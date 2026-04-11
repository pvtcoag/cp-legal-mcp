import { logMatterQuery } from './db.js';
import { config } from './config.js';
import { getUser } from './request-context.js';
import { logger } from './logger.js';

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
