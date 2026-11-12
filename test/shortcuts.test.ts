import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, listCampaigns, matchComment, matchDm, type Campaign } from "../src/campaigns";
import { withoutKeywords } from "../src/match";
import type { Media } from "../src/meta/client";
import { missedComments } from "../src/missed";
import { postFor } from "../src/nextpost";
import { saveSettings, shortcutKeywords } from "../src/settings";
import { MINUTE } from "../src/time";
import { BASE, FAN, FAN2, OTHER_POST, REEL, setupWorld } from "./helpers";

// Everything here is invented: ids, names, links, captions.
type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

const NEW_POST = "18000000000000010";
const media = (id: string, timestamp: number, caption: string): Media => ({ id, caption, permalink: `https://www.instagram.com/reel/${id}/`, timestamp, mediaType: "VIDEO" });

/** A campaign as matching sees it, without the database. */
function campaign(id: number, overrides: Partial<Campaign> = {}): Campaign {
  return {
    id,
    name: `Campaign ${id}`,
    videoId: "",
    keywords: ["AGENTS"],
    anyComment: false,
    mediaId: REEL,
    mediaLabel: "Test reel",
    nextPostAfter: null,
    publicReplies: [],
    replyCursor: -1,
    openingText: DEFAULTS.openingText,
    openingButton: DEFAULTS.openingButton,
    emailMode: "none",
    emailPrompt: DEFAULTS.emailPrompt,
    emailReask: DEFAULTS.emailReask,
    emailThanks: DEFAULTS.emailThanks,
    optionalPrompt: DEFAULTS.optionalPrompt,
    optionalThanks: DEFAULTS.optionalThanks,
    optionalThanksButton: DEFAULTS.optionalThanksButton,
    consentText: "",
    emailTag: "",
    linkText: DEFAULTS.linkText,
    links: [{ label: "Open", url: "https://example.com/library" }],
    linkTitle: "",
    followCheck: false,
    followPrompt: DEFAULTS.followPrompt,
    followReask: DEFAULTS.followReask,
    followButton: DEFAULTS.followButton,
    dmKeyword: false,
    active: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const RAISED = ["🙌"];
const form = (cookie: string, data: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});
const setShortcuts = (value: string) => saveSettings(env.DB, env.ADMIN_PASSWORD, { shortcut_keywords: value });
const privateReplies = () => w.meta.sent.filter((s) => s.kind === "private_reply");
const status = (id: string) => env.DB.prepare("SELECT status, reason, campaign_id FROM comments WHERE id = ?").bind(id).first();

describe("matching a comment with shortcut keywords", () => {
  it("answers a shortcut for a keyword campaign on that post, in any of its forms", () => {
    const reel = campaign(1);
    for (const text of ["🙌", "🙌🙌🙌", "🙌🏽", "send it 🙌", "Love this 🙌"]) {
      expect(matchComment([reel], REEL, text, RAISED)?.id, text).toBe(1);
      expect(matchComment([reel], REEL, text), `${text}, with no shortcuts`).toBeNull();
    }
    expect(matchComment([reel], REEL, "🔥", RAISED)).toBeNull();
  });

  it("leaves campaigns on all posts out, so a shortcut under any post doesn't get their link", () => {
    const all = campaign(1, { mediaId: null, mediaLabel: null });
    expect(matchComment([all], OTHER_POST, "🙌", RAISED)).toBeNull();
    expect(matchComment([all], OTHER_POST, "AGENTS 🙌", RAISED)?.id).toBe(1);
    // Even one that lists the shortcut itself: the setting decides where shortcuts count.
    const listed = campaign(2, { keywords: ["AGENTS", "🙌"], mediaId: null, mediaLabel: null });
    expect(matchComment([listed], OTHER_POST, "🙌", RAISED)).toBeNull();
    expect(matchComment([listed], OTHER_POST, "🙌"), "with no shortcuts set, its own list applies").toMatchObject({ id: 2 });
  });

  it("sends a comment with a campaign's own keyword to that campaign, before any shortcut", () => {
    const reel = campaign(1, { keywords: ["PROMPTS"] });
    const all = campaign(2, { keywords: ["AGENTS"], mediaId: null, mediaLabel: null });
    expect(matchComment([reel, all], REEL, "AGENTS 🙌", RAISED)?.id).toBe(2);
    expect(matchComment([reel, all], REEL, "🙌", RAISED)?.id).toBe(1);
    // The post's own campaign, even when an all-posts one lists the shortcut itself.
    const listed = campaign(3, { keywords: ["AGENTS", "🙌"], mediaId: null, mediaLabel: null });
    expect(matchComment([listed, reel], REEL, "🙌", RAISED)?.id).toBe(1);
  });

  it("changes nothing for any-comment campaigns, campaigns that are off, or campaigns still waiting", () => {
    const any = campaign(1, { anyComment: true, keywords: [] });
    expect(matchComment([any], REEL, "🙌", RAISED)?.id).toBe(1);
    expect(matchComment([campaign(2, { active: false })], REEL, "🙌", RAISED)).toBeNull();
    expect(matchComment([campaign(3, { mediaId: null, mediaLabel: null, nextPostAfter: 1 })], REEL, "🙌", RAISED)).toBeNull();
    // Two campaigns on one post: the oldest takes it, as with keywords.
    expect(matchComment([campaign(5), campaign(4, { keywords: ["PROMPTS"] })], REEL, "🙌", RAISED)?.id).toBe(4);
  });

  it("never counts a shortcut as a DM keyword, even when the campaign lists it", () => {
    const listed = campaign(1, { keywords: ["AGENTS", "🙌"], dmKeyword: true });
    expect(matchDm([listed], "🙌", RAISED)).toBeNull();
    expect(matchDm([listed], "AGENTS", RAISED)?.id).toBe(1);
    expect(matchDm([campaign(2, { dmKeyword: true })], "🙌", RAISED)).toBeNull();
  });

  it("removes shortcuts from a list the way matching compares keywords", () => {
    expect(withoutKeywords(["AGENTS", "Send it", "🙌"], ["send-it", "🙌"])).toEqual(["AGENTS"]);
    expect(withoutKeywords(["AGENTS"], [])).toEqual(["AGENTS"]);
  });
});

describe("a campaign waiting for the next post", () => {
  it("is never attached by a shortcut, even one it lists itself", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    const waiting = campaign(1, { keywords: ["AGENTS", "SEND IT"], mediaId: null, mediaLabel: null, nextPostAfter: now - MINUTE });
    const posts = [media(NEW_POST, now, "Five tools I use daily. Comment SEND IT and I'll DM you the list")];
    expect(postFor(waiting, posts)?.id, "with no shortcuts set, its own list applies").toBe(NEW_POST);
    expect(postFor(waiting, posts, ["Send it"])).toBeUndefined();
    expect(postFor(campaign(2, { mediaId: null, mediaLabel: null, nextPostAfter: now - MINUTE }), [media(NEW_POST, now, "Comment 🙌 for part two")], RAISED)).toBeUndefined();
    expect(postFor(waiting, [media(NEW_POST, now, "Comment AGENTS for the list")], ["Send it"])?.id).toBe(NEW_POST);
  });

  it("answers the shortcuts that reached its post before it attached", async () => {
    await setShortcuts("🙌");
    const id = await w.campaign({ mediaId: null, mediaLabel: null, nextPostAfter: w.clock.now() - 10 * MINUTE });
    w.meta.media = [media(NEW_POST, w.clock.now(), "An invented reel. Comment AGENTS and I'll send the list")];
    w.clock.advance(20_000);
    const early = w.comment("🙌", FAN, { media: NEW_POST });
    await w.sendComment(early);
    expect(await status(early.id)).toMatchObject({ status: "skipped", reason: "no matching campaign" });

    w.clock.advance(30_000);
    await w.cron();
    expect((await listCampaigns(env.DB)).find((c) => c.id === id)?.mediaId).toBe(NEW_POST);
    expect(privateReplies().map((s) => s.to)).toEqual([early.id]);
    expect(await status(early.id)).toMatchObject({ status: "done", campaign_id: id });
  });

  it("isn't reported as attaching by a caption check, for a shortcut", async () => {
    await setShortcuts("SEND IT");
    const cookie = await w.signIn();
    const page = await (await w.fetch("/dashboard/settings/api-write-token", form(cookie, { do: "new" }))).text();
    const headers = { authorization: `Bearer ${page.match(/ocw_[A-Za-z0-9_-]+/)![0]}`, "content-type": "application/json" };
    const caption = "Five tools I use daily. Comment SEND IT and I'll DM you the list";
    const res = await w.fetch("/api/campaigns/check", { method: "POST", headers, body: JSON.stringify({ caption, keywords: ["SEND IT"] }) });
    expect(await res.json()).toMatchObject({ attaches: false, matched_keyword: null });
  });
});

describe("shortcuts end to end", () => {
  it("are set in Settings, answered on a campaign's post, and ignored elsewhere and in DMs", async () => {
    const cookie = await w.signIn();
    const settings = await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text();
    expect(settings).toContain('id="shortcuts"');
    expect(settings).toContain('name="shortcut_keywords" type="text" value=""');

    const res = await w.fetch("/dashboard/settings/shortcuts", form(cookie, { shortcut_keywords: " 🙌 ,send it, 🙌 " }));
    expect(res.headers.get("location")).toBe("/dashboard/settings?saved=shortcuts#shortcuts");
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'shortcut_keywords'").first("value")).toBe("🙌, send it");
    expect(await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text()).toContain('name="shortcut_keywords" type="text" value="🙌, send it"');

    const id = await w.campaign();
    await w.campaign({ name: "Gear", keywords: ["GEAR"], mediaId: null, mediaLabel: null });
    const onReel = w.comment("🙌🙌", FAN);
    const elsewhere = w.comment("🙌", FAN2, { media: OTHER_POST });
    await w.sendComment(onReel);
    await w.sendComment(elsewhere);
    expect(privateReplies().map((s) => s.to)).toEqual([onReel.id]);
    expect(await status(onReel.id)).toMatchObject({ status: "done", campaign_id: id });
    expect(await status(elsewhere.id)).toMatchObject({ status: "skipped", reason: "no matching campaign" });

    // The test campaign answers its keyword by DM; a shortcut by DM gets nothing.
    await w.sendDm(FAN2.id, "🙌");
    expect(w.meta.sentTo(FAN2.id)).toHaveLength(0);
    await w.sendDm(FAN2.id, "AGENTS");
    expect(w.meta.sentTo(FAN2.id)).toHaveLength(1);
  });

  it("are turned off by saving the field empty", async () => {
    const cookie = await w.signIn();
    await setShortcuts("🙌");
    await w.fetch("/dashboard/settings/shortcuts", form(cookie, { shortcut_keywords: " , " }));
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'shortcut_keywords'").first()).toBeNull();
    expect(shortcutKeywords({})).toEqual([]);

    await w.campaign();
    const c = w.comment("🙌", FAN);
    await w.sendComment(c);
    expect(privateReplies()).toHaveLength(0);
  });

  it("list a skipped shortcut under To check on the campaign's post, as matching now", async () => {
    const reel = await w.campaign({ active: false });
    const all = await w.campaign({ name: "Gear", keywords: ["GEAR"], mediaId: null, mediaLabel: null, active: false });
    const raised = w.comment("🙌", FAN);
    await w.sendComment(raised);
    expect(await status(raised.id)).toMatchObject({ status: "skipped", reason: "no matching campaign" });

    const campaigns = await listCampaigns(env.DB);
    expect((await missedComments(await w.ctx(), campaigns)).get(reel)).toBeUndefined();
    await setShortcuts("🙌");
    const missed = await missedComments(await w.ctx(), campaigns);
    expect(missed.get(reel)?.map((m) => [m.id, m.why])).toEqual([[raised.id, "matches"]]);
    expect(missed.get(all)).toBeUndefined();
  });

  it("are named on the campaign's page and form, with a link to Settings, and served by the API", async () => {
    const cookie = await w.signIn();
    const reel = await w.campaign();
    const all = await w.campaign({ name: "Gear", keywords: ["GEAR"], mediaId: null, mediaLabel: null });
    const page = async (path: string) => (await w.fetch(path, { headers: { cookie } })).text();
    expect(await page(`/dashboard/campaigns/${reel}`)).not.toContain("shortcut keywords");

    await setShortcuts("🙌");
    const reelPage = await page(`/dashboard/campaigns/${reel}`);
    expect(reelPage).toContain('Also answers your <a href="/dashboard/settings#shortcuts">shortcut keywords</a>: 🙌.');
    expect(await page(`/dashboard/campaigns/${all}`)).toContain("(🙌) don't apply to a campaign on all posts.");
    expect(await page(`/dashboard/campaigns/${reel}/edit`)).toContain('also answers your <a href="/dashboard/settings#shortcuts">shortcut keywords</a> (🙌)');

    const token = (await (await w.fetch("/dashboard/settings/api-token", form(cookie, { do: "new" }))).text()).match(/oc_[A-Za-z0-9_-]+/)![0];
    const api = (await (await w.fetch("/api/campaigns", { headers: { authorization: `Bearer ${token}` } })).json()) as { shortcut_keywords: string[] };
    expect(api.shortcut_keywords).toEqual(["🙌"]);
  });
});
