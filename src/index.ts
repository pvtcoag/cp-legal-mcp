import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './logger.js';
import { authMiddleware } from './auth.js';
import { initDb } from './db.js';
import { requestContext } from './request-context.js';
import { createMcpHandler } from './server.js';
import { warmup } from './hf-client.js';
import { oauthRouter } from './oauth.js';
import { preRegisterClient } from './oauth-store.js';
import { mattersRouter } from './matters-ui.js';

const app = express();
// Trust Railway/Cloudflare proxy — required for express-rate-limit to read
// the real client IP from X-Forwarded-For without throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // OAuth login form POST

// Rate limiting — 60 requests per minute per IP
app.use(
  '/mcp',
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
  }),
);

// OAuth 2.0 — mounted before auth middleware (public endpoints)
app.use(oauthRouter);

// Matter history UI — cookie-session auth, independent of MCP bearer auth
app.use(mattersRouter);

// Diagnostic: test auslaw-mcp connectivity — useful for debugging
app.get('/health/auslaw', authMiddleware, async (_req, res) => {
  const auslawUrl = config.AUSLAW_BASE_URL;
  try {
    const response = await fetch(new URL('/mcp', auslawUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'health-check', version: '1' } }, id: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    res.json({
      status: response.ok ? 'reachable' : 'error',
      auslawUrl,
      httpStatus: response.status,
      httpStatusText: response.statusText,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    res.status(502).json({
      status: 'unreachable',
      auslawUrl,
      error: e.message,
      cause: e.cause instanceof Error ? e.cause.message : String(e.cause ?? ''),
      code: e.code,
    });
  }
});

// Health check — used by Railway healthcheck
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'cp-legal-mcp',
    timestamp: new Date().toISOString(),
  });
});

// MCP endpoint — auth guard, then propagate user identity into async context
const mcpHandler = createMcpHandler();

function mcpRoute(req: express.Request, res: express.Response): void {
  const user = res.locals['user'] as string | undefined;
  const requestId = crypto.randomUUID();

  // Log every MCP request with user identity — appears in Railway logs as audit trail.
  // Intentionally excludes query content (privacy). Tool name not available at HTTP layer.
  logger.info({ user: user ?? 'unauthenticated', requestId, method: req.method }, 'MCP request');

  requestContext.run({ user }, () => {
    mcpHandler(req, res);
  });
}

app.post('/mcp', authMiddleware, mcpRoute);
app.get('/mcp', authMiddleware, mcpRoute);
app.delete('/mcp', authMiddleware, mcpRoute);

// Startup
const server = app.listen(config.PORT, async () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, hfEnabled: config.HF_ENABLED },
    'cp-legal-mcp listening',
  );

  // Pre-register static OAuth client for Claude Web
  if (config.OAUTH_CLIENT_ID) {
    preRegisterClient(
      config.OAUTH_CLIENT_ID,
      ['https://claude.ai/api/mcp/auth_callback'],
      'Claude Web',
    );
  }

  // Initialise DB (creates schema if needed; no-op if DATABASE_URL not set)
  await initDb().catch((err) => logger.error({ err }, 'DB init failed'));

  // Warm HF model in background to reduce first-request latency
  warmup();
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});
