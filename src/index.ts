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

const app = express();
app.use(express.json());

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

  // Initialise DB (creates schema if needed; no-op if DATABASE_URL not set)
  await initDb().catch((err) => logger.error({ err }, 'DB init failed'));

  // Warm HF model in background to reduce first-request latency
  warmup();
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});
