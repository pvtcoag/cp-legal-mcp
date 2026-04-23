import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, type KeysetCursor, type OffsetCursor } from '../src/pagination.js';

describe('pagination cursor helpers', () => {
  it('round-trips a keyset cursor', () => {
    const original: KeysetCursor = { last_created_at: '2026-04-24T00:00:00.000Z', last_id: 42 };
    const encoded = encodeCursor(original);
    expect(typeof encoded).toBe('string');
    const decoded = decodeCursor<KeysetCursor>(encoded);
    expect(decoded).toEqual(original);
  });

  it('round-trips an offset cursor', () => {
    const original: OffsetCursor = { offset: 100 };
    const encoded = encodeCursor(original);
    const decoded = decodeCursor<OffsetCursor>(encoded);
    expect(decoded).toEqual(original);
  });

  it('produces url-safe (base64url) output with no padding chars', () => {
    const encoded = encodeCursor({ last_created_at: 'a'.repeat(50), last_id: 99 });
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('returns undefined for undefined input', () => {
    expect(decodeCursor<KeysetCursor>(undefined)).toBeUndefined();
  });

  it('returns undefined for garbage cursor strings (no throw)', () => {
    expect(decodeCursor<KeysetCursor>('not-a-valid-cursor')).toBeUndefined();
    expect(decodeCursor<KeysetCursor>('')).toBeUndefined();
    // valid base64url but not JSON
    const notJson = Buffer.from('hello world').toString('base64url');
    expect(decodeCursor<KeysetCursor>(notJson)).toBeUndefined();
    // valid base64url + JSON but not an object (e.g. a bare number)
    const scalar = Buffer.from('42').toString('base64url');
    expect(decodeCursor<KeysetCursor>(scalar)).toBeUndefined();
  });
});
