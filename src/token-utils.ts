import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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

// ── Symmetric encryption for plaintext token storage ─────────────────────────
// Uses AES-256-GCM. The encryption key is derived from ENCRYPTION_KEY via SHA-256
// so any key length works. Stored format: "iv_hex:tag_hex:ciphertext_hex".

function deriveAesKey(encryptionKey: string): Buffer {
  return createHash('sha256').update(encryptionKey).digest();
}

/**
 * Encrypt a plaintext token for storage in the DB.
 * Requires ENCRYPTION_KEY to be set.
 */
export function encryptToken(token: string, encryptionKey: string): string {
  const key = deriveAesKey(encryptionKey);
  const iv = randomBytes(12); // 96-bit IV — standard for AES-GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypt a token stored by encryptToken.
 * Throws if the format is invalid or authentication fails (tampered ciphertext).
 */
export function decryptToken(encrypted: string, encryptionKey: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const key = deriveAesKey(encryptionKey);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}
