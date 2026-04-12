import { logMatterQuery } from './db.js';
import { config } from './config.js';
import { getUser } from './request-context.js';
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

// Fire-and-forget: DB failures must never affect tool responses
export function recordMatterQuery(params: MatterLogParams): void {
  const effectiveMatterRef = params.matter_ref?.trim() || config.DEFAULT_MATTER_REF;
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
