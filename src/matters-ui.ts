/**
 * Matter History UI — read-only web interface at /matters
 *
 * Auth:       Cookie session (username + token from MCP_AUTH_TOKENS, 8h TTL)
 * Visibility: Admins (ADMIN_USERS) see all matters + dashboard.
 *             All others see their own matters (+ unattributed queries).
 *
 * Multi-researcher note: independent researchers tagging the same matter_ref
 * from separate chats are each attributed by their own user_id and all linked
 * to the matter. Shared/collaborative Claude.ai chats use the chat owner's
 * OAuth token, so all queries in that session appear under one user_id.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  isDbEnabled,
  listMatters,
  listMattersForUser,
  getMatterHistory,
  getMatterHistoryCount,
  getDashboardStats,
  getToolUsageStats,
  getUserStats,
  getRecentActivity,
  getPopularCases,
  getErrorStats,
  getAggregateAccuracy,
  getDashboardCostByTool,
  getUserByUsername,
  updateUserLastActive,
  logLoginEvent,
  getMatter,
  upsertMatter,
  getDailyQueryVolume,
  searchQueries,
  listUsers,
  getMonthlySpendUsd,
  getAppConfig,
  getMattersBillingExport,
  type MatterSummaryRow,
  type MatterHistoryRow,
  type DashboardStats,
  type ToolUsageStat,
  type UserStatRow,
  type PopularCaseRow,
  type ErrorStatRow,
  type ToolTokenStat,
  type DailyQueryCount,
  type SearchResult,
  type UserRow,
} from './db.js';
import { verifyToken } from './token-utils.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { getGeoForIp } from './geo.js';

export const mattersRouter = Router();

/** Extract the real client IP from X-Forwarded-For (leftmost = client).
 *  Falls back to req.ip if the header is absent (local dev). */
export function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.ip ?? '';
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const COOKIE = 'cvn_matters';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const TOOL_LABELS: Record<string, string> = {
  // Case research
  research_cases:             'Case Research',
  search_by_citation:         'Citation Search',
  find_citing_cases:          'Citing Cases',
  find_related_cases:         'Related Cases',
  // Judgment analysis
  get_judgment:               'Judgment',
  ask_judgment:               'Ask Judgment',
  enrich_judgment:            'Enrich Judgment',
  summarise_judgment:         'Summarise',
  compare_cases:              'Compare Cases',
  // Legislation
  research_legislation:       'Legislation Research',
  get_legislation:            'Legislation',
  ask_legislation:            'Ask Legislation',    // legacy — merged into get_legislation
  // Classification & citation
  classify_legal_issue:       'Classify Issue',
  format_citation:            'Format Citation',
  generate_pinpoint:          'Pinpoint',           // legacy — merged into format_citation
  // Entity intelligence
  lookup_entity:              'Entity Lookup',
  lookup_entities_bulk:       'Bulk Entity Lookup',
  // Regulatory & market intelligence
  search_regulatory_decisions:'Regulatory Decisions',
  search_asx_announcements:   'ASX Announcements',
  // Matter
  get_matter_history:         'Matter History',
  build_chronology:           'Chronology',
  draft_research_memo:        'Research Memo',
  check_deadlines:            'Deadlines',
  check_limitation_period:    'Limitation Period',
  check_filing_deadline:      'Filing Deadline',
  monitor_precedents:         'Precedent Monitor',
  // Admin
  inspect_database:           'Inspect DB',
};

// ── Cost helpers ──────────────────────────────────────────────────────────────

/**
 * Per-tool Isaacus cost rates (USD per 1M input tokens).
 * Kanon 2 Enricher       = $3.50/1M  ($0.0000035/token)
 * Kanon Answer Extractor = $1.50/1M  ($0.0000015/token)
 * Kanon Universal Classifier (reranking/classification) = $1.00/1M ($0.000001/token)
 *
 * summarise_judgment blended: 1× Enricher ($3.50) + 5× QA ($1.50×5=$7.50) = $11.00
 * across 6 calls each processing the same doc → total_tokens = 6× doc_tokens
 * → $11.00 / 6 = $1.833/M stored tokens
 */
const TOOL_COST_RATES: Record<string, number> = {
  // Kanon Answer Extractor — $1.50/1M
  ask_judgment:               1.50,
  ask_legislation:            1.50,  // legacy
  compare_cases:              1.50,
  get_legislation:            1.50,  // QA mode uses extractAnswer; pure-retrieval calls log 0 tokens so cost = 0
  draft_research_memo:        1.50,  // when with_case_analysis: true; default mode logs 0 tokens

  // Kanon 2 Enricher — $3.50/1M
  enrich_judgment:            3.50,
  build_chronology:           3.50,

  // blended: 1× Enricher ($3.50) + 5× QA ($1.50) across 6 API calls = $1.833/M stored tokens
  summarise_judgment:         1.833,

  // Kanon Universal Classifier — $1.00/1M
  // classify_legal_issue now runs 3× classifier calls; total tokens logged = sum of all 3,
  // rate remains $1.00/1M since all calls use the same model.
  research_cases:             1.00,
  research_legislation:       1.00,
  search_by_citation:         1.00,
  find_citing_cases:          1.00,
  find_related_cases:         1.00,
  classify_legal_issue:       1.00,

  // No Isaacus calls — cost is 0 (api_tokens_used will always be 0)
  get_judgment:               0,
  format_citation:            0,
  generate_pinpoint:          0,   // legacy
  get_matter_history:         0,
  lookup_entity:              0,
  lookup_entities_bulk:       0,
  search_regulatory_decisions:0,
  search_asx_announcements:   0,
  check_deadlines:            0,
  check_limitation_period:    0,
  check_filing_deadline:      0,
  monitor_precedents:         0,
  inspect_database:           0,
};

function toolCostRate(toolName: string): number {
  return TOOL_COST_RATES[toolName] ?? 1.25; // conservative default for unknown tools
}

/** Format a dollar amount with enough precision to be meaningful. */
function fmtCostValue(cost: number): string {
  if (cost === 0) return '—';
  if (cost >= 10)   return `$${cost.toFixed(2)}`;
  if (cost >= 1)    return `$${cost.toFixed(4)}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  if (cost >= 0.0001) return `$${cost.toFixed(6)}`;
  return `$${cost.toExponential(2)}`;
}

/** Estimated Isaacus API cost for a given token count, using per-tool rate if provided. */
function estCost(tokens: number, toolName?: string): string {
  if (!tokens) return '—';
  const ratePerM = toolName !== undefined ? toolCostRate(toolName) : 1.25;
  if (ratePerM === 0) return '—';
  const cost = (tokens / 1_000_000) * ratePerM;
  return fmtCostValue(cost);
}

// Approximate USD → AUD conversion rate (update periodically).
const AUD_PER_USD = 1.57;

/** Format a USD cost with AUD equivalent for use in total displays. */
function fmtCostUsdAud(usd: number): { usd: string; aud: string } {
  return {
    usd: fmtCostValue(usd),
    aud: usd > 0 ? fmtCostValue(usd * AUD_PER_USD) : '—',
  };
}

/** Compute accurate total cost for a set of history rows using per-tool rates. */
function computeMatterCost(rows: MatterHistoryRow[]): { usd: string; aud: string } {
  const total = rows.reduce((sum, r) => {
    const tokens = r.api_tokens_used ?? 0;
    const rate = toolCostRate(r.tool_name);
    return sum + (tokens / 1_000_000) * rate;
  }, 0);
  return fmtCostUsdAud(total);
}

/** Compute accurate total cost from per-tool token aggregates (for dashboard). */
function computeDashboardCost(byTool: ToolTokenStat[]): { usd: string; aud: string } {
  const total = byTool.reduce((sum, { tool_name, total_tokens }) => {
    const rate = toolCostRate(tool_name);
    return sum + (total_tokens / 1_000_000) * rate;
  }, 0);
  return fmtCostUsdAud(total);
}

interface MonthlyBillingEntry {
  month: string;
  tool_name: string;
  queries: number;
  tokens: number;
  cost_usd: number;
  cost_aud: number;
}

function computeMonthlyBilling(rows: MatterHistoryRow[]): {
  monthly: MonthlyBillingEntry[];
  grandTotal: { queries: number; tokens: number; cost_usd: number; cost_aud: number };
} {
  // ordered month → tool map
  const monthOrder: string[] = [];
  const monthToolMap = new Map<string, Map<string, MonthlyBillingEntry>>();

  for (const r of [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())) {
    const month = new Date(r.created_at).toLocaleDateString('en-AU', {
      month: 'short', year: 'numeric', timeZone: 'Australia/Sydney',
    });
    if (!monthToolMap.has(month)) { monthToolMap.set(month, new Map()); monthOrder.push(month); }
    const toolMap = monthToolMap.get(month)!;
    if (!toolMap.has(r.tool_name)) {
      toolMap.set(r.tool_name, { month, tool_name: r.tool_name, queries: 0, tokens: 0, cost_usd: 0, cost_aud: 0 });
    }
    const entry = toolMap.get(r.tool_name)!;
    const tokens = r.api_tokens_used ?? 0;
    const cost = (tokens / 1_000_000) * (TOOL_COST_RATES[r.tool_name] ?? 1.25);
    entry.queries++;
    entry.tokens += tokens;
    entry.cost_usd += cost;
    entry.cost_aud += cost * AUD_PER_USD;
  }

  const monthly: MonthlyBillingEntry[] = [];
  for (const month of monthOrder) {
    for (const entry of monthToolMap.get(month)!.values()) monthly.push(entry);
  }

  const grandTotal = monthly.reduce(
    (acc, r) => ({ queries: acc.queries + r.queries, tokens: acc.tokens + r.tokens, cost_usd: acc.cost_usd + r.cost_usd, cost_aud: acc.cost_aud + r.cost_aud }),
    { queries: 0, tokens: 0, cost_usd: 0, cost_aud: 0 },
  );

  return { monthly, grandTotal };
}

function fmtTokens(n: number): string {
  if (!n || n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return String(n);
}

/**
 * Accuracy score badge for Isaacus extractive QA confidence.
 * Legal text scores are typically 5–40%. Thresholds are calibrated for legal extraction:
 * green ≥45% (clear answer), amber ≥20% (probable), red <20% (uncertain/not extractable).
 */
function accuracyBadge(score: number | null | undefined): string {
  if (score == null) return '<span style="color:var(--txt-3)">—</span>';
  const pct = Math.round(score * 100);
  const cls = score >= 0.45 ? 'acc-high' : score >= 0.20 ? 'acc-mid' : 'acc-low';
  return `<span class="acc-badge ${cls} tip" data-tip="Extractive confidence: ${pct}%. Legal text typically scores 5–45% — reflects extractability, not correctness." tabindex="0">${pct}%</span>`;
}

// ── Session ───────────────────────────────────────────────────────────────────

export function sessionSecret(): string {
  const secret = process.env['SESSION_SECRET'] ?? process.env['MCP_AUTH_TOKENS'];
  if (!secret) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('SESSION_SECRET or MCP_AUTH_TOKENS must be set in production');
    }
    // Development only — random per restart, sessions don't survive
    return Math.random().toString(36).repeat(4);
  }
  return secret;
}

/** Session payload: `username:isAdmin:sessionVersion:exp:sig` where isAdmin is '1' or '0'. */
export function signSession(user: string, isAdminUser: boolean, sessionVersion = 0): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${user}:${isAdminUser ? '1' : '0'}:${sessionVersion}:${exp}`;
  const sig = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}:${sig}`;
}

export interface SessionData { user: string; isAdmin: boolean; sessionVersion: number; }

// ── Session version cache ─────────────────────────────────────────────────────

let sessionVersionCache: Map<string, number> = new Map();

export function buildSessionVersionCache(users: UserRow[]): void {
  sessionVersionCache = new Map(users.map((u) => [u.username, u.session_version ?? 0]));
}

export function verifySession(value: string): SessionData | null {
  const lastColon = value.lastIndexOf(':');
  if (lastColon < 0) return null;
  const payload = value.slice(0, lastColon);
  const sig = value.slice(lastColon + 1);

  // Payload format: username:isAdmin:sessionVersion:exp
  // Also support legacy 3-part: username:isAdmin:exp
  const parts = payload.split(':');
  if (parts.length < 3) return null;

  let user: string;
  let adminFlag: string;
  let sessionVersion: number;
  let exp: number;

  if (parts.length >= 4) {
    // New format: username:isAdmin:sessionVersion:exp
    // (username itself may contain colons, so work from the right)
    const expStr = parts[parts.length - 1]!;
    const svStr = parts[parts.length - 2]!;
    adminFlag = parts[parts.length - 3]!;
    user = parts.slice(0, parts.length - 3).join(':');
    exp = parseInt(expStr, 10);
    sessionVersion = parseInt(svStr, 10);
  } else {
    // Legacy 3-part: username:isAdmin:exp
    const expStr = parts[parts.length - 1]!;
    adminFlag = parts[parts.length - 2]!;
    user = parts.slice(0, parts.length - 2).join(':');
    exp = parseInt(expStr, 10);
    sessionVersion = 0;
  }

  if (!user || isNaN(exp) || Date.now() > exp) return null;
  const isAdminUser = adminFlag === '1';

  const expected = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  try {
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch { return null; }

  // Check session version against cache (invalidates old sessions after force-logout)
  const cachedVersion = sessionVersionCache.get(user);
  if (cachedVersion !== undefined && sessionVersion < cachedVersion) return null;

  return { user, isAdmin: isAdminUser, sessionVersion };
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const rawVal = part.slice(eq + 1).trim();
    let val = rawVal;
    try { val = decodeURIComponent(rawVal); } catch { /* malformed % sequence — use raw value */ }
    out[part.slice(0, eq).trim()] = val;
  }
  return out;
}

function getSessionData(req: Request): SessionData | null {
  const raw = parseCookies(req)[COOKIE];
  return raw ? verifySession(raw) : null;
}

function getSessionUser(req: Request): string | null {
  return getSessionData(req)?.user ?? null;
}

function getSessionIsAdmin(req: Request): boolean {
  return getSessionData(req)?.isAdmin ?? false;
}

function setSessionCookie(res: Response, user: string, isAdminUser: boolean): void {
  const sv = sessionVersionCache.get(user) ?? 0;
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(signSession(user, isAdminUser, sv))}; HttpOnly; Secure; SameSite=Strict; Path=/mcp; Max-Age=${8 * 3600}`);
}

function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie',
    `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/mcp; Max-Age=0`);
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function adminUsersFromEnv(): Set<string> {
  return new Set(config.ADMIN_USERS.split(',').map((u) => u.trim().toLowerCase()).filter(Boolean));
}

/** Parse client name from User-Agent string. */
export function parseClientName(ua?: string): string {
  if (!ua) return 'Unknown';
  if (/ClaudeDesktop/i.test(ua)) return 'Claude Desktop';
  if (/claude\.ai/i.test(ua)) return 'Claude Web';
  if (/ChatGPT/i.test(ua) || /openai/i.test(ua)) return 'ChatGPT';
  if (/cursor/i.test(ua)) return 'Cursor';
  if (/mcp-remote/i.test(ua)) return 'mcp-remote';
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Edg\//.test(ua)) return 'Edge';
  return 'Browser';
}

function getEnvCredentials(): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (process.env['MCP_AUTH_TOKENS'] ?? '').split(',')) {
    const colon = pair.indexOf(':');
    if (colon < 1) continue;
    const u = pair.slice(0, colon).trim().toLowerCase();
    const t = pair.slice(colon + 1).trim();
    if (u && t) map.set(u, t);
  }
  return map;
}

/**
 * Validate username + token against DB first, then env var fallback.
 * Returns isAdmin status if valid, null if invalid.
 */
async function validateCredentials(username: string, token: string): Promise<{ isAdmin: boolean } | null> {
  // Try DB first
  const dbUser = await getUserByUsername(username).catch(() => null);
  if (dbUser) {
    if (!dbUser.is_active) return null;
    if (verifyToken(token, dbUser.token_salt, dbUser.token_hash)) {
      return { isAdmin: dbUser.is_admin };
    }
    return null;
  }
  // Fall back to env var
  const creds = getEnvCredentials();
  const expected = creds.get(username);
  if (!expected) return null;
  let ok = false;
  if (expected.length === token.length) {
    try { ok = timingSafeEqual(Buffer.from(token), Buffer.from(expected)); } catch { /* */ }
  }
  if (!ok) return null;
  return { isAdmin: adminUsersFromEnv().has(username) };
}

function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!getSessionUser(req)) {
    res.redirect(`/mcp/matters/login?next=${encodeURIComponent(req.path)}`);
    return;
  }
  next();
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ');
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Australia/Sydney',
  });
}

/** Wrap a date in a <time data-utc> element so client JS can reformat to device timezone. */
function tsDate(iso: string): string {
  return `<time data-utc="${esc(iso)}">${fmtDate(iso)}</time>`;
}

/** Wrap a datetime in a <time data-utc data-fmt="datetime"> element for client-side timezone reformat. */
function tsDateTime(iso: string): string {
  return `<time data-utc="${esc(iso)}" data-fmt="datetime">${fmtDateTime(iso)}</time>`;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

// CSS and shell template extracted to src/matters-ui-templates.ts.
// Re-exported here so admin-ui.ts and other callers keep importing from this module.
export { CSS, LOGO_SRC, renderMattersShell } from './matters-ui-templates.js';
import { renderMattersShell as _renderMattersShell, LOGO_SRC } from './matters-ui-templates.js';

/** No-cache middleware — prevents Cloudflare and browsers from serving stale matter pages. */
function noCache(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
}

export function page(
  title: string,
  body: string,
  user: string | null,
  activePath?: string,
  _printButton?: string,
  isAdminUser?: boolean,
): string {
  return _renderMattersShell({ title, body, user, activePath, isAdminUser });
}

// ── Shared render helpers ─────────────────────────────────────────────────────

function renderToolChart(stats: ToolUsageStat[]): string {
  if (stats.length === 0) return '';
  const max = stats[0]!.query_count;
  const bars = stats.map((s) => {
    const pct = max > 0 ? Math.round((s.query_count / max) * 100) : 0;
    const costStr = estCost(s.total_tokens, s.tool_name);
    return `<div class="tool-bar-row">
      <div class="tool-bar-label">${esc(toolLabel(s.tool_name))}</div>
      <div class="tool-bar-track"><div class="tool-bar-fill" style="width:${pct}%"></div></div>
      <div class="tool-bar-meta">${s.query_count} queries · ${costStr !== '—' ? costStr + ' USD' : '—'}</div>
    </div>`;
  }).join('');
  return `<div class="section-block no-print"><h2>Tool Usage</h2>${bars}</div>`;
}

function renderResearcherCards(users: UserStatRow[]): string {
  if (users.length === 0) return '';
  const cards = users.map((u) => `
    <div class="researcher-card">
      <div class="researcher-name">${esc(u.user_id ?? 'Unattributed')}</div>
      <div class="researcher-stats">
        <span>${u.query_count} queries across ${u.matter_count} matter${u.matter_count !== 1 ? 's' : ''}</span>
        <span>${fmtTokens(u.total_tokens)} tokens</span>
        <span>Last active ${tsDate(u.last_activity)}</span>
      </div>
    </div>`).join('');
  return `<div class="section-block no-print"><h2>Researchers</h2><div class="researcher-grid">${cards}</div></div>`;
}

function renderPopularCases(cases: PopularCaseRow[]): string {
  if (cases.length === 0) return '';
  const rows = cases.map((c, i) => `
    <div class="popular-case-row">
      <span class="popular-case-rank">${i + 1}.</span>
      <span class="popular-case-title">
        <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title ?? c.url)}</a>
      </span>
      ${c.citation ? `<span class="popular-case-citation">${esc(c.citation)}</span>` : ''}
      <span class="popular-case-count">${c.mention_count}×</span>
    </div>`).join('');
  return `<div class="section-block no-print"><h2>Most Referenced Cases</h2>${rows}</div>`;
}

function renderErrorStats(stats: ErrorStatRow[]): string {
  if (stats.length === 0) {
    return `<div class="section-block no-print"><h2>Error Rates by Tool</h2>
      <p style="color:var(--txt-3);font-size:.8125rem;padding:.25rem 0">No errors recorded.</p>
    </div>`;
  }
  const rows = stats.map((s) => `<tr>
    <td>${esc(toolLabel(s.tool_name))}</td>
    <td style="text-align:right">${s.total_queries}</td>
    <td style="text-align:right">${s.error_count}</td>
    <td style="text-align:right">${s.error_rate_pct}%</td>
  </tr>`).join('');
  return `<div class="section-block no-print"><h2>Error Rates by Tool</h2>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Tool</th>
        <th style="text-align:right">Total Queries</th>
        <th style="text-align:right">Errors</th>
        <th style="text-align:right">Error Rate</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function renderQueryVolumeChart(data: DailyQueryCount[]): string {
  if (data.length === 0) return '';
  const max = Math.max(...data.map((d) => d.count), 1);
  const bars = data.map((d) => {
    const pct = Math.round((d.count / max) * 100);
    const label = new Date(d.day).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
    return `<div class="vol-col" title="${esc(label)}: ${d.count} quer${d.count === 1 ? 'y' : 'ies'}">
      <div class="vol-bar" style="height:${pct}%"></div>
      <div class="vol-label">${esc(label.split(' ')[0]!)}</div>
    </div>`;
  }).join('');
  return `<div class="section-block no-print">
    <h2>Query Volume — Last ${data.length} Days</h2>
    <div class="vol-chart">${bars}</div>
  </div>`;
}

function renderDashboardCards(
  stats: DashboardStats,
  costByTool: ToolTokenStat[],
  avgAccuracy: number | null,
): string {
  const accuracyHtml = avgAccuracy != null
    ? `<div class="card">
        <div class="card-label">Avg Extraction Accuracy
          <span class="tip tip-below" data-tip="Isaacus Kanon Answer Extractor confidence. Legal text typically scores 5–45% — this reflects extractability, not whether the answer is correct." tabindex="0" style="color:var(--txt-3);margin-left:.25rem">ⓘ</span>
        </div>
        <div class="card-value sm">${accuracyBadge(avgAccuracy)}</div>
        <div class="card-sub">across QA-capable tools</div>
      </div>`
    : '';
  return `<div class="summary-grid">
    <div class="card">
      <div class="card-label">Total Matters</div>
      <div class="card-value">${stats.total_matters}</div>
      <div class="card-sub">${stats.active_matters_30d} active in 30 days</div>
    </div>
    <div class="card">
      <div class="card-label">Total Queries</div>
      <div class="card-value">${stats.total_queries.toLocaleString('en-AU')}</div>
    </div>
    <div class="card">
      <div class="card-label">API Tokens Used</div>
      <div class="card-value">${fmtTokens(stats.total_tokens)}</div>
    </div>
    <div class="card">
      <div class="card-label">Est. Isaacus Cost <span class="est-badge tip tip-below" data-tip="Per-tool rates: Enricher $3.50/1M, Answer Extractor $1.50/1M, Classifier $1.00/1M (USD). Excludes Railway infrastructure." tabindex="0">est</span></div>
      ${(() => { const c = computeDashboardCost(costByTool); return `<div class="card-value sm">${c.usd} <span style="font-size:.75rem;color:var(--txt-3)">USD</span></div><div class="card-sub">≈ ${c.aud} AUD · per-tool rates</div>`; })()}
    </div>
    ${accuracyHtml}
  </div>`;
}

function renderFilterBar(params: {
  search?: string; from?: string; to?: string; viewUser?: string; allUsers: string[]; isAdmin: boolean; action: string;
}): string {
  const userOptions = params.isAdmin
    ? `<option value="">All Users</option>` +
      params.allUsers.map((u) => `<option value="${esc(u)}"${params.viewUser === u ? ' selected' : ''}>${esc(u)}</option>`).join('')
    : '';
  const userFilter = params.isAdmin
    ? `<div class="filter-group">
        <label>Researcher</label>
        <select name="user" class="filter-input">${userOptions}</select>
      </div>`
    : '';
  const clearLink = (params.search || params.from || params.to || params.viewUser)
    ? `<a href="${esc(params.action)}" class="filter-clear">Clear</a>`
    : '';
  return `<form method="GET" action="${esc(params.action)}" class="filter-bar no-print">
    <div class="filter-group">
      <label>Search</label>
      <input type="text" name="search" class="filter-input" placeholder="Matter ref…" value="${esc(params.search ?? '')}">
    </div>
    <div class="filter-group">
      <label>From</label>
      <input type="date" name="from" class="filter-input" value="${esc(params.from ?? '')}">
    </div>
    <div class="filter-group">
      <label>To</label>
      <input type="date" name="to" class="filter-input" value="${esc(params.to ?? '')}">
    </div>
    ${userFilter}
    <button type="submit" class="filter-btn">Filter</button>
    ${clearLink}
  </form>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Apply no-cache to all /matters routes to prevent Cloudflare and browser caching
mattersRouter.use(noCache);

// GET /mcp/matters/login
mattersRouter.get('/mcp/matters/login', (req: Request, res: Response) => {
  if (getSessionUser(req)) { res.redirect('/mcp/matters'); return; }
  const hasError = !!req.query['error'];
  const next = typeof req.query['next'] === 'string' ? req.query['next'] : '/mcp/matters';
  const error = hasError ? 'Incorrect username or token. Please try again.' : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(page('Sign in', `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">
          <img src="${LOGO_SRC}" alt="CP Legal" height="32" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
          <div class="login-logo-mark" style="display:none">C</div>
          <div>
            <div class="login-title" style="margin-bottom:0">CP Legal</div>
            <div style="font-size:.625rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--txt-3)">Legal Research</div>
          </div>
        </div>
        <div class="login-title">Welcome back</div>
        <div class="login-sub">Sign in to your research workspace</div>
        ${error ? `<div class="error-box">${esc(error)}</div>` : ''}
        <form method="post" action="/mcp/matters/login">
          <input type="hidden" name="next" value="${esc(next)}">
          <div class="form-group">
            <label for="u">Username</label>
            <input type="text" id="u" name="username" autocomplete="username" autofocus required placeholder="your username">
          </div>
          <div class="form-group">
            <label for="p">Token</label>
            <input type="password" id="p" name="password" autocomplete="current-password" required placeholder="your API token">
          </div>
          <button type="submit" class="login-btn">Sign in</button>
        </form>
      </div>
    </div>
  `, null));
});

// Rate limiter: 10 login attempts per IP per 15 minutes.
// Applied only to the POST handler (GET login page is unrestricted).
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes before trying again.' },
  skipSuccessfulRequests: true, // only count failed/processing attempts toward the limit
});

// POST /mcp/matters/login
mattersRouter.post('/mcp/matters/login', loginRateLimiter, async (req: Request, res: Response) => {
  const { username, password, next } = req.body as Record<string, string | undefined>;
  const user = (username ?? '').trim().toLowerCase();
  const token = (password ?? '').trim();
  const redirectTo = typeof next === 'string' && (next.startsWith('/mcp/matters') || next.startsWith('/mcp/admin')) ? next : '/mcp/matters';

  const validResult = await validateCredentials(user, token);

  // Recovery token override — allows admin access when other credentials are unavailable.
  // Uses timingSafeEqual to prevent timing-based token oracle attacks.
  const recoveryMatch = (() => {
    if (!config.RECOVERY_TOKEN || !token) return false;
    try {
      const a = Buffer.from(token);
      const b = Buffer.from(config.RECOVERY_TOKEN);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  })();
  if (!validResult && recoveryMatch) {
    const recoveryUser = user || 'recovery';
    setSessionCookie(res, recoveryUser, true); // grant admin
    logger.warn({ user: recoveryUser }, 'matters-ui: recovery token used');
    logLoginEvent({
      username: recoveryUser,
      eventType: 'recovery_login',
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      clientName: parseClientName(req.headers['user-agent']),
    }).catch(() => {/* ignore */});
    res.redirect(redirectTo);
    return;
  }

  if (!validResult) {
    logger.warn({ user }, 'matters-ui: failed login attempt');
    getGeoForIp(clientIp(req)).then((geo) => {
      logLoginEvent({
        username: user,
        eventType: 'login_failed',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
        clientName: parseClientName(req.headers['user-agent']),
        meta: geo ? { city: geo.city, region: geo.region, country: geo.country } : undefined,
      }).catch(() => {/* ignore */});
    }).catch(() => {/* ignore */});
    res.redirect('/mcp/matters/login?error=1');
    return;
  }
  setSessionCookie(res, user, validResult.isAdmin);
  updateUserLastActive(user).catch(() => {/* ignore */});
  logger.info({ user, isAdmin: validResult.isAdmin }, 'matters-ui: login');
  getGeoForIp(clientIp(req)).then((geo) => {
    logLoginEvent({
      username: user,
      eventType: 'login',
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      clientName: parseClientName(req.headers['user-agent']),
      meta: geo ? { city: geo.city, region: geo.region, country: geo.country } : undefined,
    }).catch(() => {/* ignore */});
  }).catch(() => {/* ignore */});
  res.redirect(redirectTo);
});

// GET /mcp/matters/logout
mattersRouter.get('/mcp/matters/logout', (req: Request, res: Response) => {
  const user = getSessionUser(req);
  if (user) {
    logLoginEvent({ username: user, eventType: 'logout', ip: clientIp(req), userAgent: req.headers['user-agent'], clientName: parseClientName(req.headers['user-agent']) }).catch(() => {/* ignore */});
  }
  clearSessionCookie(res);
  res.redirect('/mcp/matters/login');
});

// GET /mcp/matters/dashboard
mattersRouter.get('/mcp/matters/dashboard', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.send(page('Dashboard', '<div class="empty">Database not enabled on this deployment.</div>', user, '/mcp/matters/dashboard', undefined, userIsAdmin));
    return;
  }

  const scopedUserId = userIsAdmin ? undefined : user;
  const adminBadge = userIsAdmin ? '<span class="admin-badge">All researchers</span>' : '';

  const [stats, toolStats, userStats, recentActivity, popularCases, errorStats, costByTool, avgAccuracy, queryVolume, monthlySpend, spendCapStr] = await Promise.all([
    getDashboardStats(scopedUserId),
    getToolUsageStats(scopedUserId),
    userIsAdmin ? getUserStats() : Promise.resolve<UserStatRow[]>([]),
    getRecentActivity(20, scopedUserId),
    userIsAdmin ? getPopularCases(10) : Promise.resolve<PopularCaseRow[]>([]),
    getErrorStats(scopedUserId),
    getDashboardCostByTool(scopedUserId),
    getAggregateAccuracy(scopedUserId),
    getDailyQueryVolume(scopedUserId, 14),
    getMonthlySpendUsd(user),
    getAppConfig('spend_cap_monthly_per_user_usd'),
  ]);

  const spendCap = spendCapStr?.trim() ? parseFloat(spendCapStr) : null;
  const spendPct = spendCap && spendCap > 0 ? Math.min(100, (monthlySpend / spendCap) * 100) : null;
  const spendColorVar = spendPct === null ? 'var(--txt-2)' : spendPct >= 100 ? 'var(--err)' : spendPct >= 80 ? 'var(--warn)' : 'var(--ok)';
  const spendFillClass = spendPct === null ? '' : spendPct >= 100 ? 'spend-err' : spendPct >= 80 ? 'spend-warn' : 'spend-ok';
  const spendBar = spendPct !== null
    ? `<div class="spend-bar"><div class="spend-fill ${spendFillClass}" style="width:${spendPct}%"></div></div>`
    : '';
  const spendWidget = monthlySpend > 0 || spendCap
    ? `<div style="background:var(--surface);border:1px solid var(--bdr);border-radius:var(--r-lg);padding:.875rem 1.125rem;margin-bottom:1.25rem;display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap">
        <div style="min-width:160px">
          <div style="font-size:.75rem;color:var(--txt-3);margin-bottom:.125rem">This month's spend</div>
          <div style="font-weight:600;color:${spendColorVar}">$${monthlySpend.toFixed(4)} USD${spendCap ? ` <span style="font-weight:400;color:var(--txt-3);font-size:.875rem">/ $${spendCap.toFixed(2)} cap</span>` : ''}</div>
          ${spendBar}
        </div>
        ${spendPct !== null ? `<div style="font-size:.8125rem;color:${spendColorVar}">${spendPct.toFixed(1)}% of monthly cap used</div>` : ''}
      </div>`
    : '';

  const recentHtml = recentActivity.length > 0 ? `
    <div class="section-block no-print">
      <h2>Recent Activity</h2>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Date &amp; Time</th>
          <th>Matter</th>
          <th>Tool</th>
          <th>Researcher</th>
          <th>Query</th>
          <th style="text-align:center">Accuracy</th>
        </tr></thead>
        <tbody>
          ${recentActivity.map((r) => `
            <tr${r.is_error ? ' class="row-error"' : ''}>
              <td class="date-small">${tsDateTime(r.created_at)}</td>
              <td><a href="/mcp/matters/${encodeURIComponent(r.matter_ref)}" class="matter-ref">${esc(r.matter_ref)}</a></td>
              <td><span class="tag">${esc(toolLabel(r.tool_name))}</span></td>
              <td class="users-cell">${esc(r.user_id ?? '—')}</td>
              <td style="white-space:pre-wrap;word-break:break-word;color:var(--txt-2);max-width:380px">${esc(r.query_text)}</td>
              <td style="text-align:center;overflow:visible">${accuracyBadge(r.accuracy_score)}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>` : '';

  const nowIso = new Date().toISOString();
  const lastUpdated = new Date().toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Australia/Sydney',
  });

  const errorAlertBanner = userIsAdmin && errorStats.some((e) => e.error_rate_pct > 10)
    ? `<div style="background:var(--warn-bg);border:1px solid var(--warn);border-radius:var(--r);padding:.75rem 1rem;margin-bottom:1rem;font-size:.875rem;color:var(--warn)">⚠️ Some tools have elevated error rates. <a href="/mcp/admin" style="color:var(--warn);font-weight:600">View in Admin →</a></div>`
    : '';

  res.send(page('Dashboard', `
    ${errorAlertBanner}
    ${spendWidget}
    <h1>Dashboard ${adminBadge}</h1>
    <p class="subtitle">Aggregated research analytics${userIsAdmin ? ' across all matters and researchers' : ' for your matters'}
      <span style="float:right;font-size:.75rem;color:var(--txt-3)">Updated <time data-utc="${nowIso}" data-fmt="datetime">${esc(lastUpdated)}</time></span>
    </p>
    ${renderDashboardCards(stats, costByTool, avgAccuracy)}
    ${renderQueryVolumeChart(queryVolume)}
    ${renderToolChart(toolStats)}
    ${userIsAdmin ? renderResearcherCards(userStats) : ''}
    ${userIsAdmin ? renderPopularCases(popularCases) : ''}
    ${renderErrorStats(errorStats)}
    ${recentHtml}
  `, user, '/mcp/matters/dashboard', undefined, userIsAdmin));
});

// GET /mcp/matters — matter list
mattersRouter.get('/mcp/matters', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.send(page('Matters', '<div class="empty">Database not enabled on this deployment.</div>', user, '/mcp/matters', undefined, userIsAdmin));
    return;
  }

  const search = typeof req.query['search'] === 'string' ? req.query['search'].trim() : undefined;
  const viewUser = userIsAdmin && typeof req.query['user'] === 'string' ? req.query['user'].trim() : undefined;
  const statusFilter = typeof req.query['status'] === 'string' ? req.query['status'].trim() : undefined;
  const fromDate = typeof req.query['from'] === 'string' ? req.query['from'].trim() : undefined;
  const toDate   = typeof req.query['to']   === 'string' ? req.query['to'].trim()   : undefined;
  const validSorts = ['last_activity', 'first_activity', 'queries', 'matter_ref'] as const;
  type SortKey = typeof validSorts[number];
  const sort: SortKey = validSorts.includes(req.query['sort'] as SortKey) ? (req.query['sort'] as SortKey) : 'last_activity';
  const adminBadge = userIsAdmin ? '<span class="admin-badge">Admin</span>' : '';
  const allUsers = userIsAdmin ? (await listUsers()).map((u) => u.username) : [];

  // Build a helper that preserves current filter params when changing sort
  const buildSortUrl = (s: string) => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (viewUser) params.set('user', viewUser);
    if (statusFilter) params.set('status', statusFilter);
    if (fromDate) params.set('from', fromDate);
    if (toDate)   params.set('to', toDate);
    params.set('sort', s);
    return `/mcp/matters?${params.toString()}`;
  };

  // Admin: default to all matters; can filter by user via ?user=
  const matters: MatterSummaryRow[] = userIsAdmin
    ? (viewUser ? await listMattersForUser(viewUser, search, statusFilter, sort, fromDate, toDate) : await listMatters(search, statusFilter, sort, fromDate, toDate))
    : await listMattersForUser(user, search, statusFilter, sort, fromDate, toDate);

  // Admin user toggle tabs
  const segTabs = userIsAdmin
    ? `<div class="seg-tabs no-print">
        <a href="/mcp/matters" class="seg-tab${!viewUser ? ' active' : ''}">All Matters</a>
        ${allUsers.map((u) => `<a href="/mcp/matters?user=${encodeURIComponent(u)}" class="seg-tab${viewUser === u ? ' active' : ''}">${esc(u)}</a>`).join('')}
      </div>`
    : '';

  // Status filter tabs
  const statusTabs = `<div class="seg-tabs no-print" style="margin-bottom:.75rem">
    <a href="/mcp/matters${viewUser ? `?user=${encodeURIComponent(viewUser)}` : ''}" class="seg-tab${!statusFilter || statusFilter === 'all' ? ' active' : ''}">All</a>
    <a href="/mcp/matters?${viewUser ? `user=${encodeURIComponent(viewUser)}&` : ''}status=open" class="seg-tab${statusFilter === 'open' ? ' active' : ''}">Open</a>
    <a href="/mcp/matters?${viewUser ? `user=${encodeURIComponent(viewUser)}&` : ''}status=closed" class="seg-tab${statusFilter === 'closed' ? ' active' : ''}">Closed</a>
  </div>`;

  let tableHtml: string;
  if (matters.length === 0) {
    tableHtml = `<div class="empty">${search ? `No matters matching "${esc(search)}".` : 'No matters on record yet.'}</div>`;
  } else {
    const rows = matters.map((m) => {
      const researchers = (m.users ?? []).join(', ') || '—';
      const tools = (m.tools_used ?? []).map((t) => `<span class="tag">${esc(toolLabel(t))}</span>`).join('');
      const isClosed = m.status === 'closed';
      const statusBadge = isClosed ? ' <span class="tag" style="background:var(--err-bg);color:var(--err)">Closed</span>' : '';
      const displayLabel = m.display_name
        ? `${esc(m.display_name)}<br><span style="font-size:.75rem;color:var(--txt-3);font-family:ui-monospace,monospace">${esc(m.matter_ref)}</span>`
        : esc(m.matter_ref);
      const copyBtn = `<button class="copy-ref-btn" data-ref="${esc(m.matter_ref)}" title="Copy matter ref" onclick="navigator.clipboard.writeText(this.dataset.ref).then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='⎘',1200)})">⎘</button>`;
      return `<tr>
        <td><a href="/mcp/matters/${encodeURIComponent(m.matter_ref)}" class="matter-ref" title="${esc(m.matter_ref)}">${displayLabel}</a>${statusBadge}${copyBtn}</td>
        <td class="date-small td-clip">${tsDate(m.first_activity)}<br>${tsDate(m.last_activity)}</td>
        <td class="count" style="text-align:right">${m.query_count}</td>
        <td class="users-cell td-clip">${esc(researchers)}</td>
        <td>${tools}</td>
        <td><a href="/mcp/matters/${encodeURIComponent(m.matter_ref)}" class="btn btn-secondary no-print" style="padding:.3rem .75rem;font-size:.8125rem">View →</a></td>
      </tr>`;
    }).join('');
    const sortIcon = (col: string) => sort === col ? ' ↓' : ' <span style="color:var(--txt-3);font-weight:400">↕</span>';
    tableHtml = `<div class="table-wrap"><table>
      <thead><tr>
        <th><a href="${esc(buildSortUrl('matter_ref'))}" class="sort-link${sort === 'matter_ref' ? ' active' : ''}">Matter Ref${sortIcon('matter_ref')}</a></th>
        <th><a href="${esc(buildSortUrl('last_activity'))}" class="sort-link${sort === 'last_activity' ? ' active' : ''}">Last Active${sortIcon('last_activity')}</a></th>
        <th style="text-align:right"><a href="${esc(buildSortUrl('queries'))}" class="sort-link${sort === 'queries' ? ' active' : ''}">Queries${sortIcon('queries')}</a></th>
        <th>Researchers</th><th>Tools Used</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  res.send(page('Matters', `
    <h1>Matters ${adminBadge}</h1>
    <p class="subtitle">${matters.length} matter${matters.length !== 1 ? 's' : ''}${search ? ` matching "${esc(search)}"` : ''}</p>
    <div class="actions no-print" style="margin-bottom:1rem">
      <details class="export-dd no-print">
        <summary class="btn btn-secondary">Summary Report ▾</summary>
        <div class="dd-menu">
          <a href="/mcp/matters/export-all.csv" download>Download CSV</a>
          <hr class="dd-sep">
          <a href="/mcp/matters/export-all.pdf" target="_blank">Print as PDF</a>
        </div>
      </details>
    </div>
    ${segTabs}
    ${statusTabs}
    ${renderFilterBar({ search, from: fromDate, to: toDate, allUsers, isAdmin: userIsAdmin, viewUser, action: '/mcp/matters' })}
    ${tableHtml}
  `, user, '/mcp/matters', undefined, userIsAdmin));
});

// GET /mcp/matters/search — global query search (MUST be before /mcp/matters/:ref)
mattersRouter.get('/mcp/matters/search', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  if (!q) { res.redirect('/mcp/matters'); return; }

  const results = await searchQueries(q, userIsAdmin ? undefined : user, 50);

  const rows = results.map((r: SearchResult) => `<tr>
    <td><a href="/mcp/matters/${encodeURIComponent(r.matter_ref)}" class="matter-ref">${esc(r.display_name ?? r.matter_ref)}</a></td>
    <td><span class="tag">${esc(toolLabel(r.tool_name))}</span></td>
    <td class="date-small">${tsDateTime(r.created_at)}</td>
    ${userIsAdmin ? `<td class="users-cell">${esc(r.user_id ?? '—')}</td>` : ''}
    <td style="max-width:400px;white-space:pre-wrap;word-break:break-word;color:var(--txt-2)">${esc(r.query_text.slice(0, 300))}</td>
  </tr>`).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(page('Search Results', `
    <form method="GET" action="/mcp/matters/search" style="display:flex;gap:.5rem;margin-bottom:1.5rem">
      <input type="text" name="q" value="${esc(q)}" style="flex:1;max-width:400px">
      <button type="submit" class="btn btn-primary">Search</button>
    </form>
    <h1>Search: &ldquo;${esc(q)}&rdquo;</h1>
    <p class="subtitle">${results.length} result${results.length !== 1 ? 's' : ''}</p>
    ${results.length === 0
      ? '<div class="empty">No results found.</div>'
      : `<div class="table-wrap"><table>
          <thead><tr><th>Matter</th><th>Tool</th><th>Date</th>${userIsAdmin ? '<th>Researcher</th>' : ''}<th>Query</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`}
  `, user, '/mcp/matters', undefined, userIsAdmin));
});

// GET /mcp/matters/export-all.csv — summary CSV of all matters (MUST be before /:ref)
mattersRouter.get('/mcp/matters/export-all.csv', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);

  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const matters: MatterSummaryRow[] = userIsAdmin
    ? await listMatters()
    : await listMattersForUser(user);

  const csvEsc = (v: string | number | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const baseHeaders = ['Matter Ref', 'Display Name', 'Status', 'First Activity', 'Last Activity', 'Queries', 'Researchers', 'Tools Used'];
  const costHeaders = userIsAdmin ? ['Total Tokens', 'Est Cost USD', 'Est Cost AUD'] : [];
  const header = [...baseHeaders, ...costHeaders].map(csvEsc).join(',');

  const dataRows = await Promise.all(matters.map(async (m) => {
    const base = [
      m.matter_ref,
      m.display_name ?? '',
      m.status,
      fmtDateTime(m.first_activity),
      fmtDateTime(m.last_activity),
      String(m.query_count),
      (m.users ?? []).join('; '),
      (m.tools_used ?? []).map(toolLabel).join('; '),
    ];
    if (userIsAdmin) {
      const rows = await getMatterHistory(m.matter_ref, 5000);
      const totalTokens = rows.reduce((s, r) => s + (r.api_tokens_used ?? 0), 0);
      const costUsd = rows.reduce((s, r) => {
        const tokens = r.api_tokens_used ?? 0;
        return s + (tokens / 1_000_000) * (TOOL_COST_RATES[r.tool_name] ?? 1.25);
      }, 0);
      base.push(String(totalTokens), costUsd.toFixed(6), (costUsd * AUD_PER_USD).toFixed(6));
    }
    return base.map(csvEsc).join(',');
  }));

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cp-legal-matters-${date}.csv"`);
  res.send('\uFEFF' + [header, ...dataRows].join('\r\n'));
});

// GET /mcp/matters/export-all.pdf — printable matter list (MUST be before /:ref)
mattersRouter.get('/mcp/matters/export-all.pdf', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);

  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const matters: MatterSummaryRow[] = userIsAdmin
    ? await listMatters()
    : await listMattersForUser(user);

  const today = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });
  const rows = matters.map((m) => `<tr>
    <td>${esc(m.matter_ref)}${m.display_name ? `<br><span style="font-size:.7rem;color:#555">${esc(m.display_name)}</span>` : ''}</td>
    <td>${esc(m.status)}</td>
    <td style="text-align:right">${m.query_count}</td>
    <td>${esc(fmtDateTime(m.first_activity))}</td>
    <td>${esc(fmtDateTime(m.last_activity))}</td>
    <td style="font-size:.7rem">${(m.users ?? []).map((u) => esc(u)).join(', ') || '—'}</td>
    <td style="font-size:.7rem">${(m.tools_used ?? []).map((t) => esc(toolLabel(t))).join(', ')}</td>
  </tr>`).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
    <title>Matters Summary</title>
    <style>
      body { font-family: Georgia, serif; font-size: 9pt; margin: 1.5cm; color: #000; }
      h1 { font-size: 13pt; margin-bottom: .2rem; }
      .sub { font-size: 8pt; color: #555; margin-bottom: 1rem; }
      table { width: 100%; border-collapse: collapse; font-size: 8pt; }
      th { background: #eee; padding: .2rem .4rem; text-align: left; border-bottom: 2px solid #ccc; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .03em; }
      td { padding: .2rem .4rem; border-bottom: 1px solid #eee; vertical-align: top; }
      @page { size: A4 landscape; margin: 1.5cm; }
    </style>
  </head><body>
    <h1>Matters Summary</h1>
    <div class="sub">CP Legal · Printed ${esc(today)} · ${matters.length} matter${matters.length !== 1 ? 's' : ''}</div>
    <table>
      <thead><tr>
        <th>Matter Ref</th><th>Status</th><th>Queries</th>
        <th>First Activity</th><th>Last Activity</th>
        <th>Researchers</th><th>Tools Used</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <script>window.onload = function(){ window.print(); };</script>
  </body></html>`);
});

// GET /mcp/matters/:ref/export-billing.pdf
mattersRouter.get('/mcp/matters/:ref/export-billing.pdf', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');

  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const rows = await getMatterHistory(ref, 1000);
  if (rows.length === 0) { res.status(404).send('Not found'); return; }
  if (!userIsAdmin && !rows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send('Forbidden'); return;
  }

  const matterInfo = await getMatter(ref).catch(() => null);
  const displayLabel = matterInfo?.display_name ? `${esc(matterInfo.display_name)} <span style="font-size:.75rem;color:#888">(${esc(ref)})</span>` : esc(ref);
  const today = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

  const tableRows = rows.map((r) => {
    const tokens = r.api_tokens_used ?? 0;
    const costUsd = (tokens / 1_000_000) * (TOOL_COST_RATES[r.tool_name] ?? 1.25);
    return `<tr>
      <td>${esc(fmtDateTime(r.created_at))}</td>
      <td>${esc(toolLabel(r.tool_name))}</td>
      <td>${esc(r.user_id ?? '—')}</td>
      <td style="white-space:pre-wrap;word-break:break-word;max-width:250px">${esc(r.query_text.slice(0, 150))}</td>
      <td style="text-align:right">${tokens.toLocaleString('en-AU')}</td>
      <td style="text-align:right">${costUsd > 0 ? '$' + costUsd.toFixed(6) : '—'}</td>
      <td style="text-align:right">${costUsd > 0 ? '$' + (costUsd * AUD_PER_USD).toFixed(6) : '—'}</td>
    </tr>`;
  }).join('');

  const totalUsd = rows.reduce((s, r) => s + ((r.api_tokens_used ?? 0) / 1_000_000) * (TOOL_COST_RATES[r.tool_name] ?? 1.25), 0);
  const totalTokens = rows.reduce((s, r) => s + (r.api_tokens_used ?? 0), 0);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
    <title>Billing Detail — ${esc(ref)}</title>
    <style>
      body { font-family: Georgia, serif; font-size: 9pt; margin: 1.5cm; color: #000; }
      h1 { font-size: 13pt; margin-bottom: .2rem; }
      .sub { font-size: 8pt; color: #555; margin-bottom: 1rem; }
      table { width: 100%; border-collapse: collapse; font-size: 8pt; }
      th { background: #eee; padding: .2rem .4rem; text-align: left; border: 1px solid #ccc; font-size: 7.5pt; }
      td { padding: .2rem .4rem; border: 1px solid #ddd; vertical-align: top; }
      tfoot td { font-weight: bold; background: #f5f5f0; border-top: 2px solid #999; }
      @page { size: A4 landscape; margin: 1.5cm; }
    </style>
  </head><body>
    <h1>Billing Detail — ${displayLabel}</h1>
    <div class="sub">CP Legal · Printed ${esc(today)}</div>
    <table>
      <thead><tr>
        <th>Date/Time</th><th>Tool</th><th>Researcher</th><th>Query (truncated)</th>
        <th style="text-align:right">Tokens</th><th style="text-align:right">Cost USD</th><th style="text-align:right">Cost AUD</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
      <tfoot><tr>
        <td colspan="4"><strong>Total</strong></td>
        <td style="text-align:right">${totalTokens.toLocaleString('en-AU')}</td>
        <td style="text-align:right">$${totalUsd.toFixed(6)}</td>
        <td style="text-align:right">$${(totalUsd * AUD_PER_USD).toFixed(6)}</td>
      </tr></tfoot>
    </table>
    <script>window.onload = function(){ window.print(); };</script>
  </body></html>`);
});

// GET /mcp/matters/:ref/export-billing-summary.csv
mattersRouter.get('/mcp/matters/:ref/export-billing-summary.csv', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');

  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const rows = await getMatterHistory(ref, 5000);
  if (rows.length === 0) { res.status(404).send('Not found'); return; }
  if (!userIsAdmin && !rows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send('Forbidden'); return;
  }

  const matterInfo = await getMatter(ref).catch(() => null);
  const { monthly, grandTotal } = computeMonthlyBilling(rows);

  const csvEsc = (v: string | number | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Matter Ref', 'Display Name', 'Month', 'Tool', 'Queries', 'Tokens', 'Cost USD', 'Cost AUD'].map(csvEsc).join(',');

  const dataRows: string[] = [];
  let lastMonth = '';
  let monthRows: typeof monthly = [];

  const flushMonth = () => {
    if (!monthRows.length) return;
    const mt = monthRows.reduce((a, r) => ({ queries: a.queries + r.queries, tokens: a.tokens + r.tokens, cost_usd: a.cost_usd + r.cost_usd, cost_aud: a.cost_aud + r.cost_aud }), { queries: 0, tokens: 0, cost_usd: 0, cost_aud: 0 });
    for (const r of monthRows) {
      dataRows.push([ref, matterInfo?.display_name ?? '', r.month, toolLabel(r.tool_name), String(r.queries), String(r.tokens), r.cost_usd.toFixed(6), r.cost_aud.toFixed(6)].map(csvEsc).join(','));
    }
    dataRows.push([ref, '', lastMonth + ' SUBTOTAL', '', String(mt.queries), String(mt.tokens), mt.cost_usd.toFixed(6), mt.cost_aud.toFixed(6)].map(csvEsc).join(','));
    monthRows = [];
  };

  for (const r of monthly) {
    if (r.month !== lastMonth) { flushMonth(); lastMonth = r.month; }
    monthRows.push(r);
  }
  flushMonth();

  dataRows.push([ref, '', 'GRAND TOTAL', '', String(grandTotal.queries), String(grandTotal.tokens), grandTotal.cost_usd.toFixed(6), grandTotal.cost_aud.toFixed(6)].map(csvEsc).join(','));

  const date = new Date().toISOString().slice(0, 10);
  const safeRef = ref.replace(/[^a-zA-Z0-9\-_]/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cp-legal-billing-summary-${safeRef}-${date}.csv"`);
  res.send('\uFEFF' + [header, ...dataRows].join('\r\n'));
});

// GET /mcp/matters/:ref/export-billing-summary.pdf
mattersRouter.get('/mcp/matters/:ref/export-billing-summary.pdf', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');

  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const rows = await getMatterHistory(ref, 5000);
  if (rows.length === 0) { res.status(404).send('Not found'); return; }
  if (!userIsAdmin && !rows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send('Forbidden'); return;
  }

  const matterInfo = await getMatter(ref).catch(() => null);
  const displayLabel = matterInfo?.display_name ? `${esc(matterInfo.display_name)} (${esc(ref)})` : esc(ref);
  const today = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });
  const { monthly, grandTotal } = computeMonthlyBilling(rows);

  // Group by month for rendering
  const byMonth = new Map<string, typeof monthly>();
  for (const r of monthly) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, []);
    byMonth.get(r.month)!.push(r);
  }

  let tableHtml = '';
  for (const [month, mRows] of byMonth) {
    const mt = mRows.reduce((a, r) => ({ queries: a.queries + r.queries, tokens: a.tokens + r.tokens, cost_usd: a.cost_usd + r.cost_usd, cost_aud: a.cost_aud + r.cost_aud }), { queries: 0, tokens: 0, cost_usd: 0, cost_aud: 0 });
    tableHtml += `<tr class="month-header"><td colspan="5"><strong>${esc(month)}</strong></td></tr>`;
    for (const r of mRows) {
      tableHtml += `<tr>
        <td style="padding-left:1.5rem">${esc(toolLabel(r.tool_name))}</td>
        <td style="text-align:right">${r.queries}</td>
        <td style="text-align:right">${r.tokens.toLocaleString('en-AU')}</td>
        <td style="text-align:right">$${r.cost_usd.toFixed(4)}</td>
        <td style="text-align:right">$${r.cost_aud.toFixed(4)}</td>
      </tr>`;
    }
    tableHtml += `<tr class="subtotal">
      <td><em>${esc(month)} subtotal</em></td>
      <td style="text-align:right">${mt.queries}</td>
      <td style="text-align:right">${mt.tokens.toLocaleString('en-AU')}</td>
      <td style="text-align:right">$${mt.cost_usd.toFixed(4)}</td>
      <td style="text-align:right">$${mt.cost_aud.toFixed(4)}</td>
    </tr>`;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
    <title>Billing Summary — ${esc(ref)}</title>
    <style>
      body { font-family: Georgia, serif; font-size: 9.5pt; margin: 1.5cm; color: #000; }
      h1 { font-size: 13pt; margin-bottom: .2rem; }
      .sub { font-size: 8pt; color: #555; margin-bottom: 1rem; }
      table { width: 100%; border-collapse: collapse; font-size: 9pt; }
      th { background: #eee; padding: .3rem .5rem; text-align: left; border-bottom: 2px solid #ccc; }
      td { padding: .25rem .5rem; border-bottom: 1px solid #eee; }
      tr.month-header td { background: #f0ede8; font-size: 9.5pt; padding-top: .75rem; border-bottom: none; }
      tr.subtotal td { background: #f7f5f2; border-top: 1px solid #bbb; border-bottom: 2px solid #bbb; font-style: italic; }
      tfoot td { font-weight: bold; background: #f0ede8; border-top: 2px solid #888; padding: .4rem .5rem; font-size: 10pt; }
      @page { size: A4 portrait; margin: 1.5cm; }
    </style>
  </head><body>
    <h1>Billing Summary — ${esc(displayLabel)}</h1>
    <div class="sub">CP Legal · Printed ${esc(today)}</div>
    <table>
      <thead><tr>
        <th>Tool</th>
        <th style="text-align:right">Queries</th>
        <th style="text-align:right">Tokens</th>
        <th style="text-align:right">Cost USD</th>
        <th style="text-align:right">Cost AUD</th>
      </tr></thead>
      <tbody>${tableHtml}</tbody>
      <tfoot><tr>
        <td>Grand Total</td>
        <td style="text-align:right">${grandTotal.queries}</td>
        <td style="text-align:right">${grandTotal.tokens.toLocaleString('en-AU')}</td>
        <td style="text-align:right">$${grandTotal.cost_usd.toFixed(4)}</td>
        <td style="text-align:right">$${grandTotal.cost_aud.toFixed(4)}</td>
      </tr></tfoot>
    </table>
    <script>window.onload = function(){ window.print(); };</script>
  </body></html>`);
});

// GET /mcp/matters/:ref — matter detail
mattersRouter.get('/mcp/matters/:ref', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');
  const toolFilter = typeof req.query['tool'] === 'string' ? req.query['tool'].trim() : undefined;
  const PAGE_SIZE = 50;
  const page_num = Math.max(1, parseInt(typeof req.query['page'] === 'string' ? req.query['page'] : '1', 10) || 1);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.status(503).send(page('Error', '<div class="empty">Database not enabled.</div>', user, undefined, undefined, userIsAdmin));
    return;
  }

  // Fetch up to 500 rows for stats, plus paginated rows for display
  const [allStatsRows, matter, totalCount] = await Promise.all([
    getMatterHistory(ref, 500, toolFilter),
    getMatter(ref).catch(() => null),
    getMatterHistoryCount(ref, toolFilter),
  ]);

  if (allStatsRows.length === 0 && !toolFilter) {
    res.status(404).send(page('Not Found', '<div class="empty">Matter not found or no queries on record.</div>', user, undefined, undefined, userIsAdmin));
    return;
  }

  if (!userIsAdmin && !allStatsRows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send(page('Access Denied', '<div class="empty">You do not have access to this matter.</div>', user, undefined, undefined, userIsAdmin));
    return;
  }

  // For access check when tool filter returns 0, fetch unfiltered stats rows
  const allRows = toolFilter && allStatsRows.length === 0 ? await getMatterHistory(ref, 500) : allStatsRows;
  if (allRows.length === 0) {
    res.status(404).send(page('Not Found', '<div class="empty">Matter not found.</div>', user, undefined, undefined, userIsAdmin));
    return;
  }
  if (!userIsAdmin && !allRows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send(page('Access Denied', '<div class="empty">You do not have access to this matter.</div>', user, undefined, undefined, userIsAdmin));
    return;
  }

  // Paginated rows for table display
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  // Clamp page_num to valid range — prevents empty table on out-of-range ?page= values
  const safePage = Math.min(page_num, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;
  const displayRows = await getMatterHistory(ref, PAGE_SIZE, toolFilter, offset);

  const isClosed = matter?.status === 'closed';
  const displayName = matter?.display_name ?? null;

  const firstRow = allRows[allRows.length - 1]!;
  const lastRow = allRows[0]!;
  const researchers = [...new Set(allRows.map((r) => r.user_id).filter(Boolean))].join(', ') || '—';
  const totalResults = allRows.reduce((s, r) => s + (r.result_count ?? 0), 0);
  const totalTokens = allRows.reduce((s, r) => s + (r.api_tokens_used ?? 0), 0);
  const activeDays = new Set(allRows.map((r) => new Date(r.created_at).toISOString().slice(0, 10))).size;
  const today = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

  // Tool filter dropdown — use allRows distinct tools
  const distinctTools = [...new Set(allRows.map((r) => r.tool_name))].sort();
  const toolOptions = `<option value="">All Tools (${totalCount})</option>` +
    distinctTools.map((t) => {
      const cnt = allRows.filter((r) => r.tool_name === t).length;
      return `<option value="${esc(t)}"${toolFilter === t ? ' selected' : ''}>${esc(toolLabel(t))} (${cnt})</option>`;
    }).join('');

  const queryRows = displayRows.map((r) => {
    const topLinks = (r.top_results ?? []).slice(0, 5)
      .map((tr) => `<a href="${esc(tr.url)}" target="_blank" rel="noopener">${esc(tr.title)}${tr.citation ? ` — ${esc(tr.citation)}` : ''}</a>`)
      .join('');
    const rowClass = r.is_error ? ' class="row-error"' : '';
    const costCell = estCost(r.api_tokens_used ?? 0, r.tool_name);
    return `<tr${rowClass}>
      <td class="date-small">${tsDateTime(r.created_at)}</td>
      <td><span class="tag">${esc(toolLabel(r.tool_name))}</span></td>
      <td class="users-cell">${esc(r.user_id ?? '—')}</td>
      <td><div class="query-full">${esc(r.query_text)}</div></td>
      <td class="date-small">${esc(r.jurisdiction ?? '—')}</td>
      <td class="count" style="text-align:right">${r.result_count ?? 0}</td>
      <td class="mono no-print-col" style="text-align:right">${fmtTokens(r.api_tokens_used ?? 0)}</td>
      <td style="text-align:right">${costCell}</td>
      <td style="text-align:center;overflow:visible">${accuracyBadge(r.accuracy_score)}</td>
      <td><div class="top-results-stack">${topLinks || '—'}</div></td>
    </tr>`;
  }).join('');

  const paginationHtml = totalPages > 1 ? `<div class="pagination no-print" style="display:flex;gap:.5rem;align-items:center;margin-top:1rem">
    ${safePage > 1 ? `<a href="?page=${safePage - 1}${toolFilter ? '&tool=' + encodeURIComponent(toolFilter) : ''}" class="btn btn-secondary btn-sm">← Prev</a>` : ''}
    <span style="font-size:.8125rem;color:var(--txt-3)">Page ${safePage} of ${totalPages}</span>
    ${safePage < totalPages ? `<a href="?page=${safePage + 1}${toolFilter ? '&tool=' + encodeURIComponent(toolFilter) : ''}" class="btn btn-secondary btn-sm">Next →</a>` : ''}
  </div>` : '';

  const closedBanner = isClosed
    ? `<div style="background:var(--err-bg);border:1px solid var(--err);padding:.75rem 1rem;border-radius:var(--r);margin-bottom:1rem;color:var(--err)">This matter is <strong>closed</strong>. New queries with this matter reference will be appended with a new identifier.</div>`
    : '';

  const renameForm = `<details class="no-print" style="margin-bottom:.75rem">
    <summary style="font-size:.8125rem;color:var(--txt-2);cursor:pointer">Rename matter…</summary>
    <form method="POST" action="/mcp/matters/${encodeURIComponent(ref)}/rename" style="margin-top:.5rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <input type="text" name="display_name" value="${esc(displayName ?? '')}" placeholder="Display name (optional)" maxlength="200" style="min-width:200px;width:auto">
      <button type="submit" class="btn btn-secondary btn-sm">Save</button>
      ${displayName ? `<button type="submit" name="display_name" value="" class="btn btn-secondary btn-sm">Clear</button>` : ''}
    </form>
  </details>`;

  const notesForm = `<details class="no-print" style="margin-bottom:.75rem">
    <summary style="font-size:.8125rem;color:var(--txt-2);cursor:pointer">Matter notes…</summary>
    <form method="POST" action="/mcp/matters/${encodeURIComponent(ref)}/notes" style="margin-top:.5rem">
      <textarea name="notes" rows="4" maxlength="2000" style="max-width:600px;resize:vertical">${esc(matter?.notes ?? '')}</textarea>
      <div style="margin-top:.375rem">
        <button type="submit" class="btn btn-secondary btn-sm">Save Notes</button>
      </div>
    </form>
    ${matter?.notes ? `<div style="margin-top:.5rem;padding:.625rem .75rem;background:var(--surf-2);border:1px solid var(--bdr);border-radius:var(--r);font-size:.8125rem;white-space:pre-wrap;color:var(--txt)">${esc(matter.notes)}</div>` : ''}
  </details>`;

  const notesPrint = matter?.notes
    ? `<div style="margin-top:.5rem;padding:.5rem 0;font-size:8pt;white-space:pre-wrap;color:#333"><strong>Notes:</strong> ${esc(matter.notes)}</div>`
    : '';

  const closeButton = userIsAdmin
    ? `<div class="no-print" style="display:inline-flex;gap:.5rem;align-items:center;flex-wrap:wrap">
        <form method="POST" action="/mcp/matters/${encodeURIComponent(ref)}/set-status" style="display:inline">
          <input type="hidden" name="status" value="${isClosed ? 'open' : 'closed'}">
          <button type="submit" class="btn btn-secondary btn-sm">${isClosed ? 'Reopen Matter' : 'Close Matter'}</button>
        </form>
        <form method="POST" action="/mcp/admin/matters/${encodeURIComponent(ref)}/delete" style="display:inline"
              onsubmit="return confirm('Permanently delete matter \\'${esc(ref)}\\' and all ${totalCount} queries? This cannot be undone.')">
          <button type="submit" class="btn btn-danger btn-sm">Delete Matter</button>
        </form>
      </div>`
    : '';

  res.send(page(`${ref} — Research History`, `
    <a href="/mcp/matters" class="btn-back no-print">← All Matters</a>
    <div class="print-header">
      <div class="print-header-firm">CP Legal</div>
      <div class="print-header-sub">Matter Research Report — printed ${esc(today)}</div>
      ${notesPrint}
    </div>
    ${closedBanner}
    ${displayName
      ? `<h1>${esc(displayName)} <button class="copy-ref-btn" data-ref="${esc(ref)}" title="Copy matter ref" onclick="navigator.clipboard.writeText(this.dataset.ref).then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='⎘',1200)})">⎘</button></h1><p style="font-size:.8125rem;color:var(--txt-3);font-family:ui-monospace,monospace;margin-bottom:.375rem">${esc(ref)}</p>`
      : `<h1>${esc(ref)} <button class="copy-ref-btn" data-ref="${esc(ref)}" title="Copy matter ref" onclick="navigator.clipboard.writeText(this.dataset.ref).then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='⎘',1200)})">⎘</button></h1>`}
    ${renameForm}
    ${notesForm}
    ${closeButton}
    <p class="subtitle" style="margin-top:.5rem">${tsDate(firstRow.created_at)} to ${tsDate(lastRow.created_at)}</p>
    <div class="summary-grid">
      <div class="card">
        <div class="card-label">Total Queries</div>
        <div class="card-value">${totalCount}</div>
        ${toolFilter ? `<div class="card-sub">${totalCount} shown (filtered)</div>` : ''}
      </div>
      <div class="card">
        <div class="card-label">Results Retrieved</div>
        <div class="card-value">${totalResults.toLocaleString('en-AU')}</div>
      </div>
      <div class="card">
        <div class="card-label">Active Days</div>
        <div class="card-value">${activeDays}</div>
        <div class="card-sub">distinct research days</div>
      </div>
      <div class="card">
        <div class="card-label">API Tokens</div>
        <div class="card-value">${fmtTokens(totalTokens)}</div>
      </div>
      <div class="card">
        <div class="card-label">Est. API Cost <span class="est-badge">est</span></div>
        ${(() => { const c = computeMatterCost(allRows); return `<div class="card-value sm">${c.usd} <span style="font-size:.75rem;color:var(--txt-3)">USD</span></div><div class="card-sub">≈ ${c.aud} AUD · per-tool rates</div>`; })()}
      </div>
      <div class="card">
        <div class="card-label">Researchers</div>
        <div class="card-value sm">${esc(researchers)}</div>
      </div>
    </div>
    <div class="actions no-print">
      <details class="export-dd">
        <summary class="btn btn-secondary">Research History ▾</summary>
        <div class="dd-menu">
          <a href="/mcp/matters/${encodeURIComponent(ref)}/export.csv" download>Download CSV</a>
          <hr class="dd-sep">
          <a href="#" onclick="window.print();return false;">Print as PDF</a>
        </div>
      </details>
      <details class="export-dd">
        <summary class="btn btn-secondary">Billing Detail ▾</summary>
        <div class="dd-menu">
          <a href="/mcp/matters/${encodeURIComponent(ref)}/export-billing.csv" download>Download CSV</a>
          <hr class="dd-sep">
          <a href="/mcp/matters/${encodeURIComponent(ref)}/export-billing.pdf" target="_blank">Print as PDF</a>
        </div>
      </details>
      <details class="export-dd">
        <summary class="btn btn-secondary">Billing Summary ▾</summary>
        <div class="dd-menu">
          <a href="/mcp/matters/${encodeURIComponent(ref)}/export-billing-summary.csv" download>Download CSV</a>
          <hr class="dd-sep">
          <a href="/mcp/matters/${encodeURIComponent(ref)}/export-billing-summary.pdf" target="_blank">Print as PDF</a>
        </div>
      </details>
    </div>
    <form method="GET" action="/mcp/matters/${encodeURIComponent(ref)}" class="filter-bar no-print" style="margin-bottom:1rem">
      <div class="filter-group">
        <label>Filter by Tool</label>
        <select name="tool" class="filter-input" onchange="this.form.submit()">${toolOptions}</select>
      </div>
      ${toolFilter ? `<a href="/mcp/matters/${encodeURIComponent(ref)}" class="filter-clear">Clear filter</a>` : ''}
    </form>
    <div class="table-wrap">
    <table style="table-layout:auto">
      <thead><tr>
        <th>Date &amp; Time</th><th>Tool</th><th>Researcher</th><th>Query</th>
        <th>Jurisdiction</th><th style="text-align:right">Results</th>
        <th class="no-print-col" style="text-align:right">Tokens</th>
        <th style="text-align:right">Cost (USD)</th>
        <th style="text-align:center">Accuracy
          <span class="tip tip-below tip-right no-print-col" data-tip="Isaacus Kanon extractive confidence. Legal text typically scores 5–45% — reflects how extractable the answer is, not whether it's correct." tabindex="0" style="color:var(--txt-3);margin-left:.2rem;font-weight:400;cursor:help">ⓘ</span>
        </th>
        <th>Top Results</th>
      </tr></thead>
      <tbody>${queryRows.length > 0 ? queryRows : '<tr><td colspan="10" style="text-align:center;color:var(--txt-3);padding:2rem">No queries match this filter.</td></tr>'}</tbody>
    </table>
    </div>
    ${paginationHtml}
  `, user, '/mcp/matters', undefined, userIsAdmin));
});

// GET /mcp/matters/:ref/export.csv
mattersRouter.get('/mcp/matters/:ref/export.csv', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');

  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const rows = await getMatterHistory(ref, 1000);
  if (rows.length === 0) { res.status(404).send('Not found'); return; }
  if (!userIsAdmin && !rows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send('Forbidden'); return;
  }

  const csvEsc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header = ['Date/Time', 'Tool', 'Researcher', 'Query', 'Jurisdiction', 'Results', 'Tokens', 'Est Cost', 'Accuracy', 'Top Results']
    .map(csvEsc).join(',');
  const dataRows = rows.map((r) => {
    const topResults = (r.top_results ?? []).slice(0, 5)
      .map((tr) => `${tr.title}${tr.citation ? ` (${tr.citation})` : ''}: ${tr.url}`)
      .join(' | ');
    const tokens = r.api_tokens_used ?? 0;
    const accuracyStr = r.accuracy_score != null ? `${Math.round(r.accuracy_score * 100)}%` : '';
    return [
      fmtDateTime(r.created_at),
      toolLabel(r.tool_name),
      r.user_id ?? '',
      r.query_text,
      r.jurisdiction ?? '',
      String(r.result_count ?? 0),
      String(tokens),
      estCost(tokens, r.tool_name),
      accuracyStr,
      topResults,
    ].map(csvEsc).join(',');
  });

  const safeRef = ref.replace(/[^a-zA-Z0-9\-_]/g, '_');
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cp-legal-${safeRef}-${date}.csv"`);
  res.send('\uFEFF' + [header, ...dataRows].join('\r\n'));
});

// GET /mcp/admin/billing-export.csv — global billing export (admin only)
mattersRouter.get('/mcp/admin/billing-export.csv', requireSession, async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) { res.status(403).send('Admin only'); return; }
  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const { from, to } = req.query as Record<string, string | undefined>;

  const toolRows = await getMattersBillingExport(from, to);
  if (toolRows.length === 0) {
    res.status(404).send('No billing data found for the specified period');
    return;
  }

  // Aggregate per-matter rows from the per-tool rows
  interface MatterAgg {
    matter_ref: string;
    display_name: string | null;
    status: string;
    first_activity: string;
    last_activity: string;
    queries: number;
    total_tokens: number;
    cost_usd: number;
  }
  const matterMap = new Map<string, MatterAgg>();
  for (const r of toolRows) {
    let agg = matterMap.get(r.matter_ref);
    if (!agg) {
      agg = { matter_ref: r.matter_ref, display_name: r.display_name, status: r.status,
        first_activity: r.first_activity, last_activity: r.last_activity, queries: 0, total_tokens: 0, cost_usd: 0 };
      matterMap.set(r.matter_ref, agg);
    }
    const rate = TOOL_COST_RATES[r.tool_name] ?? 1.25;
    agg.queries      += r.queries;
    agg.total_tokens += r.tool_tokens;
    agg.cost_usd     += (r.tool_tokens / 1_000_000) * rate;
    // Keep earliest first_activity and latest last_activity
    if (r.first_activity < agg.first_activity) agg.first_activity = r.first_activity;
    if (r.last_activity  > agg.last_activity)  agg.last_activity  = r.last_activity;
  }

  const matters = [...matterMap.values()].sort((a, b) => b.last_activity.localeCompare(a.last_activity));

  const csvEsc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header = ['Matter Ref', 'Display Name', 'Status', 'First Activity', 'Last Activity', 'Queries', 'Tokens', 'Cost (USD)', 'Cost (AUD)'].map(csvEsc).join(',');

  const dataRows = matters.map((m) =>
    [m.matter_ref, m.display_name ?? '', m.status,
      fmtDateTime(m.first_activity), fmtDateTime(m.last_activity),
      String(m.queries), String(m.total_tokens),
      m.cost_usd.toFixed(6), (m.cost_usd * AUD_PER_USD).toFixed(6),
    ].map(csvEsc).join(','),
  );

  const grandUsd = matters.reduce((s, m) => s + m.cost_usd, 0);
  const grandQueries = matters.reduce((s, m) => s + m.queries, 0);
  const grandTokens  = matters.reduce((s, m) => s + m.total_tokens, 0);
  const summaryRow = ['TOTAL', '', '', '', '', String(grandQueries), String(grandTokens),
    grandUsd.toFixed(6), (grandUsd * AUD_PER_USD).toFixed(6)].map(csvEsc).join(',');

  const dateTag = new Date().toISOString().slice(0, 10);
  const suffix  = from || to ? `-${from ?? ''}-${to ?? ''}` : '';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cp-legal-billing-all${suffix}-${dateTag}.csv"`);
  res.send('\uFEFF' + [header, ...dataRows, summaryRow].join('\r\n'));
});

// GET /mcp/matters/:ref/export-billing.csv
mattersRouter.get('/mcp/matters/:ref/export-billing.csv', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const userIsAdmin = getSessionIsAdmin(req);
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');

  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const rows = await getMatterHistory(ref, 1000);
  if (rows.length === 0) { res.status(404).send('Not found'); return; }
  if (!userIsAdmin && !rows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send('Forbidden'); return;
  }

  const csvEsc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const matterInfo = await getMatter(ref).catch(() => null);

  const header = ['Matter Ref', 'Display Name', 'Date', 'Tool', 'Query Summary', 'Tokens', 'Cost USD', 'Cost AUD'].map(csvEsc).join(',');

  const dataRows = rows.map((r) => {
    const tokens = r.api_tokens_used ?? 0;
    const costUsd = (tokens / 1_000_000) * (TOOL_COST_RATES[r.tool_name] ?? 1.25);
    return [ref, matterInfo?.display_name ?? '', fmtDateTime(r.created_at), toolLabel(r.tool_name),
      r.query_text.slice(0, 100), String(tokens), costUsd.toFixed(6), (costUsd * AUD_PER_USD).toFixed(6),
    ].map(csvEsc).join(',');
  });

  const totalUsd = rows.reduce((s, r) => {
    const tokens = r.api_tokens_used ?? 0;
    return s + (tokens / 1_000_000) * (TOOL_COST_RATES[r.tool_name] ?? 1.25);
  }, 0);
  const summaryRow = [ref, '', 'TOTAL', '', '', '', totalUsd.toFixed(6), (totalUsd * AUD_PER_USD).toFixed(6)].map(csvEsc).join(',');

  const safeRef = ref.replace(/[^a-zA-Z0-9\-_]/g, '_');
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cp-legal-billing-${safeRef}-${date}.csv"`);
  res.send('\uFEFF' + [header, ...dataRows, summaryRow].join('\r\n'));
});

// POST /mcp/matters/:ref/notes
mattersRouter.post('/mcp/matters/:ref/notes', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');
  const rows = await getMatterHistory(ref, 1);
  if (!rows.length) { res.status(404).send('Not found'); return; }
  if (!getSessionIsAdmin(req) && !rows.some((r) => r.user_id === user)) { res.status(403).send('Forbidden'); return; }
  const { notes } = req.body as Record<string, string>;
  await upsertMatter(ref, { notes: (notes ?? '').trim().slice(0, 2000) || undefined });
  res.redirect(`/mcp/matters/${encodeURIComponent(ref)}`);
});

// POST /mcp/matters/:ref/set-status
mattersRouter.post('/mcp/matters/:ref/set-status', requireSession, async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) { res.status(403).send('Admin only'); return; }
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');
  const { status } = req.body as Record<string, string>;
  if (status !== 'open' && status !== 'closed') { res.status(400).send('Invalid status'); return; }
  await upsertMatter(ref, { status });
  res.redirect(`/mcp/matters/${encodeURIComponent(ref)}`);
});

// POST /mcp/matters/:ref/rename
mattersRouter.post('/mcp/matters/:ref/rename', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');
  // Check access
  const histRows = await getMatterHistory(ref, 1);
  if (!histRows.length) { res.status(404).send('Not found'); return; }
  if (!getSessionIsAdmin(req) && !histRows.some((r) => r.user_id === user)) { res.status(403).send('Forbidden'); return; }
  const { display_name } = req.body as Record<string, string>;
  const clean = (display_name ?? '').trim().slice(0, 200);
  await upsertMatter(ref, { displayName: clean || undefined });
  res.redirect(`/mcp/matters/${encodeURIComponent(ref)}`);
});
