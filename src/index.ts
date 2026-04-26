import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { LRUCache } from 'lru-cache';
import { config } from './config.js';
import { logger } from './logger.js';
import { authMiddleware, buildAuthCache } from './auth.js';
import { initDb, migrateUsersFromEnv, listUsers, pingDb, isDbEnabled, closeDb, checkSpendCap } from './db.js';
import { requestContext } from './request-context.js';
import { createMcpHandler } from './server.js';
import { oauthRouter } from './oauth.js';
import { preRegisterClient } from './oauth-store.js';
import { warnIfNoSigningKey } from './jwt.js';
import { mattersRouter, buildSessionVersionCache } from './matters-ui.js';
import { adminRouter } from './admin-ui.js';

const app = express();
// Trust Railway/Cloudflare proxy — required for express-rate-limit to read
// the real client IP from X-Forwarded-For without throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' })); // OAuth login form POST

// OAuth 2.0 — mounted before auth middleware (public discovery + token endpoints)
app.use(oauthRouter);

// CORS — allow any origin so browser-based MCP clients (OpenAI, Cursor, etc.) can connect
// Scoped inline to the MCP route only (not app.use — avoids matching /mcp/matters etc.)
const mcpCors = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
};

// Rate limiting — 60 requests per minute per IP
const mcpRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// Matter history UI — cookie-session auth, independent of MCP bearer auth
app.use(mattersRouter);

// Admin panel — same session cookie, admin flag required
app.use(adminRouter);

// Diagnostic: probe auslaw-mcp — no auth required, safe (read-only connectivity test)
app.get('/mcp/health/upstream', async (_req, res) => {
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

  await Promise.all(probes.map(async (probe) => {
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
  }));

  res.json(results);
});

// Health check — used by Railway to gate traffic onto new deployments.
// Returns 503 if the DB is unreachable so Railway holds the old deployment live.
app.get('/mcp/health', async (_req, res) => {
  const dbOk = await pingDb();
  const status = !isDbEnabled() || dbOk ? 'ok' : 'degraded';
  res.status(status === 'ok' ? 200 : 503).json({
    status,
    service: 'cp-legal-mcp',
    db: isDbEnabled() ? (dbOk ? 'ok' : 'unreachable') : 'disabled',
    timestamp: new Date().toISOString(),
  });
});

// Spend cap cache — 5-minute TTL per user to avoid hammering the DB on every request.
const SPEND_CAP_CACHE_TTL_MS = 5 * 60 * 1000;
const spendCapCache = new LRUCache<string, Awaited<ReturnType<typeof checkSpendCap>>>({
  max: 10_000,
  ttl: SPEND_CAP_CACHE_TTL_MS,
});

// Spend cap middleware — blocks requests when the user's or global monthly spend cap is exceeded.
// Runs after auth so res.locals['user'] is set. Fails open on DB errors (logs warning).
async function spendCapMiddleware(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const user = res.locals['user'] as string | undefined;
  if (!user || !isDbEnabled()) { next(); return; }
  try {
    // Check cache first — avoids repeated DB reads within the TTL window
    const cached = spendCapCache.get(user);
    if (cached) {
      const cap = cached;
      if (!cap.allowed) {
        const capStr = cap.cap_usd != null ? `$${cap.cap_usd.toFixed(2)}` : 'set limit';
        res.status(429).json({
          error: 'spend_cap_exceeded',
          message: `Monthly spend cap reached ($${cap.current_usd.toFixed(2)} of ${capStr} USD). Contact your administrator.`,
        });
        return;
      }
      next();
      return;
    }
    const cap = await checkSpendCap(user);
    spendCapCache.set(user, cap);
    if (!cap.allowed) {
      const capStr = cap.cap_usd != null ? `$${cap.cap_usd.toFixed(2)}` : 'set limit';
      res.status(429).json({
        error: 'spend_cap_exceeded',
        message: `Monthly spend cap reached ($${cap.current_usd.toFixed(2)} of ${capStr} USD). Contact your administrator.`,
      });
      return;
    }
    if (cap.at_alert && cap.pct_used !== null) {
      logger.warn(
        { user, current_usd: cap.current_usd.toFixed(4), cap_usd: cap.cap_usd?.toFixed(2), pct: cap.pct_used.toFixed(1) },
        'spend cap: approaching monthly limit',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'spend cap check failed — allowing request');
  }
  next();
}

// Per-user rate limiter — applied after authMiddleware so res.locals['user'] is set.
// IP-based pre-auth flood protection is handled by the app.use('/mcp', rateLimit(...)) above.
const userRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  keyGenerator: (_req, res) => (res.locals['user'] as string | undefined) ?? 'unauthenticated',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded for your account.' },
  skip: (_req, res) => !(res.locals['user']), // only rate-limit authenticated users here
});

// MCP endpoint — auth guard, then propagate user identity into async context
const mcpHandler = createMcpHandler();

function mcpRoute(req: express.Request, res: express.Response): void {
  const user = res.locals['user'] as string | undefined;
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const requestId = crypto.randomUUID();

  // Log every MCP request with user identity — appears in Railway logs as audit trail.
  // Intentionally excludes query content (privacy). Tool name not available at HTTP layer.
  logger.info({ user: user ?? 'unauthenticated', requestId, method: req.method }, 'MCP request');

  requestContext.run({ user, sessionId }, () => {
    void mcpHandler(req, res);
  });
}

// MCP endpoint at /mcp — OPTIONS for CORS preflight, then authenticated methods
app.options('/mcp', mcpCors);
app.post('/mcp', mcpCors, mcpRateLimit, authMiddleware, userRateLimit, spendCapMiddleware, mcpRoute);
app.get('/mcp', mcpCors, mcpRateLimit, authMiddleware, userRateLimit, spendCapMiddleware, mcpRoute);
app.delete('/mcp', mcpCors, mcpRateLimit, authMiddleware, userRateLimit, spendCapMiddleware, mcpRoute);

// Startup — initialise DB and auth caches BEFORE binding the listener so there
// is no window where /mcp accepts requests while auth is still warming.
async function startup(): Promise<ReturnType<typeof app.listen>> {
  // Pre-register static OAuth client for Claude Web / ChatGPT connectors
  if (config.OAUTH_CLIENT_ID) {
    preRegisterClient(
      config.OAUTH_CLIENT_ID,
      ['https://claude.ai/api/mcp/auth_callback'],
      ['https://claude.ai/', 'https://chatgpt.com/', 'https://chat.openai.com/'],
      'CP Legal MCP',
      config.OAUTH_CLIENT_SECRET,
    );
    logger.info({ clientId: config.OAUTH_CLIENT_ID }, 'OAuth static client pre-registered');
  }

  // Warn on missing optional env vars that degrade functionality
  if (!config.ABR_GUID) {
    logger.warn(
      'ABR_GUID not configured — entity lookups will use ASIC Connect only. ' +
      'Register for a free GUID at https://abr.business.gov.au/Tools/WebServices',
    );
  }
  if (!config.OAUTH_CLIENT_ID) {
    logger.warn('OAUTH_CLIENT_ID not set — Claude Web / ChatGPT static client will not be pre-registered');
  }
  warnIfNoSigningKey();

  await initDb().catch((err) => logger.error({ err }, 'DB init failed'));

  await migrateUsersFromEnv(
    process.env.MCP_AUTH_TOKENS ?? '',
    (config.ADMIN_USERS ?? 'admin').split(',').map((u) => u.trim().toLowerCase()),
  ).catch((err) => logger.error({ err }, 'User migration failed'));

  await buildAuthCache().catch((err) => logger.error({ err }, 'Auth cache build failed'));

  const usersForCache = await listUsers().catch(() => []);
  buildSessionVersionCache(usersForCache);

  return app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'cp-legal-mcp listening');
  });
}

const serverPromise = startup().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  // Force-exit after 10 s — Railway allows 30 s before SIGKILL, so this ensures
  // we exit cleanly before the hard kill and don't block on idle keep-alive connections.
  const forceExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out after 10 s — forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  const server = await serverPromise;
  if (!server) { clearTimeout(forceExit); await closeDb(); process.exit(0); return; }
  server.close(async () => {
    clearTimeout(forceExit);
    await closeDb();
    process.exit(0);
  });
});
