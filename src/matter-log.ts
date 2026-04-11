import { logMatterQuery } from './db.js';
import { getUser } from './request-context.js';
import { logger } from './logger.js';

// matter_ref validation: alphanumeric, hyphens, underscores, slashes, spaces. Max 100 chars.
const MATTER_REF_RE = /^[a-zA-Z0-9\-_\/ ]{1,100}$/;

export function validateMatterRef(ref: string): boolean {
  return MATTER_REF_RE.test(ref);
}

export interface MatterLogParams {
  matter_ref: string;
  tool_name: string;
  query_text: string;
  jurisdiction?: string;
  result_count: number;
  top_results: Array<{ title: string; citation?: string; url: string }>;
}

// Fire-and-forget: DB failures must never affect tool responses
export function recordMatterQuery(params: MatterLogParams): void {
  logMatterQuery({
    ...params,
    user_id: getUser(),
  }).catch((err) => logger.warn({ err }, 'Matter query log failed — continuing'));
}
