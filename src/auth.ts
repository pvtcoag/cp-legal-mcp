import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

// Token map: bearer_token → user_identity
// Built once at startup from MCP_AUTH_TOKENS env var.
// Format: "admin:TOKEN1,analyst:TOKEN2"
// Adding a user = update the env var in Railway, redeploy. No code changes.
const tokenMap = new Map<string, string>();

function buildTokenMap(): void {
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
    tokenMap.set(token, user);
  }

  logger.info({ users: [...tokenMap.values()] }, 'Auth: loaded user tokens');
}

buildTokenMap();

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Auth disabled if no tokens configured — log a warning and allow through
  if (tokenMap.size === 0) {
    logger.warn('MCP_AUTH_TOKENS not set — endpoint is unprotected');
    next();
    return;
  }

  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const identity = tokenMap.get(token);

  if (!identity) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Attach identity to res.locals for downstream middleware and request-context
  res.locals['user'] = identity;
  next();
}
