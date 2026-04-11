import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

// ── Registered clients ────────────────────────────────────────────────────────
// Populated by dynamic client registration (POST /oauth/register).
// mcp-remote and Claude Desktop register themselves before starting the flow.

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}

const clients = new Map<string, OAuthClient>();

export function registerClient(params: Omit<OAuthClient, 'clientId'>): string {
  const clientId = randomUUID();
  clients.set(clientId, { clientId, ...params });
  logger.debug({ clientId, clientName: params.clientName }, 'OAuth client registered');
  return clientId;
}

export function getClient(clientId: string): OAuthClient | undefined {
  return clients.get(clientId);
}

// ── Auth codes ────────────────────────────────────────────────────────────────
// Short-lived (5 min), single-use. Deleted on consumption or expiry.

export interface AuthCode {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;
const authCodes = new Map<string, AuthCode>();

function purgeExpiredCodes(): void {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (now > entry.expiresAt) authCodes.delete(code);
  }
}

export function createAuthCode(params: Omit<AuthCode, 'expiresAt'>): string {
  purgeExpiredCodes();
  const code = randomUUID();
  authCodes.set(code, { ...params, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

export function consumeAuthCode(code: string): AuthCode | null {
  const entry = authCodes.get(code);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    authCodes.delete(code);
    return null;
  }
  authCodes.delete(code); // single-use
  return entry;
}
