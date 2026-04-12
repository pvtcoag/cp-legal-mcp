import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Generate a new random API token. Returns the plaintext token (show once). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash a token for storage. Returns { salt, hash } both as hex strings. */
export function hashToken(token: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(token, salt, 64).toString('hex');
  return { salt, hash };
}

/** Verify a token against stored salt+hash. */
export function verifyToken(token: string, salt: string, storedHash: string): boolean {
  try {
    const hash = scryptSync(token, salt, 64);
    const stored = Buffer.from(storedHash, 'hex');
    return hash.length === stored.length && timingSafeEqual(hash, stored);
  } catch { return false; }
}
