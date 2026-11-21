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

  it("reports failures from the last 24 hours on the health line, not as something to do", async () => {
    await w.campaign();
    await env.DB.prepare("INSERT INTO activity (at, kind, outcome, reason, detail) VALUES (?, 'private_reply', 'failed', 'invented refusal', 'Application request limit reached (HTTP 403, code 4)')")
      .bind(w.clock.now())
      .run();
    await env.DB.prepare("INSERT INTO activity (at, kind, outcome, reason) VALUES (?, 'lead_webhook', 'failed', 'invented refusal')").bind(w.clock.now()).run();
    const page = await home();
    expect(page).toContain("Nothing needs you right now.");
    // History, not a to-do: one short line linking to the log, with the attempts and Meta's code on hover.
    expect(page).toContain(
      `<p class="muted small status-note"><a href="/dashboard/activity?show=failed" title="1 DM attempt refused in the last 24 hours, mostly code 4 (its app rate limit).">Instagram refused 1 DM attempt in the last 24 hours</a>. <a href="/dashboard/activity?show=failed">1 other failure</a> in the last 24 hours.</p>`,
    );
    w.clock.advance(25 * HOUR);
    expect(await home()).not.toContain("Instagram refused");
  });

  it("puts a near limit on a short line of its own, the readings per limit on hover", async () => {
    await w.campaign();
    await saveSettings(env.DB, env.ADMIN_PASSWORD, {
      meta_usage: JSON.stringify({ readings: { instagram: { percent: 1, at: w.clock.now() }, app: { percent: 81, at: w.clock.now() } }, regainMs: 0, regainAt: 0 }),
    });
    const page = await home();
    expect(page).toMatch(/<p class="small status-note" title="Meta's readings: [^"]*app 81%[^"]*"><span class="dot warn" aria-hidden="true"><\/span>Instagram's limit is at 81%\. OwnChats checks for missed comments less often; DMs still go first\.<\/p>/);
    // Its own line, not a clause of the connected line.
    expect(page).toMatch(/Connected to Instagram as @\w+\.<\/span>(?: Times are in UTC: <a [^>]+>[^<]+<\/a>\.)?<\/p><p class="small status-note"/);
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
    expect(row(page, newer)).toContain('<span class="pill off" title="Turned off today, at ');
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
    expect(await home()).toMatch(/>Connected to Instagram as @\w+\.<\/span>/);
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

describe("deciding which campaigns to keep on", () => {
  const posted = (mediaId: string, at: number) =>
    env.DB.prepare("INSERT INTO media_stats (media_id, posted_at, fetched_at) VALUES (?, ?, 0) ON CONFLICT (media_id) DO UPDATE SET posted_at = excluded.posted_at")
      .bind(mediaId, at)
      .run();
  const rowOf = (page: string, id: number) => {
    const start = page.indexOf(`id="c-${id}"`);
    if (start < 0) return "";
    const next = page.indexOf('<div class="card row campaign', start);
    return page.slice(start, next < 0 ? page.indexOf("<script>", start) : next);
  };
  const shownIds = (page: string) => [...page.matchAll(/ id="c-(\d+)"/g)].map((m) => Number(m[1]));
  const at = (query: string) => w.fetch(`/dashboard${query}`, { headers: { cookie } }).then((r) => r.text());

  it("says what a campaign costs in Meta calls, by its post's age, and asks with it before turning off", async () => {
    const cases: Array<[string, number, string]> = [
      ["18000000000000301", 1 * DAY, "about 60 Meta calls an hour"],
      ["18000000000000302", 3 * DAY, "about 4 Meta calls an hour"],
      ["18000000000000303", 10 * DAY, "about 1 Meta call an hour"],
      ["18000000000000304", 40 * DAY, "1 Meta call every 3 hours"],
    ];
    const ids: number[] = [];
    for (const [i, [mediaId, age]] of cases.entries()) {
      ids.push(await w.campaign({ name: `Reel ${i}`, keywords: [`WORD${i}`], mediaId }));
      await posted(mediaId, w.clock.now() - age);
    }
    const everywhere = await w.campaign({ name: "Everywhere", keywords: ["GUIDE"], mediaId: null });
    const page = await home();
    cases.forEach(([, , words], i) => {
      expect(rowOf(page, ids[i]!)).toContain(`title="On, costing ${words}. Click to turn off."`);
      expect(rowOf(page, ids[i]!)).toContain(`It saves ${words}, and comments that arrive while it is off get no DM.`);
    });
    expect(rowOf(page, everywhere)).toContain('title="On. Click to turn off."');

    // Off, it costs nothing, so nothing is said.
    await flip(ids[2]!, "off");
    expect(rowOf(await home(), ids[2]!)).not.toContain("costing");
  });

  it("tags a campaign that is on and had no matching comment for a week, and lists those under Quiet", async () => {
    const quiet = await w.campaign({ name: "Quiet one" });
    const busy = await w.campaign({ name: "Busy one", keywords: ["SETUP"], mediaId: OTHER_POST });
    const off = await w.campaign({ name: "Off one", keywords: ["OFFWORD"], mediaId: "18000000000000305", active: false });
    const next = await waiting({ name: "Waiting one", keywords: ["NEXT"] });
    await w.sendComment(w.comment("agents", FAN, { ago: 30 * MINUTE }));
    w.clock.advance(9 * DAY);
    await w.sendComment(w.comment("setup", FAN2, { media: OTHER_POST }));

    const page = await home();
    expect(rowOf(page, quiet)).toContain('<span class="pill quiet">No comment in 9 days</span>');
    expect(rowOf(page, busy)).not.toContain("pill quiet");
    expect(rowOf(page, off)).not.toContain("pill quiet");
    expect(rowOf(page, next)).not.toContain("pill quiet");
    expect(page).toContain(">Quiet 7 days (1)</a>");
    expect(shownIds(await at("?show=quiet"))).toEqual([quiet]);
  });

  it("filters the list, counts each filter, and keeps a switched row and the filter in view", async () => {
    const a = await w.campaign({ name: "First" });
    const b = await w.campaign({ name: "Second", keywords: ["SETUP"], mediaId: OTHER_POST, active: false });
    const page = await home();
    expect(page).toContain('aria-current="page" href="/dashboard">All (2)</a>');
    expect(page).toContain('href="/dashboard?show=on">On (1)</a>');
    expect(page).toContain('href="/dashboard?show=off">Off (1)</a>');
    expect(shownIds(await at("?show=on"))).toEqual([a]);
    expect(shownIds(await at("?show=off"))).toEqual([b]);
    expect(shownIds(await at("?show=nonsense")).sort()).toEqual([a, b].sort());

    // The switch keeps the filter, and the row it turned on stays, saying so, though it no longer is off.
    expect(await at("?show=off")).toContain('<input type="hidden" name="show" value="off">');
    const res = await w.fetch(`/dashboard/campaigns/${b}/switch`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ active: "on", show: "off" }),
    });
    expect(res.headers.get("location")).toBe(`/dashboard?show=off&switched=${b}#c-${b}`);
    const after = await at(`?show=off&switched=${b}`);
    expect(shownIds(after)).toEqual([b]);
    expect(rowOf(after, b)).toContain("Turned on.");
    expect(shownIds(await at("?show=off"))).toEqual([]);
    expect(await at("?show=off")).toContain("No campaign is off.");
  });

  it("says since when a campaign is off, set by the switch or the form and kept by a second click", async () => {
    await saveSettings(env.DB, env.ADMIN_PASSWORD, { time_zone: "America/Toronto" });
    const id = await w.campaign();
    w.clock.advance(HOUR);
    const offAt = w.clock.now();
    await flip(id, "off");
    w.clock.advance(HOUR);
    await flip(id, "off");
    const since = (await home()).match(/<span class="pill off" title="Turned off today, at ([^"]+)">Off<\/span>/)?.[1];
    expect(since).toBeDefined();
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    expect(since).toContain(fmt.format(offAt));
    expect((await env.DB.prepare("SELECT active_changed_at AS t FROM campaigns WHERE id = ?").bind(id).first<{ t: number }>())!.t).toBe(offAt);

    await flip(id, "on");
    expect(await home()).not.toContain("Turned off today");

    // Saving the form with the box unticked turns it off too, and records when.
    w.clock.advance(HOUR);
    const page = await (await w.fetch(`/dashboard/campaigns/${id}/edit`, { headers: { cookie } })).text();
    const form = new URLSearchParams();
    for (const m of page.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/g)) {
      const tag = m[0];
      const name = m[1]!;
      if (/type="(checkbox|radio)"/.test(tag) && !/ checked/.test(tag)) continue;
      if (name === "active") continue;
      form.append(name, /value="([^"]*)"/.exec(tag)?.[1] ?? "on");
    }
    for (const m of page.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([^<]*)<\/textarea>/g)) form.append(m[1]!, m[2]!);
    const saved = await w.fetch(`/dashboard/campaigns/${id}`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(saved.status).toBe(303);
    expect(await isOn(id)).toBe(false);
    expect((await env.DB.prepare("SELECT active_changed_at AS t FROM campaigns WHERE id = ?").bind(id).first<{ t: number }>())!.t).toBe(w.clock.now());
  });

  it("says when a campaign started in plain words, with the exact time on hover", async () => {
    await saveSettings(env.DB, env.ADMIN_PASSWORD, { time_zone: "America/Toronto" });
    const id = await w.campaign();
    const started = () => home().then((p) => rowOf(p, id).match(/<span class="muted small" title="Started ([^"]+)">Started ([^<]+)<\/span>/)?.slice(1));
    const [exact, words] = (await started())!;
    expect(exact).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d E[SD]T$/);
    expect(["today", "yesterday"]).toContain(words);
    w.clock.advance(3 * DAY);
    expect((await started())![1]).toMatch(/^(3|4) days ago$/);
    w.clock.advance(10 * DAY);
    expect((await started())![1]).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    w.clock.advance(400 * DAY);
    cookie = await w.signIn(); // the session from a year ago has expired
    expect((await started())![1]).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it("draws first DMs per day over 14 days, the newest day on the right", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("agents", FAN, { ago: 30 * MINUTE }));
    w.clock.advance(10 * DAY);
    await w.sendComment(w.comment("agents", FAN2, { ago: 30 * MINUTE }));
    const row = rowOf(await home(), id);
    expect(row).toContain('aria-label="First DMs per day, last 14 days: 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 (2 in all)"');
    expect(row).toContain("<b>1</b> DM in the last 7 days");
  });
});

describe("the line that says what a campaign answers", () => {
  const line = async (id: number) => {
    const page = await home();
    const row = page.slice(page.indexOf(`id="c-${id}"`));
    return /<p class="muted small">((?:Comment|Any comment).*?)<\/p>/s.exec(row)?.[1] ?? "";
  };

  it("names the main keyword, keeps the other spellings on hover, and says the email ask only when there is one", async () => {
    const plain = await w.campaign({ keywords: ["AGENTS"] });
    expect(await line(plain)).toBe("Comment <b>AGENTS</b> on Test reel");
    const more = await w.campaign({ name: "More", keywords: ["SEO", "SEOO", "S E O"], mediaId: OTHER_POST, mediaLabel: "Other reel", emailMode: "optional" });
    expect(await line(more)).toBe('Comment <b>SEO</b> <span title="Also answers: SEOO, S E O">(+2 spellings)</span> on Other reel, then asks for their email');
    const any = await w.campaign({ name: "Any", keywords: [], anyComment: true, mediaId: "18000000000000306", mediaLabel: "Third reel", emailMode: "first" });
    expect(await line(any)).toBe("Any comment on Third reel, asks for their email first");
  });

  it("keeps the connection times on hover", async () => {
    const page = await home();
    expect(page).toMatch(/<span title="Last webhook: [^"]+\. Last check for missed comments: [^"]+\.">Connected to Instagram as @\w+\.<\/span>/);
    expect(page).not.toContain(". Last webhook:");
  });
});
