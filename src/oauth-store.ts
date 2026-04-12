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
const MAX_DYNAMIC_CLIENTS = 500; // prevent unbounded growth on idle servers

export function registerClient(params: Omit<OAuthClient, 'clientId'>): { clientId: string; clientSecret: string } {
  // Evict oldest dynamic client entry if we're at the cap.
  // Pre-registered static clients are never evicted (they have no expiry and are
  // registered at startup by name, not UUID), so we only need a soft cap here.
  if (clients.size >= MAX_DYNAMIC_CLIENTS) {
    const firstKey = clients.keys().next().value;
    if (firstKey !== undefined) clients.delete(firstKey);
    logger.warn({ limit: MAX_DYNAMIC_CLIENTS }, 'OAuth client map at capacity — evicted oldest entry');
  }
  const clientId = randomUUID();
  // Always issue a server-generated secret so confidential clients (e.g. ChatGPT
  // connectors) can authenticate at the token endpoint. PKCE clients (mcp-remote,
  // Cursor) receive it but ignore it — they authenticate via code_verifier instead.
  const clientSecret = randomUUID().replace(/-/g, '');

  // Derive allowed redirect prefixes from the origins of registered URIs.
  // ChatGPT and other clients may use a slightly different path in the authorize
  // step than what they registered (different connector ID, trailing slash, etc.).
  // Accepting any URI on the same origin as a registered URI keeps us RFC 7591
  // compliant while handling these real-world variations.
  const derivedPrefixes = [
    ...new Set(
      params.redirectUris
        .map((uri) => { try { return new URL(uri).origin + '/'; } catch { return null; } })
        .filter((p): p is string => p !== null),
    ),
  ];

  clients.set(clientId, {
    clientId,
    ...params,
    allowedRedirectPrefixes: [...(params.allowedRedirectPrefixes ?? []), ...derivedPrefixes],
    clientSecret,
  });
  logger.debug({ clientId, clientName: params.clientName, derivedPrefixes }, 'OAuth client registered');
  return { clientId, clientSecret };
}

/**
 * Pre-register a client with a known static ID (used for Claude Web).
 * Called at startup — idempotent, safe to call multiple times.
 */
export function preRegisterClient(
  clientId: string,
  redirectUris: string[],
  allowedRedirectPrefixes?: string[],
  clientName?: string,
  clientSecret?: string,
): void {
  clients.set(clientId, { clientId, redirectUris, allowedRedirectPrefixes, clientName, clientSecret });
  logger.info({ clientId, clientName }, 'OAuth static client pre-registered');
}

export function getClient(clientId: string): OAuthClient | undefined {
  // Check dynamically registered clients (mcp-remote) and pre-registered static clients
  const client = clients.get(clientId);
  if (client) return client;

  return undefined;
}

/** Return a redacted view of all registered clients (no secrets) for diagnostics. */
export function listClientsDebug(): Array<{
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  allowedRedirectPrefixes?: string[];
  hasSecret: boolean;
}> {
  return [...clients.values()].map(({ clientId, clientName, redirectUris, allowedRedirectPrefixes, clientSecret }) => ({
    clientId,
    clientName,
    redirectUris,
    allowedRedirectPrefixes,
    hasSecret: !!clientSecret,
  }));
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

// Periodic background cleanup so codes don't accumulate on idle servers.
// unref() prevents this timer from keeping the process alive during graceful shutdown.
setInterval(purgeExpiredCodes, 60_000).unref();

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
