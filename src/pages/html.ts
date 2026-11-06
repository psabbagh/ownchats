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
header.top{display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line);padding:12px 16px}
header.top strong{font-size:18px}header.top nav{display:flex;gap:12px;flex-wrap:wrap}
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
input[type=text],input[type=password],input[type=url],input[type=email],textarea,select{font:inherit;width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{min-height:80px}label{display:block;margin:12px 0 4px;font-weight:600}label.inline{display:flex;gap:8px;align-items:center;font-weight:400}
.hint{font-size:14px;color:var(--muted);margin:2px 0 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:13px;border:1px solid var(--line)}
.pill.sent,.pill.saved,.pill.received{color:var(--ok);border-color:var(--ok)}.pill.failed{color:var(--bad);border-color:var(--bad)}.pill.skipped,.pill.queued{color:var(--muted)}
.errors{border-color:var(--bad)}.notice{border-color:var(--warn)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}table.figures{max-width:480px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}.stats div{border:1px solid var(--line);border-radius:8px;padding:8px}.stats b{display:block;font-size:22px}
`;

const COPY_SCRIPT = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.getAttribute('data-copy')).then(()=>{const t=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=t,1200)})});`;

export function page(title: string, body: Html, opts: { nav?: boolean; head?: Html } = {}): Response {
  const nav = opts.nav
    ? html`<header class="top"><strong>OwnChats</strong><nav><a href="/dashboard">Campaigns</a><a href="/dashboard/leads">Leads</a><a href="/dashboard/activity">Activity</a><a href="/dashboard/settings">Settings</a><a href="/setup">Setup</a></nav>
        <form method="post" action="/logout" style="margin-left:auto"><button class="secondary">Sign out</button></form></header>`
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
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; form-action 'self' https://www.facebook.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

export function copyField(value: string): Html {
  return html`<div class="copy"><code>${value}</code><button type="button" class="secondary" data-copy="${value}">Copy</button></div>`;
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
