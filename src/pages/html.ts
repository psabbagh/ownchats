/** HTML built with a tagged template that escapes every interpolated value. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return new Html(out);
}

/** 12345 as "12,345". */
export const fmtCount = (n: number): string => n.toLocaleString("en-US");

/** "1 comment", "3 comments". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Trusted markup only. */
export function raw(s: string): Html {
  return new Html(s);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#0f766e;--ok:#15803d;--bad:#b91c1c;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#2dd4bf;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
header.top{display:flex;gap:8px 20px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line);padding:10px 16px}
header.top .brand{font-size:18px;font-weight:700;color:var(--fg);text-decoration:none;white-space:nowrap}
header.top nav{display:flex;gap:2px;flex-wrap:wrap}header.top nav a{padding:4px 10px;border-radius:6px;color:var(--muted);text-decoration:none;font-weight:500}
header.top nav a:hover{color:var(--fg);background:var(--line)}header.top nav a[aria-current]{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);font-weight:600}
header.top .end{margin-left:auto;display:flex;gap:2px;align-items:center}header.top .end form{margin:0}
header.top .end button{background:transparent;border:0;color:var(--muted);padding:4px 10px;font-size:14px}header.top .end button:hover{color:var(--fg)}
header.top .end nav a{font-size:14px}
a{color:var(--accent)}h1{font-size:26px;margin:8px 0 16px}h2{font-size:20px;margin:28px 0 8px}h3{font-size:17px;margin:0 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.muted{color:var(--muted)}.small{font-size:14px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.step{display:flex;gap:12px}.step .mark{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-weight:700;border:2px solid var(--line)}
.step.done .mark{border-color:var(--ok);color:var(--ok)}.step.todo .mark{border-color:var(--warn);color:var(--warn)}.step.fail .mark{border-color:var(--bad);color:var(--bad)}
.step .body{flex:1;min-width:0}
.copy{display:flex;gap:6px;margin:6px 0;align-items:center}.copy code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg)}
button,.button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.secondary,.button.secondary{background:transparent;color:var(--accent)}button.danger{background:var(--bad);border-color:var(--bad)}
.choices{margin:8px 0 4px}.choices form{margin:0;gap:6px}.choices select{width:auto;max-width:100%;padding:5px 8px}.choices button{padding:5px 12px}
input[type=text],input[type=password],input[type=url],input[type=email],textarea,select{font:inherit;width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{min-height:80px}label{display:block;margin:12px 0 4px;font-weight:600}label.inline{display:flex;gap:8px;align-items:center;font-weight:400}
.hint{font-size:14px;color:var(--muted);margin:2px 0 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:13px;border:1px solid var(--line)}
.pill.sent,.pill.saved,.pill.received{color:var(--ok);border-color:var(--ok)}.pill.failed{color:var(--bad);border-color:var(--bad)}.pill.skipped,.pill.queued{color:var(--muted)}
button.switch{display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 5px;border-radius:999px;font-size:13px;line-height:1.3;background:transparent;color:var(--muted);border-color:var(--muted)}
button.switch::before{content:"";width:14px;height:14px;border-radius:50%;background:var(--muted)}
button.switch.on{flex-direction:row-reverse;padding:4px 5px 4px 10px;color:var(--ok);border-color:var(--ok)}button.switch.on::before{background:var(--ok)}
.errors{border-color:var(--bad)}.notice{border-color:var(--warn)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}table.figures{max-width:480px}
.campaign{align-items:flex-start;flex-wrap:nowrap}.campaign>.body{flex:1;min-width:0}
.campaign.off{background:transparent;border-style:dashed}.pill.off{color:var(--warn);border-color:var(--warn);font-weight:600}.campaign.off>.cover,.campaign.off .body>:not(.row):not([role=status]),.campaign.off h3{opacity:.55}
.recent{margin:4px 0 6px;display:flex;flex-wrap:wrap;gap:4px 16px}
.funnel{margin:6px 0 0;display:flex;flex-wrap:wrap;gap:2px 14px}.funnel b{font-size:16px}
.pill.quiet{color:var(--muted);border-color:var(--muted);border-style:dashed}
.dm-chart{vertical-align:middle;margin-left:4px;fill:var(--accent);stroke:var(--line)}.dm-chart rect{stroke:none}
.status-note{margin:-8px 0 12px}.status-note.muted a{color:inherit}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;background:var(--muted)}.dot.warn{background:var(--warn)}
.list-head{align-items:center;margin:4px 0}.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{padding:2px 10px;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--fg)}.chip.current{border-color:var(--accent);color:var(--accent);font-weight:600}
.cover{flex:none;width:64px;height:114px;border-radius:6px;overflow:hidden;border:1px solid var(--line);background:var(--bg)}.cover img{display:block;width:100%;height:100%;object-fit:cover}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}.stats div{border:1px solid var(--line);border-radius:8px;padding:8px}.stats b{display:block;font-size:22px}
`;

const COPY_SCRIPT = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.getAttribute('data-copy')).then(()=>{const t=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=t,1200)})});`;

/** A section of the signed-in pages; the header marks the one being shown. */
export type Section = "campaigns" | "leads" | "activity" | "settings" | "setup";

const SECTIONS: [Section, string, string][] = [
  ["campaigns", "/dashboard", "Campaigns"],
  ["leads", "/dashboard/leads", "Leads"],
  ["activity", "/dashboard/activity", "Activity"],
  ["settings", "/dashboard/settings", "Settings"],
];

function navLink(section: Section, href: string, label: string, current: Section): Html {
  return section === current ? html`<a aria-current="page" href="${href}">${label}</a>` : html`<a href="${href}">${label}</a>`;
}

export function page(title: string, body: Html, opts: { nav?: Section; head?: Html } = {}): Response {
  const current = opts.nav;
  // Home is "/", which sends the owner to the dashboard, or to setup while nothing is connected.
  const nav = current
    ? html`<header class="top"><a class="brand" href="/" title="Home">OwnChats</a>
        <nav aria-label="Main">${SECTIONS.map(([s, href, label]) => navLink(s, href, label, current))}</nav>
        <div class="end"><nav aria-label="Account">${navLink("setup", "/setup", "Setup", current)}</nav>
        <form method="post" action="/logout"><button>Sign out</button></form></div></header>`
    : "";
  const doc = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title><style>${raw(STYLE)}</style>${opts.head ?? ""}</head>
<body>${nav}<main>${body}</main><script>${raw(COPY_SCRIPT)}</script></body></html>`;
  return new Response(doc.value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      // Not "no-referrer": with it, browsers send "Origin: null" on form posts, and the
      // same-origin check would refuse every form. "same-origin" still sends nothing to other sites.
      "referrer-policy": "same-origin",
      // Never kept by the browser, so Back after signing out shows no leads.
      "cache-control": "no-store",
      // Sign out behind Cloudflare Access posts to /logout, which redirects through the team's
      // cloudflareaccess.com address; form-action covers redirects, so that host is allowed too.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; form-action 'self' https://www.facebook.com https://*.cloudflareaccess.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

export function copyField(value: string): Html {
  return html`<div class="copy"><code>${value}</code><button type="button" class="secondary" data-copy="${value}">Copy</button></div>`;
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}

const formats = new Map<string, Intl.DateTimeFormat>();

function partsIn(ms: number, tz: string): Record<string, string> {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    formats.set(tz, f);
  }
  return Object.fromEntries(f.formatToParts(ms).map((p) => [p.type, p.value]));
}

/** A time in the owner's zone (timeZoneOf): "2026-11-06 09:03 EST". */
export function fmtTime(ms: number | null | undefined, tz: string): string {
  if (!ms) return "";
  const p = partsIn(ms, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** The day in the owner's zone: "2026-11-06". */
export function fmtDate(ms: number | null | undefined, tz: string): string {
  if (!ms) return "";
  const p = partsIn(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}
