import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getCampaign } from "../src/campaigns";
import { MetaError, type Media } from "../src/meta/client";
import { saveSettings } from "../src/settings";
import { DAY, HOUR, MINUTE } from "../src/time";
import { BASE, FAN, FAN2, OTHER_POST, REEL, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;
let cookie: string;

beforeEach(async () => {
  w = await setupWorld();
  cookie = await w.signIn();
});

// Invented posts.
const NEW_POST = "18000000000000010";
const OLD_POST = "18000000000000009";
const media = (id: string, timestamp: number, caption: string): Media => ({
  id,
  caption,
  permalink: `https://www.instagram.com/reel/${id}/`,
  timestamp,
  mediaType: "VIDEO",
});
const waiting = (overrides = {}) => w.campaign({ mediaId: null, mediaLabel: null, nextPostAfter: w.clock.now(), ...overrides });

const home = async () => (await w.fetch("/dashboard", { headers: { cookie } })).text();
const strip = (page: string) => /<div class="card notice" id="needs-you">.*?<\/ul><\/div>/s.exec(page)?.[0] ?? "";
const entries = (page: string) => /<div id="no-campaign">.*?(?=<div class="card row campaign"(?! untaken)|<details|<\/main>)/s.exec(page)?.[0] ?? "";
const postForm = (path: string, values: Record<string, string>, headers: Record<string, string>) =>
  w.fetch(path, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
const dismiss = (mediaId: string, headers: Record<string, string> = { cookie, origin: BASE }) => postForm("/dashboard/posts/dismiss", { media_id: mediaId }, headers);
const attachPost = (mediaId: string, campaignId: string, headers: Record<string, string> = { cookie, origin: BASE }) =>
  postForm("/dashboard/posts/attach", { media_id: mediaId, campaign_id: campaignId }, headers);
const flip = (id: number, active: string, headers: Record<string, string> = { cookie, origin: BASE }) =>
  w.fetch(`/dashboard/campaigns/${id}/switch`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ active }),
  });
const isOn = async (id: number) => (await getCampaign(env.DB, id))!.active;
const problem = (values: Record<string, string>) => saveSettings(env.DB, env.ADMIN_PASSWORD, values);

describe("what needs you", () => {
  it("says so when nothing does, and only when that means something", async () => {
    expect(await home()).not.toContain("Nothing needs you");
    await w.campaign();
    expect(await home()).toContain("Nothing needs you right now.");
    await problem({ token_problem: "The invented token stopped working." });
    expect(await home()).not.toContain("Nothing needs you");
  });

  it("lists comments to check per campaign, the one running out first on top", async () => {
    const agents = await w.campaign();
    const setup = await w.campaign({ name: "Setup guide", keywords: ["SETUP"], mediaId: OTHER_POST, mediaLabel: "Other reel" });
    await w.sendComment(w.comment("Set-up", FAN, { media: OTHER_POST, ago: DAY }));
    await w.sendComment(w.comment("could you send me the agnets list", FAN, { ago: 6 * DAY }));
    await w.sendComment(w.comment("could you send me the agnets list please", FAN2, { ago: 2 * DAY }));

    const shown = strip(await home());
    expect(shown).toContain(`href="/dashboard/campaigns/${agents}#to-check">2 comments to check on Agents library</a>`);
    expect(shown).toContain("(oldest: 1 day left to answer)");
    expect(shown).toContain(`href="/dashboard/campaigns/${setup}#to-check">1 comment to check on Setup guide</a>`);
    expect(shown).toContain("(6 days left to answer)");
    expect(shown.indexOf("Agents library")).toBeLessThan(shown.indexOf("Setup guide"));
  });

  it("leaves out campaigns that are off", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("could you send me the agnets list", FAN));
    expect(strip(await home())).toContain("to check");
    await flip(id, "off");
    expect(strip(await home())).toBe("");
  });

  it("counts failures from the last 24 hours, not forever", async () => {
    await w.campaign();
    await env.DB.prepare("INSERT INTO activity (at, kind, outcome, reason) VALUES (?, 'private_reply', 'failed', 'invented refusal')").bind(w.clock.now()).run();
    const shown = strip(await home());
    expect(shown).toContain(`href="/dashboard/activity?show=failed">1 failure in the last 24 hours</a>`);
    w.clock.advance(25 * HOUR);
    expect(await home()).toContain("Nothing needs you right now.");
  });

  it("shows a check that failed, escaped, only while that check still runs", async () => {
    const at = String(w.clock.now());
    await problem({ last_poll_problem: `${at}|Meta said <b>no</b>`, next_post_problem: `${at}|Meta said maybe` });
    await w.campaign();
    let shown = strip(await home());
    expect(shown).toContain("The last check for missed comments failed");
    expect(shown).toContain("Meta said &lt;b&gt;no&lt;/b&gt;");
    expect(shown).not.toContain("your next post");

    await env.DB.prepare("DELETE FROM campaigns").run();
    await waiting();
    shown = strip(await home());
    expect(shown).toContain("The last look for your next post failed");
    expect(shown).not.toContain("missed comments");
  });
});

describe("a post no waiting campaign attached to", () => {
  const POINTER = `<a href="#no-campaign">A post went up with no campaign</a>`;

  it("is an entry in the list, pointed to from Needs you, until its caption asks for the keyword", async () => {
    const id = await waiting();
    w.clock.advance(MINUTE);
    const posted = w.clock.now();
    w.meta.media = [media(NEW_POST, posted, "A <new> reel with no call to action")];
    await w.cron();

    const page = await home();
    expect(strip(page)).toContain(POINTER);
    expect(strip(page)).not.toContain("<form");
    const entry = entries(page);
    expect(entry).toContain(`id="post-${NEW_POST}"`);
    expect(entry).toContain("A &lt;new&gt; reel with no call to action");
    expect(entry).toContain("No campaign");
    expect(entry).toContain(`href="https://www.instagram.com/reel/${NEW_POST}/"`);
    expect(entry).toContain(`name="campaign_id" value="${id}"`);
    expect(entry).toContain("Attach to Agents library (Comment AGENTS)");
    expect(entry).toContain(`action="/dashboard/posts/dismiss"`);

    w.meta.media = [media(NEW_POST, posted, "A new reel. Comment AGENTS for the list")];
    // The edited caption is seen on the next read of the post list, within 10 minutes.
    w.clock.advance(10 * MINUTE);
    await w.cron();
    expect((await getCampaign(env.DB, id))!.mediaId).toBe(NEW_POST);
    expect(entries(await home())).toBe("");
    expect(await home()).toContain("Nothing needs you right now.");
  });

  it("offers every campaign that was already waiting, and only those", async () => {
    const early = await waiting({ name: "Early one" });
    const second = await waiting({ name: "Second one", keywords: ["GUIDE"] });
    w.clock.advance(2 * MINUTE);
    w.meta.media = [media(NEW_POST, w.clock.now() - MINUTE, "No call to action")];
    const late = await waiting({ name: "Late one", keywords: ["SETUP"] });
    await w.cron();

    const entry = entries(await home());
    expect(entry).toContain(`<select name="campaign_id"`);
    expect(entry).toContain(`<option value="${early}">Early one (Comment AGENTS)</option>`);
    expect(entry).toContain(`<option value="${second}">Second one (Comment GUIDE)</option>`);
    expect(entry).not.toContain(`value="${late}"`);
  });

  it("leaves alone older posts, posts another campaign has, and waiting campaigns that are off", async () => {
    await waiting();
    await w.campaign({ name: "Already attached", keywords: ["TRAFFIC"], mediaId: NEW_POST, mediaLabel: "New reel" });
    w.clock.advance(MINUTE);
    w.meta.media = [media(NEW_POST, w.clock.now(), "Taken by the other one"), media(OLD_POST, w.clock.now() - DAY, "From yesterday")];
    await w.cron();
    expect(strip(await home())).toBe("");
    expect(entries(await home())).toBe("");

    await env.DB.prepare("DELETE FROM campaigns").run();
    await waiting({ active: false });
    w.meta.media = [media(NEW_POST, w.clock.now() + MINUTE, "No call to action")];
    w.clock.advance(2 * MINUTE);
    await w.cron();
    expect(strip(await home())).toBe("");
    expect(entries(await home())).toBe("");
  });

  it("attaches the post to the waiting campaign chosen on its entry, and answers the comments already on it", async () => {
    const id = await waiting();
    const other = await waiting({ name: "Other one", keywords: ["GUIDE"] });
    w.clock.advance(MINUTE);
    w.meta.media = [media(NEW_POST, w.clock.now(), "Forgot the line")];
    await w.cron();
    await w.sendComment(w.comment("AGENTS please", FAN, { media: NEW_POST }));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(0);

    expect((await attachPost(NEW_POST, String(id), { cookie, origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await attachPost("not-a-post", String(id))).status).toBe(303);
    expect((await attachPost(OLD_POST, String(id))).status).toBe(303);
    expect((await attachPost(NEW_POST, "9999")).status).toBe(303);
    expect((await attachPost(NEW_POST, "x")).status).toBe(303);
    expect((await getCampaign(env.DB, id))!.nextPostAfter).not.toBeNull();
    expect(entries(await home())).toContain(`id="post-${NEW_POST}"`);

    expect((await attachPost(NEW_POST, String(id))).status).toBe(303);
    const attached = (await getCampaign(env.DB, id))!;
    expect(attached.mediaId).toBe(NEW_POST);
    expect(attached.mediaLabel).toBe("Forgot the line");
    expect(attached.nextPostAfter).toBeNull();
    expect((await getCampaign(env.DB, other))!.nextPostAfter).not.toBeNull();
    expect(entries(await home())).toBe("");

    await w.cron();
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
  });

  it("does not attach a campaign that was not waiting when the post went up", async () => {
    w.clock.advance(MINUTE);
    const early = await waiting();
    w.clock.advance(MINUTE);
    w.meta.media = [media(NEW_POST, w.clock.now() - 30_000, "Forgot the line")];
    const late = await waiting({ name: "Late one", keywords: ["SETUP"] });
    await w.cron();
    expect((await attachPost(NEW_POST, String(late))).status).toBe(303);
    expect((await getCampaign(env.DB, late))!.mediaId).toBeNull();
    expect((await getCampaign(env.DB, early))!.mediaId).toBeNull();
  });

  it("drops a post the owner says is not for a campaign from the list, keeps it in the post picker, and still lists the next one", async () => {
    const id = await waiting();
    w.clock.advance(MINUTE);
    w.meta.media = [media(OLD_POST, w.clock.now(), "A question for you. Yes or no in the comments")];
    await w.cron();
    expect(entries(await home())).toContain(`id="post-${OLD_POST}"`);

    expect((await dismiss(OLD_POST, { cookie, origin: "https://elsewhere.example" })).status).toBe(403);
    expect(entries(await home())).toContain(`id="post-${OLD_POST}"`);
    expect((await dismiss("not-a-post")).status).toBe(303);
    expect(entries(await home())).toContain(`id="post-${OLD_POST}"`);

    expect((await dismiss(OLD_POST)).status).toBe(303);
    expect(entries(await home())).toBe("");
    expect(await home()).toContain("Nothing needs you right now.");
    expect((await getCampaign(env.DB, id))!.nextPostAfter).not.toBeNull();
    const picker = await (await w.fetch(`/dashboard/campaigns/${id}/edit`, { headers: { cookie } })).text();
    expect(picker).toContain(`name="media_id" value="${OLD_POST}"`);

    // The form read the list fresh; the Cron reads it again once its 10-minute cache runs out.
    w.clock.advance(10 * MINUTE);
    w.meta.media = [media(NEW_POST, w.clock.now(), "Forgot the line"), media(OLD_POST, w.clock.now() - MINUTE, "A question for you. Yes or no in the comments")];
    await w.cron();
    const shown = entries(await home());
    expect(shown).toContain(`id="post-${NEW_POST}"`);
    expect(shown).not.toContain(`id="post-${OLD_POST}"`);
    expect(strip(await home())).toContain(POINTER);

    w.meta.media = [media(NEW_POST, w.clock.now(), "Forgot the line. Comment AGENTS for the list"), media(OLD_POST, w.clock.now() - MINUTE, "A question")];
    w.clock.advance(10 * MINUTE);
    await w.cron();
    expect((await getCampaign(env.DB, id))!.mediaId).toBe(NEW_POST);
  });
});

describe("the on/off switch", () => {
  it("changes only whether the campaign is on, and off stops its DMs", async () => {
    const id = await w.campaign();
    const before = (await getCampaign(env.DB, id))!;
    w.clock.advance(MINUTE);
    const res = await flip(id, "off");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/dashboard?switched=${id}#c-${id}`);
    const after = (await getCampaign(env.DB, id))!;
    expect(after).toEqual({ ...before, active: false, updatedAt: w.clock.now() });

    await w.sendComment(w.comment("AGENTS", FAN));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(0);

    await flip(id, "on");
    expect(await isOn(id)).toBe(true);
    await w.sendComment(w.comment("AGENTS", FAN2));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
  });

  it("sets the state asked for, so a second click or an old tab can't flip it back", async () => {
    const id = await w.campaign();
    await flip(id, "off");
    await flip(id, "off");
    expect(await isOn(id)).toBe(false);
    await flip(id, "on");
    await flip(id, "nonsense");
    expect(await isOn(id)).toBe(true);
  });

  it("refuses other sites, visitors who aren't signed in, and GET", async () => {
    const id = await w.campaign();
    expect((await flip(id, "off", { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await flip(id, "off", { origin: BASE })).status).toBe(303);
    expect(await isOn(id)).toBe(true);
    expect((await w.fetch(`/dashboard/campaigns/${id}/switch`, { headers: { cookie } })).status).toBe(404);
    expect(await isOn(id)).toBe(true);
  });

  it("asks before turning off, not before turning on", async () => {
    const id = await w.campaign({ name: `Quote " name` });
    const on = await home();
    expect(on).toContain(`value="off"`);
    expect(on).toContain(`data-ask="Turn off Quote &quot; name?`);
    await flip(id, "off");
    const off = await home();
    expect(off).toContain(`value="on"`);
    expect(off).not.toContain("data-ask");
  });
});

describe("the order of the list", () => {
  const row = (page: string, id: number) => /<div class="card row campaign[^"]*" id="c-(\d+)">.*?(?=<div class="card row campaign|<script>)/gs
    .exec(page.slice(page.indexOf(`id="c-${id}"`) - 40))?.[0] ?? "";
  const order = (page: string) => [...page.matchAll(/ id="c-(\d+)"/g)].map((m) => Number(m[1]));
  const posted = (mediaId: string, at: number) =>
    env.DB.prepare("INSERT INTO media_stats (media_id, posted_at, fetched_at) VALUES (?, ?, 0)").bind(mediaId, at).run();

  it("keeps campaigns that are off in place, dimmed and marked Off", async () => {
    const old = await w.campaign({ name: "Old and on", mediaId: OLD_POST });
    w.clock.advance(HOUR);
    const newer = await w.campaign({ name: "Newest but off", active: false, mediaId: NEW_POST });
    const page = await home();
    expect(page).not.toContain("<details");
    expect(order(page)).toEqual([newer, old]);
    expect(row(page, newer)).toContain('class="card row campaign off"');
    expect(row(page, newer)).toContain('<span class="pill off">Off</span>');
    expect(row(page, old)).not.toContain(">Off</span>");
    expect(page).toContain("1 of 2 campaigns on.");

    await flip(old, "off");
    await flip(newer, "on");
    expect(order(await home())).toEqual([newer, old]);
  });

  it("puts the newest Reel on top, whenever its campaign was made", async () => {
    const reelLater = await w.campaign({ name: "Made first", mediaId: NEW_POST });
    w.clock.advance(HOUR);
    const reelEarlier = await w.campaign({ name: "Made second", mediaId: OLD_POST });
    w.clock.advance(HOUR);
    const next = await waiting({ name: "Waiting" });
    await posted(OLD_POST, w.clock.now() - 5 * DAY);
    await posted(NEW_POST, w.clock.now() - DAY);
    expect(order(await home())).toEqual([next, reelLater, reelEarlier]);
  });

  it("confirms a switch on the row it changed", async () => {
    const id = await w.campaign();
    const other = await w.campaign({ name: "Other", keywords: ["OTHER"] });
    await flip(id, "off");
    const page = await (await w.fetch(`/dashboard?switched=${id}`, { headers: { cookie } })).text();
    expect(row(page, id)).toContain("Turned off. New comments on it get no DM until you turn it back on.");
    expect(row(page, other)).not.toContain('role="status"');
    await flip(id, "on");
    const back = await (await w.fetch(`/dashboard?switched=${id}`, { headers: { cookie } })).text();
    expect(row(back, id)).toContain("Turned on. It answers new comments from now on.");
    expect(await home()).not.toContain('role="status"');
  });
});

describe("what each campaign row says about its recent days", () => {
  const row = async (id: number) => {
    const page = await home();
    return /<p class="small recent">.*?<\/p>/s.exec(page.slice(page.indexOf(`id="c-${id}"`)))?.[0] ?? "";
  };

  it("says how old the Reel is, the last matching comment and the DMs of the last 7 days", async () => {
    const id = await w.campaign();
    await env.DB.prepare("INSERT INTO media_stats (media_id, posted_at, fetched_at) VALUES (?, ?, 0)").bind(REEL, w.clock.now() - 3 * DAY).run();
    await w.sendComment(w.comment("AGENTS please", FAN, { ago: 9 * DAY }));
    await w.sendComment(w.comment("agents", FAN2, { ago: 30 * MINUTE }));
    const line = await row(id);
    expect(line).toContain("Reel posted <b>3 days ago</b>");
    expect(line).toContain('Last matching comment <b>30 minutes ago</b> <span class="muted">"agents"</span>');
    expect(line).toContain("<b>1</b> DM in the last 7 days");
  });

  it("counts only the last 7 days, and says when nothing matched yet", async () => {
    const id = await w.campaign();
    expect(await row(id)).toContain("No matching comment yet");
    expect(await row(id)).toContain("<b>0</b> DMs in the last 7 days");
    await w.sendComment(w.comment("agents", FAN));
    w.clock.advance(8 * DAY);
    const line = await row(id);
    expect(line).toContain("Last matching comment <b>8 days ago</b>");
    expect(line).toContain("<b>0</b> DMs in the last 7 days");
  });
});

describe("which platform this covers", () => {
  it("says Instagram on every signed-in page", async () => {
    for (const path of ["/dashboard", "/dashboard/leads", "/dashboard/activity", "/dashboard/settings"]) {
      const page = await (await w.fetch(path, { headers: { cookie } })).text();
      expect(page, path).toContain("OwnChats <span>for Instagram</span>");
    }
  });

  it("names Instagram on the connected line", async () => {
    expect(await home()).toMatch(/Connected to Instagram as @\w+\./);
  });
});

describe("a public reply Instagram refuses", () => {
  const COMMENT_GONE = () => new MetaError("Unsupported post request. Object with ID '1' does not exist", 400, 100, 33);
  const BLOCKED = () => new MetaError("This API call does not support the requested response format", 400, 20, 1772107);

  const refuse = async (error: MetaError) => {
    const id = await w.campaign();
    w.meta.failNext("replyToComment", error);
    await w.sendComment(w.comment("agents", FAN));
    return { id, entry: (await w.activity()).at(-1)! };
  };

  it("still leaves the DM sent", async () => {
    await refuse(COMMENT_GONE());
    expect(w.meta.sent.map((s) => s.kind)).toEqual(["private_reply"]);
  });

  it("blames the comment, and doesn't send the owner to reconnect", async () => {
    const { entry } = await refuse(COMMENT_GONE());
    expect(entry).toMatchObject({ kind: "public_reply", outcome: "failed" });
    expect(entry.reason).toContain("may be hidden or deleted");
    expect(entry.reason).not.toContain("/setup");
  });

  it("says Instagram blocked it, without claiming to know why", async () => {
    const { entry } = await refuse(BLOCKED());
    expect(entry.reason).toBe("Instagram blocked this public reply, possibly as spam (the DM still went out)");
  });

  it("keeps the usual words for any other error", async () => {
    const { entry } = await refuse(new MetaError("Error validating access token", 401, 190));
    expect(entry).toMatchObject({ kind: "public_reply", reason: expect.stringContaining("reconnect Instagram") });
  });

  it("doesn't blame the comment for other invalid requests", async () => {
    const { entry } = await refuse(new MetaError("Invalid parameter", 400, 100));
    expect(entry.reason).toBe("Meta refused");
  });

  it("still names the connection when the DM gets that same error", async () => {
    await w.campaign();
    w.meta.failNext("sendPrivateReply", COMMENT_GONE());
    await w.sendComment(w.comment("agents", FAN));
    expect((await w.activity()).at(-1)).toMatchObject({ kind: "private_reply", reason: expect.stringContaining("not assigned to this login") });
  });

  it("isn't listed as needing the owner, but stays in the log and on its campaign", async () => {
    const { id } = await refuse(COMMENT_GONE());
    expect(await home()).toContain("Nothing needs you right now.");
    const logged = await (await w.fetch("/dashboard/activity?show=failed", { headers: { cookie } })).text();
    expect(logged).toContain("may be hidden or deleted");
    const campaign = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(campaign).toContain("Public reply: this comment");
  });
});
