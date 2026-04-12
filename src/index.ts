import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './logger.js';
import { authMiddleware, buildAuthCache } from './auth.js';
import { initDb, migrateUsersFromEnv, listUsers } from './db.js';
import { requestContext } from './request-context.js';
import { createMcpHandler } from './server.js';
import { mattersRouter, buildSessionVersionCache } from './matters-ui.js';
import { adminRouter } from './admin-ui.js';

const app = express();
// Trust Railway/Cloudflare proxy — required for express-rate-limit to read
// the real client IP from X-Forwarded-For without throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // OAuth login form POST

// CORS — allow any origin so browser-based MCP clients (OpenAI, Cursor, etc.) can connect
app.use('/mcp', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

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

// Matter history UI — cookie-session auth, independent of MCP bearer auth
app.use(mattersRouter);

// Admin panel — same session cookie, admin flag required
app.use(adminRouter);

// Diagnostic: probe auslaw-mcp — no auth required, safe (read-only connectivity test)
app.get('/health/auslaw', async (_req, res) => {
  const base = config.AUSLAW_BASE_URL;
  const results: Record<string, unknown> = { base };

  // Probe several paths to discover what auslaw-mcp actually serves
  const probes = [
    { path: '/mcp',      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }, id: 1 }) },
    { path: '/mcp',      method: 'GET',  body: undefined },
    { path: '/sse',      method: 'GET',  body: undefined },
    { path: '/health',   method: 'GET',  body: undefined },
    { path: '/',         method: 'GET',  body: undefined },
  ] as const;

  for (const probe of probes) {
    const key = `${probe.method} ${probe.path}`;
    try {
      const r = await fetch(new URL(probe.path, base), {
        method: probe.method,
        headers: probe.body ? { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' } : {},
        body: probe.body,
        signal: AbortSignal.timeout(5_000),
      });
      const text = await r.text().catch(() => '');
      results[key] = { status: r.status, statusText: r.statusText, body: text.slice(0, 200) };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      results[key] = { error: e.message, cause: e.cause instanceof Error ? e.cause.message : String(e.cause ?? ''), code: e.code };
    }
  }

  res.json(results);
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
    { port: config.PORT, env: config.NODE_ENV },
    'cp-legal-mcp listening',
  );

  // Initialise DB (creates schema if needed; no-op if DATABASE_URL not set)
  await initDb().catch((err) => logger.error({ err }, 'DB init failed'));

  // Migrate users from MCP_AUTH_TOKENS env var if users table is empty
  await migrateUsersFromEnv(
    process.env.MCP_AUTH_TOKENS ?? '',
    (config.ADMIN_USERS ?? 'admin').split(',').map((u) => u.trim().toLowerCase()),
  ).catch((err) => logger.error({ err }, 'User migration failed'));

  // Build in-memory auth token cache from DB
  await buildAuthCache().catch((err) => logger.error({ err }, 'Auth cache build failed'));

  // Build session version cache (for force-logout invalidation)
  const usersForCache = await listUsers().catch(() => []);
  buildSessionVersionCache(usersForCache);

});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});
