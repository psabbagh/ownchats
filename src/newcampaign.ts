import { DEFAULTS, EMAIL_MODES, ownDefaults, listCampaigns, ownKeywords, validateCampaign, type Campaign, type CampaignInput, type EmailMode } from "./campaigns";
import type { Ctx } from "./context";
import { listPosts } from "./insights";
import { captionAsksFor, parseKeywords, withoutKeywords } from "./match";
import type { Media } from "./meta/client";
import { newCampaignDefaults } from "./pages/dashboard";
import { shortcutKeywords } from "./settings";
import { DAY } from "./time";

/** Letters and digits: a keyword's words. */
const WORD = /^[\p{L}\p{N}]+/u;
const UPPER_WORD = /^[\p{Lu}\p{N}]*\p{Lu}[\p{Lu}\p{N}]*$/u;
const QUOTES: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»" };

/**
 * The keywords a caption asks people to comment, as written: "Comment SEO" gives SEO,
 * "Comment SET UP below" gives SET UP (a run of capitalised words), "comment 'set up'"
 * gives set up (what the quotes hold), "comment agents" gives agents (one word). Each
 * one is checked with the same rule that attaches a waiting campaign (captionAsksFor),
 * so a keyword found here always attaches.
 */
export function captionKeywords(caption: string): string[] {
  const found: string[] = [];
  const text = caption.normalize("NFKC");
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])comment\p{L}*/giu)) {
    let rest = text.slice(m.index + m[0].length, m.index + m[0].length + 100);
    const gap = /^[^\p{L}\p{N}]{1,8}(?:(?:the\s+)?word[^\p{L}\p{N}]{1,8})?/iu.exec(rest);
    if (!gap) continue;
    const opener = [...gap[0]].reverse().find((ch) => ch in QUOTES);
    rest = rest.slice(gap[0].length);
    let keyword = "";
    const close = opener ? rest.indexOf(QUOTES[opener]!) : -1;
    if (close > 0 && close <= 40) keyword = rest.slice(0, close).trim();
    else {
      // A run of capitalised words, kept with the separators the caption used ("SET-UP"),
      // or one word in lower case, unless an emoji sits before it ("Comment 🙌 and").
      let end = 0;
      let count = 0;
      for (;;) {
        const w = WORD.exec(rest.slice(end))?.[0];
        if (!w) break;
        const upper = UPPER_WORD.test(w);
        if (!upper && (count || /\p{S}/u.test(gap[0]))) break;
        end += w.length;
        count++;
        if (!upper || count === 4 || !/^[ \p{Pd}]/u.test(rest.slice(end))) break;
        if (!UPPER_WORD.test(WORD.exec(rest.slice(end + 1))?.[0] ?? "")) break;
        end += 1;
      }
      keyword = rest.slice(0, end);
    }
    if (keyword && captionAsksFor(caption, [keyword]) && !found.some((k) => k.toLowerCase() === keyword.toLowerCase())) found.push(keyword);
  }
  return found;
}

export interface CaptionCheck {
  /** What the caption asks people to comment. */
  caption_keywords: string[];
  /** Whether a campaign with these keywords, waiting for the next post, would attach to a post with this caption. */
  attaches: boolean;
  /** The keyword the caption asks for that the campaign answers, if any. */
  matched_keyword: string | null;
  /** Campaigns waiting now that this caption would attach too, which would leave a new campaign for the same post unused. */
  waiting_campaigns_it_would_attach: Array<{ id: number; name: string; video_id: string | null }>;
  /** Posts from the last two days, with no campaign, whose caption asks for these keywords: the post may already be up. */
  posts_already_up: Array<{ id: string; permalink: string; posted_at: string }>;
}

/**
 * Whether a post with this caption would attach a waiting campaign with these keywords,
 * and what else it would touch. Like the Cron (postFor), it leaves the shortcut keywords out.
 */
export async function checkCaption(ctx: Ctx, caption: string, given: string[], exceptId: number | null = null): Promise<CaptionCheck> {
  const campaigns = await listCampaigns(ctx.db);
  const shortcuts = shortcutKeywords(ctx.settings);
  const keywords = withoutKeywords(given, shortcuts);
  const matched = keywords.find((k) => captionAsksFor(caption, [k])) ?? null;
  const taken = new Set(campaigns.map((c) => c.mediaId));
  const recent = new Map<string, Media>();
  for (const p of await listPosts(ctx, { since: ctx.now() - 2 * DAY, limit: 50 })) {
    if (p.caption && p.postedAt) recent.set(p.mediaId, { id: p.mediaId, caption: p.caption, permalink: p.permalink ?? "", timestamp: p.postedAt, mediaType: p.mediaType ?? "" });
  }
  // The list the Cron refreshes every minute while a campaign waits is fresher than the hourly one.
  if (ctx.settings.media_cache) {
    for (const m of JSON.parse(ctx.settings.media_cache) as Media[]) if (m.timestamp > ctx.now() - 2 * DAY) recent.set(m.id, m);
  }
  return {
    caption_keywords: captionKeywords(caption),
    attaches: matched !== null,
    matched_keyword: matched,
    waiting_campaigns_it_would_attach: campaigns
      .filter((c) => c.id !== exceptId && c.nextPostAfter !== null && (c.anyComment || captionAsksFor(caption, ownKeywords(c, shortcuts))))
      .map((c) => ({ id: c.id, name: c.name, video_id: c.videoId || null })),
    posts_already_up: keywords.length
      ? [...recent.values()]
          .filter((m) => !taken.has(m.id) && captionAsksFor(m.caption, keywords))
          .map((m) => ({ id: m.id, permalink: m.permalink, posted_at: new Date(m.timestamp).toISOString() }))
      : [],
  };
}

/** What `POST /api/campaigns` takes. Only `caption` and `link` are required. */
export interface NewCampaignRequest {
  caption?: unknown;
  keyword?: unknown;
  spellings?: unknown;
  link?: unknown;
  link_label?: unknown;
  link_title?: unknown;
  email_tag?: unknown;
  email_mode?: unknown;
  opening_button?: unknown;
  video_id?: unknown;
  name?: unknown;
  active?: unknown;
  dry_run?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * A campaign that waits for the next post, built from the caption that post will
 * carry. The keyword is read from the caption (or, when given, must be one the
 * caption asks for), so the two can't differ. Everything else starts from the
 * dashboard's "button, then ask for their email" flow, without the email ask when
 * no email tag is given.
 */
export function campaignFromRequest(ctx: Ctx, body: NewCampaignRequest): { input: CampaignInput | null; caption: string; errors: string[] } {
  const errors: string[] = [];
  const caption = str(body.caption);
  if (!caption) return { input: null, caption, errors: ["Send the post's caption as `caption`: the keyword is read from it."] };
  const asked = captionKeywords(caption);
  let keyword = str(body.keyword);
  if (keyword) {
    if (!captionAsksFor(caption, [keyword])) {
      errors.push(`The caption doesn't ask people to comment "${keyword}"${asked.length ? `; it asks for ${asked.map((k) => `"${k}"`).join(", ")}` : ""}. Fix one so they match.`);
    }
  } else if (asked.length === 1) keyword = asked[0]!;
  else if (!asked.length) errors.push('The caption doesn\'t ask people to comment a keyword. Add a line such as "Comment SEO" to it.');
  else errors.push(`The caption asks for several keywords (${asked.map((k) => `"${k}"`).join(", ")}). Say which one with \`keyword\`.`);

  if (body.spellings !== undefined && !(Array.isArray(body.spellings) && body.spellings.every((s) => typeof s === "string"))) {
    errors.push("`spellings` must be a list of strings.");
  }
  const spellings = Array.isArray(body.spellings) ? body.spellings.filter((s): s is string => typeof s === "string") : [];
  const tag = str(body.email_tag);
  const mode = body.email_mode === undefined ? (tag ? "optional" : "none") : str(body.email_mode);
  if (!(EMAIL_MODES as string[]).includes(mode)) errors.push('`email_mode` must be "none", "optional" or "first".');
  for (const k of ["active", "dry_run"] as const) if (body[k] !== undefined && typeof body[k] !== "boolean") errors.push(`\`${k}\` must be true or false.`);
  if (body.opening_button !== undefined && typeof body.opening_button !== "string") errors.push("`opening_button` must be a string (empty for no button).");
  const link = str(body.link);
  if (!link) errors.push("Send the link to deliver as `link`.");

  const defaults = newCampaignDefaults(ctx.settings, "email");
  const linkTitle = str(body.link_title);
  const videoId = str(body.video_id);
  const input: CampaignInput = {
    ...defaults,
    name: str(body.name) || [linkTitle || keyword, videoId && `(${videoId})`].filter(Boolean).join(" "),
    videoId,
    keywords: parseKeywords([keyword, ...spellings].join(",")),
    nextPostAfter: ctx.now(),
    openingButton: typeof body.opening_button === "string" ? body.opening_button.trim() : DEFAULTS.openingButton,
    emailMode: (EMAIL_MODES as string[]).includes(mode) ? (mode as EmailMode) : "none",
    emailTag: tag,
    links: link ? [{ url: link, label: str(body.link_label) || ownDefaults(ctx.settings).linkLabel }] : [],
    linkTitle,
    active: body.active !== false,
  };
  if (!errors.length) errors.push(...validateCampaign(input).filter((e) => e !== "Add the link to send."));
  return { input: errors.length ? null : input, caption, errors };
}

/** A campaign still waiting with this video id, which a second create would duplicate. */
export function waitingWithVideoId(campaigns: Campaign[], videoId: string): Campaign | undefined {
  return videoId ? campaigns.find((c) => c.nextPostAfter !== null && c.videoId.toLowerCase() === videoId.toLowerCase()) : undefined;
}
