import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';
import { listUsers, updateUserLastActive } from './db.js';
import { verifyToken } from './token-utils.js';

// ── In-memory token cache ─────────────────────────────────────────────────────
// Maps plaintext_token → username for O(1) bearer token lookups.
// Populated from the DB on startup; refreshed after user create/rotate/delete.
// Falls back to env var if DB is unavailable.

let tokenCache: Map<string, string> = new Map(); // token → username
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

  // If DB cache has been built and has entries, use it exclusively.
  // This prevents revoked env var tokens from working after migration.
  if (cacheBuilt && userCredCache.size > 0) {
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

  // Fallback: env var token map (DB cache not yet built or no active DB users)
  if (envTokenMap.size > 0) {
    const identity = envTokenMap.get(token);
    if (identity) {
      res.locals['user'] = identity;
      next();
      return;
    }
    return sendUnauthorized(res);
  }

  // No auth configured — allow through with warning
  logger.warn('Auth: no tokens configured (DB cache empty, MCP_AUTH_TOKENS not set) — endpoint unprotected');
  next();
}

function sendUnauthorized(res: Response): void {
  const issuer = process.env.OAUTH_ISSUER ?? 'https://api.example.com';
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="${issuer}", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
  );
  res.status(401).json({ error: 'Unauthorized' });
}
