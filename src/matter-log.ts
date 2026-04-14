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
const MATTER_REF_RE = /^[a-zA-Z0-9\-_\/ ]{1,100}$/;

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

interface SessionMatter {
  ref: string;
  expiresAt: number;
}

const sessionMatterCache = new Map<string, SessionMatter>();

/** Extract a human-readable matter name from tool call context. */
function inferMatterRef(
  queryText: string,
  topResults: Array<{ title: string; citation?: string; url: string }>,
): string {
  // 1. Neutral citation embedded in the query itself (e.g. "[2023] NSWSC 1")
  const queryCite = queryText.match(/^(.{0,70}\[\d{4}\]\s*[A-Z]+\s*\d+)/);
  if (queryCite) return queryCite[1].trim().slice(0, 80);

  // 2. Case-name pattern in the query ("X v Y" or "X v. Y")
  const queryCase = queryText.match(/^([A-Z][a-zA-Z'\-]+(?:\s+[A-Za-z'\-]+)*\s+v\.?\s+[A-Z][a-zA-Z'\-]+(?:\s+[A-Za-z'\-]+)*)/);
  if (queryCase) return queryCase[1].trim().slice(0, 80);

  // 3. AustLII URL in the query — extract court/year/number
  const urlMatch = queryText.match(/\/([a-z]+)\/(\d{4})\/(\d+)\.html?/i);
  if (urlMatch) return `${urlMatch[1].toUpperCase()} ${urlMatch[2]}/${urlMatch[3]}`;

  // 4. Top result title — prefer the first result with a citation embedded
  for (const r of topResults.slice(0, 3)) {
    const titleCite = r.title.match(/^(.{0,70}\[\d{4}\]\s*[A-Z]+\s*\d+)/);
    if (titleCite) return titleCite[1].trim().slice(0, 80);
    // Case name without neutral citation
    const titleCase = r.title.match(/^([A-Z][a-zA-Z'\-]+(?:\s+[A-Za-z'\-]+)*\s+v\.?\s+[A-Z][a-zA-Z'\-]+)/);
    if (titleCase) return titleCase[1].trim().slice(0, 80);
  }

  // 5. Key-term extraction from general query — strip URLs and stop words
  const STOP = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
    'from','is','was','are','were','be','been','have','had','do','does','did',
    'will','would','could','should','may','might','shall','whether','that','this',
    'these','those','what','how','when','where','who','which','any','all','not',
    'if','as','into','about','under','over','between','against','during','after',
    'before','law','court','case','act','section','regarding','concerning',
  ]);
  const words = queryText
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
    .slice(0, 6);

  if (words.length > 0) return words.join(' ').slice(0, 80);

  return 'general-research';
}

/**
 * Resolve the effective matter_ref for a query:
 *  1. Explicit matter_ref from tool input → use as-is
 *  2. DEFAULT_MATTER_REF config → use as-is
 *  3. Session cache (same Mcp-Session-Id) → reuse inferred name from first call
 *  4. Infer from query_text / top_results → cache for session duration
 */
function resolveEffectiveMatterRef(
  providedRef: string | undefined,
  queryText: string,
  topResults: Array<{ title: string; citation?: string; url: string }>,
): string | undefined {
  // Explicit always wins
  const trimmed = providedRef?.trim();
  if (trimmed && validateMatterRef(trimmed)) return trimmed;

  // Configured default
  if (config.DEFAULT_MATTER_REF) return config.DEFAULT_MATTER_REF;

  // Session-scoped inference
  const sessionId = getSessionId();
  if (sessionId) {
    const cached = sessionMatterCache.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) {
      // Refresh TTL on each use so active sessions don't expire mid-research
      cached.expiresAt = Date.now() + SESSION_MATTER_TTL_MS;
      return cached.ref;
    }

    // First untagged call in this session — infer and cache
    const inferred = inferMatterRef(queryText, topResults);
    sessionMatterCache.set(sessionId, { ref: inferred, expiresAt: Date.now() + SESSION_MATTER_TTL_MS });
    logger.info({ sessionId, inferred }, 'matter-log: inferred matter ref for session');
    return inferred;
  }

  // No session ID (e.g. direct API call without MCP session) — infer without caching
  return inferMatterRef(queryText, topResults);
}

// Fire-and-forget: DB failures must never affect tool responses
export function recordMatterQuery(params: MatterLogParams): void {
  const effectiveMatterRef = resolveEffectiveMatterRef(
    params.matter_ref,
    params.query_text,
    params.top_results,
  );
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
