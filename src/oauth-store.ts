import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

// ── Registered clients ────────────────────────────────────────────────────────
// Populated by dynamic client registration (POST /oauth/register).
// mcp-remote and Claude Desktop register themselves before starting the flow.

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  /** Present only on pre-registered static clients; dynamic clients are PKCE-only. */
  clientSecret?: string;
}

const clients = new Map<string, OAuthClient>();

export function registerClient(params: Omit<OAuthClient, 'clientId'>): string {
  const clientId = randomUUID();
  clients.set(clientId, { clientId, ...params });
  logger.debug({ clientId, clientName: params.clientName }, 'OAuth client registered');
  return clientId;
}

/**
 * Pre-register a client with a known static ID (used for Claude Web).
 * Called at startup — idempotent, safe to call multiple times.
 */
export function preRegisterClient(clientId: string, redirectUris: string[], clientName?: string, clientSecret?: string): void {
  clients.set(clientId, { clientId, redirectUris, clientName, clientSecret });
  logger.info({ clientId, clientName }, 'OAuth static client pre-registered');
}

export function getClient(clientId: string): OAuthClient | undefined {
  // Check dynamically registered clients (mcp-remote) and pre-registered static clients
  const client = clients.get(clientId);
  if (client) return client;

  // Fallback: accept the OAUTH_CLIENT_ID env var directly — no startup dependency.
  // This handles Claude Web, which uses a static client ID configured in claude.ai settings.
  const staticId = process.env.OAUTH_CLIENT_ID?.trim();
  if (staticId && clientId === staticId) {
    return {
      clientId,
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      clientName: 'Claude Web',
      clientSecret: process.env.OAUTH_CLIENT_SECRET?.trim() || undefined,
    };
  }

  return undefined;
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
