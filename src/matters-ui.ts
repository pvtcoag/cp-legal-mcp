/**
 * Matter History UI — read-only web interface at /matters
 *
 * Auth:       Cookie session (username + token from MCP_AUTH_TOKENS, 8h TTL)
 * Visibility: Admins (ADMIN_USERS) see all matters.
 *             All others see only matters where they have at least one query.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import {
  isDbEnabled,
  listMatters,
  listMattersForUser,
  getMatterHistory,
  type MatterSummaryRow,
  type MatterHistoryRow,
} from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';

export const mattersRouter = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const COOKIE = 'cvn_matters';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const TOOL_LABELS: Record<string, string> = {
  research_cases: 'Case Research',
  research_legislation: 'Legislation Research',
  get_judgment: 'Judgment',
  ask_judgment: 'Ask Judgment',
  enrich_judgment: 'Enrich Judgment',
  summarise_judgment: 'Summarise',
  classify_legal_issue: 'Classify Issue',
  find_related_cases: 'Related Cases',
  compare_cases: 'Compare Cases',
  find_citing_cases: 'Citing Cases',
  search_by_citation: 'Citation Search',
  format_citation: 'Format Citation',
  generate_pinpoint: 'Pinpoint',
  get_matter_history: 'Matter History',
};

// ── Session ───────────────────────────────────────────────────────────────────

function sessionSecret(): string {
  // SESSION_SECRET preferred; falls back to MCP_AUTH_TOKENS so no extra env var
  // is required (invalidates sessions if tokens rotate, which is acceptable).
  return process.env.SESSION_SECRET ?? process.env.MCP_AUTH_TOKENS ?? 'dev-fallback';
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
  } catch {
    return null;
  }
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
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(signSession(user))}; HttpOnly; Secure; SameSite=Strict; Path=/matters; Max-Age=${8 * 3600}`,
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/matters; Max-Age=0`,
  );
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function adminUsers(): Set<string> {
  return new Set(
    config.ADMIN_USERS.split(',').map((u) => u.trim().toLowerCase()).filter(Boolean),
  );
}

function isAdmin(user: string): boolean {
  return adminUsers().has(user.toLowerCase());
}

function getCredentials(): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (process.env.MCP_AUTH_TOKENS ?? '').split(',')) {
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

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ');
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f0; color: #1a1a1a; font-size: 14px; }
nav { background: #1a1a1a; color: #fff; padding: .75rem 2rem; display: flex; align-items: center; gap: 1rem; }
.nav-brand { font-weight: 700; font-size: 1rem; letter-spacing: -.5px; margin-right: auto; }
.nav-user { font-size: .8125rem; color: #bbb; }
.nav-logout { font-size: .8125rem; color: #bbb; text-decoration: none; border: 1px solid #555; border-radius: 4px; padding: .25rem .625rem; }
.nav-logout:hover { background: #333; color: #fff; }
main { max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem; }
h1 { font-size: 1.375rem; font-weight: 600; margin-bottom: .375rem; }
.subtitle { color: #666; font-size: .875rem; margin-bottom: 1.75rem; }
.actions { display: flex; gap: .75rem; margin-bottom: 1.5rem; align-items: center; }
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
.users-cell { color: #555; font-size: .8125rem; }
.query-text { max-width: 280px; color: #333; }
.top-results { font-size: .75rem; max-width: 220px; }
.top-results a { color: #1a6b8a; text-decoration: none; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: .125rem; }
.top-results a:hover { text-decoration: underline; }
.summary-grid { display: flex; gap: 1rem; margin-bottom: 1.75rem; flex-wrap: wrap; }
.card { background: #fff; border: 1px solid #e0ddd6; border-radius: 6px; padding: 1rem 1.25rem; min-width: 155px; }
.card-label { font-size: .6875rem; color: #888; text-transform: uppercase; letter-spacing: .05em; margin-bottom: .375rem; }
.card-value { font-size: 1.375rem; font-weight: 700; line-height: 1.2; }
.card-value.sm { font-size: .9375rem; margin-top: .125rem; }
.card-sub { font-size: .75rem; color: #555; margin-top: .1875rem; }
.tag { display: inline-block; background: #f0ede8; color: #555; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; margin: .125rem .125rem 0 0; white-space: nowrap; }
.empty { text-align: center; padding: 3rem; color: #888; background: #fff; border: 1px solid #e0ddd6; border-radius: 8px; }
.admin-badge { display: inline-block; background: #e8f4e8; color: #2a6a2a; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; font-weight: 600; margin-left: .5rem; vertical-align: middle; }
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
  body { background: #fff; font-size: 10pt; }
  nav, .actions, .btn-back, .no-print { display: none !important; }
  main { max-width: none; padding: 0; }
  h1 { font-size: 13pt; margin-bottom: .2rem; }
  .subtitle { margin-bottom: .75rem; }
  .summary-grid { display: none; }
  .print-header { display: block !important; font-size: 9pt; color: #555; margin-bottom: 1rem; }
  table { font-size: 8pt; border: 1px solid #aaa; }
  thead th { background: #eee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: .25rem .5rem !important; }
  td { padding: .25rem .5rem !important; }
  .top-results a { color: #333; text-decoration: none; }
  .query-text { max-width: none; }
  tr { page-break-inside: avoid; }
  @page { margin: 1.5cm; }
}
.print-header { display: none; }
`;

function page(title: string, body: string, user?: string): string {
  const nav = user
    ? `<nav>
        <span class="nav-brand">CP Legal</span>
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

// GET /matters — matter list
mattersRouter.get('/matters', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.send(page('Matter Research History', '<div class="empty">Database not enabled on this deployment.</div>', user));
    return;
  }

  const matters: MatterSummaryRow[] = isAdmin(user)
    ? await listMatters()
    : await listMattersForUser(user);

  const adminBadge = isAdmin(user)
    ? '<span class="admin-badge">All matters</span>'
    : '';

  let tableHtml: string;
  if (matters.length === 0) {
    tableHtml = '<div class="empty">No matters on record yet.</div>';
  } else {
    const rows = matters.map((m) => {
      const researchers = (m.users ?? []).join(', ') || '—';
      const tools = (m.tools_used ?? [])
        .map((t) => `<span class="tag">${esc(toolLabel(t))}</span>`)
        .join('');
      return `<tr>
        <td><a href="/matters/${encodeURIComponent(m.matter_ref)}" class="matter-ref">${esc(m.matter_ref)}</a></td>
        <td class="date-small">${fmtDate(m.first_activity)}<br>${fmtDate(m.last_activity)}</td>
        <td class="count">${m.query_count}</td>
        <td class="users-cell">${esc(researchers)}</td>
        <td>${tools}</td>
        <td><a href="/matters/${encodeURIComponent(m.matter_ref)}" class="btn btn-secondary no-print" style="padding:.3rem .75rem;font-size:.8125rem">View →</a></td>
      </tr>`;
    }).join('');
    tableHtml = `<table>
      <thead><tr>
        <th>Matter Ref</th>
        <th>Period</th>
        <th>Queries</th>
        <th>Researchers</th>
        <th>Tools Used</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  res.send(page('Matter Research History', `
    <h1>Matter Research History ${adminBadge}</h1>
    <p class="subtitle">${matters.length} matter${matters.length !== 1 ? 's' : ''} on record</p>
    ${tableHtml}
  `, user));
});

// GET /matters/:ref — matter detail
mattersRouter.get('/matters/:ref', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.status(503).send(page('Error', '<div class="empty">Database not enabled.</div>', user));
    return;
  }

  const rows: MatterHistoryRow[] = await getMatterHistory(ref, 1000);

  if (rows.length === 0) {
    res.status(404).send(page('Not Found', '<div class="empty">Matter not found or no queries on record.</div>', user));
    return;
  }

  // Non-admin: ensure they have at least one query on this matter
  if (!isAdmin(user) && !rows.some((r) => r.user_id === user || r.user_id === null)) {
    res.status(403).send(page('Access Denied', '<div class="empty">You do not have access to this matter.</div>', user));
    return;
  }

  const firstRow = rows[rows.length - 1]!;
  const lastRow = rows[0]!;
  const researchers = [...new Set(rows.map((r) => r.user_id).filter(Boolean))].join(', ') || '—';
  const totalResults = rows.reduce((sum, r) => sum + (r.result_count ?? 0), 0);
  const totalTokens = rows.reduce((sum, r) => sum + (r.api_tokens_used ?? 0), 0);
  const today = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

  const queryRows = rows.map((r) => {
    const topLinks = (r.top_results ?? []).slice(0, 3)
      .map((tr) => `<a href="${esc(tr.url)}" target="_blank" rel="noopener">${esc(tr.title)}${tr.citation ? ` — ${esc(tr.citation)}` : ''}</a>`)
      .join('');
    const tokensCell = r.api_tokens_used ? r.api_tokens_used.toLocaleString() : '—';
    return `<tr>
      <td class="date-small">${fmtDateTime(r.created_at)}</td>
      <td><span class="tag">${esc(toolLabel(r.tool_name))}</span></td>
      <td class="users-cell">${esc(r.user_id ?? '—')}</td>
      <td class="query-text">${esc(r.query_text)}</td>
      <td class="date-small">${esc(r.jurisdiction ?? '—')}</td>
      <td class="count" style="text-align:right">${r.result_count ?? 0}</td>
      <td class="count" style="text-align:right">${tokensCell}</td>
      <td class="top-results">${topLinks || '—'}</td>
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
        <div class="card-value">${rows.length}</div>
      </div>
      <div class="card">
        <div class="card-label">Results Retrieved</div>
        <div class="card-value">${totalResults}</div>
      </div>
      <div class="card">
        <div class="card-label">API Tokens Used</div>
        <div class="card-value">${totalTokens > 0 ? totalTokens.toLocaleString() : '—'}</div>
      </div>
      <div class="card">
        <div class="card-label">Researchers</div>
        <div class="card-value sm">${esc(researchers)}</div>
      </div>
      <div class="card">
        <div class="card-label">Period</div>
        <div class="card-value sm">${fmtDate(firstRow.created_at)}</div>
        <div class="card-sub">to ${fmtDate(lastRow.created_at)}</div>
      </div>
    </div>
    <div class="actions no-print">
      <a href="/matters/${encodeURIComponent(ref)}/export.csv" class="btn btn-secondary" download>Download CSV</a>
      <button class="btn btn-secondary" onclick="window.print()">Print / Save as PDF</button>
    </div>
    <table>
      <thead><tr>
        <th>Date &amp; Time</th>
        <th>Tool</th>
        <th>Researcher</th>
        <th>Query</th>
        <th>Jurisdiction</th>
        <th style="text-align:right">Results</th>
        <th style="text-align:right">Tokens</th>
        <th>Top Results</th>
      </tr></thead>
      <tbody>${queryRows}</tbody>
    </table>
  `, user));
});

// GET /matters/:ref/export.csv — CSV download
mattersRouter.get('/matters/:ref/export.csv', requireSession, async (req: Request, res: Response) => {
  const user = getSessionUser(req)!;
  const ref = decodeURIComponent((req.params['ref'] as string) ?? '');

  if (!isDbEnabled()) { res.status(503).send('Database not enabled'); return; }

  const rows = await getMatterHistory(ref, 1000);
  if (rows.length === 0) { res.status(404).send('Not found'); return; }
  if (!isAdmin(user) && !rows.some((r) => r.user_id === user)) { res.status(403).send('Forbidden'); return; }

  const csvEsc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const header = ['Date/Time', 'Tool', 'Researcher', 'Query', 'Jurisdiction', 'Results', 'Tokens', 'Top Results']
    .map(csvEsc).join(',');
  const dataRows = rows.map((r) => {
    const topResults = (r.top_results ?? []).slice(0, 3)
      .map((tr) => `${tr.title}${tr.citation ? ` (${tr.citation})` : ''}`)
      .join(' | ');
    return [
      fmtDateTime(r.created_at),
      toolLabel(r.tool_name),
      r.user_id ?? '',
      r.query_text,
      r.jurisdiction ?? '',
      String(r.result_count ?? 0),
      String(r.api_tokens_used ?? 0),
      topResults,
    ].map(csvEsc).join(',');
  });

  const safeRef = ref.replace(/[^a-zA-Z0-9\-_]/g, '_');
  const date = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cp-legal-${safeRef}-${date}.csv"`);
  // UTF-8 BOM so Excel opens it correctly without import wizard
  res.send('\uFEFF' + [header, ...dataRows].join('\r\n'));
});
