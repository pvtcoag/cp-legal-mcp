/**
 * OAuth 2.1 token lifecycle: short-lived JWT access tokens + rotating
 * refresh tokens with family tracking and replay detection.
 *
 * Semantics implemented:
 *  - Access tokens are HS256 JWTs, default 1h. Stateless verification.
 *  - Refresh tokens are opaque random strings; only their SHA-256 hash is
 *    stored. Each RT is single-use: presentation rotates it to a new RT and
 *    marks the previous as `used_at = NOW()`.
 *  - Family tracking: every RT belongs to a `family_id` (initial grant). On
 *    rotation, the new RT inherits the same family_id with `parent_id` set
 *    to the previous row.
 *  - Replay detection: if an already-used RT is presented again, the entire
 *    family is revoked (RFC 6819 §5.2.2.3 / OAuth 2.1 §6.1).
 *  - Inactivity expiry: each RT has its own `expires_at` (default 30d from
 *    issue). Refreshing slides the window forward by issuing a new RT.
 *  - Absolute lifetime cap: the family inherits `family_expires_at` from the
 *    initial grant (default 90d). Once that is reached, no further refreshes
 *    succeed and the user must re-authenticate via browser.
 *  - Revocation: RFC 7009 endpoint deletes-by-marking individual RTs (and
 *    their family on RT presentation).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { signJwt, jwtAvailable, type JwtPayload } from './jwt.js';
import {
  insertRefreshToken,
  getRefreshTokenByHash,
  markRefreshTokenUsed,
  revokeRefreshTokenFamily,
  logLoginEvent,
  type RefreshTokenRow,
} from './db.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function newOpaqueToken(): string {
  // 32 bytes = 256 bits of entropy, base64url-encoded (~43 chars).
  return randomBytes(32).toString('base64url');
}

function issuer(): string {
  return process.env.OAUTH_ISSUER ?? 'https://mcp.example.com/mcp';
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface IssuedTokens {
  /** Access token (JWT) — bearer for /mcp. */
  access_token: string;
  /** Lifetime of the AT in seconds. */
  expires_in: number;
  token_type: 'Bearer';
  /** Refresh token (opaque, present-once). Only returned to the client; the server stores only the hash. */
  refresh_token?: string;
  scope: string;
}

interface IssueParams {
  username: string;
  clientId: string;
  clientName?: string;
  scope?: string;
  /** When provided, the new RT continues this family (rotation). */
  family?: { familyId: string; parentId: number; familyExpiresAt: Date };
}

/**
 * Issue a fresh AT + RT pair. Used for both the initial authorization_code
 * exchange (no `family`) and rotation on refresh_token grant (`family` set).
 */
export async function issueTokens(params: IssueParams): Promise<IssuedTokens> {
  const scope = params.scope ?? 'mcp';
  const now = new Date();
  const atTtlSec = config.OAUTH_AT_TTL_SEC;

  // ── Refresh token ──────────────────────────────────────────────────────────
  let refreshToken: string | undefined;
  let familyId: string;

  if (params.family) {
    familyId = params.family.familyId;
  } else {
    familyId = randomUUID();
  }

  // Family expiry — inherited on rotation, freshly set on initial grant.
  const familyExpiresAt =
    params.family?.familyExpiresAt ??
    new Date(
      now.getTime() +
        (config.OAUTH_RT_FAMILY_MAX_SEC > 0
          ? config.OAUTH_RT_FAMILY_MAX_SEC * 1000
          : 365 * 24 * 3600 * 1000), // hard floor of 1 year if cap disabled
    );

  // Per-RT inactivity expiry, but never beyond the family cap.
  const rtExpiresAt = new Date(
    Math.min(
      now.getTime() + config.OAUTH_RT_TTL_SEC * 1000,
      familyExpiresAt.getTime(),
    ),
  );

  // Only attempt to persist an RT if the DB is available. If DB is disabled,
  // we degrade to AT-only (the token endpoint still works for stateless flows).
  const plaintextRt = newOpaqueToken();
  const rtHash = sha256Hex(plaintextRt);

  const inserted = await insertRefreshToken({
    tokenHash: rtHash,
    familyId,
    parentId: params.family?.parentId ?? null,
    username: params.username,
    clientId: params.clientId,
    clientName: params.clientName ?? null,
    scope,
    expiresAt: rtExpiresAt,
    familyExpiresAt,
  }).catch((err) => {
    logger.error({ err, user: params.username }, 'OAuth: failed to persist refresh token');
    return null;
  });

  if (inserted) {
    refreshToken = plaintextRt;
  }

  // ── Access token ───────────────────────────────────────────────────────────
  const accessToken = mintAccessToken({
    username: params.username,
    clientId: params.clientId,
    scope,
    familyId,
    ttlSec: atTtlSec,
  });

  return {
    access_token: accessToken,
    expires_in: atTtlSec,
    token_type: 'Bearer',
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    scope,
  };
}

function mintAccessToken(params: {
  username: string;
  clientId: string;
  scope: string;
  familyId: string;
  ttlSec: number;
}): string {
  const iss = issuer();
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    iss,
    sub: params.username,
    aud: iss,
    client_id: params.clientId,
    scope: params.scope,
    jti: randomUUID(),
    iat: now,
    exp: now + params.ttlSec,
    fid: params.familyId,
  };
  return signJwt(payload);
}

export interface RefreshOutcome {
  ok: boolean;
  tokens?: IssuedTokens;
  /** RFC 6749 error code when ok=false. */
  error?: 'invalid_grant' | 'server_error';
  /** Human-readable description for the OAuth error response. */
  error_description?: string;
}

/**
 * Validate a presented refresh_token, rotate it, and return new tokens.
 * Detects replay (RT already used) and revokes the family on detection.
 */
export async function rotateRefreshToken(
  presented: string,
  presentedClientId: string,
): Promise<RefreshOutcome> {
  if (!jwtAvailable()) {
    return { ok: false, error: 'server_error', error_description: 'JWT signing key not configured' };
  }

  const hash = sha256Hex(presented);
  const row: RefreshTokenRow | null = await getRefreshTokenByHash(hash).catch(() => null);

  if (!row) {
    return { ok: false, error: 'invalid_grant', error_description: 'Unknown refresh_token' };
  }

  // Client binding — the RT is bound to the client_id it was issued for.
  if (row.client_id !== presentedClientId) {
    logger.warn(
      { user: row.username, expected: row.client_id, got: presentedClientId },
      'OAuth: refresh_token client_id mismatch — revoking family',
    );
    await revokeFamilyAndAudit(row, 'client_id_mismatch');
    return { ok: false, error: 'invalid_grant', error_description: 'client_id mismatch on refresh' };
  }

  // Replay detection: a used RT must never be accepted again.
  if (row.used_at !== null) {
    logger.warn({ user: row.username, family: row.family_id }, 'OAuth: refresh_token replay detected — revoking family');
    await revokeFamilyAndAudit(row, 'replay_detected');
    return { ok: false, error: 'invalid_grant', error_description: 'Refresh token replay detected — family revoked' };
  }

  if (row.revoked_at !== null) {
    return { ok: false, error: 'invalid_grant', error_description: 'Refresh token revoked' };
  }

  const now = new Date();
  if (new Date(row.expires_at) <= now) {
    return { ok: false, error: 'invalid_grant', error_description: 'Refresh token expired (inactivity)' };
  }
  if (new Date(row.family_expires_at) <= now) {
    // Mark the family revoked so future presentations of any sibling get a clean error.
    await revokeFamilyAndAudit(row, 'family_lifetime_cap');
    return { ok: false, error: 'invalid_grant', error_description: 'Refresh token family lifetime cap reached — please re-authenticate' };
  }

  // Atomically mark the RT used. If another concurrent request already used it,
  // markRefreshTokenUsed returns false → that's a race we treat as replay.
  const claimed = await markRefreshTokenUsed(row.id);
  if (!claimed) {
    logger.warn({ user: row.username, family: row.family_id }, 'OAuth: concurrent refresh_token use — revoking family');
    await revokeFamilyAndAudit(row, 'concurrent_use');
    return { ok: false, error: 'invalid_grant', error_description: 'Refresh token already used — family revoked' };
  }

  // Issue the rotated pair.
  const tokens = await issueTokens({
    username: row.username,
    clientId: row.client_id,
    clientName: row.client_name ?? undefined,
    scope: row.scope,
    family: {
      familyId: row.family_id,
      parentId: row.id,
      familyExpiresAt: new Date(row.family_expires_at),
    },
  });

  logLoginEvent({
    username: row.username,
    eventType: 'oauth_token_refreshed',
    clientName: row.client_name ?? undefined,
    meta: { client_id: row.client_id, family_id: row.family_id, parent_rt_id: row.id },
  }).catch(() => {/* fire-and-forget */});

  return { ok: true, tokens };
}

async function revokeFamilyAndAudit(row: RefreshTokenRow, reason: string): Promise<void> {
  const count = await revokeRefreshTokenFamily(row.family_id, reason).catch(() => 0);
  logLoginEvent({
    username: row.username,
    eventType: 'oauth_family_revoked',
    clientName: row.client_name ?? undefined,
    meta: { client_id: row.client_id, family_id: row.family_id, reason, revoked_count: count },
  }).catch(() => {/* fire-and-forget */});
}

/** Look up an RT for /oauth/revoke or /oauth/introspect. */
export async function findRefreshToken(presented: string): Promise<RefreshTokenRow | null> {
  return getRefreshTokenByHash(sha256Hex(presented)).catch(() => null);
}

/** Hash an opaque RT plaintext using the same algorithm the store uses. */
export function hashRefreshToken(presented: string): string {
  return sha256Hex(presented);
}
