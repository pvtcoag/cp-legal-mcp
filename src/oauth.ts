/**
 * OAuth 2.0 Authorization Code + PKCE flow
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource   — RFC 9728 resource metadata
 *   GET  /.well-known/oauth-authorization-server — RFC 8414 server metadata
 *   POST /oauth/register                         — RFC 7591 dynamic client registration
 *   GET  /oauth/authorize                        — Show login form
 *   POST /oauth/authorize                        — Validate credentials, redirect with code
 *   POST /oauth/token                            — Exchange code for access token (PKCE)
 *
 * Design: the issued access_token is the pre-configured bearer token from
 * MCP_AUTH_TOKENS.  No separate token store — auth.ts tokenMap lookup works
 * unchanged and tokens persist across restarts.
 */

import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { logger } from './logger.js';
import {
  registerClient,
  getClient,
  createAuthCode,
  consumeAuthCode,
  listClientsDebug,
} from './oauth-store.js';
import {
  upsertOAuthAuthorization,
  logLoginEvent,
  getUserByUsername,
  revokeRefreshToken,
  revokeRefreshTokenFamily,
} from './db.js';
import { verifyToken } from './token-utils.js';
import { jwtAvailable } from './jwt.js';
import { issueTokens, rotateRefreshToken, findRefreshToken } from './oauth-tokens.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function issuer(): string {
  return process.env.OAUTH_ISSUER ?? 'https://mcp.example.com/mcp';
}

/** Map of username → bearer token, built lazily from MCP_AUTH_TOKENS. */
function buildCredentials(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = process.env.MCP_AUTH_TOKENS ?? '';
  for (const pair of raw.split(',')) {
    const colon = pair.indexOf(':');
    if (colon < 1) continue;
    const user = pair.slice(0, colon).trim().toLowerCase();
    const token = pair.slice(colon + 1).trim();
    if (user && token) map.set(user, token);
  }
  return map;
}

let _credentials: Map<string, string> | null = null;
function credentials(): Map<string, string> {
  if (!_credentials) _credentials = buildCredentials();
  return _credentials;
}

/** Constant-time-ish string comparison to resist timing attacks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): boolean {
  if (method === 'S256') {
    const hash = createHash('sha256').update(codeVerifier).digest('base64url');
    return safeEqual(hash, codeChallenge);
  }
  // plain — not supported; S256 is mandatory per MCP spec and current RFC guidance
  if (method === 'plain') {
    logger.warn('PKCE plain method rejected — S256 required');
    return false;
  }
  return false;
}

/** Check redirect_uri against exact list and allowed origin prefixes. */
function isRedirectUriAllowed(
  client: { clientId?: string; redirectUris: string[]; allowedRedirectPrefixes?: string[] },
  uri: string,
): boolean {
  if (client.redirectUris.includes(uri)) return true;
  if ((client.allowedRedirectPrefixes ?? []).some((prefix) => uri.startsWith(prefix))) return true;
  // Log mismatch details so Railway logs reveal exactly what's being compared.
  logger.warn(
    {
      clientId: client.clientId,
      requestedUri: uri,
      registeredUris: client.redirectUris,
      allowedPrefixes: client.allowedRedirectPrefixes ?? [],
    },
    'OAuth: redirect_uri not allowed',
  );
  return false;
}

// ── Login form rendering ──────────────────────────────────────────────────────

interface LoginFormParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  clientName?: string;
  error?: string;
}

function renderLoginForm(params: LoginFormParams): string {
  const { clientId, redirectUri, codeChallenge, codeChallengeMethod, state, clientName, error } = params;
  const stateField = state ? `<input type="hidden" name="state" value="${escHtml(state)}">` : '';
  const errorBlock = error ? `<div class="error">${escHtml(error)}</div>` : '';

  // Show the requesting client and redirect host so users can spot a phishing
  // attempt (rogue DCR client with an unfamiliar redirect URI).
  let redirectHost = '';
  try { redirectHost = new URL(redirectUri).host; } catch { redirectHost = redirectUri; }
  const clientLabel = clientName ? escHtml(clientName) : 'An OAuth client';
  const consent = `<p class="consent"><strong>${clientLabel}</strong> is requesting access on behalf of your account. After sign-in it will redirect to <code>${escHtml(redirectHost)}</code>.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — CP Legal</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
    .card { background: #fff; border: 1px solid #e0ddd6; border-radius: 8px; padding: 2.5rem 2rem; width: 100%; max-width: 380px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: .25rem; color: #1a1a1a; }
    p.subtitle { font-size: .875rem; color: #666; margin-bottom: 1.25rem; }
    p.consent { font-size: .8125rem; color: #444; background: #faf9f6; border: 1px solid #eae7dd; border-radius: 6px; padding: .625rem .75rem; margin-bottom: 1.25rem; }
    p.consent code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #fff; padding: 0 .25rem; border-radius: 3px; }
    label { display: block; font-size: .875rem; font-weight: 500; margin-bottom: .375rem; color: #333; }
    input[type="text"], input[type="password"] { width: 100%; padding: .625rem .75rem; border: 1px solid #d0cdc6; border-radius: 6px; font-size: .9375rem; outline: none; transition: border-color .15s; margin-bottom: 1.25rem; }
    input:focus { border-color: #1a1a1a; }
    button { width: 100%; padding: .75rem; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; font-size: 1rem; font-weight: 500; cursor: pointer; transition: background .15s; }
    button:hover { background: #333; }
    .error { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; color: #dc2626; font-size: .875rem; padding: .625rem .75rem; margin-bottom: 1.25rem; }
    .logo { font-weight: 700; letter-spacing: -.5px; margin-bottom: 1.5rem; font-size: 1.1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">CP Legal</div>
    <h1>Sign in to continue</h1>
    <p class="subtitle">Sign in to authorise access to your research tools.</p>
    ${consent}
    ${errorBlock}
    <form method="POST" action="/mcp/oauth/authorize">
      <input type="hidden" name="client_id" value="${escHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escHtml(redirectUri)}">
      <input type="hidden" name="code_challenge" value="${escHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escHtml(codeChallengeMethod)}">
      ${stateField}
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Token</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const oauthRouter = Router();

// Rate limit all OAuth endpoints — 30 req/min per IP is generous for humans
// completing a login flow but kills credential-stuffing and DCR-flood attempts.
const oauthRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', error_description: 'Rate limit exceeded on OAuth endpoint.' },
});

// Stricter limiter for the login POST — 10 failed attempts per IP per 15 min.
const oauthLoginRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // 302 after a valid login doesn't count
  message: { error: 'too_many_requests', error_description: 'Too many failed login attempts. Wait 15 minutes before retrying.' },
});

// CORS for all OAuth endpoints — browser-based clients (ChatGPT, etc.) make
// cross-origin requests to /.well-known/*, /oauth/register, and /oauth/token.
oauthRouter.use((req: Request, res: Response, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// Apply baseline rate limit to every OAuth path (discovery endpoints excluded
// below — those are cheap GETs that monitoring tools hit).
// Matches: /oauth/*, /mcp/oauth/*, /auslaw/oauth/*, and the /register alias.
oauthRouter.use(/^\/(mcp\/|auslaw\/)?(oauth\/|register$)/, oauthRateLimit);

// RFC 9728 — Protected Resource Metadata
// Tells clients where to find the authorization server.
// The `resource` field MUST match the URL ChatGPT (and other clients) use as
// the MCP server URL — i.e. the /mcp endpoint, not just the base domain.
// ChatGPT validates resource metadata.resource === its configured connector URL.
function protectedResourceMetadata(_req: Request, res: Response): void {
  const base = issuer();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    resource: base,   // MCP server URL is the issuer base (no /mcp suffix)
    authorization_servers: [base],
  });
}

function authorizationServerMetadata(_req: Request, res: Response): void {
  const base = issuer();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    introspection_endpoint: `${base}/oauth/introspect`,
    response_types_supported: ['code'],
    // refresh_token grant added once short-lived JWT ATs are enabled (JWT signing key set).
    grant_types_supported: jwtAvailable()
      ? ['authorization_code', 'refresh_token']
      : ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    // DCR issues a server-generated secret → confidential clients (ChatGPT) use
    // client_secret_post. PKCE clients (mcp-remote, Cursor) use 'none'.
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    introspection_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: ['mcp'],
  });
}

// RFC 9728 — Protected Resource Metadata
// Served at both the /mcp-prefixed path and at the unprefixed RFC 8414 paths
// that some clients discover by convention.
oauthRouter.get('/mcp/.well-known/oauth-protected-resource', protectedResourceMetadata);
oauthRouter.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
oauthRouter.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

// RFC 8414 — Authorization Server Metadata
oauthRouter.get('/mcp/.well-known/oauth-authorization-server', authorizationServerMetadata);
oauthRouter.get('/.well-known/oauth-authorization-server', authorizationServerMetadata);
oauthRouter.get('/.well-known/oauth-authorization-server/mcp', authorizationServerMetadata);

// RFC 7591 — Dynamic Client Registration
// Used by ChatGPT, mcp-remote, Cursor, Windsurf, and other MCP clients that
// self-register before starting the OAuth flow. No client secret is issued —
// PKCE S256 handles the security.
function dynamicClientRegistration(req: Request, res: Response): void {
  const body = req.body as Record<string, unknown>;
  const { redirect_uris, client_name, scope } = body;

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    return;
  }

  const uris = (redirect_uris as unknown[]).filter((u) => typeof u === 'string') as string[];
  if (uris.length === 0) {
    res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris must contain at least one string URI' });
    return;
  }

  const name = typeof client_name === 'string' ? client_name : undefined;
  const { clientId, clientSecret } = registerClient({ redirectUris: uris, clientName: name });
  logger.info({ clientId, clientName: name, redirectUris: uris }, 'OAuth: dynamic client registered');

  // RFC 7591 §3.2.1 — echo back all registered metadata plus server-assigned fields.
  // We issue a client_secret so confidential clients (ChatGPT) can authenticate at
  // the token endpoint. client_secret_expires_at: 0 means it does not expire.
  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: uris,
    ...(name ? { client_name: name } : {}),
    ...(typeof scope === 'string' ? { scope } : { scope: 'mcp' }),
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: jwtAvailable() ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
    response_types: ['code'],
    code_challenge_methods_supported: ['S256'],
  });
}

oauthRouter.post('/mcp/oauth/register', dynamicClientRegistration);
// Alias: some clients POST to /register (no service prefix) per RFC 7591
oauthRouter.post('/register', dynamicClientRegistration);

// GET /oauth/authorize — Serve login form
// Parameters come from mcp-remote as query string.
oauthRouter.get('/mcp/oauth/authorize', (req: Request, res: Response) => {
  const {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    response_type,
  } = req.query as Record<string, string | undefined>;

  logger.info({ client_id, redirect_uri, response_type }, 'OAuth: authorize request received');

  if (response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type' });
    return;
  }
  if (!client_id || !redirect_uri || !code_challenge || !code_challenge_method) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
    return;
  }

  const client = getClient(client_id);
  if (!client) {
    logger.warn({ client_id }, 'OAuth: unknown client_id');
    res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
    return;
  }
  if (!isRedirectUriAllowed(client, redirect_uri)) {
    res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderLoginForm({
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    state,
    clientName: client.clientName,
  }));
});

// POST /oauth/authorize — Validate credentials, issue code, redirect
oauthRouter.post('/mcp/oauth/authorize', oauthLoginRateLimit, async (req: Request, res: Response) => {
  const {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    username,
    password,
  } = req.body as Record<string, string | undefined>;

  if (!client_id || !redirect_uri || !code_challenge || !code_challenge_method || !username || !password) {
    res.status(400).send('Missing required fields');
    return;
  }

  const client = getClient(client_id);
  if (!client || !isRedirectUriAllowed(client, redirect_uri)) {
    res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
    return;
  }

  // Validate credentials — check DB first, then fall back to MCP_AUTH_TOKENS
  const normalUser = username.trim().toLowerCase();
  let credValid = false;
  const dbUserRecord = await getUserByUsername(normalUser).catch(() => null);
  if (dbUserRecord && dbUserRecord.is_active) {
    credValid = verifyToken(password.trim(), dbUserRecord.token_salt, dbUserRecord.token_hash);
  } else {
    const creds = credentials();
    const expectedToken = creds.get(normalUser);
    if (expectedToken) credValid = safeEqual(password.trim(), expectedToken);
  }

  if (!credValid) {
    logger.warn({ username }, 'OAuth: failed login attempt');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(401).send(renderLoginForm({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      state,
      clientName: client.clientName,
      error: 'Incorrect username or token. Please try again.',
    }));
    return;
  }

  // Issue auth code
  const code = createAuthCode({
    userId: username.trim().toLowerCase(),
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
  });

  logger.info({ user: username.trim().toLowerCase() }, 'OAuth: authorisation code issued');

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  res.redirect(redirectUrl.toString());
});

// POST /oauth/token
// Dispatches by grant_type:
//   authorization_code → exchange code + PKCE verifier for AT (+ RT when JWT key set)
//   refresh_token       → rotate the presented RT, return new AT + RT
oauthRouter.post('/mcp/oauth/token', async (req: Request, res: Response) => {
  const body = req.body as Record<string, string | undefined>;
  const grant_type = body['grant_type'];

  logger.info(
    {
      grant_type,
      client_id: body['client_id'],
      has_code: !!body['code'],
      has_refresh_token: !!body['refresh_token'],
      has_code_verifier: !!body['code_verifier'],
      has_client_secret: !!body['client_secret'],
      content_type: req.headers['content-type'],
    },
    'OAuth: token request received',
  );

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');

  if (grant_type === 'authorization_code') {
    await handleAuthCodeGrant(req, res);
    return;
  }
  if (grant_type === 'refresh_token') {
    await handleRefreshGrant(req, res);
    return;
  }

  logger.warn({ grant_type }, 'OAuth: unsupported grant_type');
  res.status(400).json({ error: 'unsupported_grant_type' });
});

async function handleAuthCodeGrant(req: Request, res: Response): Promise<void> {
  const {
    code,
    redirect_uri,
    client_id,
    client_secret,
    code_verifier,
  } = req.body as Record<string, string | undefined>;

  if (!code || !redirect_uri || !client_id || !code_verifier) {
    logger.warn({ has_code: !!code, has_redirect_uri: !!redirect_uri, has_client_id: !!client_id, has_code_verifier: !!code_verifier }, 'OAuth: token request missing required fields');
    res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
    return;
  }

  const entry = consumeAuthCode(code);
  if (!entry) {
    logger.warn({ client_id }, 'OAuth: auth code invalid or expired');
    res.status(400).json({ error: 'invalid_grant', error_description: 'Code invalid or expired' });
    return;
  }

  if (entry.clientId !== client_id) {
    logger.warn({ expected: entry.clientId, got: client_id }, 'OAuth: client_id mismatch');
    res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    return;
  }

  // Validate client secret when the client sends one. We accept it if it matches
  // and ignore the check if neither side has a secret (PKCE-only clients).
  const client = getClient(client_id);
  if (client_secret && client?.clientSecret) {
    if (!safeEqual(client_secret, client.clientSecret)) {
      logger.warn({ client_id }, 'OAuth: invalid client_secret');
      res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client_secret' });
      return;
    }
  }

  if (entry.redirectUri !== redirect_uri) {
    logger.warn({ stored: entry.redirectUri, got: redirect_uri }, 'OAuth: redirect_uri mismatch at token exchange');
    res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    return;
  }

  if (!verifyPkce(code_verifier, entry.codeChallenge, entry.codeChallengeMethod)) {
    logger.warn({ user: entry.userId, method: entry.codeChallengeMethod }, 'OAuth: PKCE verification failed');
    res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    return;
  }

  // Verify the user still exists and is active before issuing tokens.
  const dbUser = await getUserByUsername(entry.userId).catch(() => null);
  if (dbUser && !dbUser.is_active) {
    logger.warn({ user: entry.userId }, 'OAuth: user is disabled — refusing to issue tokens');
    res.status(400).json({ error: 'invalid_grant', error_description: 'User disabled' });
    return;
  }
  if (!dbUser && !credentials().get(entry.userId)) {
    logger.error({ user: entry.userId }, 'OAuth: user not found in DB or env');
    res.status(400).json({ error: 'invalid_grant', error_description: 'User not found' });
    return;
  }

  // Modern path: short-lived JWT AT + rotating RT. Available when a JWT signing
  // key is configured. Falls back to the legacy long-lived bearer otherwise so
  // misconfigured deployments don't break.
  if (jwtAvailable()) {
    try {
      const tokens = await issueTokens({
        username: entry.userId,
        clientId: client_id,
        clientName: client?.clientName,
        scope: 'mcp',
      });

      upsertOAuthAuthorization({
        username: entry.userId,
        clientId: client_id,
        clientName: client?.clientName,
        redirectUri: redirect_uri,
      }).catch(() => {/* fire-and-forget */});

      logLoginEvent({
        username: entry.userId,
        eventType: 'oauth_token_issued',
        clientName: client?.clientName,
        meta: { client_id, has_refresh_token: !!tokens.refresh_token },
      }).catch(() => {/* fire-and-forget */});

      logger.info({ user: entry.userId, has_rt: !!tokens.refresh_token }, 'OAuth: JWT access token issued');
      res.json(tokens);
      return;
    } catch (err) {
      logger.error({ err, user: entry.userId }, 'OAuth: token issuance failed');
      res.status(500).json({ error: 'server_error', error_description: 'Token issuance failed' });
      return;
    }
  }

  // Legacy path: return the user's pre-configured long-lived bearer.
  // Kept so that deployments without a JWT signing key continue to work.
  await issueLegacyBearer(entry.userId, client_id, client?.clientName, redirect_uri, res);
}

async function handleRefreshGrant(req: Request, res: Response): Promise<void> {
  const {
    refresh_token,
    client_id,
    client_secret,
  } = req.body as Record<string, string | undefined>;

  if (!refresh_token || !client_id) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token or client_id' });
    return;
  }

  if (!jwtAvailable()) {
    // Without a JWT signing key we never issued an RT in the first place.
    res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Refresh tokens disabled (JWT signing key not configured)' });
    return;
  }

  // Confidential client check — same rule as the auth_code grant.
  const client = getClient(client_id);
  if (client_secret && client?.clientSecret) {
    if (!safeEqual(client_secret, client.clientSecret)) {
      logger.warn({ client_id }, 'OAuth: invalid client_secret on refresh');
      res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client_secret' });
      return;
    }
  }

  const outcome = await rotateRefreshToken(refresh_token, client_id);
  if (!outcome.ok || !outcome.tokens) {
    const status = outcome.error === 'server_error' ? 500 : 400;
    res.status(status).json({
      error: outcome.error ?? 'invalid_grant',
      ...(outcome.error_description ? { error_description: outcome.error_description } : {}),
    });
    return;
  }

  res.json(outcome.tokens);
}

async function issueLegacyBearer(
  userId: string,
  clientId: string,
  clientName: string | undefined,
  redirectUri: string,
  res: Response,
): Promise<void> {
  const dbUser = await getUserByUsername(userId).catch(() => null);

  let accessToken: string | undefined;
  if (dbUser && dbUser.is_active && dbUser.token_encrypted) {
    const encKey = process.env.ENCRYPTION_KEY?.trim();
    if (!encKey) {
      logger.error({ user: userId }, 'OAuth: token_encrypted present but ENCRYPTION_KEY not set');
      res.status(500).json({ error: 'server_error', error_description: 'Server misconfiguration: ENCRYPTION_KEY required' });
      return;
    }
    try {
      const { decryptToken } = await import('./token-utils.js');
      accessToken = decryptToken(dbUser.token_encrypted, encKey);
    } catch (err) {
      logger.error({ user: userId, err }, 'OAuth: failed to decrypt token');
      res.status(500).json({ error: 'server_error', error_description: 'Token decryption failed' });
      return;
    }
  } else {
    accessToken = credentials().get(userId);
  }

  if (!accessToken) {
    logger.error({ user: userId }, 'OAuth: no token available for legacy bearer issuance');
    res.status(500).json({ error: 'server_error', error_description: 'Token not available — rotate via admin panel' });
    return;
  }

  upsertOAuthAuthorization({ username: userId, clientId, clientName, redirectUri }).catch(() => {/* ignore */});
  logLoginEvent({
    username: userId,
    eventType: 'oauth_authorized',
    clientName,
    meta: { client_id: clientId, legacy_bearer: true },
  }).catch(() => {/* ignore */});

  logger.info({ user: userId }, 'OAuth: legacy long-lived access token issued (no JWT signing key)');
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    scope: 'mcp',
  });
}

// POST /oauth/revoke — RFC 7009 token revocation.
// Accepts an access_token or refresh_token. Spec: ALWAYS return 200 (with no
// body) regardless of whether the token was found, to avoid token-existence oracles.
oauthRouter.post('/mcp/oauth/revoke', async (req: Request, res: Response) => {
  const { token, token_type_hint, client_id, client_secret } = req.body as Record<string, string | undefined>;

  res.setHeader('Cache-Control', 'no-store');

  if (!token) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Missing token' });
    return;
  }

  // Authenticate the client when one was issued a secret.
  if (client_id) {
    const client = getClient(client_id);
    if (client_secret && client?.clientSecret) {
      if (!safeEqual(client_secret, client.clientSecret)) {
        logger.warn({ client_id }, 'OAuth: invalid client_secret on revoke');
        res.status(401).json({ error: 'invalid_client' });
        return;
      }
    }
  }

  // Try refresh-token revocation first unless the hint says access_token.
  // Per RFC 7009 §2.1, hints are advisory — we still try the alternate type.
  let revokedKind: 'refresh_token' | 'access_token' | 'unknown' = 'unknown';
  let revokedRow: Awaited<ReturnType<typeof findRefreshToken>> = null;

  if (token_type_hint !== 'access_token') {
    revokedRow = await findRefreshToken(token);
    if (revokedRow) {
      // Revoke this RT and its entire family — explicit user logout should
      // sever the chain so a stale sibling can't be used to mint new tokens.
      await revokeRefreshToken(revokedRow.id, 'client_revocation').catch(() => {/* ignore */});
      const count = await revokeRefreshTokenFamily(revokedRow.family_id, 'client_revocation').catch(() => 0);
      revokedKind = 'refresh_token';
      logLoginEvent({
        username: revokedRow.username,
        eventType: 'oauth_token_revoked',
        clientName: revokedRow.client_name ?? undefined,
        meta: { client_id: revokedRow.client_id, family_id: revokedRow.family_id, revoked_count: count, kind: 'refresh_token' },
      }).catch(() => {/* ignore */});
    }
  }

  // Access tokens (JWTs) are stateless — we can't revoke them server-side
  // without a denylist, but we still log the attempt for the audit trail.
  // Real revocation comes from the short TTL + RT family revocation cutting
  // off future ATs.
  if (!revokedRow) {
    logLoginEvent({
      username: 'unknown',
      eventType: 'oauth_token_revoke_attempt',
      meta: { hint: token_type_hint ?? null, kind: revokedKind, client_id: client_id ?? null },
    }).catch(() => {/* ignore */});
  }

  // RFC 7009: always 200 even if the token was unknown.
  res.status(200).end();
});

// POST /oauth/introspect — RFC 7662 token introspection.
// Returns metadata for refresh tokens we issued; for access-token JWTs we
// verify the signature and report the embedded claims. Active=false on any
// error or unknown token (no oracle).
oauthRouter.post('/mcp/oauth/introspect', async (req: Request, res: Response) => {
  const { token, client_id, client_secret } = req.body as Record<string, string | undefined>;

  res.setHeader('Cache-Control', 'no-store');

  if (!token) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Missing token' });
    return;
  }

  // Confidential-client check — RFC 7662 requires client auth on this endpoint.
  if (client_id) {
    const client = getClient(client_id);
    if (client_secret && client?.clientSecret) {
      if (!safeEqual(client_secret, client.clientSecret)) {
        res.status(401).json({ error: 'invalid_client' });
        return;
      }
    }
  }

  // Try as JWT access token first.
  const { verifyJwt, looksLikeJwt } = await import('./jwt.js');
  if (looksLikeJwt(token)) {
    const v = verifyJwt(token);
    if (v.ok && v.payload) {
      res.json({
        active: true,
        scope: v.payload.scope,
        client_id: v.payload.client_id,
        username: v.payload.sub,
        sub: v.payload.sub,
        aud: v.payload.aud,
        iss: v.payload.iss,
        exp: v.payload.exp,
        iat: v.payload.iat,
        jti: v.payload.jti,
        token_type: 'Bearer',
      });
      return;
    }
    // fall through to RT lookup — some opaque RTs could superficially match the
    // JWT shape regex; this keeps both paths safe.
  }

  const row = await findRefreshToken(token);
  if (!row || row.revoked_at !== null || row.used_at !== null) {
    res.json({ active: false });
    return;
  }
  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now || new Date(row.family_expires_at).getTime() <= now) {
    res.json({ active: false });
    return;
  }
  res.json({
    active: true,
    scope: row.scope,
    client_id: row.client_id,
    username: row.username,
    sub: row.username,
    exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
    iat: Math.floor(new Date(row.issued_at).getTime() / 1000),
    token_type: 'refresh_token',
  });
});

// GET /oauth/debug — Diagnostic endpoint: registered clients (no secrets).
// Only accessible when DEBUG_SECRET env var is set and ?secret=<value> matches.
oauthRouter.get('/oauth/debug', (req: Request, res: Response) => {
  const debugSecret = process.env.DEBUG_SECRET;
  const provided = typeof req.query['secret'] === 'string' ? req.query['secret'] : '';
  if (!debugSecret || !safeEqual(provided, debugSecret)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ clients: listClientsDebug() });
});

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
