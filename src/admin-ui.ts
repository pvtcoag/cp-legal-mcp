/**
 * Admin Panel — /admin
 *
 * Auth:    Shared session cookie (cvn_matters, now Path=/).
 *          requireAdmin middleware checks is_admin flag from session.
 *          If not logged in: redirect to /matters/login?next=/admin
 *          If logged in but not admin: 403 HTML page.
 *
 * Pages:
 *   GET  /admin                         — Dashboard
 *   GET  /admin/users                   — User list
 *   GET  /admin/users/new               — New user form
 *   POST /admin/users/new               — Create user (renders token once)
 *   GET  /admin/users/:username         — User detail
 *   POST /admin/users/:username/rotate-token
 *   POST /admin/users/:username/toggle-admin
 *   POST /admin/users/:username/toggle-active
 *   POST /admin/users/:username/delete
 *   GET  /admin/config                  — App config
 *   POST /admin/config                  — Update config key
 *   GET  /admin/data                    — Data management
 *   POST /admin/data/purge-queries
 *   POST /admin/data/purge-cache
 *   POST /admin/data/purge-cache-all
 *   GET  /admin/watchlist               — Precedent watchlist
 *   POST /admin/watchlist/add           — Add citation to watchlist
 *   POST /admin/watchlist/remove        — Remove citation from watchlist
 */

import { createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import {
  isDbEnabled,
  listUsers,
  getUserByUsername,
  createUser,
  updateUserAdmin,
  updateUserActive,
  rotateUserToken,
  deleteUser,
  logLoginEvent,
  getLoginEvents,
  getRecentLoginEvents,
  getOAuthAuthorizations,
  listAppConfig,
  getAppConfig,
  setAppConfig,
  getAdminDashboardStats,
  getAdminDashboardStatsV2,
  getUserCostByPeriod,
  purgeOldMatterQueries,
  purgeOldJudgmentCache,
  purgeAllJudgmentCache,
  getRecentErrors,
  getRecentActivity,
  listAdminMatters,
  getDailyQueryVolume,
  getQueryVolumeByUserToday,
  incrementSessionVersion,
  getMonthlySpendUsd,
  listWatchlist,
  addWatchlistEntry,
  removeWatchlistEntry,
  type WatchlistEntry,
  type UserRow,
  type LoginEventRow,
  type OAuthAuthRow,
  type AppConfigRow,
  type AdminMatterRow,
  type DailyQueryCount,
  type UserQueryToday,
} from './db.js';
import {
  COOKIE,
  CSS,
  LOGO_SRC,
  parseCookies,
  verifySession,
  buildSessionVersionCache,
} from './matters-ui.js';
import { decryptToken, encryptToken, generateToken, hashToken } from './token-utils.js';
import { refreshAuthCache } from './auth.js';
import { config } from './config.js';
import { logger } from './logger.js';

export const adminRouter = Router();

// ── Session helpers ───────────────────────────────────────────────────────────

function getAdminSession(req: Request): { user: string; isAdmin: boolean } | null {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return null;
  const session = verifySession(raw);
  if (!session) return null;
  return session;
}

// ── CSRF check ────────────────────────────────────────────────────────────────

function checkCsrf(req: Request): boolean {
  const origin = req.headers['origin'] ?? '';
  const referer = req.headers['referer'] ?? '';
  const host = req.headers['host'] ?? '';
  const check = origin || referer;
  if (!check) return false; // require either origin or referer
  try {
    const url = new URL(check);
    return url.host === host;
  } catch { return false; }
}

// ── Middleware ────────────────────────────────────────────────────────────────

/** No-cache for all admin routes. */
function noCache(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
}

adminRouter.use(noCache);

/** Require admin session. Redirects to login if not authenticated; renders 403 if not admin. */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const session = getAdminSession(req);
  if (!session) {
    res.redirect(`/matters/login?next=${encodeURIComponent(req.path)}`);
    return;
  }
  if (!session.isAdmin) {
    res.status(403).setHeader('Content-Type', 'text/html; charset=utf-8').send(
      page('Access Denied', `
        <div style="text-align:center;padding:4rem 2rem">
          <h1 style="font-size:1.5rem;margin-bottom:.5rem">403 — Access Denied</h1>
          <p style="color:#666;margin-bottom:1.5rem">Your account does not have admin privileges.</p>
          <a href="/matters" class="btn btn-secondary">← Back to Matters</a>
        </div>
      `, session.user, undefined),
    );
    return;
  }
  next();
}

/** CSRF middleware for all POST routes. */
function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!checkCsrf(req)) {
    res.status(403).send('CSRF check failed');
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

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Australia/Sydney',
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
}

function tsDateTime(iso: string): string {
  return `<time data-utc="${esc(iso)}" data-fmt="datetime">${fmtDateTime(iso)}</time>`;
}

const ADMIN_CSS = `
${CSS}
.btn-danger { background: #991b1b; color: #fff; border-color: #991b1b; }
.btn-danger:hover { background: #7f1d1d; border-color: #7f1d1d; }
.btn-sm { padding: .3rem .625rem; font-size: .8125rem; }
.token-display { background: #f0fdf4; border: 2px solid #16a34a; border-radius: 8px; padding: 1rem 1.25rem; font-family: ui-monospace, "Cascadia Code", monospace; font-size: 1rem; word-break: break-all; margin: 1rem 0; }
.token-warning { background: #fef9c3; border: 1px solid #ca8a04; border-radius: 6px; padding: .75rem 1rem; font-size: .875rem; color: #713f12; margin-bottom: .5rem; }
.token-explain { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; padding: .75rem 1rem; font-size: .875rem; color: #075985; margin-bottom: .5rem; }
.badge-admin { display: inline-block; background: #dbeafe; color: #1e40af; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; font-weight: 600; }
.badge-inactive { display: inline-block; background: #fee2e2; color: #991b1b; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; font-weight: 600; }
.badge-active { display: inline-block; background: #d1fae5; color: #065f46; padding: .125rem .5rem; border-radius: 10px; font-size: .6875rem; font-weight: 600; }
.status-ok { color: #16a34a; font-weight: 600; }
.status-err { color: #dc2626; font-weight: 600; }
.card-link { text-decoration: none; }
.card-link .card:hover { border-color: var(--accent); }
.form-group { margin-bottom: 1rem; }
.form-group label { display: block; font-size: .875rem; font-weight: 500; margin-bottom: .375rem; color: #333; }
.form-group input[type="text"], .form-group input[type="number"], .form-group select { width: 100%; max-width: 400px; padding: .5rem .75rem; border: 1px solid #d0cdc6; border-radius: 6px; font-size: .9375rem; }
.form-group input[type="checkbox"] { width: auto; }
.form-hint { font-size: .8125rem; color: #888; margin-top: .25rem; }
.section-title { font-size: .6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #888; margin: 2rem 0 .75rem; }
.confirm-box { border: 1px solid #fca5a5; background: #fff5f5; border-radius: 8px; padding: 1.25rem; margin-top: 1.5rem; }
.confirm-box h3 { color: #991b1b; font-size: .9375rem; margin-bottom: .75rem; }
/* Admin layout: sidebar + content */
.admin-layout { display: flex; min-height: calc(100vh - 52px); }
.admin-sidebar { width: 220px; flex-shrink: 0; background: #fff; border-right: 1px solid var(--border); padding: 1.5rem 0; }
.admin-sidebar-section { font-size: .6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #aaa; padding: 0 1rem; margin: 1rem 0 .375rem; }
.admin-sidebar-link { display: block; padding: .5rem 1rem; font-size: .875rem; color: #444; text-decoration: none; border-left: 3px solid transparent; }
.admin-sidebar-link:hover { background: var(--light); color: var(--primary); }
.admin-sidebar-link.active { background: #EEF2FF; color: var(--primary); border-left-color: var(--accent); font-weight: 600; }
.admin-content { flex: 1; padding: 2rem 1.5rem; min-width: 0; overflow: hidden; }
/* Period toggle tabs */
.period-tabs { display: inline-flex; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; margin-bottom: 1.25rem; }
.period-tab { padding: .3rem .75rem; font-size: .8125rem; color: #555; text-decoration: none; border-right: 1px solid var(--border); background: #fff; }
.period-tab:last-child { border-right: none; }
.period-tab.active { background: var(--primary); color: #fff; }
.copy-btn { padding: .3rem .75rem; font-size: .8125rem; background: #fff; border: 1px solid var(--border); border-radius: 5px; cursor: pointer; margin-left: .5rem; }
.copy-btn:hover { background: var(--light); }
@media (max-width: 768px) {
  .admin-layout { flex-direction: column; }
  .admin-sidebar { width: 100%; border-right: none; border-bottom: 1px solid var(--border); padding: .75rem 0; display: flex; flex-wrap: wrap; gap: 0; }
  .admin-sidebar-section { display: none; }
  .admin-sidebar-link { border-left: none; border-bottom: 3px solid transparent; padding: .5rem .75rem; font-size: .8125rem; }
  .admin-sidebar-link.active { border-bottom-color: var(--accent); border-left: none; }
  main { padding: 0; }
  .admin-content { padding: 1.25rem 1rem; }
}
`;

function sidebar(activePath?: string): string {
  const link = (href: string, label: string) =>
    `<a href="${href}" class="admin-sidebar-link${activePath === href ? ' active' : ''}">${label}</a>`;
  return `<div class="admin-sidebar">
    <div class="admin-sidebar-section">Overview</div>
    ${link('/admin', 'Dashboard')}
    <div class="admin-sidebar-section">Management</div>
    ${link('/admin/users', 'Users')}
    ${link('/admin/matters', 'Matters')}
    <div class="admin-sidebar-section">Research</div>
    ${link('/admin/watchlist', 'Watchlist')}
    <div class="admin-sidebar-section">System</div>
    ${link('/admin/config', 'Config')}
    ${link('/admin/data', 'Data')}
  </div>`;
}

function page(title: string, body: string, user?: string, activePath?: string): string {
  const nav = user
    ? `<nav>
        <a href="/matters" class="nav-brand">
          <img src="${LOGO_SRC}" alt="CP Legal" height="26" style="display:block"
               onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
          <span class="nav-brand-fallback">CP Legal</span>
        </a>
        <div class="nav-links">
          <a href="/matters" class="nav-link">Matters</a>
          <a href="/matters/dashboard" class="nav-link">Dashboard</a>
          <a href="/admin" class="nav-link${activePath?.startsWith('/admin') ? ' active' : ''}">Admin</a>
        </div>
        <span class="nav-user">${esc(user)} <span class="badge-admin" style="margin-left:.25rem">admin</span></span>
        <a href="/matters/logout" class="nav-logout no-print">Sign out</a>
      </nav>`
    : '';
  const useSidebar = !!user && activePath?.startsWith('/admin');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — CP Legal Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${ADMIN_CSS}</style>
</head>
<body>
${nav}
${useSidebar
  ? `<div class="admin-layout">${sidebar(activePath)}<div class="admin-content">${body}</div></div>`
  : `<main>${body}</main>`
}
<script>
(function(){
  var tz='Australia/Sydney';
  try{var det=Intl.DateTimeFormat().resolvedOptions().timeZone;if(det)tz=det;}catch(e){}
  if(tz==='Australia/Sydney')return;
  var els=document.querySelectorAll('time[data-utc]');
  for(var i=0;i<els.length;i++){
    var el=els[i];var iso=el.getAttribute('data-utc');var fmt=el.getAttribute('data-fmt');
    try{
      var d=new Date(iso);
      var opts=fmt==='datetime'
        ?{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true,timeZone:tz}
        :{day:'2-digit',month:'short',year:'numeric',timeZone:tz};
      el.textContent=d.toLocaleString('en-AU',opts);
    }catch(e){}
  }
})();
</script>
</body>
</html>`;
}

// ── Cost helpers ──────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (!n || n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return String(n);
}

const TOOL_COST_RATES: Record<string, number> = {
  // Kanon Answer Extractor — $1.50/1M
  ask_judgment: 1.50, ask_legislation: 1.50, compare_cases: 1.50,
  get_legislation: 1.50, draft_research_memo: 1.50,
  // Kanon 2 Enricher — $3.50/1M
  enrich_judgment: 3.50, build_chronology: 3.50,
  // blended
  summarise_judgment: 1.833,
  // Kanon Universal Classifier — $1.00/1M
  research_cases: 1.00, research_legislation: 1.00, search_by_citation: 1.00,
  find_citing_cases: 1.00, find_related_cases: 1.00, classify_legal_issue: 1.00,
  // No Isaacus calls — 0 tokens logged, cost = 0
  get_judgment: 0, format_citation: 0, generate_pinpoint: 0,
  lookup_entity: 0, lookup_entities_bulk: 0, search_regulatory_decisions: 0,
  search_asx_announcements: 0, check_limitation_period: 0, check_filing_deadline: 0,
  get_matter_history: 0, inspect_database: 0, monitor_precedents: 0,
};
const AUD_PER_USD = 1.57;

function estCostUsd(tokens: number, toolName?: string): number {
  if (!tokens) return 0;
  const rate = (toolName ? TOOL_COST_RATES[toolName] : undefined) ?? 1.25;
  return (tokens / 1_000_000) * rate;
}

function fmtCost(usd: number): { usd: string; aud: string } {
  const fmt = (n: number) => {
    if (n === 0) return '—';
    if (n >= 10) return `$${n.toFixed(2)}`;
    if (n >= 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toExponential(2)}`;
  };
  return { usd: fmt(usd), aud: usd > 0 ? fmt(usd * AUD_PER_USD) : '—' };
}

// ── Volume chart ─────────────────────────────────────────────────────────────

function renderAdminVolumeChart(data: DailyQueryCount[]): string {
  if (data.length === 0) return '';
  const max = Math.max(...data.map((d) => d.count), 1);
  const bars = data.map((d) => {
    const pct = Math.round((d.count / max) * 100);
    const label = new Date(d.day).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
    const dayNum = label.split(' ')[0]!;
    return `<div class="vol-col" title="${label}: ${d.count} quer${d.count === 1 ? 'y' : 'ies'}">
      <div class="vol-bar" style="height:${pct}%;background:var(--accent);width:100%;border-radius:2px 2px 0 0;min-height:2px"></div>
      <div style="font-size:.5625rem;color:#aaa;margin-top:3px;white-space:nowrap">${dayNum}</div>
    </div>`;
  }).join('');
  return `<div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
    <div style="font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#555;margin-bottom:.75rem">Query Volume — Last ${data.length} Days</div>
    <div style="display:flex;align-items:flex-end;gap:4px;height:80px;padding-top:8px">${bars}</div>
  </div>`;
}

// ── Reusable table renderers ──────────────────────────────────────────────────

function renderLoginEventsTable(events: LoginEventRow[], caption?: string, showUsername = false): string {
  if (events.length === 0) return `<p style="color:#888;font-size:.875rem;padding:.5rem 0">${caption ?? 'No events recorded.'}</p>`;
  const rows = events.map((e) => {
    const meta = (e.meta ?? {}) as Record<string, string>;
    const location = [meta['city'], meta['country']].filter(Boolean).join(', ') || '—';
    return `<tr>
    <td class="date-small">${tsDateTime(e.created_at)}</td>
    ${showUsername ? `<td>${esc(e.username)}</td>` : ''}
    <td><span class="tag">${esc(e.event_type)}</span></td>
    <td>${esc(e.client_name ?? '—')}</td>
    <td class="mono" style="font-size:.75rem">${esc(e.ip ?? '—')}</td>
    <td style="font-size:.75rem;color:#555">${esc(location)}</td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.user_agent ?? '')}">${esc((e.user_agent ?? '').slice(0, 60))}</td>
  </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Date &amp; Time</th>${showUsername ? '<th>Username</th>' : ''}<th>Event</th><th>Client</th><th>IP</th><th>Location</th><th>User Agent</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderTokenDisplay(token: string): string {
  return `<div style="max-width:560px">
    <div class="token-explain">This is the user's API token. They use it to authenticate with the CP Legal MCP server at <strong>api.example.com</strong> — enter it as the password when connecting any MCP client (Claude, ChatGPT, Cursor, etc.). It will not be shown again.</div>
    <div class="token-warning">Save this token — it cannot be recovered. Share it with the user via a secure channel.</div>
    <div style="display:flex;align-items:flex-start;gap:.5rem">
      <div class="token-display" id="token-val" style="flex:1">${esc(token)}</div>
      <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('token-val').textContent.trim()).then(function(){this.textContent='Copied!';var b=this;setTimeout(function(){b.textContent='Copy';},1500);}.bind(this))">Copy</button>
    </div>
  </div>`;
}

function renderUserRow(u: UserRow): string {
  const adminBadge = u.is_admin ? '<span class="badge-admin">Admin</span>' : '';
  const statusBadge = u.is_active ? '<span class="badge-active">Active</span>' : '<span class="badge-inactive">Inactive</span>';
  const lastActive = u.last_active ? fmtDate(u.last_active) : '—';
  return `<tr>
    <td><a href="/admin/users/${encodeURIComponent(u.username)}" style="font-weight:600;color:var(--primary);text-decoration:none">${esc(u.username)}</a></td>
    <td>${adminBadge || '<span style="color:#aaa;font-size:.8125rem">User</span>'}</td>
    <td>${statusBadge}</td>
    <td class="date-small">${lastActive}</td>
    <td style="text-align:right">
      <a href="/admin/users/${encodeURIComponent(u.username)}" class="btn btn-secondary btn-sm">View</a>
    </td>
  </tr>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Apply requireAdmin to all /admin routes
adminRouter.use('/admin', requireAdmin);

// ── GET /admin — Dashboard ────────────────────────────────────────────────────

adminRouter.get('/admin', async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.send(page('Admin Dashboard', '<div class="empty">Database not enabled on this deployment.</div>', session.user, '/admin'));
    return;
  }

  const [stats, recentErrors, recentLogins, queryVolume, userToday] = await Promise.all([
    getAdminDashboardStatsV2(),
    getRecentErrors(10),
    getRecentLoginEvents(10),
    getDailyQueryVolume(undefined, 14),
    getQueryVolumeByUserToday(),
  ]);

  // Railway service health checks (fire concurrently, cap at 3s)
  const auslawHealthStart = Date.now();
  let auslawStatus = '—';
  let auslawMs = 0;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${config.AUSLAW_BASE_URL}/health`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    auslawMs = Date.now() - auslawHealthStart;
    auslawStatus = r.ok ? 'healthy' : `HTTP ${r.status}`;
  } catch {
    auslawMs = Date.now() - auslawHealthStart;
    auslawStatus = 'unreachable';
  }
  const auslawOk = auslawStatus === 'healthy';
  const uptimeSecs = Math.round(process.uptime());
  const uptimeStr = uptimeSecs < 60 ? `${uptimeSecs}s` : uptimeSecs < 3600 ? `${Math.floor(uptimeSecs/60)}m ${uptimeSecs%60}s` : `${Math.floor(uptimeSecs/3600)}h ${Math.floor((uptimeSecs%3600)/60)}m`;

  const errCountColor = stats.error_count_24h > 0 ? 'color:#dc2626' : '';

  const errorTableHtml = recentErrors.length > 0
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>User</th><th>Matter</th><th>Tool</th><th>Error</th></tr></thead>
        <tbody>${recentErrors.map((r) => `<tr class="row-error">
          <td class="date-small">${tsDateTime(r.created_at)}</td>
          <td>${esc(r.user_id ?? '—')}</td>
          <td>${esc(r.matter_ref)}</td>
          <td><span class="tag">${esc(r.tool_name)}</span></td>
          <td style="color:#dc2626;max-width:300px">${esc(r.error_message ?? '—')}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
    : '<p style="color:#888;font-size:.875rem;padding:.5rem 0">No errors in the last 24 hours.</p>';

  const errorAlertBanner = stats.error_count_24h >= 3
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:1rem 1.25rem;margin-bottom:1.5rem;display:flex;align-items:flex-start;gap:.75rem">
        <span style="font-size:1.25rem">⚠️</span>
        <div>
          <div style="font-weight:600;color:#991b1b;margin-bottom:.25rem">${stats.error_count_24h} tool errors in the last 24 hours</div>
          <div style="font-size:.875rem;color:#7f1d1d">Review the Recent Errors section below. Users may be experiencing failed tool calls.</div>
        </div>
      </div>`
    : '';

  const userTodayHtml = `<div class="section-title">Today's Activity by User</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      ${userToday.length === 0
        ? '<p style="color:#888;font-size:.875rem">No queries today.</p>'
        : `<div class="table-wrap"><table><thead><tr><th>User</th><th style="text-align:right">Queries Today</th></tr></thead><tbody>
            ${(userToday as UserQueryToday[]).map((u) => `<tr><td>${esc(u.user_id)}</td><td style="text-align:right;font-weight:600">${u.count}</td></tr>`).join('')}
           </tbody></table></div>`}
    </div>`;

  res.send(page('Admin Dashboard', `
    ${errorAlertBanner}
    <h1>Admin Dashboard</h1>
    <p class="subtitle">System overview and health</p>

    <div class="summary-grid">
      <a href="/admin/users" class="card-link">
        <div class="card">
          <div class="card-label">Total Users</div>
          <div class="card-value">${stats.total_users}</div>
          <div class="card-sub">${stats.active_users_7d} active this week</div>
        </div>
      </a>
      <div class="card">
        <div class="card-label">Queries Today</div>
        <div class="card-value">${stats.total_queries_today}</div>
      </div>
      <div class="card">
        <div class="card-label">Queries This Week</div>
        <div class="card-value">${stats.total_queries_7d}</div>
      </div>
      <div class="card">
        <div class="card-label">Errors (24h)</div>
        <div class="card-value" style="${errCountColor}">${stats.error_count_24h}</div>
      </div>
      <a href="/admin/data" class="card-link">
        <div class="card">
          <div class="card-label">Judgment Cache</div>
          <div class="card-value">${stats.judgment_cache_count}</div>
          <div class="card-sub">${stats.judgment_cache_mb} MB</div>
        </div>
      </a>
      <a href="/admin/matters" class="card-link">
        <div class="card">
          <div class="card-label">Unique Matters</div>
          <div class="card-value">${(stats as { unique_matters_count: number }).unique_matters_count ?? 0}</div>
        </div>
      </a>
    </div>

    <div class="section-title">Service Health</div>
    <div class="summary-grid" style="margin-bottom:1.5rem">
      <div class="card">
        <div class="card-label">cp-legal-mcp</div>
        <div class="card-value sm"><span class="status-ok">✓ Healthy</span></div>
        <div class="card-sub">Uptime ${uptimeStr}</div>
      </div>
      <div class="card">
        <div class="card-label">auslaw-mcp</div>
        <div class="card-value sm"><span class="${auslawOk ? 'status-ok' : 'status-err'}">${auslawOk ? '✓' : '✗'} ${esc(auslawStatus)}</span></div>
        <div class="card-sub">${auslawMs}ms</div>
      </div>
      <div class="card">
        <div class="card-label">Database</div>
        <div class="card-value sm"><span class="status-ok">✓ Connected</span></div>
      </div>
      <div class="card">
        <div class="card-label">Isaacus API Key</div>
        <div class="card-value sm">${config.ISAACUS_API_KEY ? '<span class="status-ok">✓ Configured</span>' : '<span class="status-err">✗ Missing</span>'}</div>
      </div>
    </div>

    ${renderAdminVolumeChart(queryVolume)}
    ${userTodayHtml}

    <div class="section-title">Recent Errors</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      ${errorTableHtml}
    </div>

    <div class="section-title">Recent Logins</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      ${renderLoginEventsTable(recentLogins, undefined, true)}
    </div>
  `, session.user, '/admin'));
});

// ── GET /admin/users — User list ──────────────────────────────────────────────

adminRouter.get('/admin/users', async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const users = isDbEnabled() ? await listUsers() : [];

  const tableHtml = users.length === 0
    ? '<div class="empty">No users yet. Create one below.</div>'
    : `<div class="table-wrap"><table>
        <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Last Active</th><th></th></tr></thead>
        <tbody>${users.map(renderUserRow).join('')}</tbody>
      </table></div>`;

  res.send(page('Users', `
    <div class="actions">
      <h1 style="margin:0">Users</h1>
      <a href="/admin/users/new" class="btn btn-primary" style="margin-left:auto">+ New User</a>
    </div>
    <p class="subtitle">${users.length} user account${users.length !== 1 ? 's' : ''}</p>
    ${tableHtml}
  `, session.user, '/admin/users'));
});

// ── GET /admin/users/new — New user form ──────────────────────────────────────

adminRouter.get('/admin/users/new', (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(page('New User', `
    <a href="/admin/users" class="btn-back">← Users</a>
    <h1>New User</h1>
    <p class="subtitle">Create a new user account. A token will be generated — show it to the user once.</p>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.5rem;max-width:480px">
      <form method="POST" action="/admin/users/new">
        <div class="form-group">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" required autocomplete="off" pattern="[a-z0-9_\\-]+" title="Lowercase letters, numbers, hyphens, underscores">
          <div class="form-hint">Lowercase letters, numbers, hyphens, underscores only.</div>
        </div>
        <div class="form-group">
          <label><input type="checkbox" name="is_admin" value="1"> Grant admin access</label>
          <div class="form-hint">Admins can access this panel and see all matters.</div>
        </div>
        <button type="submit" class="btn btn-primary">Create User</button>
      </form>
    </div>
  `, session.user, '/admin/users'));
});

// ── POST /admin/users/new — Create user ──────────────────────────────────────

adminRouter.post('/admin/users/new', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const { username, is_admin } = req.body as Record<string, string | undefined>;
  const cleanUsername = (username ?? '').trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!cleanUsername) {
    res.status(400).send(page('Error', '<div class="empty">Invalid username.</div>', session.user, '/admin/users'));
    return;
  }

  const existing = isDbEnabled() ? await getUserByUsername(cleanUsername) : null;
  if (existing) {
    res.status(409).send(page('Error', `<div class="empty">Username "${esc(cleanUsername)}" already exists.</div>`, session.user, '/admin/users'));
    return;
  }

  const token = generateToken();
  const { salt, hash } = hashToken(token);
  const encKey = process.env.ENCRYPTION_KEY?.trim();
  const tokenEncrypted = encKey ? encryptToken(token, encKey) : undefined;
  const isAdmin = is_admin === '1';

  await createUser({
    username: cleanUsername,
    tokenSalt: salt,
    tokenHash: hash,
    tokenEncrypted,
    isAdmin,
    createdBy: session.user,
  });
  await refreshAuthCache();

  logger.info({ createdBy: session.user, username: cleanUsername, isAdmin }, 'admin: user created');

  res.send(page('User Created', `
    <a href="/admin/users" class="btn-back">← Users</a>
    <h1>User Created</h1>
    <p class="subtitle">Account <strong>${esc(cleanUsername)}</strong> has been created.</p>
    ${renderTokenDisplay(token)}
    <div style="display:flex;gap:.75rem;margin-top:1.25rem">
      <a href="/admin/users/${encodeURIComponent(cleanUsername)}" class="btn btn-primary">View User →</a>
      <a href="/admin/users/new" class="btn btn-secondary">Create Another</a>
    </div>
  `, session.user, '/admin/users'));
});

// ── GET /admin/users/:username — User detail ──────────────────────────────────

adminRouter.get('/admin/users/:username', async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const username = decodeURIComponent(req.params['username'] as string ?? '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const user = isDbEnabled() ? await getUserByUsername(username) : null;
  if (!user) {
    res.status(404).send(page('Not Found', '<div class="empty">User not found.</div>', session.user, '/admin/users'));
    return;
  }

  const period = (['lifetime', 'month', 'week'] as const).includes(req.query['period'] as 'lifetime'|'month'|'week')
    ? (req.query['period'] as 'lifetime'|'month'|'week')
    : 'lifetime';

  const [stats, oauthAuths, loginHistory, recentQueries] = await Promise.all([
    getUserCostByPeriod(username, period),
    getOAuthAuthorizations(username),
    getLoginEvents(username, 20),
    getRecentActivity(20, username),
  ]);

  const costUsd = estCostUsd(stats.total_tokens);
  const { usd, aud } = fmtCost(costUsd);

  const oauthRows = oauthAuths.length > 0
    ? oauthAuths.map((a) => `<tr>
        <td>${esc(a.client_name ?? a.client_id)}</td>
        <td class="date-small">${tsDateTime(a.first_auth)}</td>
        <td class="date-small">${tsDateTime(a.last_auth)}</td>
        <td style="text-align:right">${a.auth_count}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" style="text-align:center;color:#888;padding:1.5rem">No OAuth connections.</td></tr>';

  const queryRows = recentQueries.map((r) => `<tr${r.is_error ? ' class="row-error"' : ''}>
    <td class="date-small">${tsDateTime(r.created_at)}</td>
    <td><a href="/matters/${encodeURIComponent(r.matter_ref)}" style="color:var(--primary);font-weight:600;text-decoration:none">${esc(r.matter_ref)}</a></td>
    <td><span class="tag">${esc(r.tool_name)}</span></td>
    <td style="max-width:300px;white-space:pre-wrap;word-break:break-word;color:#555">${esc(r.query_text.slice(0, 200))}</td>
    ${r.is_error ? `<td style="color:#dc2626">${esc(r.error_message ?? 'Error')}</td>` : '<td>—</td>'}
  </tr>`).join('');

  const periodTabHtml = `<div class="period-tabs">
    <a href="?period=lifetime" class="period-tab${period==='lifetime'?' active':''}">Lifetime</a>
    <a href="?period=month" class="period-tab${period==='month'?' active':''}">This Month</a>
    <a href="?period=week" class="period-tab${period==='week'?' active':''}">This Week</a>
  </div>`;

  res.send(page(`User: ${username}`, `
    <a href="/admin/users" class="btn-back">← Users</a>

    <div style="display:flex;align-items:flex-start;gap:1.5rem;flex-wrap:wrap;margin-bottom:1.5rem">
      <div>
        <h1 style="margin-bottom:.25rem">${esc(user.username)}</h1>
        <p class="subtitle" style="margin:0">
          ${user.is_admin ? '<span class="badge-admin">Admin</span> ' : ''}
          ${user.is_active ? '<span class="badge-active">Active</span>' : '<span class="badge-inactive">Inactive</span>'}
        </p>
        <p style="font-size:.8125rem;color:#888;margin-top:.5rem">
          Created ${fmtDate(user.created_at)}${user.created_by ? ` by ${esc(user.created_by)}` : ''}
          ${user.last_active ? ` · Last active ${fmtDate(user.last_active)}` : ''}
        </p>
      </div>
    </div>

    ${periodTabHtml}
    <div class="summary-grid">
      <div class="card">
        <div class="card-label">Total Queries</div>
        <div class="card-value">${stats.query_count}</div>
        ${stats.first_query ? `<div class="card-sub">Since ${fmtDate(stats.first_query)}</div>` : ''}
      </div>
      <div class="card">
        <div class="card-label">Unique Matters</div>
        <div class="card-value">${stats.matter_count}</div>
      </div>
      <div class="card">
        <div class="card-label">Total Tokens</div>
        <div class="card-value">${fmtTokens(stats.total_tokens)}</div>
      </div>
      <div class="card">
        <div class="card-label">Est. Cost</div>
        <div class="card-value sm">${usd} <span style="font-size:.75rem;color:#888">USD</span></div>
        <div class="card-sub">≈ ${aud} AUD</div>
      </div>
    </div>

    <div class="section-title">OAuth Connections</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      <div class="table-wrap"><table>
        <thead><tr><th>Client</th><th>First Connected</th><th>Last Used</th><th style="text-align:right">Auth Count</th></tr></thead>
        <tbody>${oauthRows}</tbody>
      </table></div>
    </div>

    <div class="section-title">Login History (Last 20)</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      ${renderLoginEventsTable(loginHistory)}
    </div>

    <div class="section-title">Recent Queries (Last 20)</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Matter</th><th>Tool</th><th>Query</th><th>Status</th></tr></thead>
        <tbody>${queryRows || '<tr><td colspan="5" style="text-align:center;color:#888;padding:1.5rem">No queries yet.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="section-title">Token</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      <p style="font-size:.875rem;color:#555;margin-bottom:.75rem">Reveal the current encrypted token for this user. Requires <code>ENCRYPTION_KEY</code> to be set.</p>
      <form method="POST" action="/admin/users/${encodeURIComponent(username)}/reveal-token">
        <button type="submit" class="btn btn-secondary">Reveal Token</button>
      </form>
    </div>

    <div class="section-title">Sessions</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      <p style="font-size:.875rem;color:#555;margin-bottom:.75rem">Active sessions are cookie-based. Use Force Logout to invalidate all current sessions for this user.</p>
      <form method="POST" action="/admin/users/${encodeURIComponent(username)}/force-logout">
        <button type="submit" class="btn btn-secondary">Force Logout All Sessions</button>
      </form>
    </div>

    <div class="section-title">Actions</div>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:2rem">
      <form method="POST" action="/admin/users/${encodeURIComponent(username)}/rotate-token">
        <button type="submit" class="btn btn-secondary">Rotate Token</button>
      </form>
      <form method="POST" action="/admin/users/${encodeURIComponent(username)}/toggle-admin">
        <button type="submit" class="btn btn-secondary">${user.is_admin ? 'Remove Admin' : 'Grant Admin'}</button>
      </form>
      <form method="POST" action="/admin/users/${encodeURIComponent(username)}/toggle-active">
        <button type="submit" class="btn btn-secondary">${user.is_active ? 'Deactivate' : 'Activate'}</button>
      </form>
    </div>

    <div class="confirm-box">
      <h3>Delete User</h3>
      <p style="font-size:.875rem;color:#555;margin-bottom:.75rem">
        This permanently deletes the user account. To confirm, type the username below.
      </p>
      <form method="POST" action="/admin/users/${encodeURIComponent(username)}/delete" onsubmit="return document.getElementById('du').value==='${esc(username)}'||alert('Username does not match.')&&false">
        <div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">
          <input type="text" id="du" name="confirm_username" placeholder="${esc(username)}" style="max-width:200px;padding:.5rem .75rem;border:1px solid #fca5a5;border-radius:6px;font-size:.875rem">
          <button type="submit" class="btn btn-danger btn-sm">Delete User</button>
        </div>
      </form>
    </div>
  `, session.user, '/admin/users'));
});

// ── POST /admin/users/:username/rotate-token ──────────────────────────────────

adminRouter.post('/admin/users/:username/rotate-token', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const username = decodeURIComponent(req.params['username'] as string ?? '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const user = isDbEnabled() ? await getUserByUsername(username) : null;
  if (!user) {
    res.status(404).send(page('Not Found', '<div class="empty">User not found.</div>', session.user, '/admin/users'));
    return;
  }

  const token = generateToken();
  const { salt, hash } = hashToken(token);
  const encKey = process.env.ENCRYPTION_KEY?.trim();
  const tokenEncrypted = encKey ? encryptToken(token, encKey) : undefined;
  await rotateUserToken(username, salt, hash, tokenEncrypted);
  await refreshAuthCache();

  logLoginEvent({ username, eventType: 'token_rotated', meta: { rotated_by: session.user } }).catch(() => {/* ignore */});
  logger.info({ rotatedBy: session.user, username }, 'admin: token rotated');

  res.send(page('Token Rotated', `
    <a href="/admin/users/${encodeURIComponent(username)}" class="btn-back">← ${esc(username)}</a>
    <h1>Token Rotated</h1>
    <p class="subtitle">New token for <strong>${esc(username)}</strong>. Share via a secure channel.</p>
    ${renderTokenDisplay(token)}
    <p style="font-size:.875rem;color:#555;margin:.5rem 0 1.25rem">The previous token is now invalid.</p>
    <a href="/admin/users/${encodeURIComponent(username)}" class="btn btn-primary">Back to User →</a>
  `, session.user, '/admin/users'));
});

// ── POST /admin/users/:username/reveal-token ──────────────────────────────────

adminRouter.post('/admin/users/:username/reveal-token', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const username = decodeURIComponent(req.params['username'] as string ?? '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const user = isDbEnabled() ? await getUserByUsername(username) : null;
  if (!user) {
    res.status(404).send(page('Not Found', '<div class="empty">User not found.</div>', session.user, '/admin/users'));
    return;
  }

  const encKey = process.env.ENCRYPTION_KEY?.trim();
  if (!encKey || !user.token_encrypted) {
    res.send(page('Reveal Token', `
      <a href="/admin/users/${encodeURIComponent(username)}" class="btn-back">← ${esc(username)}</a>
      <h1>Token Not Available</h1>
      <div style="max-width:520px">
        <div class="token-warning">${!encKey ? 'ENCRYPTION_KEY is not set on this deployment.' : 'No encrypted token stored — rotate the token to generate one.'} Rotate the token to generate a new encrypted copy.</div>
        <a href="/admin/users/${encodeURIComponent(username)}" class="btn btn-secondary" style="margin-top:1rem">Back to User</a>
      </div>
    `, session.user, '/admin/users'));
    return;
  }

  let revealed: string;
  try {
    revealed = decryptToken(user.token_encrypted, encKey);
  } catch {
    res.send(page('Reveal Token', `
      <a href="/admin/users/${encodeURIComponent(username)}" class="btn-back">← ${esc(username)}</a>
      <h1>Decryption Failed</h1>
      <div class="token-warning" style="max-width:520px">Could not decrypt token — the ENCRYPTION_KEY may have changed. Rotate the token to generate a fresh encrypted copy.</div>
    `, session.user, '/admin/users'));
    return;
  }

  logger.info({ revealedBy: session.user, username }, 'admin: token revealed');

  res.send(page('Token Revealed', `
    <a href="/admin/users/${encodeURIComponent(username)}" class="btn-back">← ${esc(username)}</a>
    <h1>Current Token — ${esc(username)}</h1>
    ${renderTokenDisplay(revealed)}
    <a href="/admin/users/${encodeURIComponent(username)}" class="btn btn-secondary" style="margin-top:1rem">Back to User</a>
  `, session.user, '/admin/users'));
});

// ── POST /admin/users/:username/toggle-admin ──────────────────────────────────

adminRouter.post('/admin/users/:username/toggle-admin', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const username = decodeURIComponent(req.params['username'] as string ?? '');

  const user = isDbEnabled() ? await getUserByUsername(username) : null;
  if (!user) { res.status(404).send('Not found'); return; }

  await updateUserAdmin(username, !user.is_admin);
  logger.info({ changedBy: session.user, username, isAdmin: !user.is_admin }, 'admin: toggled admin');
  res.redirect(`/admin/users/${encodeURIComponent(username)}`);
});

// ── POST /admin/users/:username/toggle-active ─────────────────────────────────

adminRouter.post('/admin/users/:username/toggle-active', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const username = decodeURIComponent(req.params['username'] as string ?? '');

  const user = isDbEnabled() ? await getUserByUsername(username) : null;
  if (!user) { res.status(404).send('Not found'); return; }

  await updateUserActive(username, !user.is_active);
  await refreshAuthCache(); // refresh cache so deactivated users lose access immediately
  logger.info({ changedBy: session.user, username, isActive: !user.is_active }, 'admin: toggled active');
  res.redirect(`/admin/users/${encodeURIComponent(username)}`);
});

// ── POST /admin/users/:username/delete ────────────────────────────────────────

adminRouter.post('/admin/users/:username/delete', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const username = decodeURIComponent(req.params['username'] as string ?? '');
  const { confirm_username } = req.body as Record<string, string | undefined>;

  if (!confirm_username || confirm_username.trim() !== username) {
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8').send(
      page('Error', '<div class="empty">Username confirmation did not match.</div>', session.user, '/admin/users'),
    );
    return;
  }

  await deleteUser(username);
  await refreshAuthCache();
  logger.info({ deletedBy: session.user, username }, 'admin: user deleted');
  res.redirect('/admin/users');
});

// ── POST /admin/users/:username/force-logout ──────────────────────────────────

adminRouter.post('/admin/users/:username/force-logout', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const username = decodeURIComponent(req.params['username'] as string ?? '');

  await incrementSessionVersion(username);
  // Refresh auth cache and rebuild session version cache
  await refreshAuthCache();
  const updatedUsers = isDbEnabled() ? await listUsers() : [];
  buildSessionVersionCache(updatedUsers);

  logLoginEvent({ username, eventType: 'force_logout', meta: { forced_by: session.user } }).catch(() => {/* ignore */});
  logger.info({ forcedBy: session.user, username }, 'admin: force-logged-out all sessions');
  res.redirect(`/admin/users/${encodeURIComponent(username)}`);
});

// ── GET /admin/config — Configuration ─────────────────────────────────────────

const DEFAULT_CONFIG_KEYS = [
  { key: 'default_matter_ref',              description: 'Default matter reference for untagged queries', defaultValue: config.DEFAULT_MATTER_REF ?? '' },
  { key: 'judgment_cache_ttl_days',         description: 'Days to keep judgment cache', defaultValue: '30' },
  { key: 'matter_retention_days',           description: 'Days to keep matter history', defaultValue: '365' },
  { key: 'spend_cap_monthly_per_user_usd',  description: 'Monthly Isaacus spend cap per user (USD). Leave blank to disable.', defaultValue: '' },
  { key: 'spend_cap_monthly_global_usd',    description: 'Global monthly Isaacus spend cap across all users (USD). Leave blank to disable.', defaultValue: '' },
  { key: 'spend_alert_threshold_pct',       description: 'Spend alert threshold — log a warning when a user reaches this % of their cap (default: 80)', defaultValue: '80' },
];

adminRouter.get('/admin/config', async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.send(page('Config', '<div class="empty">Database not enabled.</div>', session.user, '/admin/config'));
    return;
  }

  // Seed default keys if not present
  for (const { key, description, defaultValue } of DEFAULT_CONFIG_KEYS) {
    const existing = await getAppConfig(key);
    if (existing === null && defaultValue) {
      await setAppConfig(key, defaultValue, 'system', description);
    } else if (existing === null) {
      await setAppConfig(key, '', 'system', description);
    }
  }

  const [rows, allUsers, globalSpend] = await Promise.all([
    listAppConfig(),
    listUsers(),
    getMonthlySpendUsd(),
  ]);
  const perUserCapStr = rows.find((r) => r.key === 'spend_cap_monthly_per_user_usd')?.value ?? '';
  const globalCapStr  = rows.find((r) => r.key === 'spend_cap_monthly_global_usd')?.value ?? '';
  const perUserCap = perUserCapStr ? parseFloat(perUserCapStr) : null;
  const globalCap  = globalCapStr  ? parseFloat(globalCapStr)  : null;

  // Spend per active user this month (fire all in parallel)
  const userSpends = await Promise.all(
    allUsers.filter((u) => u.is_active).map(async (u) => ({
      username: u.username,
      spend_usd: await getMonthlySpendUsd(u.username),
    })),
  );

  const spendRows = userSpends.map(({ username, spend_usd }) => {
    const pct = perUserCap && perUserCap > 0 ? Math.min(100, (spend_usd / perUserCap) * 100) : null;
    const bar = pct !== null
      ? `<div style="background:#e5e7eb;border-radius:3px;height:6px;width:120px;display:inline-block;vertical-align:middle;margin-left:.5rem"><div style="background:${pct >= 100 ? '#dc2626' : pct >= 80 ? '#f59e0b' : '#16a34a'};border-radius:3px;height:6px;width:${pct}%"></div></div>`
      : '';
    return `<tr>
      <td style="font-weight:500">${esc(username)}</td>
      <td>$${spend_usd.toFixed(4)}</td>
      <td>${perUserCap ? `$${perUserCap.toFixed(2)} ${bar}` : '<span style="color:#aaa">—</span>'}</td>
      <td>${pct !== null ? `${pct.toFixed(1)}%` : '<span style="color:#aaa">—</span>'}</td>
    </tr>`;
  }).join('');

  const globalPct = globalCap && globalCap > 0 ? Math.min(100, (globalSpend / globalCap) * 100) : null;
  const globalBar = globalPct !== null
    ? `<div style="background:#e5e7eb;border-radius:3px;height:6px;width:160px;display:inline-block;vertical-align:middle;margin-left:.5rem"><div style="background:${globalPct >= 100 ? '#dc2626' : globalPct >= 80 ? '#f59e0b' : '#16a34a'};border-radius:3px;height:6px;width:${globalPct}%"></div></div>`
    : '';

  const tableRows = rows.map((r) => `<tr>
    <td><code style="font-size:.875rem">${esc(r.key)}</code></td>
    <td id="val-${esc(r.key)}">${esc(r.value || '—')}</td>
    <td style="color:#888;font-size:.8125rem">${esc(r.description ?? '')}</td>
    <td class="date-small">${r.updated_at ? tsDateTime(r.updated_at) : '—'}</td>
    <td>${esc(r.updated_by ?? '—')}</td>
    <td>
      <button class="btn btn-secondary btn-sm" onclick="showEdit('${esc(r.key)}','${esc(r.value)}')">Edit</button>
    </td>
  </tr>`).join('');

  res.send(page('Configuration', `
    <h1>Configuration</h1>
    <p class="subtitle">DB-backed settings. Changes take effect immediately.</p>

    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:1.5rem">
      <div class="table-wrap"><table>
        <thead><tr><th>Key</th><th>Value</th><th>Description</th><th>Updated</th><th>By</th><th></th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="6" style="text-align:center;color:#888;padding:2rem">No config entries.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div id="edit-panel" style="display:none;background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem;max-width:480px">
      <h2 style="font-size:.9375rem;margin-bottom:.875rem">Edit Config</h2>
      <form method="POST" action="/admin/config">
        <input type="hidden" id="edit-key" name="key">
        <div class="form-group">
          <label id="edit-label">Value</label>
          <input type="text" id="edit-value" name="value" autocomplete="off" style="width:100%;max-width:100%">
        </div>
        <div style="display:flex;gap:.75rem">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn btn-secondary" onclick="document.getElementById('edit-panel').style.display='none'">Cancel</button>
        </div>
      </form>
    </div>

    <script>
    function showEdit(key, val) {
      document.getElementById('edit-panel').style.display = 'block';
      document.getElementById('edit-key').value = key;
      document.getElementById('edit-value').value = val;
      document.getElementById('edit-label').textContent = key;
      document.getElementById('edit-value').focus();
    }
    </script>

    <div class="section-title">This Month's Spend</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      <div style="display:flex;align-items:baseline;gap:1.5rem;margin-bottom:1rem;flex-wrap:wrap">
        <div>
          <span style="font-size:.8125rem;color:#888">Global spend</span><br>
          <strong>$${globalSpend.toFixed(4)} USD</strong>
          ${globalCap ? `<span style="color:#888;font-size:.8125rem"> / $${globalCap.toFixed(2)} cap ${globalBar}</span>` : '<span style="color:#aaa;font-size:.8125rem"> (no cap set)</span>'}
        </div>
        ${perUserCap ? `<div><span style="font-size:.8125rem;color:#888">Per-user cap</span><br><strong>$${perUserCap.toFixed(2)} USD / month</strong></div>` : ''}
      </div>
      ${userSpends.length > 0 ? `
      <table style="font-size:.875rem">
        <thead><tr><th style="text-align:left;padding:.375rem .625rem;color:#888;font-weight:500">User</th><th style="text-align:left;padding:.375rem .625rem;color:#888;font-weight:500">Spend (USD)</th><th style="text-align:left;padding:.375rem .625rem;color:#888;font-weight:500">Cap</th><th style="text-align:left;padding:.375rem .625rem;color:#888;font-weight:500">Used</th></tr></thead>
        <tbody>${spendRows}</tbody>
      </table>` : '<p style="color:#888;font-size:.875rem">No active users.</p>'}
      <p style="font-size:.75rem;color:#aaa;margin-top:.75rem">Set caps above via <code>spend_cap_monthly_per_user_usd</code> and <code>spend_cap_monthly_global_usd</code>. When a cap is hit, further tool calls return 429 until the next calendar month.</p>
    </div>

    <div class="section-title">Security</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
      <p style="font-size:.875rem;color:#555">
        Recovery access: Set <code>RECOVERY_TOKEN</code> in Railway env vars.
        This token can be used as the password at the login page (with any username) to gain temporary admin access.
        Remove it after recovering access.
        ${config.RECOVERY_TOKEN ? '<span style="color:#16a34a;font-weight:600">&#x2713; Recovery token is configured</span>' : '<span style="color:#888">Not configured — add RECOVERY_TOKEN env var to enable</span>'}
      </p>
    </div>
  `, session.user, '/admin/config'));
});

// ── POST /admin/config ────────────────────────────────────────────────────────

adminRouter.post('/admin/config', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const { key, value } = req.body as Record<string, string | undefined>;
  if (!key) { res.status(400).send('Missing key'); return; }
  await setAppConfig(key, value ?? '', session.user);
  logger.info({ changedBy: session.user, key }, 'admin: config updated');
  res.redirect('/admin/config');
});

// ── GET /admin/data — Data management ────────────────────────────────────────

adminRouter.get('/admin/data', async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.send(page('Data Management', '<div class="empty">Database not enabled.</div>', session.user, '/admin/data'));
    return;
  }

  const stats = await getAdminDashboardStats();
  const [cacheRetention, matterRetention] = await Promise.all([
    getAppConfig('judgment_cache_ttl_days'),
    getAppConfig('matter_retention_days'),
  ]);

  const flashMsg = req.query['msg'] ? `<div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:6px;padding:.75rem 1rem;margin-bottom:1.5rem;font-size:.875rem;color:#065f46">${esc(String(req.query['msg']))}</div>` : '';

  res.send(page('Data Management', `
    <h1>Data Management</h1>
    <p class="subtitle">Storage statistics and purge tools.</p>
    ${flashMsg}

    <div class="summary-grid">
      <div class="card">
        <div class="card-label">Matter Queries</div>
        <div class="card-value">${stats.matter_queries_count.toLocaleString('en-AU')}</div>
        <div class="card-sub">Retention: ${matterRetention ?? 365} days</div>
      </div>
      <div class="card">
        <div class="card-label">Judgment Cache</div>
        <div class="card-value">${stats.judgment_cache_count}</div>
        <div class="card-sub">${stats.judgment_cache_mb} MB · TTL: ${cacheRetention ?? 30} days</div>
      </div>
      <div class="card">
        <div class="card-label">Embeddings</div>
        <div class="card-value">${stats.embeddings_count}</div>
      </div>
    </div>

    <div class="section-title">Retention Settings</div>
    <p style="font-size:.875rem;color:#555;margin-bottom:1rem">
      Adjust in <a href="/admin/config">Configuration</a>:
      <code>judgment_cache_ttl_days</code> (current: ${esc(cacheRetention ?? '30')}),
      <code>matter_retention_days</code> (current: ${esc(matterRetention ?? '365')}).
    </p>

    <div class="section-title">Purge Operations</div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem">
      <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem">
        <h2 style="font-size:.9375rem;margin-bottom:.5rem">Purge Matter Queries</h2>
        <p style="font-size:.8125rem;color:#555;margin-bottom:1rem">Delete matter queries older than N days.</p>
        <form method="POST" action="/admin/data/purge-queries">
          <div style="display:flex;gap:.75rem;align-items:center">
            <input type="number" name="days" value="${esc(matterRetention ?? '365')}" min="1" max="9999" style="width:100px;padding:.4rem .6rem;border:1px solid #d0cdc6;border-radius:5px;font-size:.875rem">
            <span style="font-size:.875rem;color:#555">days old</span>
            <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Purge matter queries older than '+this.form.days.value+' days?')">Purge</button>
          </div>
        </form>
      </div>

      <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem">
        <h2 style="font-size:.9375rem;margin-bottom:.5rem">Purge Judgment Cache</h2>
        <p style="font-size:.8125rem;color:#555;margin-bottom:1rem">Delete judgment cache entries older than N days.</p>
        <form method="POST" action="/admin/data/purge-cache">
          <div style="display:flex;gap:.75rem;align-items:center">
            <input type="number" name="days" value="${esc(cacheRetention ?? '30')}" min="1" max="9999" style="width:100px;padding:.4rem .6rem;border:1px solid #d0cdc6;border-radius:5px;font-size:.875rem">
            <span style="font-size:.875rem;color:#555">days old</span>
            <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Purge cache entries older than '+this.form.days.value+' days?')">Purge</button>
          </div>
        </form>
      </div>

      <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1.25rem">
        <h2 style="font-size:.9375rem;margin-bottom:.5rem">Clear All Judgment Cache</h2>
        <p style="font-size:.8125rem;color:#555;margin-bottom:1rem">Remove all ${stats.judgment_cache_count} cached judgments. They will be re-fetched on demand.</p>
        <form method="POST" action="/admin/data/purge-cache-all">
          <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Clear ALL ${stats.judgment_cache_count} judgment cache entries?')">Clear All Cache</button>
        </form>
      </div>
    </div>
  `, session.user, '/admin/data'));
});

// ── POST /admin/data/purge-queries ────────────────────────────────────────────

adminRouter.post('/admin/data/purge-queries', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const days = parseInt((req.body as Record<string, string>)['days'] ?? '365', 10);
  if (!days || days < 1) { res.status(400).send('Invalid days'); return; }
  const deleted = await purgeOldMatterQueries(days);
  logger.info({ deletedBy: session.user, days, deleted }, 'admin: purged matter queries');
  res.redirect(`/admin/data?msg=Deleted+${deleted}+matter+queries+older+than+${days}+days`);
});

// ── POST /admin/data/purge-cache ──────────────────────────────────────────────

adminRouter.post('/admin/data/purge-cache', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const days = parseInt((req.body as Record<string, string>)['days'] ?? '30', 10);
  if (!days || days < 1) { res.status(400).send('Invalid days'); return; }
  const deleted = await purgeOldJudgmentCache(days);
  logger.info({ deletedBy: session.user, days, deleted }, 'admin: purged judgment cache');
  res.redirect(`/admin/data?msg=Deleted+${deleted}+judgment+cache+entries+older+than+${days}+days`);
});

// ── POST /admin/data/purge-cache-all ─────────────────────────────────────────

adminRouter.post('/admin/data/purge-cache-all', requireCsrf, async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  const deleted = await purgeAllJudgmentCache();
  logger.info({ deletedBy: session.user, deleted }, 'admin: cleared all judgment cache');
  res.redirect(`/admin/data?msg=Cleared+all+judgment+cache+(${deleted}+entries)`);
});

// ── GET /admin/matters — Matter list ──────────────────────────────────────────

function estMatterCostUsd(tokens: number): number {
  // For matters list we don't have per-tool breakdown, use default 1.25/M blended
  return (tokens / 1_000_000) * 1.25;
}

adminRouter.get('/admin/matters', async (req: Request, res: Response) => {
  const session = getAdminSession(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!isDbEnabled()) {
    res.send(page('Matters', '<div class="empty">Database not enabled.</div>', session.user, '/admin/matters'));
    return;
  }

  const period = (['lifetime', 'month', 'week'] as const).includes(req.query['period'] as 'lifetime'|'month'|'week')
    ? (req.query['period'] as 'lifetime'|'month'|'week')
    : 'lifetime';

  const matters = await listAdminMatters(period);

  const periodTabHtml = `<div class="period-tabs">
    <a href="?period=lifetime" class="period-tab${period==='lifetime'?' active':''}">Lifetime</a>
    <a href="?period=month" class="period-tab${period==='month'?' active':''}">This Month</a>
    <a href="?period=week" class="period-tab${period==='week'?' active':''}">This Week</a>
  </div>`;

  const rows = matters.map((m: AdminMatterRow) => {
    const costUsd = estMatterCostUsd(m.total_tokens);
    const { usd } = fmtCost(costUsd);
    const isClosed = m.status === 'closed';
    const statusBadge = isClosed
      ? '<span style="display:inline-block;background:#fee2e2;color:#991b1b;padding:.125rem .5rem;border-radius:10px;font-size:.6875rem;font-weight:600;margin-left:.25rem">Closed</span>'
      : '<span style="display:inline-block;background:#d1fae5;color:#065f46;padding:.125rem .5rem;border-radius:10px;font-size:.6875rem;font-weight:600;margin-left:.25rem">Open</span>';
    const displayLabel = m.display_name
      ? `${esc(m.display_name)}<br><span style="font-size:.75rem;color:#888;font-family:ui-monospace,monospace">${esc(m.matter_ref)}</span>`
      : esc(m.matter_ref);
    const activeUsers = (m.active_users ?? []).join(', ') || '—';
    const copyBtn = `<button class="copy-ref-btn" data-ref="${esc(m.matter_ref)}" title="Copy matter ref" onclick="navigator.clipboard.writeText(this.dataset.ref).then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='⎘',1200)})">⎘</button>`;
    return `<tr>
      <td style="font-weight:600;font-family:ui-monospace,monospace;font-size:.875rem">
        <a href="/matters/${encodeURIComponent(m.matter_ref)}" style="color:var(--primary);text-decoration:none">${displayLabel}</a>${statusBadge}${copyBtn}
      </td>
      <td class="date-small">${m.creator ? esc(m.creator) : '—'}</td>
      <td class="date-small">${tsDateTime(m.first_seen)}</td>
      <td class="date-small">${tsDateTime(m.last_seen)}</td>
      <td style="text-align:right;font-weight:600">${m.query_count.toLocaleString('en-AU')}</td>
      <td style="font-size:.8125rem;color:#555">${esc(activeUsers)}</td>
      <td style="text-align:right">${fmtTokens(m.total_tokens)}</td>
      <td style="text-align:right">${usd}</td>
    </tr>`;
  }).join('');

  const tableHtml = matters.length === 0
    ? '<div class="empty">No matters on record yet.</div>'
    : `<div class="table-wrap"><table>
        <thead><tr>
          <th>Matter Ref</th>
          <th>Creator</th>
          <th>First Seen</th>
          <th>Last Active</th>
          <th style="text-align:right">Queries</th>
          <th>Active Users</th>
          <th style="text-align:right">Tokens</th>
          <th style="text-align:right">Est. Cost (USD)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;

  res.send(page('Matters', `
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.25rem">
      <h1 style="margin-bottom:0">Matters</h1>
      <a href="/matters/export.csv" class="btn btn-secondary btn-sm" style="font-size:.8125rem">⬇ Export all billing (CSV)</a>
    </div>
    <p class="subtitle">${matters.length} matter${matters.length !== 1 ? 's' : ''} on record, sorted by last activity</p>
    ${periodTabHtml}
    ${tableHtml}
  `, session.user, '/admin/matters'));
});

// ── Precedent watchlist ───────────────────────────────────────────────────────

adminRouter.get('/admin/watchlist', requireAdmin, async (req, res) => {
  const entries = await listWatchlist().catch(() => [] as WatchlistEntry[]);
  const session = getAdminSession(req)!;
  res.setHeader('Content-Type', 'text/html; charset=utf-8').send(
    page('Precedent Watchlist', `
      <div class="card" style="margin-bottom:1.5rem">
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:1rem">Add to Watchlist</h2>
        <form method="POST" action="/admin/watchlist/add" style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end">
          <div>
            <label style="display:block;font-size:.8125rem;font-weight:500;margin-bottom:.25rem">Neutral Citation</label>
            <input type="text" name="citation" placeholder="[2024] HCA 12" required style="padding:.5rem .75rem;border:1px solid #d0cdc6;border-radius:6px;font-size:.875rem;width:240px">
          </div>
          <div>
            <label style="display:block;font-size:.8125rem;font-weight:500;margin-bottom:.25rem">Label (optional)</label>
            <input type="text" name="label" placeholder="Short case description" style="padding:.5rem .75rem;border:1px solid #d0cdc6;border-radius:6px;font-size:.875rem;width:300px">
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </form>
      </div>
      <div class="card">
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:1rem">Watched Citations (${entries.length})</h2>
        ${entries.length === 0 ? '<p style="color:#666;font-size:.875rem">No cases on watchlist yet.</p>' : `
        <table class="table">
          <thead><tr><th>Citation</th><th>Label</th><th>Last Checked</th><th>Citing Cases</th><th></th></tr></thead>
          <tbody>
            ${entries.map((e) => `
              <tr>
                <td><code style="font-size:.8125rem">${esc(e.citation)}</code></td>
                <td style="color:#444;font-size:.875rem">${esc(e.label ?? '—')}</td>
                <td style="font-size:.8125rem;color:#666">${e.last_checked ? fmtDateTime(e.last_checked) : '—'}</td>
                <td style="text-align:center">${e.last_count > 0 ? `<span class="badge-active" style="font-size:.75rem">${e.last_count}</span>` : '—'}</td>
                <td>
                  <form method="POST" action="/admin/watchlist/remove" style="display:inline">
                    <input type="hidden" name="citation" value="${esc(e.citation)}">
                    <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Remove ${esc(e.citation)} from watchlist?')">Remove</button>
                  </form>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>`}
      </div>
    `, session.user, '/admin/watchlist')
  );
});

adminRouter.post('/admin/watchlist/add', requireAdmin, requireCsrf, async (req, res) => {
  const { citation, label } = req.body as Record<string, string | undefined>;
  if (citation?.trim()) {
    const session = getAdminSession(req)!;
    await addWatchlistEntry(citation.trim(), label?.trim() || undefined, session.user).catch(() => {});
  }
  res.redirect('/admin/watchlist');
});

adminRouter.post('/admin/watchlist/remove', requireAdmin, requireCsrf, async (req, res) => {
  const { citation } = req.body as Record<string, string | undefined>;
  if (citation?.trim()) await removeWatchlistEntry(citation.trim()).catch(() => {});
  res.redirect('/admin/watchlist');
});
