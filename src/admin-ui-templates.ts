/**
 * Admin UI templates — large static HTML/CSS blobs extracted from admin-ui.ts.
 * Pure view layer: no data access, no req/res.
 */

import { CSS, LOGO_SRC } from './matters-ui-templates.js';

function escAttr(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

export const ADMIN_CSS = `
${CSS}
.btn-danger { background:transparent;color:var(--err);border:1px solid var(--err-bg); }
.btn-danger:hover { background:var(--err-bg);border-color:var(--err); }
.btn-sm { padding:.3125rem .75rem;font-size:.8125rem; }
.token-display { background:var(--surf-2);border:1px solid var(--bdr-2);border-radius:var(--r);padding:1rem 1.25rem;font-family:ui-monospace,'Cascadia Code',monospace;font-size:.9375rem;word-break:break-all;color:var(--ok);margin:1rem 0;letter-spacing:.02em; }
.token-warning { background:var(--warn-bg);border:1px solid rgba(251,191,36,.3);border-radius:var(--r);padding:.75rem 1rem;font-size:.875rem;color:var(--warn);margin-bottom:.5rem; }
.token-explain { background:var(--accent-bg);border:1px solid var(--accent-bdr);border-radius:var(--r);padding:.75rem 1rem;font-size:.875rem;color:var(--accent-l);margin-bottom:.5rem; }
.badge-admin { display:inline-flex;align-items:center;padding:.2rem .5rem;border-radius:100px;font-size:.6875rem;font-weight:600;background:var(--accent-bg);color:var(--accent-l); }
.badge-inactive { display:inline-flex;align-items:center;padding:.2rem .5rem;border-radius:100px;font-size:.6875rem;font-weight:600;background:var(--err-bg);color:var(--err); }
.badge-active { display:inline-flex;align-items:center;padding:.2rem .5rem;border-radius:100px;font-size:.6875rem;font-weight:600;background:var(--ok-bg);color:var(--ok); }
.status-ok { color:var(--ok);font-weight:600; }
.status-err { color:var(--err);font-weight:600; }
.card-link { text-decoration:none;color:inherit; }
.card-link .card:hover { border-color:var(--bdr-2); }
.form-group { margin-bottom:1rem; }
.form-group label { display:block;font-size:.875rem;font-weight:500;margin-bottom:.375rem;color:var(--txt-2); }
.form-group input[type="text"],.form-group input[type="number"],.form-group select { width:100%;max-width:400px;padding:.5rem .75rem;border:1px solid var(--bdr-2);border-radius:6px;font-size:.9375rem;background:var(--surf-2);color:var(--txt);outline:none;transition:border-color .15s,box-shadow .15s; }
.form-group input:focus,.form-group select:focus { border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg); }
.form-group input[type="checkbox"] { width:auto; }
.form-hint { font-size:.8125rem;color:var(--txt-3);margin-top:.25rem; }
.section-title { font-size:.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--txt-3);margin:2rem 0 .75rem; }
.confirm-box { border:1px solid rgba(248,113,113,.3);background:var(--err-bg);border-radius:var(--r-lg);padding:1.25rem;margin-top:1.5rem; }
.confirm-box h3 { color:var(--err);font-size:.9375rem;margin-bottom:.75rem;font-family:inherit;font-weight:600; }
/* Admin sidebar layout */
.admin-layout { display:flex;min-height:calc(100vh - 52px); }
.admin-sidebar { width:220px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--bdr);padding:1.5rem 0; }
.admin-sidebar-section { font-size:.5625rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--txt-3);padding:0 1rem;margin:1rem 0 .375rem; }
.admin-sidebar-link { display:block;padding:.5rem 1rem;font-size:.875rem;color:var(--txt-2);text-decoration:none;border-left:2px solid transparent;transition:all .15s; }
.admin-sidebar-link:hover { background:var(--surf-2);color:var(--txt); }
.admin-sidebar-link.active { background:var(--accent-bg);color:var(--accent-l);border-left-color:var(--accent);font-weight:500; }
.admin-content { flex:1;padding:2rem 1.5rem;min-width:0;overflow:hidden; }
/* Period tabs */
.period-tabs { display:inline-flex;border:1px solid var(--bdr-2);border-radius:var(--r);overflow:hidden;margin-bottom:1.25rem; }
.period-tab { padding:.3rem .875rem;font-size:.8125rem;color:var(--txt-2);text-decoration:none;border-right:1px solid var(--bdr-2);background:transparent;transition:all .15s; }
.period-tab:last-child { border-right:none; }
.period-tab.active { background:var(--accent);color:#fff; }
.period-tab:hover:not(.active) { background:var(--surf-2);color:var(--txt); }
.copy-btn { padding:.3rem .75rem;font-size:.8125rem;background:var(--surf-3);border:1px solid var(--bdr-2);border-radius:var(--r);cursor:pointer;color:var(--txt-2);font-family:inherit;transition:all .15s; }
.copy-btn:hover { background:var(--surf-4);color:var(--txt); }
@media(max-width:768px){
  .admin-layout{flex-direction:column;}
  .admin-sidebar{width:100%;border-right:none;border-bottom:1px solid var(--bdr);padding:.75rem 0;display:flex;flex-wrap:wrap;gap:0;}
  .admin-sidebar-section{display:none;}
  .admin-sidebar-link{border-left:none;border-bottom:2px solid transparent;padding:.5rem .75rem;font-size:.8125rem;}
  .admin-sidebar-link.active{border-bottom-color:var(--accent);border-left:none;}
  .admin-content{padding:1.25rem 1rem;}
}
`;

export interface AdminShellData {
  title: string;
  body: string;
  user?: string | undefined;
  activePath?: string | undefined;
}

/** Renders the full HTML page shell (sidebar + body) for the admin UI. */
export function renderAdminShell(data: AdminShellData): string {
  const { title, body, user, activePath } = data;
  const avatar = (user?.slice(0, 1) || '?').toUpperCase();

  const iconDash = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg>`;
  const iconUsers = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/></svg>`;
  const iconMatters = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`;
  const iconWatch = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`;
  const iconConfig = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`;
  const iconData = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/></svg>`;
  const iconMattersRes = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>`;
  const iconLogout = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>`;
  const iconDocs = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>`;

  const lnk = (href: string, label: string, icon: string) =>
    `<a href="${href}" class="sb-link${activePath === href ? ' active' : ''}">${icon}<span>${label}</span></a>`;

  const sidebarHtml = user ? `<aside class="sidebar">
    <a href="/auslaw/admin" class="sb-logo">
      <img src="${LOGO_SRC}" alt="CP Legal" onerror="this.style.display='none'">
      <div class="sb-logo-mark" style="display:flex">C</div>
      <div class="sb-wordmark">
        <span class="sb-logo-name">CP Legal</span>
        <span class="sb-logo-sub">Admin</span>
      </div>
    </a>
    <nav class="sb-nav">
      <div class="sb-section">Overview</div>
      ${lnk('/auslaw/admin', 'Dashboard', iconDash)}
      <div class="sb-section">Management</div>
      ${lnk('/auslaw/admin/users', 'Users', iconUsers)}
      ${lnk('/auslaw/admin/matters', 'Matters', iconMatters)}
      <div class="sb-section">Research</div>
      ${lnk('/auslaw/admin/watchlist', 'Watchlist', iconWatch)}
      <div class="sb-section">System</div>
      ${lnk('/auslaw/admin/config', 'Config', iconConfig)}
      ${lnk('/auslaw/admin/data', 'Data', iconData)}
      ${lnk('/auslaw/admin/docs', 'Docs', iconDocs)}
      <div class="sb-section">Navigation</div>
      ${lnk('/auslaw/matters', 'Research Portal', iconMattersRes)}
    </nav>
    <div class="sb-footer">
      <div class="sb-user">
        <div class="sb-avatar">${escAttr(avatar)}</div>
        <div class="sb-user-info">
          <div class="sb-username">${escAttr(user)}</div>
          <div class="sb-role">Admin</div>
        </div>
        <a href="/auslaw/matters/logout" class="sb-logout" title="Sign out">${iconLogout}</a>
      </div>
    </div>
  </aside>` : '';

  const timeScript = `<script>
(function(){
  var tz='Australia/Sydney';
  try{var det=Intl.DateTimeFormat().resolvedOptions().timeZone;if(det)tz=det;}catch(e){}
  if(tz==='Australia/Sydney')return;
  document.querySelectorAll('time[data-utc]').forEach(function(el){
    var iso=el.getAttribute('data-utc');var fmt=el.getAttribute('data-fmt');
    try{
      var opts=fmt==='datetime'
        ?{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true,timeZone:tz}
        :{day:'2-digit',month:'short',year:'numeric',timeZone:tz};
      el.textContent=new Date(iso).toLocaleString('en-AU',opts);
    }catch(e){}
  });
})();
</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escAttr(title)} — CP Legal Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:ital,opsz,wght@0,14..32,300..700;1,14..32,400&display=swap" rel="stylesheet">
  <style>${ADMIN_CSS}</style>
</head>
<body>
<div class="app">
  ${sidebarHtml}
  <div class="main">
    <div class="content">
      ${body}
    </div>
  </div>
</div>
${timeScript}
</body>
</html>`;
}
