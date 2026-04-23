import { LRUCache } from 'lru-cache';
import { logMatterQuery } from './db.js';
import { config } from './config.js';
import { getUser, getSessionId } from './request-context.js';
import { logger } from './logger.js';

/**
 * Appends a standard support note to tool error messages returned to Claude.
 * Wraps any error string to include the admin contact URL.
 */
export function fmtToolError(msg: string): string {
  return `${msg}\n\nIf this error persists, contact your administrator.`;
}

// matter_ref validation: alphanumeric, hyphens, underscores, slashes, spaces. Max 100 chars.
export const MATTER_REF_RE = /^[a-zA-Z0-9\-_\/ ]{1,100}$/;

export function validateMatterRef(ref: string): boolean {
  return MATTER_REF_RE.test(ref);
}

export interface MatterLogParams {
  /** Explicit matter reference from the tool call. Falls back to DEFAULT_MATTER_REF if absent. */
  matter_ref?: string;
  tool_name: string;
  query_text: string;
  jurisdiction?: string;
  result_count: number;
  top_results: Array<{ title: string; citation?: string; url: string }>;
  /** Total Isaacus API tokens consumed by this tool call. Used for per-matter cost attribution. */
  api_tokens_used?: number;
  /** True if the tool returned an error response. */
  is_error?: boolean;
  /** Human-readable error code or message if is_error is true. */
  error_message?: string;
  /** Top answer confidence score (0–1) from extractive QA tools. Null for non-QA tools. */
  accuracy_score?: number;
}

// ── Session-scoped matter inference ──────────────────────────────────────────
//
// When no matter_ref is provided and no DEFAULT_MATTER_REF is configured, we
// infer a contextual name from the query and cache it for the duration of the
// MCP session (identified by Mcp-Session-Id). All tool calls in the same
// conversation without an explicit matter_ref are grouped under the same name.

const SESSION_MATTER_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — covers a typical work session

const sessionMatterCache = new LRUCache<string, string>({
  max: 10_000,
  ttl: SESSION_MATTER_TTL_MS,
  updateAgeOnGet: true,
});

/**
 * Extract a human-readable matter name from user input (query text only — not results).
 * @internal Exported for unit tests only.
 */
export function inferMatterRef(queryText: string): string {
  const text = queryText.trim();

  // 1. Neutral citation embedded in the query (e.g. "Smith v Jones [2023] NSWSC 1")
  const queryCite = text.match(/^(.{0,70}\[\d{4}\]\s*[A-Z]+\s*\d+)/);
  if (queryCite) return queryCite[1].trim().slice(0, 80);

  // 2. Case-name "X v Y" pattern
  const queryCase = text.match(/^([A-Z][a-zA-Z'\-]+(?:\s+[A-Za-z'\-]+)*\s+v\.?\s+[A-Z][a-zA-Z'\-]+(?:\s+[A-Za-z'\-]+)*)/);
  if (queryCase) return queryCase[1].trim().slice(0, 80);

  // 3. AustLII URL — extract court/year/number
  const urlMatch = text.match(/\/([a-z]+)\/(\d{4})\/(\d+)\.html?/i);
  if (urlMatch) return `${urlMatch[1].toUpperCase()} ${urlMatch[2]}/${urlMatch[3]}`;

  // 4. Proper-noun phrase — consecutive capitalised words (e.g. "Aussie Wool", "Johnson Industries")
  //    Captures up to 3 consecutive capitalised tokens, skipping common sentence-start words.
  const GENERIC_CAPS = new Set(['The','A','An','In','On','At','For','Of','With','By','From','Our','Re','And']);
  const capTokens = text.split(/\s+/);
  const properNounRun: string[] = [];
  for (const tok of capTokens) {
    if (/^[A-Z][a-zA-Z'\-]{1,}$/.test(tok) && !GENERIC_CAPS.has(tok)) {
      properNounRun.push(tok);
      if (properNounRun.length === 3) break;
    } else if (properNounRun.length > 0) {
      break; // run ended
    }
  }
  if (properNounRun.length >= 2) return properNounRun.join(' ');

  // 5. Key-term extraction — first 2 non-stop words from the query
  const STOP = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
    'from','is','was','are','were','be','been','have','had','do','does','did',
    'will','would','could','should','may','might','shall','whether','that','this',
    'these','those','what','how','when','where','who','which','any','all','not',
    'if','as','into','about','under','over','between','against','during','after',
    'before','law','court','case','act','section','regarding','concerning',
  ]);
  const words = text
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
    .slice(0, 3);

  if (words.length > 0) return words.join(' ').slice(0, 80);

  return 'untagged';
}

/**
 * Resolve the effective matter_ref for a query:
 *  1. Explicit matter_ref from tool input → use as-is
 *  2. Session cache (same Mcp-Session-Id) → reuse inferred name from first call in session
 *  3. Infer from query_text (user input only, not results) → cache for session duration
 *  4. DEFAULT_MATTER_REF config → last-resort fallback only
 */
function resolveEffectiveMatterRef(
  providedRef: string | undefined,
  queryText: string,
): string | undefined {
  // Explicit always wins
  const trimmed = providedRef?.trim();
  if (trimmed && validateMatterRef(trimmed)) return trimmed;

  // Session-scoped inference — keeps all untagged calls in a conversation grouped together
  const sessionId = getSessionId();
  if (sessionId) {
    const cached = sessionMatterCache.get(sessionId);
    if (cached !== undefined) return cached;

    // First untagged call in this session — infer from user input and cache
    const inferred = inferMatterRef(queryText);
    sessionMatterCache.set(sessionId, inferred);
    logger.info({ sessionId, inferred }, 'matter-log: inferred matter ref for session');
    return inferred;
  }

  // No session ID (direct API call) — infer without caching
  const inferred = inferMatterRef(queryText);
  if (inferred !== 'untagged') return inferred;

  // Last resort: configured default (e.g. "general-research" for a shared test environment)
  return config.DEFAULT_MATTER_REF;
}

// Fire-and-forget: DB failures must never affect tool responses
export function recordMatterQuery(params: MatterLogParams): void {
  const effectiveMatterRef = resolveEffectiveMatterRef(params.matter_ref, params.query_text);
  if (!effectiveMatterRef || !validateMatterRef(effectiveMatterRef)) return;

  logMatterQuery({
    ...params,
    matter_ref: effectiveMatterRef,
    user_id: getUser(),
  }).catch((err) => logger.warn({ err }, 'Matter query log failed — continuing'));
}

/**
 * Convenience wrapper for recording tool error events.
 * Calls recordMatterQuery with is_error: true, result_count: 0, top_results: [].
 * Fire-and-forget — never throws.
 */
export function recordMatterError(params: {
  matter_ref?: string;
  tool_name: string;
  query_text: string;
  error_message: string;
}): void {
  recordMatterQuery({
    ...params,
    result_count: 0,
    top_results: [],
    is_error: true,
    error_message: params.error_message,
  });
}
