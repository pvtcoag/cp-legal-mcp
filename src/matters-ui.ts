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
import {
  isDbEnabled,
  listMatters,
  listMattersForUser,
  getMatterHistory,
  getDashboardStats,
  getToolUsageStats,
  getUserStats,
  getRecentActivity,
  getPopularCases,
  getErrorStats,
  getAggregateAccuracy,
  getDashboardCostByTool,
  type MatterSummaryRow,
  type MatterHistoryRow,
  type DashboardStats,
  type ToolUsageStat,
  type UserStatRow,
  type PopularCaseRow,
  type ErrorStatRow,
  type ToolTokenStat,
} from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';

export const mattersRouter = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const COOKIE = 'cvn_matters';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const TOOL_LABELS: Record<string, string> = {
  research_cases:      'Case Research',
  research_legislation:'Legislation Research',
  get_judgment:        'Judgment',
  ask_judgment:        'Ask Judgment',
  enrich_judgment:     'Enrich Judgment',
  summarise_judgment:  'Summarise',
  classify_legal_issue:'Classify Issue',
  find_related_cases:  'Related Cases',
  compare_cases:       'Compare Cases',
  find_citing_cases:   'Citing Cases',
  get_legislation:     'Legislation',
  ask_legislation:     'Ask Legislation',
  search_by_citation:  'Citation Search',
  format_citation:     'Format Citation',
  generate_pinpoint:   'Pinpoint',
  get_matter_history:  'Matter History',
  inspect_database:    'Inspect DB',
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
  ask_judgment:        1.50,  // Kanon Answer Extractor
  ask_legislation:     1.50,  // Kanon Answer Extractor
  compare_cases:       1.50,  // Kanon Answer Extractor
  enrich_judgment:     3.50,  // Kanon 2 Enricher
  summarise_judgment:  1.833, // blended: 1× Enricher + 5× QA (see above)
  research_cases:      1.00,  // Kanon Universal Classifier
  research_legislation:1.00,  // Kanon Universal Classifier
  search_by_citation:  1.00,  // Kanon Universal Classifier
  find_citing_cases:   1.00,  // Kanon Universal Classifier
  find_related_cases:  1.00,  // Kanon Universal Classifier + Embedder (Embedder rate TBC)
  classify_legal_issue:1.00,  // Kanon Universal Classifier
  get_judgment:        0,
  get_legislation:     0,
  format_citation:     0,
  generate_pinpoint:   0,
  get_matter_history:  0,
  inspect_database:    0,
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

/** Compute accurate total cost for a set of history rows using per-tool rates. */
function computeMatterCost(rows: MatterHistoryRow[]): string {
  const total = rows.reduce((sum, r) => {
    const tokens = r.api_tokens_used ?? 0;
    const rate = toolCostRate(r.tool_name);
    return sum + (tokens / 1_000_000) * rate;
  }, 0);
  return fmtCostValue(total);
}

/** Compute accurate total cost from per-tool token aggregates (for dashboard). */
function computeDashboardCost(byTool: ToolTokenStat[]): string {
  const total = byTool.reduce((sum, { tool_name, total_tokens }) => {
    const rate = toolCostRate(tool_name);
    return sum + (total_tokens / 1_000_000) * rate;
  }, 0);
  return fmtCostValue(total);
}

function fmtTokens(n: number): string {
  return n > 0 ? n.toLocaleString('en-AU') : '—';
}

/**
 * Accuracy score badge for Isaacus extractive QA confidence.
 * Legal text scores are typically 5–40%. Thresholds are calibrated for legal extraction:
 * green ≥45% (clear answer), amber ≥20% (probable), red <20% (uncertain/not extractable).
 */
function accuracyBadge(score: number | null | undefined): string {
  if (score == null) return '<span style="color:#aaa">—</span>';
  const pct = Math.round(score * 100);
  const cls = score >= 0.45 ? 'acc-high' : score >= 0.20 ? 'acc-mid' : 'acc-low';
  return `<span class="acc-badge ${cls}" title="Extractive confidence: ${pct}% (legal text typically 5–45%)">${pct}%</span>`;
}

// ── Session ───────────────────────────────────────────────────────────────────

function sessionSecret(): string {
  return process.env['SESSION_SECRET'] ?? process.env['MCP_AUTH_TOKENS'] ?? 'dev-fallback';
}

function signSession(user: string): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${user}:${exp}`;
  const sig = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}:${sig}`;
}

function verifySession(value: string): string | null {
  const lastColon = value.lastIndexOf(':');
  if (lastColon < 0) return null;
  const payload = value.slice(0, lastColon);
  const sig = value.slice(lastColon + 1);
  const colonIdx = payload.indexOf(':');
  if (colonIdx < 0) return null;
  const user = payload.slice(0, colonIdx);
  const exp = parseInt(payload.slice(colonIdx + 1), 10);
  if (!user || isNaN(exp) || Date.now() > exp) return null;
  const expected = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  try {
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length) return null;
    return timingSafeEqual(a, b) ? user : null;
  } catch { return null; }
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function getSessionUser(req: Request): string | null {
  const raw = parseCookies(req)[COOKIE];
  return raw ? verifySession(raw) : null;
}

function setSessionCookie(res: Response, user: string): void {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(signSession(user))}; HttpOnly; Secure; SameSite=Strict; Path=/matters; Max-Age=${8 * 3600}`);
}

function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie',
    `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/matters; Max-Age=0`);
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function adminUsers(): Set<string> {
  return new Set(config.ADMIN_USERS.split(',').map((u) => u.trim().toLowerCase()).filter(Boolean));
}

function isAdmin(user: string): boolean {
  return adminUsers().has(user.toLowerCase());
}

function getCredentials(): Map<string, string> {
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

function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!getSessionUser(req)) {
    res.redirect(`/matters/login?next=${encodeURIComponent(req.path)}`);
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
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --primary:   #0B1F33;
  --secondary: #2E3A46;
  --accent:    #B79A5B;
  --light:     #F5F3EF;
  --text:      #1A1A1A;
  --border:    #E0DDD6;
  --surface:   #FAFAF8;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--light); color: var(--text); font-size: 14px; }
h1 { font-family: 'Canela', Georgia, 'Times New Roman', serif; font-size: 1.5rem; font-weight: 400; margin-bottom: .375rem; color: var(--primary); }
h2 { font-family: 'Canela', Georgia, 'Times New Roman', serif; font-size: 1.0625rem; font-weight: 400; margin-bottom: .875rem; color: var(--primary); }
nav { background: var(--primary); color: #fff; padding: .75rem 2rem; display: flex; align-items: center; gap: 1rem; }
.nav-brand { display: flex; align-items: center; gap: .625rem; margin-right: auto; text-decoration: none; }
.nav-brand-fallback { font-weight: 700; font-size: 1rem; letter-spacing: -.5px; color: #fff; display: none; }
.nav-links { display: flex; gap: .5rem; }
.nav-link { font-size: .8125rem; color: rgba(255,255,255,.7); text-decoration: none; padding: .25rem .625rem; border-radius: 4px; }
.nav-link:hover, .nav-link.active { background: var(--secondary); color: #fff; }
.nav-user { font-size: .8125rem; color: rgba(255,255,255,.6); }
.nav-logout { font-size: .8125rem; color: rgba(255,255,255,.7); text-decoration: none; border: 1px solid rgba(255,255,255,.3); border-radius: 4px; padding: .25rem .625rem; }
.nav-logout:hover { background: var(--secondary); color: #fff; }
main { max-width: 1200px; margin: 0 auto; padding: 2rem 1.5rem; }
.subtitle { color: #666; font-size: .875rem; margin-bottom: 1.75rem; }
.actions { display: flex; gap: .75rem; margin-bottom: 1.5rem; align-items: center; flex-wrap: wrap; }
.btn { padding: .5rem 1rem; border-radius: 5px; font-size: .875rem; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; border: 1px solid; transition: background .15s; }
.btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.btn-primary:hover { background: var(--secondary); border-color: var(--secondary); }
.btn-secondary { background: #fff; color: #333; border-color: var(--border); }
.btn-secondary:hover { background: var(--light); }
.btn-back { color: #555; text-decoration: none; font-size: .875rem; display: inline-flex; align-items: center; gap: .375rem; margin-bottom: 1.5rem; }
.btn-back:hover { color: var(--primary); }
.table-wrap { overflow-x: auto; border-radius: 8px; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; border: 1px solid var(--border); font-size: .8125rem; }
.table-wrap table { border-radius: 0; border: none; }
thead th { background: #F0EDE8; padding: .625rem 1rem; text-align: left; font-weight: 600; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: #555; border-bottom: 1px solid var(--border); }
tbody tr + tr td { border-top: 1px solid #F0EDE8; }
tbody tr:hover td { background: #FAFAF8; }
tbody tr.row-error td { background: #FFF8F8 !important; }
tbody tr.row-error:hover td { background: #FFF1F1 !important; }
td { padding: .625rem 1rem; vertical-align: top; }
.matter-ref { font-weight: 600; font-family: ui-monospace, "Cascadia Code", monospace; font-size: .875rem; color: var(--primary); text-decoration: none; }
.matter-ref:hover { text-decoration: underline; }
.date-small { color: #555; font-size: .75rem; white-space: nowrap; }
.count { font-weight: 600; }
.mono { font-family: ui-monospace, "Cascadia Code", monospace; font-size: .8125rem; }
.users-cell { color: #555; font-size: .8125rem; }
.query-full { white-space: pre-wrap; word-break: break-word; color: #333; line-height: 1.4; }
.top-results-stack { }
.top-results-stack a { color: #1a6b8a; text-decoration: none; display: block; word-break: break-word; margin-bottom: .3rem; font-size: .75rem; line-height: 1.4; }
.top-results-stack a:hover { text-decoration: underline; }
.summary-grid { display: flex; gap: 1rem; margin-bottom: 1.75rem; flex-wrap: wrap; }
.card { background: #fff; border: 1px solid var(--border); border-radius: 6px; padding: 1rem 1.25rem; min-width: 140px; }
.card-label { font-size: .6875rem; color: #888; text-transform: uppercase; letter-spacing: .05em; margin-bottom: .375rem; }
.card-value { font-size: 1.375rem; font-weight: 700; line-height: 1.2; color: var(--primary); }
.card-value.sm { font-size: .9375rem; margin-top: .125rem; }
.card-sub { font-size: .75rem; color: #555; margin-top: .1875rem; }
.tag { display: inline-block; background: #F0EDE8; color: #555; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; margin: .125rem .125rem 0 0; white-space: nowrap; }
.empty { text-align: center; padding: 3rem; color: #888; background: #fff; border: 1px solid var(--border); border-radius: 8px; }
.admin-badge { display: inline-block; background: #e8f4e8; color: #2a6a2a; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; font-weight: 600; margin-left: .5rem; vertical-align: middle; }
.est-badge { display: inline-block; background: #fef9e7; color: #7d6608; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; font-weight: 500; }
.acc-badge { display: inline-block; padding: .125rem .4rem; border-radius: 10px; font-size: .6875rem; font-weight: 600; }
.acc-high { background: #d1fae5; color: #065f46; }
.acc-mid  { background: #fef3c7; color: #92400e; }
.acc-low  { background: #fee2e2; color: #991b1b; }

/* Search / filter bar */
.filter-bar { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-end; }
.filter-group { display: flex; flex-direction: column; gap: .3rem; }
.filter-group label { font-size: .6875rem; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: .04em; }
.filter-input { padding: .4rem .625rem; border: 1px solid #d0cdc6; border-radius: 5px; font-size: .875rem; background: #fff; height: 32px; }
select.filter-input { cursor: pointer; min-width: 120px; }
.filter-btn { padding: 0 .875rem; background: var(--primary); color: #fff; border: none; border-radius: 5px; font-size: .875rem; font-weight: 500; cursor: pointer; height: 32px; }
.filter-btn:hover { background: var(--secondary); }
.filter-clear { font-size: .8125rem; color: #888; text-decoration: none; padding-bottom: .125rem; align-self: flex-end; }
.filter-clear:hover { color: #333; }

/* Segmented user tabs (admin) */
.seg-tabs { display: flex; gap: .25rem; background: #F0EDE8; border-radius: 6px; padding: .25rem; margin-bottom: 1.5rem; width: fit-content; flex-wrap: wrap; }
.seg-tab { padding: .3125rem .875rem; border-radius: 4px; font-size: .8125rem; font-weight: 500; text-decoration: none; color: #555; transition: all .15s; }
.seg-tab.active { background: #fff; color: var(--primary); box-shadow: 0 1px 3px rgba(0,0,0,.1); }
.seg-tab:hover:not(.active) { color: var(--primary); }

/* Tool usage bar chart */
.section-block { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; }
.section-block h2 { font-family: inherit; font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #555; margin-bottom: 1rem; }
.tool-bar-row { display: flex; align-items: center; gap: .75rem; margin-bottom: .5rem; }
.tool-bar-label { width: 150px; font-size: .8125rem; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.tool-bar-track { flex: 1; height: 8px; background: #F0EDE8; border-radius: 4px; overflow: hidden; }
.tool-bar-fill { height: 100%; background: var(--accent); border-radius: 4px; }
.tool-bar-meta { font-size: .75rem; color: #888; white-space: nowrap; width: 120px; text-align: right; }

/* Researcher cards */
.researcher-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .75rem; }
.researcher-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: .875rem 1rem; }
.researcher-name { font-weight: 600; font-size: .9375rem; margin-bottom: .5rem; color: var(--primary); }
.researcher-stats { font-size: .8125rem; color: #555; display: flex; flex-direction: column; gap: .2rem; }

/* Popular cases */
.popular-case-row { display: flex; gap: .75rem; align-items: baseline; padding: .4375rem 0; border-bottom: 1px solid #F0EDE8; font-size: .8125rem; }
.popular-case-row:last-child { border-bottom: none; }
.popular-case-rank { color: #aaa; font-size: .75rem; width: 1.25rem; flex-shrink: 0; text-align: right; }
.popular-case-title { flex: 1; }
.popular-case-title a { color: #1a6b8a; text-decoration: none; }
.popular-case-title a:hover { text-decoration: underline; }
.popular-case-citation { color: #555; font-size: .75rem; white-space: nowrap; }
.popular-case-count { font-weight: 600; color: var(--primary); white-space: nowrap; font-size: .75rem; }

/* Login */
.login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; background: var(--light); }
.login-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 2.5rem 2rem; width: 100%; max-width: 380px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
.login-logo { margin-bottom: 1.5rem; }
.login-title { font-family: 'Canela', Georgia, 'Times New Roman', serif; font-size: 1.375rem; font-weight: 400; margin-bottom: .25rem; color: var(--primary); }
.login-sub { font-size: .875rem; color: #666; margin-bottom: 2rem; }
label { display: block; font-size: .875rem; font-weight: 500; margin-bottom: .375rem; color: #333; }
input[type="text"], input[type="password"] { width: 100%; padding: .625rem .75rem; border: 1px solid #d0cdc6; border-radius: 6px; font-size: .9375rem; outline: none; transition: border-color .15s; margin-bottom: 1.25rem; }
input:focus { border-color: var(--primary); }
.login-btn { width: 100%; padding: .75rem; background: var(--primary); color: #fff; border: none; border-radius: 6px; font-size: 1rem; font-weight: 500; cursor: pointer; transition: background .15s; }
.login-btn:hover { background: var(--secondary); }
.error-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; color: #dc2626; font-size: .875rem; padding: .625rem .75rem; margin-bottom: 1.25rem; }

/* Print */
@media print {
  body { background: #fff; font-size: 8.5pt; font-family: Georgia, serif; }
  nav, .actions, .btn-back, .no-print, .filter-bar, .seg-tabs, .section-block { display: none !important; }
  main { max-width: none; padding: 0; }
  h1 { font-size: 13pt; font-family: Georgia, serif; margin-bottom: .2rem; color: #000; }
  .subtitle { margin-bottom: .5rem; }
  .summary-grid { display: none; }
  .print-header { display: block !important; margin-bottom: 1rem; }
  .print-header-firm { font-family: Georgia, serif; font-size: 11pt; font-weight: bold; color: #0B1F33; }
  .print-header-sub { font-size: 7.5pt; color: #555; margin-top: .125rem; }
  /* Hide heavy columns in print — links don't work on paper */
  .no-print-col { display: none !important; }
  table { font-size: 7pt; border: 1px solid #aaa; table-layout: fixed; }
  thead th { background: #eee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: .15rem .3rem !important; font-size: 6.5pt; }
  td { padding: .15rem .3rem !important; vertical-align: top; word-break: break-word; }
  .query-full { white-space: pre-wrap; word-break: break-word; }
  .top-results-stack a { color: #333; text-decoration: none; }
  .acc-badge { border: 1px solid #999; background: none !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  tr { page-break-inside: avoid; }
  @page { size: A4 landscape; margin: 1cm 1.5cm; }
}
.print-header { display: none; }
`;

const LOGO_SRC = '';

/** No-cache middleware — prevents Cloudflare and browsers from serving stale matter pages. */
function noCache(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function page(title: string, body: string, user?: string, activePath?: string, autoRefreshSecs?: number): string {
  const nav = user
    ? `<nav>
        <a href="/matters" class="nav-brand">
          <img src="${LOGO_SRC}" alt="CP Legal" height="26" style="display:block"
               onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
          <span class="nav-brand-fallback">CP Legal</span>
        </a>
        <div class="nav-links">
          <a href="/matters" class="nav-link${activePath === '/matters' ? ' active' : ''}">Matters</a>
          <a href="/matters/dashboard" class="nav-link${activePath === '/matters/dashboard' ? ' active' : ''}">Dashboard</a>
        </div>
        <span class="nav-user">${esc(user)}</span>
        <a href="/matters/logout" class="nav-logout no-print">Sign out</a>
      </nav>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — CP Legal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${autoRefreshSecs ? `<meta http-equiv="refresh" content="${autoRefreshSecs}">` : ''}
  <style>${CSS}</style>
</head>
<body>
${nav}
<main>${body}</main>
</body>
</html>`;
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
      <div class="tool-bar-meta">${s.query_count} queries · ${costStr !== '—' ? costStr : fmtTokens(s.total_tokens) + ' tok'}</div>
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
        <span>Last active ${fmtDate(u.last_activity)}</span>
      </div>
    </div>`).join('');
  return `<div class="section-block no-print"><h2>Researchers</h2><div class="researcher-grid">${cards}</div></div>`;
}

function renderRailwayCosts(): string {
  const uptimeDays = process.uptime() / 86400;
  const memMB = process.memoryUsage().rss / (1024 * 1024);
  const memGB = memMB / 1024;
  // Estimate since deploy: memory cost (current RSS × uptime as lower bound)
  const estMemCost = memGB * (uptimeDays * 24 * 60) * 0.000231;
  const estCpuCost = 0.5 * (uptimeDays * 24 * 60) * 0.000463; // ~0.5 vCPU est
  const estInfraCost = estMemCost + estCpuCost;
  return `<div class="section-block no-print"><h2>Railway Infrastructure Costs</h2>
    <p style="font-size:.8125rem;color:#555;margin-bottom:.875rem">
      Infrastructure costs run independently of per-query API usage.
      Egress and volume costs are not tracked per-query.
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.75rem;margin-bottom:.875rem">
      <div class="card" style="min-width:0">
        <div class="card-label">Memory</div>
        <div class="card-value sm">$0.000231<span style="font-size:.6875rem;font-weight:400;color:#888">/GB/min</span></div>
        <div class="card-sub">~${memMB.toFixed(0)} MB current RSS</div>
      </div>
      <div class="card" style="min-width:0">
        <div class="card-label">CPU</div>
        <div class="card-value sm">$0.000463<span style="font-size:.6875rem;font-weight:400;color:#888">/vCPU/min</span></div>
      </div>
      <div class="card" style="min-width:0">
        <div class="card-label">Egress</div>
        <div class="card-value sm">$0.05<span style="font-size:.6875rem;font-weight:400;color:#888">/GB</span></div>
      </div>
      <div class="card" style="min-width:0">
        <div class="card-label">Volume Storage</div>
        <div class="card-value sm">$0.00000347<span style="font-size:.6875rem;font-weight:400;color:#888">/GB/min</span></div>
      </div>
      <div class="card" style="min-width:0">
        <div class="card-label">Est. Since Deploy <span class="est-badge">est</span></div>
        <div class="card-value sm">${fmtCostValue(estInfraCost)}</div>
        <div class="card-sub">${(uptimeDays).toFixed(1)} day uptime · excl. egress &amp; volume</div>
      </div>
    </div>
  </div>`;
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
  if (stats.length === 0) return '';
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

function renderDashboardCards(
  stats: DashboardStats,
  costByTool: ToolTokenStat[],
  avgAccuracy: number | null,
): string {
  const accuracyHtml = avgAccuracy != null
    ? `<div class="card">
        <div class="card-label">Avg Extraction Accuracy
          <span title="Isaacus Kanon Answer Extractor confidence. Legal text typically scores 5–45% — this reflects extractability, not answer correctness." style="cursor:help;color:#aaa;margin-left:.25rem">ⓘ</span>
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
      <div class="card-value">${stats.total_tokens > 0 ? Math.round(stats.total_tokens / 1000).toLocaleString('en-AU') + 'K' : '—'}</div>
    </div>
    <div class="card">
      <div class="card-label">Est. Isaacus Cost <span class="est-badge">est</span></div>
      <div class="card-value sm">${computeDashboardCost(costByTool)}</div>
      <div class="card-sub">Per-tool rates</div>
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

// GET /matters/login
mattersRouter.get('/matters/login', (req: Request, res: Response) => {
  if (getSessionUser(req)) { res.redirect('/matters'); return; }
  const hasError = !!req.query['error'];
  const next = typeof req.query['next'] === 'string' ? req.query['next'] : '/matters';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(page('Sign in', `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">
          <img src="${LOGO_SRC}" alt="CP Legal" height="28" style="display:block"
               onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
          <span style="display:none;font-weight:700;font-size:1.1rem;color:#0B1F33">CP Legal</span>
        </div>
        <h1 class="login-title">Matter Research</h1>
        <p class="login-sub">Sign in to view research history.</p>
        ${hasError ? '<div class="error-box">Incorrect username or token. Please try again.</div>' : ''}
        <form method="POST" action="/matters/login">
          <input type="hidden" name="next" value="${esc(next)}">
          <label for="u">Username</label>
          <input type="text" id="u" name="username" autocomplete="username" required autofocus>
          <label for="p">Token</label>
          <input type="password" id="p" name="password" autocomplete="current-password" required>
          <button class="login-btn" type="submit">Sign in</button>
        </form>
      </div>
    </div>
  `));
});

// POST /matters/login
mattersRouter.post('/matters/login', (req: Request, res: Response) => {
  const { username, password, next } = req.body as Record<string, string | undefined>;
  const user = (username ?? '').trim().toLowerCase();
  const token = (password ?? '').trim();
  const redirectTo = typeof next === 'string' && next.startsWith('/matters') ? next : '/matters';
  const creds = getCredentials();
  const expected = creds.get(user);
  let ok = false;
  if (expected && token.length === expected.length) {
    try { ok = timingSafeEqual(Buffer.from(token), Buffer.from(expected)); } catch { /* */ }
  }
  if (!ok) {
    logger.warn({ user }, 'matters-ui: failed login attempt');
    res.redirect('/matters/login?error=1');
    return;
  }
  setSessionCookie(res, user);
  logger.info({ user }, 'matters-ui: login');
  res.redirect(redirectTo);
});

// GET /matters/logout
mattersRouter.get('/matters/logout', (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.redirect('/matters/login');
});

// GET /matters/dashboard
mattersRouter.get('/matters/dashboard', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.send(page('Dashboard', '<div class="empty">Database not enabled on this deployment.</div>', user, '/matters/dashboard'));
    return;
  }

  const scopedUserId = isAdmin(user) ? undefined : user;
  const adminBadge = isAdmin(user) ? '<span class="admin-badge">All researchers</span>' : '';

  const [stats, toolStats, userStats, recentActivity, popularCases, errorStats, costByTool, avgAccuracy] = await Promise.all([
    getDashboardStats(scopedUserId),
    getToolUsageStats(scopedUserId),
    isAdmin(user) ? getUserStats() : Promise.resolve<UserStatRow[]>([]),
    getRecentActivity(20, scopedUserId),
    isAdmin(user) ? getPopularCases(10) : Promise.resolve<PopularCaseRow[]>([]),
    getErrorStats(scopedUserId),
    getDashboardCostByTool(scopedUserId),
    getAggregateAccuracy(scopedUserId),
  ]);

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
              <td class="date-small">${fmtDateTime(r.created_at)}</td>
              <td><a href="/matters/${encodeURIComponent(r.matter_ref)}" class="matter-ref">${esc(r.matter_ref)}</a></td>
              <td><span class="tag">${esc(toolLabel(r.tool_name))}</span></td>
              <td class="users-cell">${esc(r.user_id ?? '—')}</td>
              <td style="white-space:pre-wrap;word-break:break-word;color:#555;max-width:380px">${esc(r.query_text)}</td>
              <td style="text-align:center">${accuracyBadge(r.accuracy_score)}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>` : '';

  const lastUpdated = new Date().toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  });

  res.send(page('Dashboard', `
    <h1>Dashboard ${adminBadge}</h1>
    <p class="subtitle">Aggregated research analytics${isAdmin(user) ? ' across all matters and researchers' : ' for your matters'}
      <span style="float:right;font-size:.75rem;color:#aaa">Updated ${esc(lastUpdated)} · auto-refreshes every 5 min</span>
    </p>
    ${renderDashboardCards(stats, costByTool, avgAccuracy)}
    ${renderToolChart(toolStats)}
    ${isAdmin(user) ? renderResearcherCards(userStats) : ''}
    ${isAdmin(user) ? renderPopularCases(popularCases) : ''}
    ${isAdmin(user) ? renderRailwayCosts() : ''}
    ${renderErrorStats(errorStats)}
    ${recentHtml}
  `, user, '/matters/dashboard', 300));
});

// GET /matters — matter list
mattersRouter.get('/matters', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.send(page('Matters', '<div class="empty">Database not enabled on this deployment.</div>', user, '/matters'));
    return;
  }

  const search = typeof req.query['search'] === 'string' ? req.query['search'].trim() : undefined;
  const viewUser = isAdmin(user) && typeof req.query['user'] === 'string' ? req.query['user'].trim() : undefined;
  const adminBadge = isAdmin(user) ? '<span class="admin-badge">Admin</span>' : '';
  const allUsers = [...getCredentials().keys()];

  // Admin: default to all matters; can filter by user via ?user=
  const matters: MatterSummaryRow[] = isAdmin(user)
    ? (viewUser ? await listMattersForUser(viewUser, search) : await listMatters(search))
    : await listMattersForUser(user, search);

  // Admin user toggle tabs
  const segTabs = isAdmin(user)
    ? `<div class="seg-tabs no-print">
        <a href="/matters" class="seg-tab${!viewUser ? ' active' : ''}">All Matters</a>
        ${allUsers.map((u) => `<a href="/matters?user=${encodeURIComponent(u)}" class="seg-tab${viewUser === u ? ' active' : ''}">${esc(u)}</a>`).join('')}
      </div>`
    : '';

  let tableHtml: string;
  if (matters.length === 0) {
    tableHtml = `<div class="empty">${search ? `No matters matching "${esc(search)}".` : 'No matters on record yet.'}</div>`;
  } else {
    const rows = matters.map((m) => {
      const researchers = (m.users ?? []).join(', ') || '—';
      const tools = (m.tools_used ?? []).map((t) => `<span class="tag">${esc(toolLabel(t))}</span>`).join('');
      return `<tr>
        <td><a href="/matters/${encodeURIComponent(m.matter_ref)}" class="matter-ref">${esc(m.matter_ref)}</a></td>
        <td class="date-small">${fmtDate(m.first_activity)}<br>${fmtDate(m.last_activity)}</td>
        <td class="count" style="text-align:right">${m.query_count}</td>
        <td class="users-cell">${esc(researchers)}</td>
        <td>${tools}</td>
        <td><a href="/matters/${encodeURIComponent(m.matter_ref)}" class="btn btn-secondary no-print" style="padding:.3rem .75rem;font-size:.8125rem">View →</a></td>
      </tr>`;
    }).join('');
    tableHtml = `<div class="table-wrap"><table>
      <thead><tr>
        <th>Matter Ref</th><th>Period</th><th style="text-align:right">Queries</th>
        <th>Researchers</th><th>Tools Used</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  res.send(page('Matters', `
    <h1>Matters ${adminBadge}</h1>
    <p class="subtitle">${matters.length} matter${matters.length !== 1 ? 's' : ''}${search ? ` matching "${esc(search)}"` : ''}</p>
    ${segTabs}
    ${renderFilterBar({ search, allUsers, isAdmin: isAdmin(user), viewUser, action: '/matters' })}
    ${tableHtml}
  `, user, '/matters', 300));
});

// GET /matters/:ref — matter detail
mattersRouter.get('/matters/:ref', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');
  const toolFilter = typeof req.query['tool'] === 'string' ? req.query['tool'].trim() : undefined;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.status(503).send(page('Error', '<div class="empty">Database not enabled.</div>', user));
    return;
  }

  const rows: MatterHistoryRow[] = await getMatterHistory(ref, 1000, toolFilter);

  if (rows.length === 0 && !toolFilter) {
    res.status(404).send(page('Not Found', '<div class="empty">Matter not found or no queries on record.</div>', user));
    return;
  }

  if (!isAdmin(user) && !rows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send(page('Access Denied', '<div class="empty">You do not have access to this matter.</div>', user));
    return;
  }

  // For access check when tool filter returns 0, fetch unfiltered
  const allRows = toolFilter && rows.length === 0 ? await getMatterHistory(ref, 1000) : rows;
  if (allRows.length === 0) {
    res.status(404).send(page('Not Found', '<div class="empty">Matter not found.</div>', user));
    return;
  }
  if (!isAdmin(user) && !allRows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send(page('Access Denied', '<div class="empty">You do not have access to this matter.</div>', user));
    return;
  }

  const displayRows = rows.length > 0 ? rows : allRows;
  const firstRow = allRows[allRows.length - 1]!;
  const lastRow = allRows[0]!;
  const researchers = [...new Set(allRows.map((r) => r.user_id).filter(Boolean))].join(', ') || '—';
  const totalResults = displayRows.reduce((s, r) => s + (r.result_count ?? 0), 0);
  const totalTokens = displayRows.reduce((s, r) => s + (r.api_tokens_used ?? 0), 0);
  const activeDays = new Set(allRows.map((r) => new Date(r.created_at).toISOString().slice(0, 10))).size;
  const today = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

  // Tool filter dropdown — use allRows distinct tools
  const distinctTools = [...new Set(allRows.map((r) => r.tool_name))].sort();
  const toolOptions = `<option value="">All Tools (${allRows.length})</option>` +
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
      <td class="date-small">${fmtDateTime(r.created_at)}</td>
      <td><span class="tag">${esc(toolLabel(r.tool_name))}</span></td>
      <td class="users-cell">${esc(r.user_id ?? '—')}</td>
      <td><div class="query-full">${esc(r.query_text)}</div></td>
      <td class="date-small">${esc(r.jurisdiction ?? '—')}</td>
      <td class="count" style="text-align:right">${r.result_count ?? 0}</td>
      <td class="mono no-print-col" style="text-align:right">${fmtTokens(r.api_tokens_used ?? 0)}</td>
      <td style="text-align:right">${costCell}</td>
      <td style="text-align:center">${accuracyBadge(r.accuracy_score)}</td>
      <td class="no-print-col"><div class="top-results-stack">${topLinks || '—'}</div></td>
    </tr>`;
  }).join('');

  res.send(page(`${ref} — Research History`, `
    <a href="/matters" class="btn-back no-print">← All Matters</a>
    <div class="print-header">
      <div class="print-header-firm">CP Legal</div>
      <div class="print-header-sub">Matter Research Report — printed ${esc(today)}</div>
    </div>
    <h1>${esc(ref)}</h1>
    <p class="subtitle">${fmtDate(firstRow.created_at)} to ${fmtDate(lastRow.created_at)}</p>
    <div class="summary-grid">
      <div class="card">
        <div class="card-label">Total Queries</div>
        <div class="card-value">${allRows.length}</div>
        ${toolFilter ? `<div class="card-sub">${displayRows.length} shown (filtered)</div>` : ''}
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
        <div class="card-value">${totalTokens > 0 ? Math.round(totalTokens / 1000).toLocaleString('en-AU') + 'K' : '—'}</div>
      </div>
      <div class="card">
        <div class="card-label">Est. API Cost <span class="est-badge">est</span></div>
        <div class="card-value sm">${computeMatterCost(displayRows)}</div>
        <div class="card-sub">Per-tool Isaacus rates</div>
      </div>
      <div class="card">
        <div class="card-label">Researchers</div>
        <div class="card-value sm">${esc(researchers)}</div>
      </div>
    </div>
    <div class="actions no-print">
      <a href="/matters/${encodeURIComponent(ref)}/export.csv" class="btn btn-secondary" download>Download CSV</a>
      <button class="btn btn-secondary" onclick="window.print()">Print / Save PDF</button>
    </div>
    <form method="GET" action="/matters/${encodeURIComponent(ref)}" class="filter-bar no-print" style="margin-bottom:1rem">
      <div class="filter-group">
        <label>Filter by Tool</label>
        <select name="tool" class="filter-input" onchange="this.form.submit()">${toolOptions}</select>
      </div>
      ${toolFilter ? `<a href="/matters/${encodeURIComponent(ref)}" class="filter-clear">Clear filter</a>` : ''}
    </form>
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Date &amp; Time</th><th>Tool</th><th>Researcher</th><th>Query</th>
        <th>Jurisdiction</th><th style="text-align:right">Results</th>
        <th class="no-print-col" style="text-align:right">Tokens</th>
        <th style="text-align:right">Cost</th>
        <th style="text-align:center">Accuracy
          <span class="no-print-col" title="Isaacus extractive confidence. Legal text typically scores 5–45%." style="cursor:help;color:#aaa;margin-left:.2rem;font-weight:400">ⓘ</span>
        </th>
        <th class="no-print-col">Top Results</th>
      </tr></thead>
      <tbody>${queryRows.length > 0 ? queryRows : '<tr><td colspan="10" style="text-align:center;color:#888;padding:2rem">No queries match this filter.</td></tr>'}</tbody>
    </table>
    </div>
  `, user, '/matters'));
});

// GET /matters/:ref/export.csv
mattersRouter.get('/matters/:ref/export.csv', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');

  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const rows = await getMatterHistory(ref, 1000);
  if (rows.length === 0) { res.status(404).send('Not found'); return; }
  if (!isAdmin(user) && !rows.some((r) => r.user_id === user || r.user_id === null)) {
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
