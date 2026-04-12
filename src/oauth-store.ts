import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

// ── Registered clients ────────────────────────────────────────────────────────
// Populated by dynamic client registration (POST /oauth/register).
// mcp-remote and Claude Desktop register themselves before starting the flow.

export interface OAuthClient {
  clientId: string;
  /** Exact redirect URIs — used for dynamically registered clients. */
  redirectUris: string[];
  /**
   * Trusted origin prefixes — any redirect_uri starting with one of these is
   * accepted. Used for the static client where platforms (ChatGPT, Claude web)
   * use dynamic per-connector URIs that cannot be pre-registered exactly.
   * Security is maintained by PKCE S256 regardless of the redirect_uri.
   */
  allowedRedirectPrefixes?: string[];
  clientName?: string;
  /** Present only on pre-registered static clients; dynamic clients are PKCE-only. */
  clientSecret?: string;
}

const clients = new Map<string, OAuthClient>();

export function registerClient(params: Omit<OAuthClient, 'clientId'>): { clientId: string; clientSecret: string } {
  const clientId = randomUUID();
  // Always issue a server-generated secret so confidential clients (e.g. ChatGPT
  // connectors) can authenticate at the token endpoint. PKCE clients (mcp-remote,
  // Cursor) receive it but ignore it — they authenticate via code_verifier instead.
  const clientSecret = randomUUID().replace(/-/g, '');
  clients.set(clientId, { clientId, ...params, clientSecret });
  logger.debug({ clientId, clientName: params.clientName }, 'OAuth client registered');
  return { clientId, clientSecret };
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
  // Handles Claude Web and ChatGPT which use a static client_id you configure in their UI.
  // allowedRedirectPrefixes accepts their dynamic per-connector redirect URIs without
  // needing to know them in advance. PKCE S256 maintains security regardless.
  const staticId = process.env.OAUTH_CLIENT_ID?.trim();
  if (staticId && clientId === staticId) {
    return {
      clientId,
      redirectUris: [
        'https://claude.ai/api/mcp/auth_callback',
      ],
      allowedRedirectPrefixes: [
        'https://claude.ai/',
        'https://chatgpt.com/',
        'https://chat.openai.com/',
      ],
      clientName: 'CP Legal MCP',
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
