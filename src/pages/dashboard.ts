import { campaignFromForm, DEFAULTS, getCampaign, listCampaigns, saveCampaign, type Campaign, type CampaignInput, type EmailMode } from "../campaigns";

export const EMAIL_MODE_LABEL: Record<EmailMode, string> = { none: "link only", optional: "link plus optional email", first: "email first" };

function newCampaignDefaults(): CampaignInput {
  return {
    name: "",
    keywords: [],
    anyComment: false,
    mediaId: null,
    mediaLabel: null,
    publicReplies: DEFAULTS.publicReplies,
    openingText: DEFAULTS.openingText,
    openingButton: DEFAULTS.openingButton,
    emailMode: "none",
    emailPrompt: DEFAULTS.emailPrompt,
    emailReask: DEFAULTS.emailReask,
    emailThanks: DEFAULTS.emailThanks,
    optionalPrompt: DEFAULTS.optionalPrompt,
    optionalThanks: DEFAULTS.optionalThanks,
    consentText: "",
    linkText: DEFAULTS.linkText,
    links: [{ label: DEFAULTS.linkLabel, url: "" }],
    // Off by default: a keyword that is a common word ("traffic") would answer ordinary DMs.
    dmKeyword: false,
    active: true,
  };
}
import type { Ctx } from "../context";
import { randomToken, sha256Hex } from "../crypto";
import { leadsCsv, listLeads } from "../export";
import type { Media } from "../meta/client";
import { recentMedia } from "../pipeline/poll";
import { missedComments } from "../missed";
import { deleteSettings, saveSettings } from "../settings";
import { campaignCounts, deletePerson, findPersonByUsername, listActivity, type ActivityRow } from "../stats";
import { copyField, fmtTime, html, page, redirect, type Html } from "./html";

export function healthBanner(ctx: Ctx): Html {
  const s = ctx.settings;
  const notes: Html[] = [];
  if (!s.access_token || !s.ig_user_id) notes.push(html`Instagram is not connected yet. Finish the <a href="/setup">setup checklist</a>.`);
  if (s.token_problem) notes.push(html`${s.token_problem} <a href="/setup">Open setup</a>.`);
  const [at, problem] = (s.last_webhook_problem ?? "").split("|");
  if (problem && Number(at) > Number(s.last_webhook_at ?? 0)) notes.push(html`A webhook from Meta was refused: ${problem}. Check the app secret on <a href="/setup">setup</a>.`);
  if (!notes.length) return html``;
  return html`<div class="card notice">${notes.map((n) => html`<p>${n}</p>`)}</div>`;
}

export async function dashboardHome(ctx: Ctx): Promise<Response> {
  const campaigns = await listCampaigns(ctx.db);
  const counts = await campaignCounts(ctx);
  const missed = await missedComments(ctx, campaigns.filter((c) => c.active));
  const s = ctx.settings;
  return page(
    "OwnChats",
    html`${healthBanner(ctx)}
      <div class="row"><h1 style="flex:1">Campaigns</h1><a class="button" href="/dashboard/campaigns/new">New campaign</a></div>
      ${s.ig_username ? html`<p class="muted">Connected to @${s.ig_username}. Last webhook: ${fmtTime(Number(s.last_webhook_at)) || "none yet"}. Last check for missed comments: ${fmtTime(Number(s.last_poll_at)) || "none yet"}.</p>` : ""}
      ${campaigns.length === 0 ? html`<div class="card"><p>No campaigns yet. Create one: a keyword, the post it watches, and the link to send.</p></div>` : ""}
      ${campaigns.map((c) => {
        const n = counts.get(c.id);
        return html`<div class="card">
          <div class="row"><h3 style="flex:1"><a href="/dashboard/campaigns/${c.id}">${c.name}</a></h3>
            <span class="pill ${c.active ? "sent" : "skipped"}">${c.active ? "on" : "off"}</span></div>
          <p class="muted small">${c.anyComment ? "Any comment" : `Keyword: ${c.keywords.join(", ")}`} on ${c.mediaId ? c.mediaLabel || `post ${c.mediaId}` : "all posts"}, ${EMAIL_MODE_LABEL[c.emailMode]}</p>
          ${missed.get(c.id)?.length
            ? html`<p class="small"><a class="warn" href="/dashboard/campaigns/${c.id}#to-check">${missed.get(c.id)!.length === 1 ? "1 comment" : `${missed.get(c.id)!.length} comments`} to check</a></p>`
            : ""}
          <div class="stats small">
            <div><b>${n?.people ?? 0}</b>people</div><div><b>${n?.dmsSent ?? 0}</b>DMs sent</div>
            ${c.openingButton ? html`<div><b>${n?.taps ?? 0}</b>taps</div>` : ""}
            ${c.emailMode !== "none" ? html`<div><b>${n?.emails ?? 0}</b>emails</div>` : ""}
            <div><b>${n?.linksSent ?? 0}</b>links sent</div><div><b>${n?.failed ?? 0}</b>failed</div>
          </div></div>`;
      })}`,
    { nav: true },
  );
}

function mediaPicker(media: Media[], current: Campaign | null, input?: CampaignInput): Html {
  const selected = input ? input.mediaId ?? "all" : current ? current.mediaId ?? "all" : "all";
  const options = [...media];
  if (selected !== "all" && !options.some((m) => m.id === selected)) {
    options.unshift({ id: selected, caption: input?.mediaLabel ?? current?.mediaLabel ?? "", permalink: "", timestamp: 0, mediaType: "" });
  }
  return html`<label>Which post?</label>
    <label class="inline"><input type="radio" name="media_id" value="all" ${selected === "all" ? "checked" : ""}> All posts, including ones you haven't posted yet</label>
    ${options.map(
      (m) => html`<label class="inline"><input type="radio" name="media_id" value="${m.id}" ${selected === m.id ? "checked" : ""} data-label="${caption(m)}">
        ${m.thumbnailUrl ? html`<img src="${m.thumbnailUrl}" alt="" width="40" height="40" style="object-fit:cover;border-radius:4px">` : ""}
        <span>${caption(m)} <span class="muted small">${m.timestamp ? fmtTime(m.timestamp) : ""}</span></span></label>`,
    )}
    <input type="hidden" name="media_label" value="${input?.mediaLabel ?? current?.mediaLabel ?? ""}">
    <p class="hint">With all posts, use a keyword you don't use for anything else.</p>
    <script>document.addEventListener('change',e=>{if(e.target.name==='media_id'){document.querySelector('[name=media_label]').value=e.target.dataset.label||''}})</script>`;
}

function caption(m: Media): string {
  const c = (m.caption || "").replace(/\s+/g, " ").trim();
  return c ? (c.length > 70 ? `${c.slice(0, 70)}...` : c) : `Post ${m.id}`;
}

async function campaignForm(ctx: Ctx, current: Campaign | null, input?: CampaignInput, errors: string[] = []): Promise<Response> {
  let media: Media[] = [];
  let mediaProblem = "";
  try {
    media = await recentMedia(ctx);
  } catch (e) {
    mediaProblem = e instanceof Error ? e.message : String(e);
  }
  const v: CampaignInput = input ?? current ?? newCampaignDefaults();
  const action = current ? `/dashboard/campaigns/${current.id}` : "/dashboard/campaigns/new";
  const checked = (b: boolean) => (b ? "checked" : "");
  const mode = (m: EmailMode, label: string, hint: string) =>
    html`<label class="inline"><input type="radio" name="email_mode" value="${m}" ${checked(v.emailMode === m)}> <span><b>${label}</b> <span class="muted small">${hint}</span></span></label>`;
  const links = [...v.links, { label: "", url: "" }, { label: "", url: "" }, { label: "", url: "" }].slice(0, 3);
  return page(
    current ? `Edit ${current.name}` : "New campaign",
    html`<h1>${current ? `Edit "${current.name}"` : "New campaign"}</h1>
      ${errors.length ? html`<div class="card errors"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <p class="muted">Every message below is yours to edit. Write <code>{name}</code> for the person's Instagram name (their username when Meta doesn't share the name) or <code>{username}</code> for their username.</p>
      <form method="post" action="${action}">
        <div class="card">
          <label for="name">Name</label><input id="name" name="name" type="text" value="${v.name}" placeholder="Agents library" required>
          <label for="keywords">Keyword</label><input id="keywords" name="keywords" type="text" value="${v.keywords.join(", ")}" placeholder="AGENTS, AGENT">
          <p class="hint">Separate extra spellings with commas. Matching ignores case and needs the whole word: AGENTS matches "agents!" but not "agentsmith". A space also matches a hyphen, so SET UP matches "set-up" but not "setup".</p>
          <label class="inline"><input type="checkbox" name="any_comment" ${checked(v.anyComment)}> Any comment: answer every comment on the chosen post, keyword or not</label>
          ${mediaProblem ? html`<p class="warn small">Could not load your posts: ${mediaProblem}</p>` : ""}
          ${mediaPicker(media, current, input)}
        </div>
        <div class="card">
          <h3>Public reply under the comment</h3>
          <label for="public_replies">Reply variants, one per line</label>
          <textarea id="public_replies" name="public_replies" rows="4">${v.publicReplies.join("\n")}</textarea>
          <p class="hint">One is picked at random each time, never the same twice in a row: identical replies on a busy post can get your comments limited. Leave empty for no public reply.</p>
        </div>
        <div class="card">
          <h3>First DM</h3>
          <label for="opening_text">Message</label><textarea id="opening_text" name="opening_text">${v.openingText}</textarea>
          <label for="opening_button">Button label</label><input id="opening_button" name="opening_button" type="text" value="${v.openingButton}" maxlength="20">
          <p class="hint">Instagram lets you send one DM per comment until the person answers. The tap counts as an answer, so the next message can follow. Leave the label empty to send the next step (the link, or the email question) as the first DM.</p>
        </div>
        <div class="card">
          <h3>Link</h3>
          <label for="link_text">Message with the link</label><textarea id="link_text" name="link_text">${v.linkText}</textarea>
          ${links.map(
            (l, i) => html`<div class="row" style="align-items:flex-end">
              <div style="flex:2;min-width:220px"><label for="link_url_${i}">${i === 0 ? "Link" : `Link ${i + 1} (optional)`}</label>
                <input id="link_url_${i}" name="link_url_${i}" type="url" value="${l.url}" placeholder="https://" ${i === 0 ? "required" : ""}></div>
              <div style="flex:1;min-width:140px"><label for="link_label_${i}">Button label</label>
                <input id="link_label_${i}" name="link_label_${i}" type="text" value="${l.label}" maxlength="20" placeholder="${i === 0 ? DEFAULTS.linkLabel : ""}"></div></div>`,
          )}
          <p class="hint">Up to three links. With button labels they show as buttons under the message; leave every label empty to put the links in the message instead.</p>
        </div>
        <div class="card">
          <h3>Email</h3>
          ${mode("none", "Link only", "no email ask")}
          ${mode("optional", "Link plus optional email", "the link comes right away, with a line inviting them to reply with their email")}
          ${mode("first", "Email first", "ask for the email, re-ask once, then send the link either way")}
          <h3 style="margin-top:16px">Link plus optional email</h3>
          <label for="optional_prompt">Line added under the link</label><textarea id="optional_prompt" name="optional_prompt">${v.optionalPrompt}</textarea>
          <p class="hint">Say what people will receive. Replies that aren't an email are left alone: no re-ask.</p>
          <label for="optional_thanks">Reply once the email is saved</label><textarea id="optional_thanks" name="optional_thanks">${v.optionalThanks}</textarea>
          <p class="hint">Leave empty to say nothing.</p>
          <h3 style="margin-top:16px">Email first</h3>
          <label for="email_prompt">Question</label><textarea id="email_prompt" name="email_prompt">${v.emailPrompt}</textarea>
          <p class="hint">Say what people will receive.</p>
          <label for="email_reask">Reply when the answer isn't an email (sent once)</label><textarea id="email_reask" name="email_reask">${v.emailReask}</textarea>
          <label for="email_thanks">Message with the link once the email is saved</label><textarea id="email_thanks" name="email_thanks">${v.emailThanks}</textarea>
          <p class="hint">Leave empty to use the link message above. After a second answer that isn't an email, the link is sent anyway with the link message.</p>
          <h3 style="margin-top:16px">Consent</h3>
          <label for="consent_text">Wording saved with each email</label><textarea id="consent_text" name="consent_text" placeholder="Leave empty to save the question they answered">${v.consentText}</textarea>
          <p class="hint">Stored with every lead, with the date, as the record of what they agreed to.</p>
        </div>
        <div class="card">
          <label class="inline"><input type="checkbox" name="dm_keyword" ${checked(v.dmKeyword)}> Also answer the keyword when someone sends it by DM</label>
          <label class="inline"><input type="checkbox" name="active" ${checked(v.active)}> Campaign is on</label>
          <p><button>${current ? "Save" : "Create campaign"}</button> <a href="${current ? `/dashboard/campaigns/${current.id}` : "/dashboard"}">Cancel</a></p>
        </div>
      </form>
      ${current
        ? html`<form method="post" action="/dashboard/campaigns/${current.id}/delete" onsubmit="return confirm('Delete this campaign? Its emails stay in Leads.')">
            <button class="danger">Delete campaign</button></form>`
        : ""}`,
    { nav: true },
  );
}

export function newCampaignPage(ctx: Ctx): Promise<Response> {
  return campaignForm(ctx, null);
}

export async function editCampaignPage(ctx: Ctx, id: number): Promise<Response> {
  const c = await getCampaign(ctx.db, id);
  if (!c) return new Response("No such campaign", { status: 404 });
  return campaignForm(ctx, c);
}

export async function saveCampaignForm(ctx: Ctx, request: Request, id: number | null): Promise<Response> {
  const current = id === null ? null : await getCampaign(ctx.db, id);
  if (id !== null && !current) return new Response("No such campaign", { status: 404 });
  const { input, errors } = campaignFromForm(await request.formData());
  if (errors.length) return campaignForm(ctx, current, input, errors);
  const saved = await saveCampaign(ctx.db, input, id, ctx.now());
  return redirect(`/dashboard/campaigns/${saved}`);
}

export async function deleteCampaign(ctx: Ctx, id: number): Promise<Response> {
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM campaigns WHERE id = ?").bind(id),
    ctx.db.prepare("DELETE FROM conversations WHERE campaign_id = ?").bind(id),
  ]);
  return redirect("/dashboard");
}

/** What each kind of log entry is, in the dashboard's words. */
export const KIND_LABEL: Record<string, string> = {
  comment: "Comment",
  private_reply: "First DM",
  public_reply: "Public reply",
  tap: "Button tap",
  message: "DM",
  email: "Email",
  link: "Link",
  token: "Token",
};

export function activityTable(rows: ActivityRow[], names: Map<number, string>): Html {
  if (!rows.length) return html`<p class="muted">Nothing yet.</p>`;
  return html`<table><thead><tr><th>When</th><th>What</th><th>Result</th><th>Who</th><th>Why</th></tr></thead><tbody>
    ${rows.map(
      (r) => html`<tr><td class="small">${fmtTime(r.at)}</td>
        <td>${KIND_LABEL[r.kind] ?? r.kind}${r.campaign_id ? html`<br><span class="muted small">${names.get(r.campaign_id) ?? `campaign ${r.campaign_id}`}</span>` : ""}</td>
        <td><span class="pill ${r.outcome}">${r.outcome}</span></td>
        <td>${r.username ? `@${r.username}` : ""}</td>
        <td class="small">${r.reason ?? ""}${r.detail ? html`<br><span class="muted">${r.detail}</span>` : ""}</td></tr>`,
    )}</tbody></table>`;
}

export async function activityPage(ctx: Ctx, url: URL): Promise<Response> {
  const filter = url.searchParams.get("show") ?? "matched";
  const before = Number(url.searchParams.get("before")) || undefined;
  const rows = await listActivity(ctx, {
    limit: 100,
    before,
    matchedOnly: filter === "matched",
    outcome: filter === "failed" ? "failed" : undefined,
  });
  const names = new Map((await listCampaigns(ctx.db)).map((c) => [c.id, c.name]));
  const tab = (key: string, label: string) =>
    key === filter ? html`<b>${label}</b>` : html`<a href="/dashboard/activity?show=${key}">${label}</a>`;
  const last = rows[rows.length - 1];
  return page(
    "Activity",
    html`${healthBanner(ctx)}<h1>Activity</h1>
      <p class="row">${tab("matched", "Campaign activity")} ${tab("failed", "Failures")} ${tab("all", "Everything, including comments with no keyword")}</p>
      ${activityTable(rows, names)}
      ${rows.length === 100 && last ? html`<p><a href="/dashboard/activity?show=${filter}&before=${last.id}">Older</a></p>` : ""}`,
    { nav: true },
  );
}

export async function leadsPage(ctx: Ctx, message = ""): Promise<Response> {
  const leads = await listLeads(ctx, { limit: 500 });
  return page(
    "Leads",
    html`<div class="row"><h1 style="flex:1">Leads</h1><a class="button secondary" href="/dashboard/leads.csv">Download CSV</a></div>
      ${message ? html`<div class="card">${message}</div>` : ""}
      <p class="muted">For Google Sheets, create a live link under <a href="/dashboard/settings">Settings</a>.</p>
      ${leads.length === 0
        ? html`<p class="muted">No emails yet.</p>`
        : html`<table><thead><tr><th>Email</th><th>Instagram</th><th>Campaign</th><th>When</th><th></th></tr></thead><tbody>
          ${leads.map(
            (l) => html`<tr><td>${l.email}</td><td>${l.username ? `@${l.username}` : ""}</td><td>${l.campaign_name ?? "deleted campaign"}</td>
              <td class="small">${fmtTime(l.consented_at)}</td>
              <td><form method="post" action="/dashboard/people/delete" onsubmit="return confirm('Delete everything stored about this person?')">
                <input type="hidden" name="ig_user_id" value="${l.ig_user_id}"><button class="secondary small">Delete</button></form></td></tr>`,
          )}</tbody></table>`}
      ${leads.length === 500 ? html`<p class="muted">Showing the newest 500. The CSV has all of them.</p>` : ""}
      <h2>Delete someone's data</h2>
      <form method="post" action="/dashboard/people/delete" class="card">
        <label for="username">Instagram username</label><input id="username" name="username" type="text" placeholder="@username">
        <p class="hint">Deletes their email, conversations, comments and log entries. Each comment keeps only its id, so OwnChats never answers it again. Use it when someone asks for their data to be deleted.</p>
        <p><button class="danger">Delete their data</button></p>
      </form>`,
    { nav: true },
  );
}

export async function leadsCsvDownload(ctx: Ctx): Promise<Response> {
  return new Response(leadsCsv(await listLeads(ctx)), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="ownchats-leads.csv"' },
  });
}

export async function deletePersonForm(ctx: Ctx, request: Request): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get("ig_user_id") ?? "").trim();
  const username = String(form.get("username") ?? "").trim();
  const ids = id ? [id] : username ? await findPersonByUsername(ctx, username) : [];
  for (const personId of ids) await deletePerson(ctx, personId);
  return leadsPage(ctx, ids.length ? "Deleted everything stored about that person." : "Nobody with that username was found.");
}

export async function settingsPage(ctx: Ctx, fresh: { apiToken?: string } = {}): Promise<Response> {
  const s = ctx.settings;
  const exportUrl = s.export_key ? `${s.base_url}/export/leads.csv?key=${s.export_key}` : "";
  return page(
    "Settings",
    html`<h1>Settings</h1>
      <div class="card">
        <h3>Google Sheets</h3>
        ${exportUrl
          ? html`<p>Paste this into cell A1 of a Google Sheet. It refreshes about once an hour.</p>
              ${copyField(`=IMPORTDATA("${exportUrl}")`)}
              <p class="hint">Anyone with this link can read your leads. Regenerate it to cut off the old one.</p>
              <form method="post" action="/dashboard/settings/export" class="row"><button class="secondary" name="do" value="new">Regenerate link</button><button class="danger" name="do" value="revoke">Turn off</button></form>`
          : html`<p>Create a secret link that Google Sheets can read with IMPORTDATA.</p>
              <form method="post" action="/dashboard/settings/export"><button name="do" value="new">Create link</button></form>`}
      </div>
      <div class="card">
        <h3>API token</h3>
        <p>For tools that read your campaigns and leads. See <code>GET ${s.base_url ?? ""}/api</code>.</p>
        ${fresh.apiToken
          ? html`<p class="ok">Copy it now; it is shown only once.</p>${copyField(fresh.apiToken)}`
          : html`<p class="muted">${s.api_token_hash ? "A token exists." : "No token yet."}</p>`}
        <form method="post" action="/dashboard/settings/api-token" class="row"><button name="do" value="new">${s.api_token_hash ? "Replace token" : "Create token"}</button>
          ${s.api_token_hash ? html`<button class="danger" name="do" value="revoke">Revoke</button>` : ""}</form>
      </div>
      <div class="card">
        <h3>Contact for the privacy page</h3>
        <form method="post" action="/dashboard/settings/contact">
          <input name="contact" type="text" value="${s.contact ?? ""}" placeholder="an email address, or leave empty to use a DM to your account">
          <p class="hint">Shown on <a href="/privacy">/privacy</a> and <a href="/data-deletion">/data-deletion</a>.</p>
          <p><button>Save</button></p>
        </form>
      </div>`,
    { nav: true },
  );
}

export async function settingsAction(ctx: Ctx, request: Request, what: string): Promise<Response> {
  const form = await request.formData();
  const pw = ctx.env.ADMIN_PASSWORD;
  const action = String(form.get("do") ?? "");
  if (what === "export") {
    if (action === "revoke") await deleteSettings(ctx.db, ["export_key"]);
    else await saveSettings(ctx.db, pw, { export_key: randomToken(24) });
    return redirect("/dashboard/settings");
  }
  if (what === "api-token") {
    if (action === "revoke") {
      await deleteSettings(ctx.db, ["api_token_hash"]);
      return redirect("/dashboard/settings");
    }
    const token = `oc_${randomToken(24)}`;
    const hash = await sha256Hex(token);
    await saveSettings(ctx.db, pw, { api_token_hash: hash });
    ctx.settings.api_token_hash = hash;
    return settingsPage(ctx, { apiToken: token });
  }
  if (what === "contact") {
    await saveSettings(ctx.db, pw, { contact: String(form.get("contact") ?? "").trim().slice(0, 200) });
    return redirect("/dashboard/settings");
  }
  return new Response("Not found", { status: 404 });
}
