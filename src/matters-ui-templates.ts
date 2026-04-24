/**
 * Matters UI templates — large static HTML/CSS blobs extracted from matters-ui.ts.
 * Pure view layer: no data access, no req/res.
 */

export const LOGO_SRC = '';

function escAttr(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:ital,opsz,wght@0,14..32,300..700;1,14..32,400&display=swap');

:root {
  --bg:#F5F3EF;--surface:#FFFFFF;--surf-2:#F8F7F4;--surf-3:#EFECE6;--surf-4:#E5E1D8;
  --bdr:rgba(26,26,26,0.07);--bdr-2:rgba(26,26,26,0.12);--bdr-3:rgba(26,26,26,0.18);--bdr-4:rgba(26,26,26,0.26);
  --accent:#B79A5B;--accent-l:#C9AE75;--accent-xl:#D9C48E;--accent-bg:rgba(183,154,91,0.10);--accent-bdr:rgba(183,154,91,0.30);
  --gold:#7A5C1E;--gold-l:#9A7530;--gold-bg:rgba(122,92,30,0.09);--gold-bdr:rgba(122,92,30,0.28);
  --ok:#15803D;--ok-bg:rgba(21,128,61,0.08);--warn:#B45309;--warn-bg:rgba(180,83,9,0.08);
  --err:#B91C1C;--err-bg:rgba(185,28,28,0.08);
  --txt:#1A1A1A;--txt-2:#555555;--txt-3:#888888;
  --r:8px;--r-lg:14px;--r-xl:20px;--sw:228px;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
img{max-width:100%;height:auto;}
html,body{height:100%;}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.5;background:var(--bg);color:var(--txt);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}
a{color:inherit;}

/* ── Layout ── */
.app{display:flex;height:100vh;overflow:hidden;}
.sidebar{width:var(--sw);flex-shrink:0;height:100vh;display:flex;flex-direction:column;background:#0B1F33;border-right:1px solid rgba(255,255,255,0.08);position:fixed;left:0;top:0;z-index:100;overflow-y:auto;}
.main{margin-left:var(--sw);flex:1;height:100vh;overflow-y:auto;min-width:0;}
.content{padding:2.5rem 2rem;max-width:1200px;}

/* ── Sidebar Logo ── */
.sb-logo{padding:1.375rem 1.25rem 1rem;display:flex;align-items:center;gap:.625rem;border-bottom:1px solid rgba(255,255,255,0.08);text-decoration:none;}
.sb-logo img{height:26px;width:auto;display:block;filter:brightness(0) invert(1);}
.sb-logo-mark{width:28px;height:28px;background:var(--accent);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:.875rem;color:#0B1F33;font-weight:700;flex-shrink:0;}
.sb-wordmark{display:flex;flex-direction:column;}
.sb-logo-name{font-family:'DM Serif Display',Georgia,serif;font-size:1rem;color:#fff;letter-spacing:-.01em;line-height:1.2;}
.sb-logo-sub{font-size:.5625rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,0.35);}

/* ── Sidebar Nav ── */
.sb-nav{flex:1;padding:.75rem 0;}
.sb-section{font-size:.5625rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,0.32);padding:.875rem 1.25rem .3rem;}
.sb-link{display:flex;align-items:center;gap:.625rem;padding:.5625rem 1.25rem;font-size:.875rem;font-weight:400;color:rgba(255,255,255,0.6);text-decoration:none;border-left:2px solid transparent;transition:all .15s;}
.sb-link:hover{color:rgba(255,255,255,0.9);background:rgba(255,255,255,0.05);}
.sb-link.active{color:#fff;background:rgba(183,154,91,0.18);border-left-color:var(--accent);font-weight:500;}
.sb-link svg{flex-shrink:0;opacity:.6;}
.sb-link.active svg{opacity:1;}

/* ── Sidebar Footer ── */
.sb-footer{padding:.875rem 1rem;border-top:1px solid rgba(255,255,255,0.08);margin-top:auto;}
.sb-user{display:flex;align-items:center;gap:.625rem;}
.sb-avatar{width:30px;height:30px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:#0B1F33;flex-shrink:0;text-transform:uppercase;}
.sb-user-info{flex:1;min-width:0;}
.sb-username{font-size:.8125rem;font-weight:500;color:rgba(255,255,255,0.9);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sb-role{font-size:.6875rem;color:rgba(255,255,255,0.4);}
.sb-logout{color:rgba(255,255,255,0.35);text-decoration:none;padding:.375rem;border-radius:6px;transition:all .15s;display:flex;flex-shrink:0;}
.sb-logout:hover{color:var(--err);background:var(--err-bg);}

/* ── Page Header ── */
.page-hd{margin-bottom:2rem;display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap;}
.page-title{font-family:'DM Serif Display',Georgia,serif;font-size:1.625rem;font-weight:400;color:#0B1F33;letter-spacing:-.02em;line-height:1.2;}
.page-sub{font-size:.875rem;color:var(--txt-2);margin-top:.3rem;}
.page-actions{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;}
h1{font-family:'DM Serif Display',Georgia,serif;font-size:1.5rem;font-weight:400;color:#0B1F33;letter-spacing:-.02em;margin-bottom:.375rem;}
h2{font-family:'DM Serif Display',Georgia,serif;font-size:1.0625rem;font-weight:400;color:#0B1F33;letter-spacing:-.01em;margin-bottom:.875rem;}
.subtitle{color:var(--txt-2);font-size:.875rem;margin-bottom:1.75rem;}

/* ── Stat cards ── */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:1rem;margin-bottom:2rem;}
/* summary-grid is an alias used throughout the templates */
.summary-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:1rem;margin-bottom:2rem;}
.card,.stat-card{background:var(--surface);border:1px solid var(--bdr);border-radius:var(--r-lg);padding:1.25rem 1.375rem;transition:border-color .2s,transform .2s,box-shadow .2s;animation:cardIn .35s ease both;}
.card:hover,.stat-card:hover{border-color:var(--bdr-2);transform:translateY(-1px);box-shadow:0 8px 32px rgba(0,0,0,.08);}
a.card,a.stat-card{text-decoration:none;color:inherit;cursor:pointer;display:block;}
.card-label{font-size:.625rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--txt-3);margin-bottom:.5rem;}
.card-value{font-family:'DM Serif Display',Georgia,serif;font-size:1.75rem;font-weight:400;color:var(--txt);line-height:1;letter-spacing:-.02em;}
.card-value.sm{font-size:1.0625rem;font-family:inherit;font-weight:600;}
.card-sub{font-size:.75rem;color:var(--txt-2);margin-top:.375rem;}
.card-link{text-decoration:none;color:inherit;}
.card-link .card:hover{border-color:var(--bdr-2);}

/* ── Section block ── */
.section-block,.section{background:var(--surface);border:1px solid var(--bdr);border-radius:var(--r-lg);padding:1.5rem;margin-bottom:1.25rem;}
.section-block h2,.section h2{font-size:.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--txt-3);margin-bottom:1rem;font-family:inherit;}
.section-hd{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:1.25rem;}
.section-title{font-size:.6875rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt-3);}

/* ── Tables ── */
.table-wrap{overflow-x:auto;border-radius:var(--r);border:1px solid var(--bdr);-webkit-overflow-scrolling:touch;}
.table-wrap table{border-radius:0;border:none;}
table{width:100%;border-collapse:collapse;font-size:.8125rem;}
thead th{background:var(--surf-2);padding:.625rem 1rem;text-align:left;font-size:.625rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--txt-3);border-bottom:1px solid var(--bdr);white-space:nowrap;}
tbody tr{border-bottom:1px solid var(--bdr);}
tbody tr:last-child{border-bottom:none;}
tbody td{padding:.75rem 1rem;color:var(--txt);vertical-align:middle;}
tbody tr:hover td{background:var(--surf-2);}
tbody tr.row-error td{background:rgba(248,113,113,0.04)!important;}
tbody tr.row-error:hover td{background:rgba(248,113,113,0.08)!important;}
.td-clip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;}
.ua-cell{word-break:break-word;white-space:normal;max-width:200px;font-size:.75rem;color:var(--txt-2);}
.date-small{color:var(--txt-2);font-size:.75rem;white-space:nowrap;}
.mono{font-family:ui-monospace,'Cascadia Code',monospace;font-size:.8125rem;}
.count{font-weight:600;}
.users-cell{color:var(--txt-2);font-size:.8125rem;}
.query-full{white-space:pre-wrap;word-break:break-word;color:var(--txt);line-height:1.5;}
.top-results-stack a{color:var(--accent-l);text-decoration:none;display:block;word-break:break-word;margin-bottom:.25rem;font-size:.75rem;line-height:1.4;}
.top-results-stack a:hover{text-decoration:underline;}
.matter-ref{font-weight:600;font-family:ui-monospace,'Cascadia Code',monospace;font-size:.8125rem;color:var(--accent-l);text-decoration:none;}
.matter-ref:hover{text-decoration:underline;}

/* ── Badges ── */
.badge,.tag{display:inline-flex;align-items:center;gap:.2rem;padding:.2rem .5rem;border-radius:100px;font-size:.6875rem;font-weight:600;white-space:nowrap;}
.badge-ok,.badge-active{background:var(--ok-bg);color:var(--ok);}
.badge-warn{background:var(--warn-bg);color:var(--warn);}
.badge-err,.badge-inactive{background:var(--err-bg);color:var(--err);}
.badge-accent,.badge-admin{background:var(--accent-bg);color:var(--accent-l);}
.badge-gold{background:var(--gold-bg);color:var(--gold-l);}
.badge-neutral,.tag{background:var(--surf-3);color:var(--txt-2);}
.admin-badge{display:inline-flex;align-items:center;padding:.2rem .5rem;border-radius:100px;font-size:.6875rem;font-weight:600;background:var(--accent-bg);color:var(--accent-l);margin-left:.375rem;vertical-align:middle;}
.est-badge{display:inline-flex;align-items:center;padding:.2rem .5rem;border-radius:100px;font-size:.6875rem;font-weight:500;background:var(--gold-bg);color:var(--gold-l);}
.acc-badge{display:inline-block;padding:.175rem .4rem;border-radius:100px;font-size:.6875rem;font-weight:600;}
.acc-high{background:var(--ok-bg);color:var(--ok);}
.acc-mid{background:var(--warn-bg);color:var(--warn);}
.acc-low{background:var(--err-bg);color:var(--err);}

/* ── Buttons ── */
.btn{display:inline-flex;align-items:center;gap:.375rem;padding:.5625rem 1.125rem;border-radius:var(--r);font-size:.875rem;font-weight:500;font-family:inherit;cursor:pointer;text-decoration:none;border:1px solid transparent;transition:all .15s;white-space:nowrap;line-height:1;}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent);}
.btn-primary:hover{background:var(--accent-l);border-color:var(--accent-l);box-shadow:0 0 0 3px var(--accent-bg);}
.btn-secondary{background:transparent;color:var(--txt-2);border-color:var(--bdr-2);}
.btn-secondary:hover{background:var(--surf-2);color:var(--txt);border-color:var(--bdr-3);}
.btn-danger{background:transparent;color:var(--err);border-color:var(--err-bg);}
.btn-danger:hover{background:var(--err-bg);border-color:var(--err);}
.btn-sm{padding:.3125rem .75rem;font-size:.8125rem;}
.btn-xs{padding:.2rem .5rem;font-size:.75rem;}
.btn-back{display:inline-flex;align-items:center;gap:.375rem;font-size:.8125rem;color:var(--txt-2);text-decoration:none;margin-bottom:1.5rem;transition:color .15s;}
.btn-back:hover{color:var(--txt);}
.actions{display:flex;gap:.75rem;margin-bottom:1.5rem;align-items:center;flex-wrap:wrap;}

/* ── Forms ── */
.form-group{margin-bottom:1.125rem;}
.form-group label,label{display:block;font-size:.8125rem;font-weight:500;margin-bottom:.375rem;color:var(--txt-2);}
input[type="text"],input[type="password"],input[type="number"],input[type="email"],select,textarea{width:100%;padding:.625rem .875rem;background:var(--surf-2);border:1px solid var(--bdr-2);border-radius:var(--r);color:var(--txt);font-size:.9375rem;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s;-webkit-appearance:none;appearance:none;}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg);}
input::placeholder{color:var(--txt-3);}
select{cursor:pointer;padding-right:2.25rem;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .75rem center;}
select option{background:var(--surf-3);color:var(--txt);}
.form-hint{font-size:.75rem;color:var(--txt-3);margin-top:.3rem;}
.error-box{background:var(--err-bg);border:1px solid var(--err);border-radius:var(--r);color:var(--err);font-size:.875rem;padding:.625rem .875rem;margin-bottom:1rem;}

/* ── Filter bar ── */
.filter-bar{background:var(--surface);border:1px solid var(--bdr);border-radius:var(--r-lg);padding:1rem 1.25rem;margin-bottom:1.25rem;display:flex;gap:.875rem;flex-wrap:wrap;align-items:flex-end;}
.filter-group{display:flex;flex-direction:column;gap:.3rem;}
.filter-group label{font-size:.5625rem;font-weight:700;color:var(--txt-3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:0;}
.filter-input{padding:.4rem .75rem;border:1px solid var(--bdr-2);border-radius:var(--r);background:var(--surf-2);color:var(--txt);font-size:.875rem;height:34px;outline:none;transition:border-color .15s,box-shadow .15s;font-family:inherit;-webkit-appearance:none;appearance:none;}
.filter-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg);}
select.filter-input{cursor:pointer;min-width:130px;}
.filter-btn{padding:0 1rem;background:var(--accent);color:#fff;border:none;border-radius:var(--r);font-size:.875rem;font-weight:500;cursor:pointer;height:34px;font-family:inherit;transition:background .15s;}
.filter-btn:hover{background:var(--accent-l);}
.filter-clear{font-size:.8125rem;color:var(--txt-3);text-decoration:none;align-self:flex-end;padding-bottom:.25rem;transition:color .15s;}
.filter-clear:hover{color:var(--txt);}

/* ── Segmented tabs ── */
.seg-tabs{display:flex;gap:.25rem;background:var(--surf-3);border-radius:var(--r);padding:.25rem;margin-bottom:1.25rem;width:fit-content;flex-wrap:wrap;}
.seg-tab{padding:.3125rem .875rem;border-radius:6px;font-size:.8125rem;font-weight:500;text-decoration:none;color:var(--txt-2);transition:all .15s;}
.seg-tab.active{background:var(--surf-4);color:var(--txt);box-shadow:0 1px 3px rgba(0,0,0,.2);}
.seg-tab:hover:not(.active){color:var(--txt);}

/* ── Tool bar chart ── */
.tool-bar-row{display:flex;align-items:center;gap:.75rem;margin-bottom:.625rem;}
.tool-bar-label{width:155px;font-size:.8125rem;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;}
.tool-bar-track{flex:1;height:6px;background:var(--surf-3);border-radius:3px;overflow:hidden;}
.tool-bar-fill{height:100%;background:var(--accent);border-radius:3px;}
.tool-bar-meta{font-size:.75rem;color:var(--txt-3);white-space:nowrap;min-width:200px;text-align:left;flex-shrink:0;}

/* ── Volume chart ── */
.vol-chart,.vol-chart-inner{display:flex;align-items:flex-end;gap:3px;height:72px;padding-top:8px;}
.vol-col{display:flex;flex-direction:column;align-items:center;flex:1;height:100%;justify-content:flex-end;}
.vol-bar{width:100%;background:var(--accent);border-radius:2px 2px 0 0;min-height:2px;opacity:.7;transition:opacity .15s;}
.vol-col:hover .vol-bar{opacity:1;}
.vol-label{font-size:.5rem;color:var(--txt-3);margin-top:3px;white-space:nowrap;}

/* ── Popular cases / researcher ── */
.researcher-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.75rem;}
.researcher-card{background:var(--surf-2);border:1px solid var(--bdr);border-radius:var(--r);padding:.875rem 1rem;}
.researcher-name{font-weight:600;font-size:.9375rem;margin-bottom:.375rem;color:var(--txt);}
.researcher-stats{font-size:.8125rem;color:var(--txt-2);display:flex;flex-direction:column;gap:.2rem;}
.popular-case-row{display:flex;gap:.75rem;align-items:baseline;padding:.5rem 0;border-bottom:1px solid var(--bdr);font-size:.8125rem;}
.popular-case-row:last-child{border-bottom:none;}
.popular-case-rank{color:var(--txt-3);width:1.25rem;flex-shrink:0;text-align:right;font-size:.75rem;}
.popular-case-title{flex:1;}
.popular-case-title a{color:var(--accent-l);text-decoration:none;}
.popular-case-title a:hover{text-decoration:underline;}
.popular-case-citation{color:var(--txt-2);font-size:.75rem;white-space:nowrap;}
.popular-case-count{font-weight:600;color:var(--txt);font-size:.75rem;white-space:nowrap;}

/* ── Empty state ── */
.empty{text-align:center;padding:4rem 2rem;color:var(--txt-2);background:var(--surface);border:1px solid var(--bdr);border-radius:var(--r-lg);}

/* ── Tooltip ── */
.tip{position:relative;cursor:help;display:inline-block;}
.tip::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--surf-4);color:var(--txt);border:1px solid var(--bdr-2);padding:.375rem .625rem;border-radius:var(--r);font-size:.75rem;font-weight:400;font-family:inherit;white-space:normal;width:220px;line-height:1.45;pointer-events:none;opacity:0;transition:opacity .15s .1s;z-index:200;box-shadow:0 4px 12px rgba(0,0,0,.12);text-align:left;}
.tip::before{content:'';position:absolute;bottom:calc(100% + 1px);left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:var(--surf-4);pointer-events:none;opacity:0;transition:opacity .15s .1s;z-index:200;}
.tip:hover::after,.tip:focus::after{opacity:1;}
.tip:hover::before,.tip:focus::before{opacity:1;}
.tip-right::after{left:auto;right:0;transform:none;}
.tip-right::before{left:auto;right:12px;transform:none;}
.tip-below::after{bottom:auto;top:calc(100% + 6px);}
.tip-below::before{bottom:auto;top:calc(100% + 1px);border-top-color:transparent;border-bottom-color:var(--surf-4);}

/* ── Login ── */
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--bg);padding:1rem;background-image:radial-gradient(ellipse 80% 60% at 50% -10%,rgba(11,31,51,0.08),transparent);}
.login-card{background:var(--surface);border:1px solid var(--bdr-2);border-radius:var(--r-xl);padding:2.5rem 2.25rem;width:100%;max-width:380px;box-shadow:0 24px 64px rgba(11,31,51,0.12);animation:loginIn .4s ease both;}
.login-logo{margin-bottom:1.75rem;display:flex;align-items:center;gap:.75rem;}
.login-logo img{height:32px;width:auto;}
.login-logo-mark{width:40px;height:40px;background:#0B1F33;border-radius:var(--r);display:flex;align-items:center;justify-content:center;font-size:1.125rem;color:#fff;font-weight:700;}
.login-title{font-family:'DM Serif Display',Georgia,serif;font-size:1.5rem;font-weight:400;color:#0B1F33;margin-bottom:.25rem;letter-spacing:-.02em;}
.login-sub{font-size:.875rem;color:var(--txt-2);margin-bottom:2rem;}
.login-btn{width:100%;padding:.75rem;background:var(--accent);color:#fff;border:none;border-radius:var(--r);font-size:1rem;font-weight:500;cursor:pointer;transition:all .15s;font-family:inherit;}
.login-btn:hover{background:var(--accent-l);box-shadow:0 0 0 3px var(--accent-bg);}

/* ── Spend bar ── */
.spend-bar{height:6px;background:var(--surf-3);border-radius:3px;margin-top:.5rem;overflow:hidden;}
.spend-fill{height:100%;border-radius:3px;}
.spend-ok{background:var(--ok);}
.spend-warn{background:var(--warn);}
.spend-err{background:var(--err);}

/* ── Animations ── */
@keyframes fadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
@keyframes cardIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
@keyframes loginIn{from{opacity:0;transform:translateY(20px) scale(.98);}to{opacity:1;transform:translateY(0) scale(1);}}
.content{animation:fadeUp .3s ease both;}
.stat-card:nth-child(1),.card:nth-child(1){animation-delay:0ms;}
.stat-card:nth-child(2),.card:nth-child(2){animation-delay:50ms;}
.stat-card:nth-child(3),.card:nth-child(3){animation-delay:100ms;}
.stat-card:nth-child(4),.card:nth-child(4){animation-delay:150ms;}
.stat-card:nth-child(5),.card:nth-child(5){animation-delay:200ms;}

/* ── Print ── */
@media print{
  body{background:#fff;color:#000;font-size:9pt;}
  .sidebar,.page-actions,.filter-bar,.seg-tabs,.btn-back,.no-print,.actions{display:none!important;}
  .main{margin-left:0!important;}
  .content{padding:0;animation:none;}
  table{font-size:8pt;}
  .section-block,.section{background:#fff;border:1px solid #ccc;border-radius:0;}
  a{color:#000;}
  h1,h2{color:#000;}
}

/* ── Responsive ── */
@media(max-width:768px){
  .app{flex-direction:column;height:auto;}
  .sidebar{position:relative;width:100%;height:auto;flex-direction:row;flex-wrap:wrap;border-right:none;border-bottom:1px solid rgba(255,255,255,0.08);overflow:visible;}
  .sb-logo{padding:.75rem 1rem;border-bottom:none;}
  .sb-wordmark{display:none;}
  .sb-nav{display:flex;flex-direction:row;flex-wrap:wrap;padding:.25rem .5rem;}
  .sb-section{display:none;}
  .sb-link{padding:.375rem .625rem;border-left:none;border-bottom:2px solid transparent;font-size:.8125rem;}
  .sb-link.active{border-left:none;border-bottom-color:var(--accent);}
  .sb-footer{padding:.5rem .875rem;border-top:none;border-left:1px solid rgba(255,255,255,0.08);margin-left:auto;align-self:center;}
  .sb-role{display:none;}
  .main{margin-left:0;height:auto;}
  .content{padding:1.25rem 1rem;}
  .summary-grid,.stat-grid{grid-template-columns:repeat(2,1fr);}
}

/* Matter ref copy button */
.copy-ref-btn{background:none;border:none;cursor:pointer;color:var(--txt-3);font-size:.875rem;padding:0 .25rem;vertical-align:middle;}
.copy-ref-btn:hover{color:var(--accent-l);}

/* Sort links in table headers */
.sort-link{color:inherit;text-decoration:none;}
.sort-link:hover{color:var(--accent-l);}
.sort-link.active{color:var(--accent-l);font-weight:700;}

/* Export dropdown */
details.export-dd{position:relative;display:inline-block;}
details.export-dd summary{list-style:none;cursor:pointer;}
details.export-dd summary::-webkit-details-marker{display:none;}
details.export-dd[open] summary{background:var(--surf-3);color:var(--txt);border-color:var(--bdr-3);}
details.export-dd .dd-menu{position:absolute;top:calc(100% + 4px);left:0;background:var(--surf-3);border:1px solid var(--bdr-2);border-radius:var(--r);box-shadow:0 8px 24px rgba(11,31,51,.10);min-width:180px;z-index:200;padding:.25rem 0;}
details.export-dd .dd-menu a{display:block;padding:.45rem 1rem;font-size:.8125rem;color:var(--txt-2);text-decoration:none;white-space:nowrap;}
details.export-dd .dd-menu a:hover{background:var(--surf-4);color:var(--txt);}
details.export-dd .dd-menu .dd-sep{border:none;border-top:1px solid var(--bdr);margin:.25rem 0;}

/* Print header (shown only in print) */
.print-header{display:none;}
@media print{
  .print-header{display:block!important;margin-bottom:1rem;}
  .print-header-firm{font-family:Georgia,serif;font-size:11pt;font-weight:bold;color:#000;}
  .print-header-sub{font-size:7.5pt;color:#555;margin-top:.125rem;}
  .no-print-col{display:none!important;}
  table{font-size:7pt;border:1px solid #aaa;table-layout:fixed;}
  thead th{background:#eee!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;padding:.15rem .3rem!important;font-size:6.5pt;}
  td{padding:.15rem .3rem!important;vertical-align:top;word-break:break-word;}
  .query-full{white-space:pre-wrap;word-break:break-word;}
  .top-results-stack a{color:#333;text-decoration:none;}
  .acc-badge{border:1px solid #999;background:none!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  tr{page-break-inside:avoid;}
  @page{size:A4 landscape;margin:1.5cm;}
  td{word-wrap:break-word;overflow-wrap:break-word;}
  .summary-grid{display:none;}
}
`;

export interface MattersShellData {
  title: string;
  body: string;
  user: string | null;
  activePath?: string | undefined;
  isAdminUser?: boolean | undefined;
}

/** Renders the full HTML page shell (sidebar + body) for the matters UI. */
export function renderMattersShell(data: MattersShellData): string {
  const { title, body, user, activePath, isAdminUser } = data;

  // Login page — no sidebar
  if (!user) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escAttr(title)} — CP Legal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:ital,opsz,wght@0,14..32,300..700;1,14..32,400&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>${body}</body>
</html>`;
  }

  const avatar = (user.slice(0, 1) || '?').toUpperCase();
  const role = isAdminUser ? 'Admin' : 'Researcher';

  const navLink = (href: string, label: string, icon: string) =>
    `<a href="${href}" class="sb-link${activePath === href || (href !== '/mcp/matters' && activePath?.startsWith(href)) ? ' active' : ''}">${icon}${label}</a>`;

  const iconMatters = `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`;
  const iconDash = `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg>`;
  const iconAdmin = `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`;
  const iconLogout = `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>`;

  const sidebar = `<aside class="sidebar">
    <a href="/mcp/matters" class="sb-logo">
      <img src="${LOGO_SRC}" alt="CP Legal" onerror="this.style.display='none'">
      <div class="sb-logo-mark" style="display:flex">C</div>
      <div class="sb-wordmark">
        <span class="sb-logo-name">CP Legal</span>
        <span class="sb-logo-sub">Legal Research</span>
      </div>
    </a>
    <nav class="sb-nav">
      <div class="sb-section">Research</div>
      ${navLink('/mcp/matters/dashboard', 'Dashboard', iconDash)}
      ${navLink('/mcp/matters', 'Matters', iconMatters)}
      ${isAdminUser ? `<div class="sb-section">Administration</div>${navLink('/mcp/admin', 'Admin Panel', iconAdmin)}` : ''}
    </nav>
    <div class="sb-footer">
      <div class="sb-user">
        <div class="sb-avatar">${escAttr(avatar)}</div>
        <div class="sb-user-info">
          <div class="sb-username">${escAttr(user)}</div>
          <div class="sb-role">${role}</div>
        </div>
        <a href="/mcp/matters/logout" class="sb-logout" title="Sign out">${iconLogout}</a>
      </div>
    </div>
  </aside>`;

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
  <title>${escAttr(title)} — CP Legal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:ital,opsz,wght@0,14..32,300..700;1,14..32,400&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
<div class="app">
  ${sidebar}
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
