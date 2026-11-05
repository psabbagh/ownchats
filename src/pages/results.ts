import { getCampaign, listCampaigns, type Campaign } from "../campaigns";
import type { Ctx } from "../context";
import type { Media } from "../meta/client";
import { recentMedia } from "../pipeline/poll";
import {
  campaignResults,
  COMMENT_DAYS,
  COMMENT_FILTERS,
  listActivity,
  listCampaignComments,
  type CommentFilter,
  type CommentLine,
  type CommentTally,
} from "../stats";
import { activityTable, EMAIL_MODE_LABEL, healthBanner, KIND_LABEL } from "./dashboard";
import { fmtTime, html, page, type Html } from "./html";

const COMMENTS_PER_PAGE = 100;

/** How far the DM went, for an answered comment. */
const PROGRESS: Record<string, string> = {
  opened: "DM sent, no tap yet",
  awaiting_email: "asked for their email",
  reasked: "asked for their email again",
  optional_email: "link sent",
  done: "link sent",
};

/** Skip reasons in the words of this page. */
const REASON: Record<string, string> = {
  "no matching campaign": "no keyword matched",
  "person deleted": "deleted on request",
};

const reason = (r: string | null) => (r ? REASON[r] ?? r : "");
const share = (n: number, of: number) => (of > 0 ? ` (${Math.round((100 * n) / of)}%)` : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function caption(media: Media | undefined, c: Campaign): string {
  const text = (media?.caption || c.mediaLabel || "").replace(/\s+/g, " ").trim();
  if (!text) return c.mediaId ? `Post ${c.mediaId}` : "All posts";
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function outcome(line: CommentLine, campaign: Campaign, names: Map<number, string>): Html {
  if (line.status === "done") {
    if (line.campaign_id !== campaign.id) {
      const by = line.campaign_id ? names.get(line.campaign_id) : undefined;
      return html`<span class="pill sent">answered</span> <span class="muted small">by ${by ?? "another campaign"}</span>`;
    }
    const progress = [line.state ? PROGRESS[line.state] : "", line.has_email ? "email saved" : ""].filter(Boolean).join(", ");
    return html`<span class="pill sent">answered</span> <span class="muted small">${progress}</span>`;
  }
  if (line.status === "skipped" || line.status === "failed") {
    return html`<span class="pill ${line.status}">${line.status}</span> <span class="muted small">${reason(line.reason)}</span>`;
  }
  return html`<span class="pill queued">waiting</span> <span class="muted small">${reason(line.reason)}</span>`;
}

function commentText(line: CommentLine): Html {
  if (!line.text && line.reason === "person deleted") return html`<span class="muted">(deleted on request)</span>`;
  const text = line.text.length > 280 ? `${line.text.slice(0, 280)}...` : line.text;
  return html`${line.parent_id ? html`<span class="muted small">reply: </span>` : ""}${text}`;
}

function tallyTable(day: CommentTally, month: CommentTally): Html {
  const rows: Array<[string, keyof CommentTally]> = [
    ["Comments", "total"],
    ["Answered", "answered"],
    ...(month.answeredElsewhere ? [["Answered by another campaign", "answeredElsewhere"] as [string, keyof CommentTally]] : []),
    ["Skipped", "skipped"],
    ["Failed", "failed"],
    ...(month.waiting ? [["Waiting", "waiting"] as [string, keyof CommentTally]] : []),
  ];
  return html`<table class="figures"><thead><tr><th></th><th class="num">Last 24 hours</th><th class="num">Last ${COMMENT_DAYS} days</th></tr></thead><tbody>
    ${rows.map(([label, key]) => html`<tr><td>${label}</td><td class="num">${day[key]}</td><td class="num">${month[key]}</td></tr>`)}
  </tbody></table>`;
}

/** The page a campaign opens on: what happened to its comments and DMs. The form is behind Edit. */
export async function campaignResultsPage(ctx: Ctx, id: number, url: URL): Promise<Response> {
  const campaign = await getCampaign(ctx.db, id);
  if (!campaign) return new Response("No such campaign", { status: 404 });
  const show = (COMMENT_FILTERS as string[]).includes(url.searchParams.get("show") ?? "") ? (url.searchParams.get("show") as CommentFilter) : "all";
  const before = Number(url.searchParams.get("before")) || undefined;

  let media: Media | undefined;
  if (campaign.mediaId) {
    try {
      media = (await recentMedia(ctx)).find((m) => m.id === campaign.mediaId);
    } catch {
      // The page works without the thumbnail.
    }
  }
  const results = await campaignResults(ctx, campaign);
  const comments = await listCampaignComments(ctx, campaign, { show, before, limit: COMMENTS_PER_PAGE });
  const names = new Map((await listCampaigns(ctx.db)).map((c) => [c.id, c.name]));
  const activity = await listActivity(ctx, { campaignId: campaign.id, limit: 50 });

  const base = `/dashboard/campaigns/${campaign.id}`;
  const { fromComments: fc, fromDms: fd, lastDay } = results;
  const dmColumn = campaign.dmKeyword || fd.dmsSent > 0;
  const emailRow = campaign.emailMode !== "none" || fc.emails > 0 || fd.emails > 0;
  const cell = (n: number, of?: number) => html`<td class="num">${n}${of === undefined ? "" : share(n, of)}</td>`;
  const tab = (key: CommentFilter, label: string) =>
    key === show ? html`<b>${label}</b>` : html`<a href="${base}?show=${key}#comments">${label}</a>`;
  const lastLine = comments[comments.length - 1];

  return page(
    campaign.name,
    html`${healthBanner(ctx)}
      <div class="row"><h1 style="flex:1">${campaign.name}</h1>
        <span class="pill ${campaign.active ? "sent" : "skipped"}">${campaign.active ? "on" : "off"}</span>
        <a class="button secondary" href="${base}/edit">Edit</a></div>
      <div class="card row" style="align-items:flex-start;flex-wrap:nowrap">
        ${media?.thumbnailUrl ? html`<img src="${media.thumbnailUrl}" alt="" width="64" height="64" style="flex:none;object-fit:cover;border-radius:6px">` : ""}
        <div style="min-width:0">
          <p style="margin:0">${caption(media, campaign)}</p>
          <p class="muted small" style="margin:4px 0 0">${campaign.anyComment ? "Any comment" : `Keyword: ${campaign.keywords.join(", ")}`},
            ${EMAIL_MODE_LABEL[campaign.emailMode]}. Started ${fmtTime(campaign.createdAt)}.
            ${media?.timestamp ? html`Posted ${fmtTime(media.timestamp)}.` : ""}
            ${media?.permalink ? html`<a href="${media.permalink}" rel="noopener noreferrer" target="_blank">Open on Instagram</a>` : ""}</p>
        </div>
      </div>

      <h2>Comments</h2>
      <p class="muted small">${campaign.mediaId
        ? "Every comment on this post that OwnChats saw, except its own replies."
        : html`This campaign watches all posts, so only the comments that matched its keyword are counted here. Comments with no keyword are in <a href="/dashboard/activity?show=all">Activity</a>.`}</p>
      ${tallyTable(results.day, results.month)}
      ${results.skipReasons.length
        ? html`<p class="small" style="margin-bottom:4px">Why comments were skipped, last ${COMMENT_DAYS} days:</p>
            <ul class="small" style="margin-top:0">${results.skipReasons.map((r) => html`<li>${reason(r.reason)}: ${r.n}</li>`)}</ul>
            <p class="small"><a href="${base}?show=skipped#comments">See the skipped comments</a></p>`
        : ""}

      <h2>DMs</h2>
      <p class="muted small">Everyone this campaign answered since it started.</p>
      <table class="figures"><thead><tr><th></th><th class="num">From comments</th>${dmColumn ? html`<th class="num">From DMs</th>` : ""}</tr></thead><tbody>
        <tr><td>First DM sent</td>${cell(fc.dmsSent)}${dmColumn ? cell(fd.dmsSent) : ""}</tr>
        ${campaign.openingButton ? html`<tr><td>Tapped the button or replied</td>${cell(fc.opened, fc.dmsSent)}${dmColumn ? html`<td></td>` : ""}</tr>` : ""}
        ${emailRow ? html`<tr><td>Gave their email</td>${cell(fc.emails, fc.dmsSent)}${dmColumn ? cell(fd.emails, fd.dmsSent) : ""}</tr>` : ""}
        <tr><td>Got the link</td>${cell(fc.links, fc.dmsSent)}${dmColumn ? cell(fd.links, fd.dmsSent) : ""}</tr>
      </tbody></table>
      <p class="muted small">Last 24 hours: ${plural(lastDay.dmsSent, "first DM")}, ${plural(lastDay.taps, "tap")}, ${plural(lastDay.emails, "email")},
        ${plural(lastDay.links, "link")} sent.${results.resent
          ? ` ${plural(results.resent, "link was", "links were")} sent again because someone sent the keyword by DM (last 90 days).`
          : ""}</p>

      ${results.failures.length
        ? html`<h2>Failures</h2>
            <p class="muted small">From the last 90 days of the log.</p>
            <ul class="small">${results.failures.map(
              (f) => html`<li>${KIND_LABEL[f.kind] ?? f.kind}: ${f.reason}. ${plural(f.n, "time")}, last ${fmtTime(f.last)}.</li>`,
            )}</ul>`
        : ""}

      <h2 id="comments">Every comment</h2>
      <p class="row small">${tab("all", "All")} ${tab("answered", "Answered")} ${tab("skipped", "Skipped")} ${tab("failed", "Failed")}</p>
      ${comments.length === 0
        ? html`<p class="muted">${show === "all" ? "No comments yet." : "None."}</p>`
        : html`<table><thead><tr><th>Who, when</th><th>Comment</th><th>What happened</th></tr></thead><tbody>
            ${comments.map(
              (line) => html`<tr><td>${line.from_username ? `@${line.from_username}` : ""}<br><span class="muted small">${fmtTime(line.commented_at)}</span></td>
                <td style="overflow-wrap:anywhere">${commentText(line)}</td>
                <td>${outcome(line, campaign, names)}</td></tr>`,
            )}</tbody></table>`}
      ${comments.length === COMMENTS_PER_PAGE && lastLine
        ? html`<p><a href="${base}?show=${show}&before=${lastLine.commented_at}#comments">Older</a></p>`
        : ""}

      <details style="margin-top:28px"><summary>Activity log for this campaign</summary>
        <div style="overflow-x:auto">${activityTable(activity, new Map([[campaign.id, campaign.name]]))}</div></details>`,
    { nav: true },
  );
}
