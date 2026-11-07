import {
  campaignFromForm,
  consentFor,
  DEFAULTS,
  fill,
  emailLines,
  getCampaign,
  listCampaigns,
  NEXT_POST,
  postLabel,
  saveCampaign,
  senderOf,
  type Campaign,
  type CampaignInput,
  type EmailMode,
} from "../campaigns";

export const EMAIL_MODE_LABEL: Record<EmailMode, string> = { none: "link only", optional: "link plus optional email", first: "email first" };

function newCampaignDefaults(settings: Settings): CampaignInput {
  // The email lines name the sender and link to the privacy page, which shows their mailing address.
  const lines = emailLines(senderOf(settings));
  return {
    name: "",
    keywords: [],
    anyComment: false,
    mediaId: null,
    mediaLabel: null,
    nextPostAfter: null,
    publicReplies: DEFAULTS.publicReplies,
    openingText: DEFAULTS.openingText,
    openingButton: DEFAULTS.openingButton,
    emailMode: "none",
    emailPrompt: lines.emailPrompt,
    emailReask: DEFAULTS.emailReask,
    emailThanks: DEFAULTS.emailThanks,
    optionalPrompt: lines.optionalPrompt,
    optionalThanks: DEFAULTS.optionalThanks,
    consentText: "",
    emailTag: "",
    linkText: DEFAULTS.linkText,
    links: [{ label: DEFAULTS.linkLabel, url: "" }],
    // Off by default: a keyword that is a common word ("traffic") would answer ordinary DMs.
    dmKeyword: false,
    active: true,
  };
}
import type { Ctx } from "../context";
import { trackingBase } from "../clicks";
import { randomToken, sha256Hex } from "../crypto";
import { leadsCsv, listLeads } from "../export";
import { getDelivery, MIN_SECRET_LENGTH, recentDeliveries, sendTestLead, webhookConfig, type DeliveryRow } from "../leadwebhook";
import { extractEmail } from "../match";
import type { Media } from "../meta/client";
import { recentMedia } from "../pipeline/poll";
import { MISSING_PERMISSION, readMediaStats } from "../insights";
import { missedComments } from "../missed";
import { deleteSettings, saveSettings, type Settings } from "../settings";
import { campaignCounts, deletePerson, findPersonByUsername, listActivity, storedAboutPeople, type ActivityRow } from "../stats";
import { copyField, fmtCount, fmtDate, fmtTime, html, page, plural, redirect, type Html } from "./html";
import { isTimeZone, timeZoneOf } from "../time";

/** Which post a campaign watches, in a few words. */
export function postWords(c: Campaign): string {
  if (c.mediaId) return c.mediaLabel || `post ${c.mediaId}`;
  return c.nextPostAfter !== null ? "your next post (waiting for it)" : "all posts";
}

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
  // Newest first here only: listCampaigns keeps id order, which DM keyword matching relies on.
  const campaigns = (await listCampaigns(ctx.db)).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const counts = await campaignCounts(ctx);
  const missed = await missedComments(ctx, campaigns.filter((c) => c.active));
  const stats = await readMediaStats(ctx, campaigns.flatMap((c) => (c.mediaId ? [c.mediaId] : [])));
  const noPermission = campaigns.some((c) => c.active && c.mediaId && stats.get(c.mediaId)?.problem === MISSING_PERMISSION);
  const s = ctx.settings;
  const tz = timeZoneOf(s);
  const clicksOn = trackingBase(ctx) !== null;
  return page(
    "OwnChats",
    html`${healthBanner(ctx)}
      <div class="row"><h1 style="flex:1">Campaigns</h1><a class="button" href="/dashboard/campaigns/new">New campaign</a></div>
      ${s.ig_username ? html`<p class="muted">Connected to @${s.ig_username}. Last webhook: ${fmtTime(Number(s.last_webhook_at), tz) || "none yet"}. Last check for missed comments: ${fmtTime(Number(s.last_poll_at), tz) || "none yet"}.${s.time_zone ? "" : html` Times are in UTC: <a href="/dashboard/settings#time-zone">choose your time zone</a>.`}</p>` : ""}
      ${noPermission ? html`<p class="warn small">Instagram shares each post's views once your Meta login configuration includes <code>instagram_manage_insights</code>. <a href="/setup#step-3">Add it in setup</a>, then reconnect.</p>` : ""}
      ${campaigns.length === 0 ? html`<div class="card"><p>No campaigns yet. Create one: a keyword, the post it watches, and the link to send.</p></div>` : ""}
      ${campaigns.map((c) => {
        const n = counts.get(c.id);
        const views = c.mediaId ? stats.get(c.mediaId)?.views : undefined;
        // Instagram's cover image for the post: the Reel's first frame unless another cover was chosen. Kept fresh by the hourly post list.
        const cover = c.mediaId ? stats.get(c.mediaId)?.thumbnailUrl : null;
        return html`<div class="card row campaign">
          <a class="cover" href="/dashboard/campaigns/${c.id}" aria-hidden="true" tabindex="-1">${cover ? html`<img src="${cover}" alt="" loading="lazy" onerror="this.remove()">` : ""}</a>
          <div class="body">
          <div class="row"><h3 style="flex:1 1 auto"><a href="/dashboard/campaigns/${c.id}">${c.name}</a></h3><span class="muted small">Started ${fmtDate(c.createdAt, tz)}</span>
            <span class="pill ${c.active ? "sent" : "skipped"}">${c.active ? "on" : "off"}</span></div>
          <p class="muted small">${c.anyComment ? "Any comment" : `Keyword: ${c.keywords.join(", ")}`} on ${postWords(c)}, ${EMAIL_MODE_LABEL[c.emailMode]}</p>
          ${missed.get(c.id)?.length
            ? html`<p class="small"><a class="warn" href="/dashboard/campaigns/${c.id}#to-check">${missed.get(c.id)!.length === 1 ? "1 comment" : `${missed.get(c.id)!.length} comments`} to check</a></p>`
            : ""}
          <div class="stats small">
            ${views !== undefined ? html`<div><b>${fmtCount(views)}</b>views</div>` : ""}
            <div><b>${n?.people ?? 0}</b>people</div><div><b>${n?.dmsSent ?? 0}</b>DMs sent</div>
            ${c.openingButton ? html`<div><b>${n?.taps ?? 0}</b>taps</div>` : ""}
            ${c.emailMode !== "none" ? html`<div><b>${n?.emails ?? 0}</b>emails</div>` : ""}
            <div><b>${n?.linksSent ?? 0}</b>links sent</div>
            ${clicksOn || n?.clicks ? html`<div><b>${n?.clicks ?? 0}</b>clicked</div>` : ""}
            <div><b>${n?.failed ?? 0}</b>failed</div>
          </div></div></div>`;
      })}`,
    { nav: true },
  );
}

function mediaPicker(media: Media[], current: Campaign | null, tz: string, input?: CampaignInput): Html {
  const v = input ?? current;
  const selected = !v ? "all" : v.nextPostAfter !== null ? NEXT_POST : v.mediaId ?? "all";
  const options = [...media];
  if (selected !== "all" && selected !== NEXT_POST && !options.some((m) => m.id === selected)) {
    options.unshift({ id: selected, caption: input?.mediaLabel ?? current?.mediaLabel ?? "", permalink: "", timestamp: 0, mediaType: "" });
  }
  const waitingSince = current?.nextPostAfter ?? null;
  return html`<label>Which post?</label>
    <label class="inline"><input type="radio" name="media_id" value="all" ${selected === "all" ? "checked" : ""}> All posts, including ones you haven't posted yet</label>
    <label class="inline"><input type="radio" name="media_id" value="${NEXT_POST}" ${selected === NEXT_POST ? "checked" : ""} data-label="">
      <span>The next post you publish ${waitingSince !== null ? html`<span class="muted small">waiting since ${fmtTime(waitingSince, tz)}</span>` : ""}</span></label>
    ${options.map(
      (m) => html`<label class="inline"><input type="radio" name="media_id" value="${m.id}" ${selected === m.id ? "checked" : ""} data-label="${postLabel(m)}">
        ${m.thumbnailUrl ? html`<img src="${m.thumbnailUrl}" alt="" width="40" height="40" style="object-fit:cover;border-radius:4px">` : ""}
        <span>${postLabel(m)} <span class="muted small">${m.timestamp ? fmtTime(m.timestamp, tz) : ""}</span></span></label>`,
    )}
    <input type="hidden" name="media_label" value="${input?.mediaLabel ?? current?.mediaLabel ?? ""}">
    <p class="hint">With all posts, use a keyword you don't use for anything else. With the next post, set the campaign up before you post: within a minute of posting, OwnChats attaches it to the first post you publish after saving whose caption asks for the keyword ("Comment AGENTS"), and answers the comments that came in before that. Already posted? Pick the post from the list instead.</p>
    <script>document.addEventListener('change',e=>{if(e.target.name==='media_id'){document.querySelector('[name=media_label]').value=e.target.dataset.label||''}})</script>`;
}

async function campaignForm(ctx: Ctx, current: Campaign | null, input?: CampaignInput, errors: string[] = []): Promise<Response> {
  let media: Media[] = [];
  let mediaProblem = "";
  try {
    // Read fresh, so a post published a minute ago is listed and isn't mistaken for "the next post".
    media = await recentMedia(ctx, true);
  } catch (e) {
    mediaProblem = e instanceof Error ? e.message : String(e);
  }
  const v: CampaignInput = input ?? current ?? newCampaignDefaults(ctx.settings);
  const s = ctx.settings;
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
          ${mediaPicker(media, current, timeZoneOf(ctx.settings), input)}
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
          <p class="hint">Anti-spam laws ask the line people answer to say what they'll get, who you are, where to find your mailing address,
            and that they can unsubscribe. The defaults say all four, and link to your <a href="/privacy">privacy page</a>, which shows your name and address
            ${s.sender_name && s.sender_address ? "from Settings" : html`once you add them under <a href="/dashboard/settings#sender">Settings</a>`}.
            Check the rules where you and your audience live.</p>
          <h3 style="margin-top:16px">Consent</h3>
          <label for="consent_text">Wording saved with each email</label><textarea id="consent_text" name="consent_text" placeholder="Leave empty to save the question they answered">${v.consentText}</textarea>
          <p class="hint">Stored with every lead, with the date, as the record of what they agreed to.</p>
          <label for="email_tag">Email tag (optional)</label><input id="email_tag" name="email_tag" type="text" value="${v.emailTag}" maxlength="100" placeholder="setupGuide">
          <p class="hint">Sent with each new email to your <a href="/dashboard/settings#webhook">lead webhook</a> as <code>campaign.email_tag</code>, so your email tool can start the right sequence. Leave empty for none.</p>
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
  const { input, errors } = campaignFromForm(await request.formData(), ctx.now());
  if (errors.length) return campaignForm(ctx, current, input, errors);
  const saved = await saveCampaign(ctx.db, input, id, ctx.now());
  return redirect(`/dashboard/campaigns/${saved}`);
}

export async function deleteCampaign(ctx: Ctx, id: number): Promise<Response> {
  await ctx.db.batch([
    // Links already sent keep working; they just count nowhere now.
    ctx.db.prepare("UPDATE tracked_links SET conversation_id = NULL WHERE campaign_id = ?").bind(id),
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
  click: "Link click",
  lead_webhook: "Lead webhook",
  token: "Token",
};

export function activityTable(rows: ActivityRow[], names: Map<number, string>, tz: string): Html {
  if (!rows.length) return html`<p class="muted">Nothing yet.</p>`;
  return html`<table><thead><tr><th>When</th><th>What</th><th>Result</th><th>Who</th><th>Why</th></tr></thead><tbody>
    ${rows.map(
      (r) => html`<tr><td class="small">${fmtTime(r.at, tz)}</td>
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
      ${activityTable(rows, names, timeZoneOf(ctx.settings))}
      ${rows.length === 100 && last ? html`<p><a href="/dashboard/activity?show=${filter}&before=${last.id}">Older</a></p>` : ""}`,
    { nav: true },
  );
}

export async function leadsPage(ctx: Ctx, message = ""): Promise<Response> {
  const leads = await listLeads(ctx, { limit: 500 });
  const tz = timeZoneOf(ctx.settings);
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
              <td class="small">${fmtTime(l.consented_at, tz)}</td>
              <td><form method="post" action="/dashboard/people/delete" onsubmit="return confirm('Delete everything stored about this person?')">
                <input type="hidden" name="ig_user_id" value="${l.ig_user_id}"><button class="secondary small">Delete</button></form></td></tr>`,
          )}</tbody></table>`}
      ${leads.length === 500 ? html`<p class="muted">Showing the newest 500. The CSV has all of them.</p>` : ""}
      <h2>Delete someone's data</h2>
      <form method="post" action="/dashboard/people/delete" class="card">
        <label for="username">Instagram username</label><input id="username" name="username" type="text" placeholder="@username">
        <p class="hint">Use it when someone asks for their data to be deleted. It first shows what OwnChats stores about them, and deletes nothing until you confirm.</p>
        <p><button class="secondary">Find their data</button></p>
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
  const ids = form.getAll("ig_user_id").map((v) => String(v).trim()).filter(Boolean);
  const username = String(form.get("username") ?? "").trim().replace(/^@/, "").toLowerCase();
  if (ids.length) {
    for (const personId of ids) await deletePerson(ctx, personId);
    return leadsPage(ctx, username ? `Deleted everything stored about @${username}.` : "Deleted everything stored about that person.");
  }
  // A typed username only finds the person. Deleting takes a second click on what it found, so a typo can't delete someone else.
  if (!username) return leadsPage(ctx, "Enter the Instagram username of the person whose data you want to delete.");
  const found = await findPersonByUsername(ctx, username);
  if (!found.length) return leadsPage(ctx, `Nobody with the username @${username} was found. Nothing was deleted.`);
  return confirmDeletePage(ctx, username, found);
}

async function confirmDeletePage(ctx: Ctx, username: string, ids: string[]): Promise<Response> {
  const s = await storedAboutPeople(ctx, ids);
  return page(
    "Delete someone's data",
    html`<h1>Delete @${username}'s data?</h1>
      <div class="card">
        <p>OwnChats stores this about @${username}:</p>
        <ul>
          <li>${plural(s.leads, "email")}${s.emails.length ? `: ${s.emails.join(", ")}` : ""}</li>
          <li>${plural(s.conversations, "conversation")}</li>
          <li>${plural(s.comments, "comment")}</li>
          <li>${plural(s.logEntries, "log entry", "log entries")}</li>
        </ul>
        <p class="hint">Each comment keeps only its id, so OwnChats never answers it again. The rest is gone for good.${s.leads && webhookConfig(ctx)
          ? " Your lead webhook is sent each email as deleted, so your email tool can delete its copy."
          : ""}</p>
        <form method="post" action="/dashboard/people/delete" class="row">
          <input type="hidden" name="username" value="${username}">
          ${ids.map((id) => html`<input type="hidden" name="ig_user_id" value="${id}">`)}
          <button class="danger">Delete their data</button>
          <a class="button secondary" href="/dashboard/leads">Cancel</a>
        </form>
      </div>`,
    { nav: true },
  );
}

/** Every zone Intl knows, for the Settings list. */
function timeZones(): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

function timeZoneCard(saved: string | undefined): Html {
  const current = saved && isTimeZone(saved) ? saved : "UTC";
  return html`<div class="card" id="time-zone">
    <h3>Time zone</h3>
    <form method="post" action="/dashboard/settings/time-zone">
      <select name="time_zone" aria-label="Time zone">${timeZones().map((z) => html`<option${z === current ? " selected" : ""}>${z}</option>`)}</select>
      <p class="hint">Times on these pages show in this zone. ${saved ? "" : "None is saved yet, so they show in UTC; the list starts on your browser's zone. "}The API, the CSV and the database keep UTC.</p>
      <p><button>Save</button></p>
    </form>
    ${saved ? "" : html`<script>(()=>{const z=Intl.DateTimeFormat().resolvedOptions().timeZone,s=document.querySelector('[name=time_zone]');if([...s.options].some(o=>o.value===z))s.value=z})()</script>`}
  </div>`;
}

/** Where the lead webhook's format is documented. */
const WEBHOOK_DOCS = "https://github.com/psabbagh/ownchats/blob/main/docs/lead-webhook.md";

const DELIVERY_PILL: Record<DeliveryRow["status"], string> = { delivered: "sent", pending: "queued", failed: "failed" };

/** What happened to the test lead just sent, in words. */
function testNotice(d: DeliveryRow | null, tz: string): Html {
  if (!d) return html``;
  if (d.status === "delivered") return html`<div class="card"><p class="ok">Test lead delivered (${d.last_result}).</p></div>`;
  if (d.status === "failed") {
    return html`<div class="card errors"><p>The test lead was refused (${d.last_result}) and won't be retried. Check the URL, and that the receiver checks the signature with the same secret.</p></div>`;
  }
  if (!d.attempts) return html`<div class="card notice"><p>The test lead is queued and goes out within a minute. Reload to see what happened.</p></div>`;
  return html`<div class="card notice"><p>The test lead didn't get through yet (${d.last_result}). OwnChats tries again at ${fmtTime(d.next_attempt_at, tz)}, as it would for a real lead.</p></div>`;
}

function webhookCard(ctx: Ctx, campaigns: Campaign[], deliveries: DeliveryRow[], notes: { error?: string; test?: DeliveryRow | null }): Html {
  const s = ctx.settings;
  const tz = timeZoneOf(s);
  const config = webhookConfig(ctx);
  const workerSecret = !!ctx.env.LEAD_WEBHOOK_SECRET;
  const emailCampaigns = campaigns.filter((c) => c.emailMode !== "none");
  const choices = emailCampaigns.length ? emailCampaigns : campaigns;
  return html`<div class="card" id="webhook">
    <h3>Lead webhook</h3>
    <p>Sends each new email to a web address you choose, signed with a secret, so your email tool (directly, through Zapier or Make, or a small script of your own) can send what the person asked for.
      When you delete someone's data, it sends that too, so their copy goes as well. The format and how to check the signature: <a href="${WEBHOOK_DOCS}" rel="noopener noreferrer" target="_blank">docs/lead-webhook.md</a>.</p>
    ${notes.error ? html`<div class="card errors"><p>${notes.error}</p></div>` : ""}
    <form method="post" action="/dashboard/settings/webhook">
      <label for="webhook_url">URL</label><input id="webhook_url" name="url" type="url" value="${s.lead_webhook_url ?? ""}" placeholder="https://">
      <label for="webhook_secret">Signing secret</label>
      ${workerSecret
        ? html`<p class="muted small">Using the <code>LEAD_WEBHOOK_SECRET</code> Worker secret.</p>`
        : html`<input id="webhook_secret" name="secret" type="password" autocomplete="new-password" placeholder="${s.lead_webhook_secret ? "Saved. Type a new one to replace it." : `At least ${MIN_SECRET_LENGTH} characters`}">`}
      <p class="hint">The receiver uses the same secret to check each request came from you. Make a long random one with your password manager and keep it there.
        ${workerSecret ? "" : html`It's stored encrypted. You can set it as a Worker secret named <code>LEAD_WEBHOOK_SECRET</code> instead.`}
        A failed delivery is retried for about a day, and every attempt is in the <a href="/dashboard/activity">activity log</a>.</p>
      <p class="row"><button name="do" value="save">Save</button>${s.lead_webhook_url ? html`<button class="danger" name="do" value="off">Turn off</button>` : ""}</p>
    </form>
    ${config
      ? html`<h3 style="margin-top:16px">Send a test lead</h3>
          ${testNotice(notes.test ?? null, tz)}
          <form method="post" action="/dashboard/settings/test-lead">
            <label for="test_email">Email</label><input id="test_email" name="email" type="email" required placeholder="Your own address, to see the email arrive">
            <label for="test_name">Name (optional)</label><input id="test_name" name="name" type="text" placeholder="Leave empty to send no name, as when Instagram shares none">
            ${choices.length
              ? html`<label for="test_campaign">As if from</label><select id="test_campaign" name="campaign_id">${choices.map(
                  (c) => html`<option value="${c.id}">${c.name}${c.emailTag ? ` (tag: ${c.emailTag})` : ""}</option>`,
                )}</select>`
              : ""}
            <p class="hint">Sent exactly as a real new lead, with <code>"test": true</code>, the campaign's email tag and consent wording, and lead id 0. It isn't saved in Leads. Delivered and retried like a real one, and logged the same way.</p>
            <p><button>Send a test lead</button></p>
          </form>`
      : ""}
    ${deliveries.length
      ? html`<h3 style="margin-top:16px">Recent deliveries</h3>
          <div style="overflow-x:auto"><table><thead><tr><th>When</th><th>Event</th><th>Result</th><th class="num">Attempts</th><th>Last reply</th></tr></thead><tbody>
            ${deliveries.map(
              (d) => html`<tr><td class="small">${fmtTime(d.created_at, tz)}</td><td>${d.test ? "Test " : ""}${d.event}</td>
                <td><span class="pill ${DELIVERY_PILL[d.status]}">${d.status}</span>${d.status === "pending" && d.next_attempt_at ? html`<br><span class="muted small">next try ${fmtTime(d.next_attempt_at, tz)}</span>` : ""}</td>
                <td class="num">${d.attempts}</td><td class="small">${d.last_result ?? ""}</td></tr>`,
            )}</tbody></table></div>`
      : ""}
  </div>`;
}

export async function settingsPage(ctx: Ctx, fresh: { apiToken?: string; webhookError?: string; testId?: string | null } = {}): Promise<Response> {
  const s = ctx.settings;
  const exportUrl = s.export_key ? `${s.base_url}/export/leads.csv?key=${s.export_key}` : "";
  const campaigns = await listCampaigns(ctx.db);
  const deliveries = await recentDeliveries(ctx);
  const test = fresh.testId ? await getDelivery(ctx, fresh.testId) : null;
  const clicksOn = s.click_tracking !== "off";
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
      ${webhookCard(ctx, campaigns, deliveries, { error: fresh.webhookError, test })}
      <div class="card">
        <h3>API token</h3>
        <p>For tools that read your campaigns and leads. See <code>GET ${s.base_url ?? ""}/api</code>.</p>
        ${fresh.apiToken
          ? html`<p class="ok">Copy it now; it is shown only once.</p>${copyField(fresh.apiToken)}`
          : html`<p class="muted">${s.api_token_hash ? "A token exists." : "No token yet."}</p>`}
        <form method="post" action="/dashboard/settings/api-token" class="row"><button name="do" value="new">${s.api_token_hash ? "Replace token" : "Create token"}</button>
          ${s.api_token_hash ? html`<button class="danger" name="do" value="revoke">Revoke</button>` : ""}</form>
      </div>
      <div class="card" id="clicks">
        <h3>Link clicks</h3>
        <p>${clicksOn
          ? "On. Campaign links go out as links to your OwnChats address, which sends people on to the real link, so each campaign can count who clicked."
          : "Off. Campaign links go out as they are, and clicks aren't counted."}</p>
        <p class="hint">Each person gets their own random link: it names nobody. Only a person's first click counts, and link previews (Instagram's included) don't.
          Links already sent keep working either way.</p>
        <form method="post" action="/dashboard/settings/clicks"><button class="secondary" name="do" value="${clicksOn ? "off" : "on"}">${clicksOn ? "Stop counting clicks" : "Count clicks"}</button></form>
      </div>
      ${timeZoneCard(s.time_zone)}
      <div class="card" id="sender">
        <h3>You, on the privacy page</h3>
        <form method="post" action="/dashboard/settings/contact">
          <label for="sender_name">Your name or business name</label>
          <input id="sender_name" name="sender_name" type="text" value="${s.sender_name ?? ""}" placeholder="Leave empty to use your Instagram handle">
          <label for="sender_address">Mailing address</label>
          <textarea id="sender_address" name="sender_address" rows="3" placeholder="A PO box or mailbox service works">${s.sender_address ?? ""}</textarea>
          <label for="contact">Contact</label>
          <input id="contact" name="contact" type="text" value="${s.contact ?? ""}" placeholder="an email address, or leave empty to use a DM to your account">
          <p class="hint">Shown on <a href="/privacy">/privacy</a>, which the default email questions link to as "who I am and my address", and on <a href="/data-deletion">/data-deletion</a>.
            Anti-spam laws such as Canada's CASL ask for a name and a mailing address wherever you ask for an email.
            New campaigns name you in their email questions; existing ones keep their wording until you edit it.</p>
          <p><button>Save</button></p>
        </form>
      </div>`,
    { nav: true },
  );
}

/** Checks the webhook form. Returns the values to save, or the problem in words. */
function webhookFromForm(ctx: Ctx, form: FormData): { url: string; secret?: string } | { error: string } {
  const url = String(form.get("url") ?? "").trim();
  const secret = String(form.get("secret") ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Enter the full web address the leads go to, starting with https://" };
  }
  if (parsed.protocol !== "https:") return { error: "The webhook address must start with https://, so the emails travel encrypted." };
  if (url.length > 500) return { error: "That address is too long." };
  if (secret && secret.length < MIN_SECRET_LENGTH) return { error: `The signing secret must be at least ${MIN_SECRET_LENGTH} characters. A password manager's generator makes a good one.` };
  if (!secret && !ctx.settings.lead_webhook_secret && !ctx.env.LEAD_WEBHOOK_SECRET) return { error: "Choose a signing secret too, so the receiver can tell the leads come from you." };
  return { url, secret: secret || undefined };
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
  if (what === "webhook") {
    if (action === "off") {
      await deleteSettings(ctx.db, ["lead_webhook_url", "lead_webhook_secret"]);
      return redirect("/dashboard/settings#webhook");
    }
    const values = webhookFromForm(ctx, form);
    if ("error" in values) return settingsPage(ctx, { webhookError: values.error });
    await saveSettings(ctx.db, pw, { lead_webhook_url: values.url, lead_webhook_secret: values.secret });
    return redirect("/dashboard/settings#webhook");
  }
  if (what === "test-lead") {
    if (!webhookConfig(ctx)) return settingsPage(ctx, { webhookError: "Set the webhook's URL and secret first." });
    const typed = String(form.get("email") ?? "").trim();
    const email = extractEmail(typed);
    if (!email || email !== typed.toLowerCase()) return settingsPage(ctx, { webhookError: "Enter one email address to send the test lead to." });
    const name = String(form.get("name") ?? "").trim().slice(0, 100) || null;
    const chosen = await getCampaign(ctx.db, Number(form.get("campaign_id")) || 0);
    // With no campaign yet, a stand-in, so the webhook can be checked before the first campaign exists.
    const campaign = chosen ?? { id: 0, name: "Test", emailTag: "" };
    const consentText = chosen ? fill(consentFor(chosen), { name }) : emailLines(senderOf(ctx.settings)).optionalPrompt;
    const id = await sendTestLead(ctx, { email, name, campaign, consentText });
    return redirect(`/dashboard/settings?test=${encodeURIComponent(id)}#webhook`);
  }
  if (what === "clicks") {
    if (action === "off") await saveSettings(ctx.db, pw, { click_tracking: "off" });
    else await deleteSettings(ctx.db, ["click_tracking"]);
    return redirect("/dashboard/settings#clicks");
  }
  if (what === "time-zone") {
    const tz = String(form.get("time_zone") ?? "").trim();
    if (isTimeZone(tz)) await saveSettings(ctx.db, pw, { time_zone: tz });
    return redirect("/dashboard/settings");
  }
  if (what === "contact") {
    const field = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max);
    await saveSettings(ctx.db, pw, { contact: field("contact", 200), sender_name: field("sender_name", 100), sender_address: field("sender_address", 300) });
    return redirect("/dashboard/settings#sender");
  }
  return new Response("Not found", { status: 404 });
}
