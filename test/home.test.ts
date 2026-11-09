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
    await w.sendComment(w.comment("agnets", FAN, { ago: 6 * DAY }));
    await w.sendComment(w.comment("agnets please", FAN2, { ago: 2 * DAY }));

    const shown = strip(await home());
    expect(shown).toContain(`href="/dashboard/campaigns/${agents}#to-check">2 comments to check on Agents library</a>`);
    expect(shown).toContain("(oldest: 1 day left to answer)");
    expect(shown).toContain(`href="/dashboard/campaigns/${setup}#to-check">1 comment to check on Setup guide</a>`);
    expect(shown).toContain("(6 days left to answer)");
    expect(shown.indexOf("Agents library")).toBeLessThan(shown.indexOf("Setup guide"));
  });

  it("leaves out campaigns that are off", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("agnets", FAN));
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
  it("is flagged until its caption asks for the keyword", async () => {
    const id = await waiting();
    w.clock.advance(MINUTE);
    const posted = w.clock.now();
    w.meta.media = [media(NEW_POST, posted, "A <new> reel with no call to action")];
    await w.cron();

    const shown = strip(await home());
    expect(shown).toContain(`no campaign attached to it: "A &lt;new&gt; reel with no call to action"`);
    expect(shown).toContain(`<a href="/dashboard/campaigns/${id}/edit">Agents library</a> needs "Comment AGENTS"`);

    w.meta.media = [media(NEW_POST, posted, "A new reel. Comment AGENTS for the list")];
    await w.cron();
    expect((await getCampaign(env.DB, id))!.mediaId).toBe(NEW_POST);
    expect(await home()).toContain("Nothing needs you right now.");
  });

  it("names every campaign that was already waiting, and only those", async () => {
    const early = await waiting({ name: "Early one" });
    w.clock.advance(2 * MINUTE);
    w.meta.media = [media(NEW_POST, w.clock.now() - MINUTE, "No call to action")];
    const late = await waiting({ name: "Late one", keywords: ["SETUP"] });
    await w.cron();

    const shown = strip(await home());
    expect(shown).toContain(`/dashboard/campaigns/${early}/edit`);
    expect(shown).not.toContain(`/dashboard/campaigns/${late}/edit`);
  });

  it("leaves alone older posts, posts another campaign has, and waiting campaigns that are off", async () => {
    await waiting();
    await w.campaign({ name: "Already attached", keywords: ["TRAFFIC"], mediaId: NEW_POST, mediaLabel: "New reel" });
    w.clock.advance(MINUTE);
    w.meta.media = [media(NEW_POST, w.clock.now(), "Taken by the other one"), media(OLD_POST, w.clock.now() - DAY, "From yesterday")];
    await w.cron();
    expect(strip(await home())).toBe("");

    await env.DB.prepare("DELETE FROM campaigns").run();
    await waiting({ active: false });
    w.meta.media = [media(NEW_POST, w.clock.now() + MINUTE, "No call to action")];
    w.clock.advance(2 * MINUTE);
    await w.cron();
    expect(strip(await home())).toBe("");
  });
});

describe("the on/off switch", () => {
  it("changes only whether the campaign is on, and off stops its DMs", async () => {
    const id = await w.campaign();
    const before = (await getCampaign(env.DB, id))!;
    w.clock.advance(MINUTE);
    const res = await flip(id, "off");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard");
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
  it("puts campaigns that are on first, and folds away those that are off", async () => {
    const old = await w.campaign({ name: "Old and on" });
    w.clock.advance(HOUR);
    const offOne = await w.campaign({ name: "Newest but off", active: false });
    const page = await home();
    expect(page.indexOf("Old and on")).toBeLessThan(page.indexOf("<details"));
    expect(page.indexOf("<details")).toBeLessThan(page.indexOf("Newest but off"));
    expect(page).toContain("1 campaign off</summary>");
    expect(page).not.toContain("<details open");

    await flip(old, "off");
    expect(await home()).toContain("<details open");
    await flip(offOne, "on");
    await flip(old, "on");
    expect(await home()).not.toContain("<details");
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
