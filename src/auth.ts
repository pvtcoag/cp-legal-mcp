import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';
import { config } from './config.js';
import { listUsers, updateUserLastActive } from './db.js';
import { verifyToken } from './token-utils.js';
import { verifyJwt, looksLikeJwt } from './jwt.js';

// ── In-memory token cache ─────────────────────────────────────────────────────
// Maps plaintext_token → username for O(1) bearer token lookups.
// Populated from the DB on startup; refreshed after user create/rotate/delete.
// Falls back to env var if DB is unavailable.

let cacheBuilt = false;

/** Load all active users from DB into the in-memory token cache. */
export async function buildAuthCache(): Promise<void> {
  try {
    const users = await listUsers();
    const newCache = new Map<string, string>();
    // The DB stores hashed tokens, so we cannot reverse-map them here.
    // Instead, buildAuthCache stores username → { salt, hash } and verifyToken is used on each request.
    // For O(1) lookup we keep a secondary structure: Map<username, {salt, hash}>.
    // However, to avoid changing the auth middleware interface, we use a different approach:
    // Store username → {salt, hash} for per-request verification.
    for (const u of users) {
      if (u.is_active) {
        // Store as "username" → credentials for lookup
        newCache.set(u.username, `${u.token_salt}:${u.token_hash}`);
      }
    }
    userCredCache = newCache;
    cacheBuilt = true;
    logger.info({ users: newCache.size }, 'Auth: token cache built from DB');
  } catch (err) {
    logger.error({ err }, 'Auth: failed to build token cache from DB, falling back to env var');
    cacheBuilt = false;
  }
}

/** Call after creating, rotating, or deleting a user. */
export async function refreshAuthCache(): Promise<void> {
  await buildAuthCache();
}

// Maps username → "salt:hash" for per-request token verification
let userCredCache: Map<string, string> = new Map();

// Token map from env var (legacy fallback): bearer_token → username
// Built once at startup from MCP_AUTH_TOKENS env var.
// Format: "admin:TOKEN1,analyst:TOKEN2"
const envTokenMap = new Map<string, string>();

function buildEnvTokenMap(): void {
  const raw = process.env.MCP_AUTH_TOKENS ?? '';
  if (!raw.trim()) return;

  for (const pair of raw.split(',')) {
    const colon = pair.indexOf(':');
    if (colon < 1) {
      logger.warn({ pair }, 'MCP_AUTH_TOKENS: skipping malformed entry (expected user:token)');
      continue;
    }
    const user = pair.slice(0, colon).trim().toLowerCase();
    const token = pair.slice(colon + 1).trim();
    if (!user || !token) continue;
    envTokenMap.set(token, user);
  }

  if (envTokenMap.size > 0) {
    logger.info({ users: [...envTokenMap.values()] }, 'Auth: loaded fallback env tokens');
  }
}

buildEnvTokenMap();

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return sendUnauthorized(res);
  }

  // ── JWT path ──────────────────────────────────────────────────────────────
  // Short-lived JWTs issued by /oauth/token. Verified statelessly via HMAC.
  // We try this first because JWTs are cheap to verify and easy to recognise.
  if (looksLikeJwt(token)) {
    const v = verifyJwt(token);
    if (v.ok && v.payload) {
      const username = v.payload.sub;
      res.locals['user'] = username;
      updateUserLastActive(username).catch(() => {/* fire-and-forget */});
      next();
      return;
    }
    // Token shaped like a JWT but failed verification — log and fall through
    // to scrypt verification (a long opaque API token could in principle look
    // like a JWT regex match). This keeps legacy direct-API tokens working.
    logger.debug({ reason: v.reason }, 'Auth: JWT verification failed, falling through to legacy bearer check');
  }

  // Once the DB cache has been built successfully, it is the sole authority.
  // This holds even if the DB returned zero active users — a disabled account
  // must not be silently rescued by a still-present env-var token.
  if (cacheBuilt) {
    for (const [username, saltHash] of userCredCache) {
      const colon = saltHash.indexOf(':');
      if (colon < 0) continue;
      const salt = saltHash.slice(0, colon);
      const hash = saltHash.slice(colon + 1);
      if (verifyToken(token, salt, hash)) {
        res.locals['user'] = username;
        updateUserLastActive(username).catch(() => {/* fire-and-forget */});
        next();
        return;
      }
    }
    return sendUnauthorized(res);
  }

  // Pre-init path — DB cache not yet built. Only accept env-var tokens if some
  // are configured; otherwise fail closed so an unprotected window can't appear
  // between app.listen and buildAuthCache completing.
  if (envTokenMap.size > 0) {
    const identity = envTokenMap.get(token);
    if (identity) {
      res.locals['user'] = identity;
      next();
      return;
    }
    return sendUnauthorized(res);
  }

  // Fail closed — no tokens configured anywhere.
  logger.warn('Auth: no tokens configured and DB cache not built — rejecting request');
  return sendUnauthorized(res);
}

function sendUnauthorized(res: Response): void {
  const issuer = config.OAUTH_ISSUER;
  // OAuth resource metadata URL tells Claude web and other OAuth-aware clients
  // where to discover the authorization server and start the flow automatically.
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="${issuer}", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
  );
  res.status(401).json({
    error: 'Unauthorized',
    message: 'A valid Bearer token is required. OAuth-aware clients will be redirected to authenticate automatically.',
  });
}
