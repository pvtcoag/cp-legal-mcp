/**
 * Opaque cursor helpers for list-returning tools.
 *
 * Cursors are base64url-encoded JSON payloads. Callers treat the string as
 * opaque — the shape of the payload is an internal contract between a tool
 * and itself across paginated calls.
 *
 * Two cursor shapes are used by this codebase:
 *   - OffsetCursor:  { offset } — for tools where pagination is implemented
 *                    by over-fetching and client-side slicing.
 *   - KeysetCursor:  { last_created_at, last_id } — for DB-backed tools
 *                    that can use `(created_at, id) < (last, last)` keyset
 *                    pagination for stable ordering under concurrent writes.
 *
 * Decoding is forgiving: a corrupt / non-JSON / non-base64url cursor is
 * treated as "no cursor" (returns undefined) rather than failing the call.
 * This means an agent that passes a stale cursor after the data has rotated
 * silently restarts from the top rather than seeing a hard error.
 */

export interface OffsetCursor {
  offset: number;
}

export interface KeysetCursor {
  /** ISO-8601 timestamp of the last row in the previous page. */
  last_created_at: string;
  /** Primary key of the last row in the previous page. Disambiguates ties. */
  last_id: number;
}

export function encodeCursor(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor<T>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as T;
    return undefined;
  } catch {
    return undefined;
  }
}
