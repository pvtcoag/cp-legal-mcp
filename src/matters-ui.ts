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
  type MatterSummaryRow,
  type MatterHistoryRow,
  type DashboardStats,
  type ToolUsageStat,
  type UserStatRow,
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
};

// ── Cost helper ───────────────────────────────────────────────────────────────

/** Estimated Isaacus API cost. Rate configurable via ISAACUS_COST_PER_1M_TOKENS (default $2.00). */
function estCost(tokens: number): string {
  if (!tokens) return '—';
  const ratePerM = parseFloat(process.env['ISAACUS_COST_PER_1M_TOKENS'] ?? '2.00');
  const cost = (tokens / 1_000_000) * ratePerM;
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : '<$0.01';
}

function fmtTokens(n: number): string {
  return n > 0 ? n.toLocaleString('en-AU') : '—';
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
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f0; color: #1a1a1a; font-size: 14px; }
nav { background: #1a1a1a; color: #fff; padding: .75rem 2rem; display: flex; align-items: center; gap: 1rem; }
.nav-brand { font-weight: 700; font-size: 1rem; letter-spacing: -.5px; margin-right: auto; }
.nav-links { display: flex; gap: .5rem; }
.nav-link { font-size: .8125rem; color: #bbb; text-decoration: none; padding: .25rem .625rem; border-radius: 4px; }
.nav-link:hover, .nav-link.active { background: #333; color: #fff; }
.nav-user { font-size: .8125rem; color: #bbb; }
.nav-logout { font-size: .8125rem; color: #bbb; text-decoration: none; border: 1px solid #555; border-radius: 4px; padding: .25rem .625rem; }
.nav-logout:hover { background: #333; color: #fff; }
main { max-width: 1200px; margin: 0 auto; padding: 2rem 1.5rem; }
h1 { font-size: 1.375rem; font-weight: 600; margin-bottom: .375rem; }
h2 { font-size: 1rem; font-weight: 600; margin-bottom: .875rem; }
.subtitle { color: #666; font-size: .875rem; margin-bottom: 1.75rem; }
.actions { display: flex; gap: .75rem; margin-bottom: 1.5rem; align-items: center; flex-wrap: wrap; }
.btn { padding: .5rem 1rem; border-radius: 5px; font-size: .875rem; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; border: 1px solid; transition: background .15s; }
.btn-primary { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
.btn-primary:hover { background: #333; }
.btn-secondary { background: #fff; color: #333; border-color: #d0cdc6; }
.btn-secondary:hover { background: #f5f5f0; }
.btn-back { color: #555; text-decoration: none; font-size: .875rem; display: inline-flex; align-items: center; gap: .375rem; margin-bottom: 1.5rem; }
.btn-back:hover { color: #1a1a1a; }
table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; border: 1px solid #e0ddd6; font-size: .8125rem; }
thead th { background: #f0ede8; padding: .625rem 1rem; text-align: left; font-weight: 600; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: #555; border-bottom: 1px solid #e0ddd6; }
tbody tr + tr td { border-top: 1px solid #f0ede8; }
tbody tr:hover td { background: #faf9f7; }
td { padding: .625rem 1rem; vertical-align: top; }
.matter-ref { font-weight: 600; font-family: ui-monospace, "Cascadia Code", monospace; font-size: .875rem; color: #1a1a1a; text-decoration: none; }
.matter-ref:hover { text-decoration: underline; }
.date-small { color: #555; font-size: .75rem; white-space: nowrap; }
.count { font-weight: 600; }
.mono { font-family: ui-monospace, "Cascadia Code", monospace; font-size: .8125rem; }
.users-cell { color: #555; font-size: .8125rem; }
.query-full { white-space: pre-wrap; word-break: break-word; color: #333; min-width: 200px; max-width: 320px; line-height: 1.4; }
.top-results-stack { min-width: 180px; }
.top-results-stack a { color: #1a6b8a; text-decoration: none; display: block; word-break: break-word; margin-bottom: .3rem; font-size: .75rem; line-height: 1.4; }
.top-results-stack a:hover { text-decoration: underline; }
.summary-grid { display: flex; gap: 1rem; margin-bottom: 1.75rem; flex-wrap: wrap; }
.card { background: #fff; border: 1px solid #e0ddd6; border-radius: 6px; padding: 1rem 1.25rem; min-width: 140px; }
.card-label { font-size: .6875rem; color: #888; text-transform: uppercase; letter-spacing: .05em; margin-bottom: .375rem; }
.card-value { font-size: 1.375rem; font-weight: 700; line-height: 1.2; }
.card-value.sm { font-size: .9375rem; margin-top: .125rem; }
.card-sub { font-size: .75rem; color: #555; margin-top: .1875rem; }
.tag { display: inline-block; background: #f0ede8; color: #555; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; margin: .125rem .125rem 0 0; white-space: nowrap; }
.empty { text-align: center; padding: 3rem; color: #888; background: #fff; border: 1px solid #e0ddd6; border-radius: 8px; }
.admin-badge { display: inline-block; background: #e8f4e8; color: #2a6a2a; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; font-weight: 600; margin-left: .5rem; vertical-align: middle; }
.est-badge { display: inline-block; background: #fef9e7; color: #7d6608; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; font-weight: 500; }

/* Search / filter bar */
.filter-bar { background: #fff; border: 1px solid #e0ddd6; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-end; }
.filter-group { display: flex; flex-direction: column; gap: .3rem; }
.filter-group label { font-size: .6875rem; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: .04em; }
.filter-input { padding: .4rem .625rem; border: 1px solid #d0cdc6; border-radius: 5px; font-size: .875rem; background: #fff; height: 32px; }
select.filter-input { cursor: pointer; min-width: 120px; }
.filter-btn { padding: 0 .875rem; background: #1a1a1a; color: #fff; border: none; border-radius: 5px; font-size: .875rem; font-weight: 500; cursor: pointer; height: 32px; }
.filter-btn:hover { background: #333; }
.filter-clear { font-size: .8125rem; color: #888; text-decoration: none; padding-bottom: .125rem; align-self: flex-end; }
.filter-clear:hover { color: #333; }

/* Segmented user tabs (admin) */
.seg-tabs { display: flex; gap: .25rem; background: #f0ede8; border-radius: 6px; padding: .25rem; margin-bottom: 1.5rem; width: fit-content; }
.seg-tab { padding: .3125rem .875rem; border-radius: 4px; font-size: .8125rem; font-weight: 500; text-decoration: none; color: #555; transition: all .15s; }
.seg-tab.active { background: #fff; color: #1a1a1a; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
.seg-tab:hover:not(.active) { color: #1a1a1a; }

/* Tool usage bar chart */
.section-block { background: #fff; border: 1px solid #e0ddd6; border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; }
.section-block h2 { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #555; margin-bottom: 1rem; }
.tool-bar-row { display: flex; align-items: center; gap: .75rem; margin-bottom: .5rem; }
.tool-bar-label { width: 150px; font-size: .8125rem; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.tool-bar-track { flex: 1; height: 8px; background: #f0ede8; border-radius: 4px; overflow: hidden; }
.tool-bar-fill { height: 100%; background: #1a1a1a; border-radius: 4px; }
.tool-bar-meta { font-size: .75rem; color: #888; white-space: nowrap; width: 120px; text-align: right; }

/* Researcher cards */
.researcher-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .75rem; }
.researcher-card { background: #f8f7f4; border: 1px solid #e0ddd6; border-radius: 6px; padding: .875rem 1rem; }
.researcher-name { font-weight: 600; font-size: .9375rem; margin-bottom: .5rem; }
.researcher-stats { font-size: .8125rem; color: #555; display: flex; flex-direction: column; gap: .2rem; }

/* Recent activity */
.activity-list { display: flex; flex-direction: column; gap: .5rem; }
.activity-row { display: flex; gap: .875rem; align-items: baseline; font-size: .8125rem; padding: .4375rem .625rem; border-radius: 5px; }
.activity-row:nth-child(odd) { background: #faf9f7; }
.activity-time { color: #888; white-space: nowrap; width: 130px; flex-shrink: 0; }
.activity-matter { font-weight: 600; font-family: ui-monospace, monospace; color: #1a1a1a; text-decoration: none; white-space: nowrap; }
.activity-matter:hover { text-decoration: underline; }
.activity-query { color: #555; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; }
.activity-user { color: #888; font-size: .75rem; white-space: nowrap; }

/* Login */
.login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
.login-card { background: #fff; border: 1px solid #e0ddd6; border-radius: 8px; padding: 2.5rem 2rem; width: 100%; max-width: 380px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
.login-logo { font-weight: 700; letter-spacing: -.5px; margin-bottom: 1.5rem; font-size: 1.1rem; }
.login-title { font-size: 1.25rem; font-weight: 600; margin-bottom: .25rem; }
.login-sub { font-size: .875rem; color: #666; margin-bottom: 2rem; }
label { display: block; font-size: .875rem; font-weight: 500; margin-bottom: .375rem; color: #333; }
input[type="text"], input[type="password"] { width: 100%; padding: .625rem .75rem; border: 1px solid #d0cdc6; border-radius: 6px; font-size: .9375rem; outline: none; transition: border-color .15s; margin-bottom: 1.25rem; }
input:focus { border-color: #1a1a1a; }
.login-btn { width: 100%; padding: .75rem; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; font-size: 1rem; font-weight: 500; cursor: pointer; transition: background .15s; }
.login-btn:hover { background: #333; }
.error-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; color: #dc2626; font-size: .875rem; padding: .625rem .75rem; margin-bottom: 1.25rem; }

/* Print */
@media print {
  body { background: #fff; font-size: 9pt; }
  nav, .actions, .btn-back, .no-print, .filter-bar, .seg-tabs, .section-block { display: none !important; }
  main { max-width: none; padding: 0; }
  h1 { font-size: 12pt; margin-bottom: .2rem; }
  .subtitle { margin-bottom: .5rem; }
  .summary-grid { display: none; }
  .print-header { display: block !important; font-size: 9pt; color: #555; margin-bottom: 1rem; }
  table { font-size: 7.5pt; border: 1px solid #aaa; }
  thead th { background: #eee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: .2rem .4rem !important; }
  td { padding: .2rem .4rem !important; }
  .query-full { max-width: none; white-space: pre-wrap; word-break: break-word; }
  .top-results-stack a { color: #333; text-decoration: none; }
  tr { page-break-inside: avoid; }
  @page { margin: 1.5cm; }
}
.print-header { display: none; }
`;

function page(title: string, body: string, user?: string, activePath?: string): string {
  const nav = user
    ? `<nav>
        <span class="nav-brand">CP Legal</span>
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
    return `<div class="tool-bar-row">
      <div class="tool-bar-label">${esc(toolLabel(s.tool_name))}</div>
      <div class="tool-bar-track"><div class="tool-bar-fill" style="width:${pct}%"></div></div>
      <div class="tool-bar-meta">${s.query_count} queries · ${fmtTokens(s.total_tokens)} tok</div>
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
        <span>${fmtTokens(u.total_tokens)} tokens · ${estCost(u.total_tokens)} est.</span>
        <span>Last active ${fmtDate(u.last_activity)}</span>
      </div>
    </div>`).join('');
  return `<div class="section-block no-print"><h2>Researchers</h2><div class="researcher-grid">${cards}</div></div>`;
}

function renderDashboardCards(stats: DashboardStats): string {
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
      <div class="card-label">Est. API Cost <span class="est-badge">est</span></div>
      <div class="card-value sm">${estCost(Number(stats.total_tokens))}</div>
      <div class="card-sub">@ $${parseFloat(process.env['ISAACUS_COST_PER_1M_TOKENS'] ?? '2.00').toFixed(2)}/1M tokens</div>
    </div>
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

// GET /matters/login
mattersRouter.get('/matters/login', (req: Request, res: Response) => {
  if (getSessionUser(req)) { res.redirect('/matters'); return; }
  const hasError = !!req.query['error'];
  const next = typeof req.query['next'] === 'string' ? req.query['next'] : '/matters';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(page('Sign in', `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">CP Legal</div>
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

  const [stats, toolStats, userStats, recentActivity] = await Promise.all([
    getDashboardStats(scopedUserId),
    getToolUsageStats(scopedUserId),
    isAdmin(user) ? getUserStats() : Promise.resolve<UserStatRow[]>([]),
    isAdmin(user) ? getRecentActivity(15) : Promise.resolve<MatterHistoryRow[]>([]),
  ]);

  const recentHtml = recentActivity.length > 0 ? `
    <div class="section-block no-print">
      <h2>Recent Activity</h2>
      <div class="activity-list">
        ${recentActivity.map((r) => `
          <div class="activity-row">
            <span class="activity-time">${fmtDateTime(r.created_at)}</span>
            <a href="/matters/${encodeURIComponent(r.matter_ref)}" class="activity-matter">${esc(r.matter_ref)}</a>
            <span class="tag">${esc(toolLabel(r.tool_name))}</span>
            <span class="activity-query">${esc(r.query_text)}</span>
            <span class="activity-user">${esc(r.user_id ?? '—')}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  res.send(page('Dashboard', `
    <h1>Dashboard ${adminBadge}</h1>
    <p class="subtitle">Aggregated research analytics${isAdmin(user) ? ' across all matters and researchers' : ' for your matters'}</p>
    ${renderDashboardCards(stats)}
    ${renderToolChart(toolStats)}
    ${isAdmin(user) ? renderResearcherCards(userStats) : ''}
    ${recentHtml}
  `, user, '/matters/dashboard'));
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
    tableHtml = `<table>
      <thead><tr>
        <th>Matter Ref</th><th>Period</th><th style="text-align:right">Queries</th>
        <th>Researchers</th><th>Tools Used</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  res.send(page('Matters', `
    <h1>Matters ${adminBadge}</h1>
    <p class="subtitle">${matters.length} matter${matters.length !== 1 ? 's' : ''}${search ? ` matching "${esc(search)}"` : ''}</p>
    ${segTabs}
    ${renderFilterBar({ search, allUsers, isAdmin: isAdmin(user), viewUser, action: '/matters' })}
    ${tableHtml}
  `, user, '/matters'));
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
  const activeDays = new Set(allRows.map((r) => r.created_at.slice(0, 10))).size;
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
    return `<tr>
      <td class="date-small">${fmtDateTime(r.created_at)}</td>
      <td><span class="tag">${esc(toolLabel(r.tool_name))}</span></td>
      <td class="users-cell">${esc(r.user_id ?? '—')}</td>
      <td><div class="query-full">${esc(r.query_text)}</div></td>
      <td class="date-small">${esc(r.jurisdiction ?? '—')}</td>
      <td class="count" style="text-align:right">${r.result_count ?? 0}</td>
      <td class="mono" style="text-align:right">${fmtTokens(r.api_tokens_used ?? 0)}</td>
      <td><div class="top-results-stack">${topLinks || '—'}</div></td>
    </tr>`;
  }).join('');

  res.send(page(`${ref} — Research History`, `
    <a href="/matters" class="btn-back no-print">← All Matters</a>
    <div class="print-header">CP Legal Matter Research — printed ${esc(today)}</div>
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
        <div class="card-value sm">${estCost(totalTokens)}</div>
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
    <table>
      <thead><tr>
        <th>Date &amp; Time</th><th>Tool</th><th>Researcher</th><th>Query</th>
        <th>Jurisdiction</th><th style="text-align:right">Results</th>
        <th style="text-align:right">Tokens</th><th>Top Results</th>
      </tr></thead>
      <tbody>${queryRows.length > 0 ? queryRows : '<tr><td colspan="8" style="text-align:center;color:#888;padding:2rem">No queries match this filter.</td></tr>'}</tbody>
    </table>
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
  const header = ['Date/Time', 'Tool', 'Researcher', 'Query', 'Jurisdiction', 'Results', 'Tokens', 'Est Cost', 'Top Results']
    .map(csvEsc).join(',');
  const dataRows = rows.map((r) => {
    const topResults = (r.top_results ?? []).slice(0, 5)
      .map((tr) => `${tr.title}${tr.citation ? ` (${tr.citation})` : ''}: ${tr.url}`)
      .join(' | ');
    const tokens = r.api_tokens_used ?? 0;
    return [
      fmtDateTime(r.created_at),
      toolLabel(r.tool_name),
      r.user_id ?? '',
      r.query_text,
      r.jurisdiction ?? '',
      String(r.result_count ?? 0),
      String(tokens),
      estCost(tokens),
      topResults,
    ].map(csvEsc).join(',');
  });

  const safeRef = ref.replace(/[^a-zA-Z0-9\-_]/g, '_');
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cp-legal-${safeRef}-${date}.csv"`);
  res.send('\uFEFF' + [header, ...dataRows].join('\r\n'));
});
