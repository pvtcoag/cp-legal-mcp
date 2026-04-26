/**
 * Minimal HS256 JWT sign/verify, dependency-free (node:crypto).
 *
 * Used to issue short-lived OAuth access tokens. We deliberately do not pull a
 * full JWT library — HS256 is ~30 lines of code and the surface area we need
 * is tiny: sign / verify / decode.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

export interface JwtPayload {
  iss: string;
  sub: string;            // username
  aud: string;            // resource (issuer base)
  client_id: string;
  scope: string;
  jti: string;
  iat: number;            // seconds
  exp: number;            // seconds
  /** Refresh-token family ID this AT was issued under (for audit / introspection). */
  fid?: string;
}

const HEADER_B64 = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'v1' }));

/** Resolve the signing key from config, with fallbacks. Returns null if none set. */
export function jwtSigningKey(): string | null {
  const key = (config.JWT_SIGNING_KEY ?? config.SESSION_SECRET ?? config.ENCRYPTION_KEY ?? '').trim();
  if (!key || key.length < 32) {
    return null;
  }
  return key;
}

export function jwtAvailable(): boolean {
  return jwtSigningKey() !== null;
}

export function signJwt(payload: JwtPayload): string {
  const key = jwtSigningKey();
  if (!key) throw new Error('JWT signing key not configured (set JWT_SIGNING_KEY or SESSION_SECRET, ≥32 chars)');
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${HEADER_B64}.${body}`;
  const sig = createHmac('sha256', key).update(signingInput).digest();
  return `${signingInput}.${b64urlBuf(sig)}`;
}

export interface VerifyResult {
  ok: boolean;
  payload?: JwtPayload;
  reason?: 'malformed' | 'bad_signature' | 'expired' | 'unsupported_alg' | 'no_key';
}

export function verifyJwt(token: string): VerifyResult {
  const key = jwtSigningKey();
  if (!key) return { ok: false, reason: 'no_key' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerB64, bodyB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  try { header = JSON.parse(b64urlDecode(headerB64).toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (header.alg !== 'HS256') return { ok: false, reason: 'unsupported_alg' };

  const expected = createHmac('sha256', key).update(`${headerB64}.${bodyB64}`).digest();
  let presented: Buffer;
  try { presented = b64urlDecode(sigB64); } catch { return { ok: false, reason: 'malformed' }; }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: JwtPayload;
  try { payload = JSON.parse(b64urlDecode(bodyB64).toString('utf8')) as JwtPayload; } catch { return { ok: false, reason: 'malformed' }; }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}

/** Decode without verifying — for introspection / debugging only. */
export function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1]!).toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
}

/** Heuristic: does this look like a JWT we issued (3 dot-separated b64url parts)? */
export function looksLikeJwt(token: string): boolean {
  if (token.length < 20 || token.length > 4096) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  return /^[A-Za-z0-9_-]+$/.test(parts[0]!) && /^[A-Za-z0-9_-]+$/.test(parts[1]!) && /^[A-Za-z0-9_-]+$/.test(parts[2]!);
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function b64urlBuf(b: Buffer): string {
  return b.toString('base64url');
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** One-time warning at startup if no signing key is configured. */
export function warnIfNoSigningKey(): void {
  if (!jwtAvailable()) {
    logger.warn(
      'OAuth: no JWT signing key configured (JWT_SIGNING_KEY / SESSION_SECRET / ENCRYPTION_KEY all unset or <32 chars). ' +
      '/oauth/token will fall back to legacy long-lived bearer. Set JWT_SIGNING_KEY to enable short-lived JWT access tokens.',
    );
  }
}
