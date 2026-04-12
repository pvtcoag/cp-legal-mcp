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
import { logger } from './logger.js';
import {
  registerClient,
  getClient,
  createAuthCode,
  consumeAuthCode,
} from './oauth-store.js';
import { upsertOAuthAuthorization, logLoginEvent, getUserByUsername } from './db.js';
import { decryptToken, verifyToken } from './token-utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function issuer(): string {
  return process.env.OAUTH_ISSUER ?? 'https://api.example.com';
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
  // plain — not recommended but technically allowed
  if (method === 'plain') return safeEqual(codeVerifier, codeChallenge);
  return false;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const oauthRouter = Router();

// RFC 9728 — Protected Resource Metadata
// Tells mcp-remote where to find the authorization server.
oauthRouter.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
  const base = issuer();
  res.json({
    resource: base,
    authorization_servers: [base],
  });
});

// RFC 8414 — Authorization Server Metadata
// Tells mcp-remote which endpoints to use and what features are supported.
oauthRouter.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  const base = issuer();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    // 'none' = PKCE-only (mcp-remote, Cursor, etc.)
    // 'client_secret_post' = client_id + client_secret in POST body (ChatGPT, Claude Web)
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['mcp'],
  });
});

// RFC 7591 — Dynamic Client Registration
// mcp-remote registers itself before starting the flow.
oauthRouter.post('/oauth/register', (req: Request, res: Response) => {
  const { redirect_uris, client_name } = req.body as {
    redirect_uris?: unknown;
    client_name?: unknown;
  };

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    return;
  }

  const uris = redirect_uris as string[];
  const name = typeof client_name === 'string' ? client_name : undefined;

  const clientId = registerClient({ redirectUris: uris, clientName: name });
  logger.debug({ clientId, clientName: name }, 'OAuth: dynamic client registered');

  res.status(201).json({
    client_id: clientId,
    redirect_uris: uris,
    client_name: name,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  });
});

// GET /oauth/authorize — Serve login form
// Parameters come from mcp-remote as query string.
oauthRouter.get('/oauth/authorize', (req: Request, res: Response) => {
  const {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    response_type,
  } = req.query as Record<string, string | undefined>;

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
    res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
    return;
  }
  if (!client.redirectUris.includes(redirect_uri)) {
    res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
    return;
  }

  // Encode all OAuth params into hidden fields so the POST can validate them
  const stateField = state ? `<input type="hidden" name="state" value="${escHtml(state)}">` : '';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — CP Legal</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: #fff;
      border: 1px solid #e0ddd6;
      border-radius: 8px;
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 2px 8px rgba(0,0,0,.06);
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: .25rem; color: #1a1a1a; }
    p.subtitle { font-size: .875rem; color: #666; margin-bottom: 2rem; }
    label { display: block; font-size: .875rem; font-weight: 500; margin-bottom: .375rem; color: #333; }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: .625rem .75rem;
      border: 1px solid #d0cdc6;
      border-radius: 6px;
      font-size: .9375rem;
      outline: none;
      transition: border-color .15s;
      margin-bottom: 1.25rem;
    }
    input:focus { border-color: #1a1a1a; }
    button {
      width: 100%;
      padding: .75rem;
      background: #1a1a1a;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: background .15s;
    }
    button:hover { background: #333; }
    .error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 6px;
      color: #dc2626;
      font-size: .875rem;
      padding: .625rem .75rem;
      margin-bottom: 1.25rem;
    }
    .logo { font-weight: 700; letter-spacing: -.5px; margin-bottom: 1.5rem; font-size: 1.1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">CP Legal</div>
    <h1>Sign in to continue</h1>
    <p class="subtitle">Authorise Claude to access your research tools.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escHtml(client_id)}">
      <input type="hidden" name="redirect_uri" value="${escHtml(redirect_uri)}">
      <input type="hidden" name="code_challenge" value="${escHtml(code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${escHtml(code_challenge_method)}">
      ${stateField}
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Token</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`);
});

// POST /oauth/authorize — Validate credentials, issue code, redirect
oauthRouter.post('/oauth/authorize', async (req: Request, res: Response) => {
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
  if (!client || !client.redirectUris.includes(redirect_uri)) {
    res.status(400).json({ error: 'invalid_request' });
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
    // Redisplay form with error
    const stateField = state ? `<input type="hidden" name="state" value="${escHtml(state)}">` : '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
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
    p.subtitle { font-size: .875rem; color: #666; margin-bottom: 2rem; }
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
    <p class="subtitle">Authorise Claude to access your research tools.</p>
    <div class="error">Incorrect username or token. Please try again.</div>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escHtml(client_id)}">
      <input type="hidden" name="redirect_uri" value="${escHtml(redirect_uri)}">
      <input type="hidden" name="code_challenge" value="${escHtml(code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${escHtml(code_challenge_method)}">
      ${stateField}
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Token</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`);
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

// POST /oauth/token — Exchange code + PKCE verifier for access token
oauthRouter.post('/oauth/token', async (req: Request, res: Response) => {
  const {
    grant_type,
    code,
    redirect_uri,
    client_id,
    client_secret,
    code_verifier,
  } = req.body as Record<string, string | undefined>;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  if (!code || !redirect_uri || !client_id || !code_verifier) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
    return;
  }

  const entry = consumeAuthCode(code);
  if (!entry) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Code invalid or expired' });
    return;
  }

  if (entry.clientId !== client_id) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    return;
  }

  // Validate client secret for pre-registered static clients that have one configured.
  // Dynamic clients are PKCE-only and have no secret.
  const client = getClient(client_id);
  if (client?.clientSecret) {
    if (!client_secret || !safeEqual(client_secret, client.clientSecret)) {
      logger.warn({ client_id }, 'OAuth: invalid client_secret');
      res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client_secret' });
      return;
    }
  }

  if (entry.redirectUri !== redirect_uri) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    return;
  }

  if (!verifyPkce(code_verifier, entry.codeChallenge, entry.codeChallengeMethod)) {
    logger.warn({ user: entry.userId }, 'OAuth: PKCE verification failed');
    res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    return;
  }

  // Resolve access token — prefer DB (encrypted plaintext), fall back to MCP_AUTH_TOKENS.
  let accessToken: string | undefined;

  const dbUser = await getUserByUsername(entry.userId).catch(() => null);
  if (dbUser && dbUser.is_active) {
    if (dbUser.token_encrypted) {
      const encKey = process.env.ENCRYPTION_KEY?.trim();
      if (!encKey) {
        logger.error({ user: entry.userId }, 'OAuth: token_encrypted present but ENCRYPTION_KEY not set');
        res.status(500).json({ error: 'server_error', error_description: 'Server misconfiguration: ENCRYPTION_KEY required' });
        return;
      }
      try {
        accessToken = decryptToken(dbUser.token_encrypted, encKey);
      } catch (err) {
        logger.error({ user: entry.userId, err }, 'OAuth: failed to decrypt token');
        res.status(500).json({ error: 'server_error', error_description: 'Token decryption failed' });
        return;
      }
    } else {
      // Legacy: token not yet encrypted — fall back to env var
      accessToken = credentials().get(entry.userId);
      if (!accessToken) {
        logger.error({ user: entry.userId }, 'OAuth: no encrypted token and no env token — rotate token in admin panel');
        res.status(500).json({ error: 'server_error', error_description: 'Token not available — rotate via admin panel' });
        return;
      }
    }
  } else {
    // No DB user — legacy env-var-only path
    accessToken = credentials().get(entry.userId);
    if (!accessToken) {
      logger.error({ user: entry.userId }, 'OAuth: user not found in DB or env');
      res.status(400).json({ error: 'invalid_grant', error_description: 'User not found' });
      return;
    }
  }

  logger.info({ user: entry.userId }, 'OAuth: access token issued');

  // Log OAuth authorization to DB (fire-and-forget)
  upsertOAuthAuthorization({
    username: entry.userId,
    clientId: client_id,
    clientName: client?.clientName,
    redirectUri: redirect_uri,
  }).catch(() => {/* ignore */});

  logLoginEvent({
    username: entry.userId,
    eventType: 'oauth_authorized',
    clientName: client?.clientName,
    meta: { client_id },
  }).catch(() => {/* ignore */});

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    // No expiry — token is valid until MCP_AUTH_TOKENS is changed in Railway
    scope: 'mcp',
  });
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
