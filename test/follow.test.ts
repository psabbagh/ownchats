import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { FOLLOW_PAYLOAD_PREFIX, OPEN_PAYLOAD_PREFIX } from "../src/campaigns";
import { MetaError, type OutMessage } from "../src/meta/client";
import { campaignResults } from "../src/stats";
import { BASE, FAN, FAN2, REEL, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
  w.meta.names.set(FAN.id, "Invented Fan");
});

const open = (id: number) => `${OPEN_PAYLOAD_PREFIX}${id}`;
const follow = (id: number) => `${FOLLOW_PAYLOAD_PREFIX}${id}`;
const toFan = () => w.meta.sentTo(FAN.id).map((s) => s.message as OutMessage);
const conversation = () =>
  env.DB.prepare("SELECT state, follows, follow_asked, name FROM conversations WHERE ig_user_id = ?").bind(FAN.id).first();
const followLog = async () => (await w.activity()).filter((a) => a.kind === "follow").map((a) => `${a.outcome}: ${a.reason}`);

describe("follow check", () => {
  it("sends a follower the link right after the tap, with no ask", async () => {
    const id = await w.campaign({ followCheck: true });
    w.meta.followers.add(FAN.id);
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, open(id));
    expect(toFan()).toEqual([expect.objectContaining({ kind: "buttons", buttons: [expect.objectContaining({ type: "web_url" })] })]);
    expect(await conversation()).toMatchObject({ state: "done", follows: 1, follow_asked: 0, name: "Invented Fan" });
    expect(await followLog()).toEqual(["received: follows"]);
  });

  it("asks someone who doesn't follow, then sends the link once they follow and tap", async () => {
    const id = await w.campaign({ followCheck: true });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, open(id));
    expect(toFan()).toEqual([
      {
        kind: "buttons",
        text: "Almost there, Invented Fan! Follow me first, then tap the button and I'll send it over.",
        buttons: [{ type: "postback", title: "I'm following", payload: follow(id) }],
      },
    ]);
    expect(await conversation()).toMatchObject({ state: "awaiting_follow", follows: 0, follow_asked: 1 });

    w.meta.followers.add(FAN.id);
    await w.tap(FAN.id, follow(id));
    expect(toFan()).toHaveLength(2);
    expect(toFan()[1]).toMatchObject({ kind: "buttons", buttons: [{ type: "web_url", url: "https://example.com/library" }] });
    expect(await conversation()).toMatchObject({ state: "done", follows: 1, follow_asked: 1 });
    expect(await followLog()).toEqual(["received: not following", "received: follows"]);
  });

  it("asks once more, then sends the link anyway, and ignores later taps", async () => {
    const id = await w.campaign({ followCheck: true });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, open(id));
    await w.tap(FAN.id, follow(id));
    expect(toFan()[1]).toMatchObject({ kind: "buttons", text: expect.stringContaining("can't see your follow yet"), buttons: [{ payload: follow(id) }] });
    expect(await conversation()).toMatchObject({ state: "follow_reasked", follow_asked: 2 });
    await w.tap(FAN.id, follow(id));
    expect(toFan()).toHaveLength(3);
    expect(toFan()[2]).toMatchObject({ buttons: [{ type: "web_url" }] });
    expect(await conversation()).toMatchObject({ state: "done", follows: 0, follow_asked: 2 });
    expect((await w.activity()).filter((a) => a.kind === "link").map((a) => a.reason)).toEqual(["link without a follow"]);

    await w.tap(FAN.id, follow(id));
    await w.tap(FAN.id, open(id));
    expect(toFan()).toHaveLength(3);
  });

  it("takes a typed reply as the tap, on either button", async () => {
    const id = await w.campaign({ followCheck: true });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendDm(FAN.id, "hi!");
    expect(await conversation()).toMatchObject({ state: "awaiting_follow" });
    w.meta.followers.add(FAN.id);
    await w.sendDm(FAN.id, "done, followed");
    expect(toFan()).toHaveLength(2);
    expect(await conversation()).toMatchObject({ state: "done", follows: 1 });
    expect(id).toBeGreaterThan(0);
  });

  it("sends the link when Meta's check fails, so our error never blocks anyone", async () => {
    const id = await w.campaign({ followCheck: true });
    await w.sendComment(w.comment("agents", FAN));
    w.meta.failNext("getFollowStatus", new MetaError("An unknown error has occurred.", 500, 1));
    await w.tap(FAN.id, open(id));
    expect(toFan()).toEqual([expect.objectContaining({ buttons: [expect.objectContaining({ type: "web_url" })] })]);
    expect(await conversation()).toMatchObject({ state: "done", follows: null, follow_asked: 0 });
    expect((await w.activity()).find((a) => a.kind === "follow")).toMatchObject({ outcome: "failed" });
    expect((await w.activity()).find((a) => a.kind === "link")).toMatchObject({ reason: "follow check failed" });
  });

  it("comes before the email question in email-first mode", async () => {
    const id = await w.campaign({ followCheck: true, emailMode: "first" });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, open(id));
    expect(toFan()[0]).toMatchObject({ text: expect.stringContaining("Follow me first") });
    w.meta.followers.add(FAN.id);
    await w.tap(FAN.id, follow(id));
    expect(toFan()[1]).toMatchObject({ kind: "text", text: expect.stringContaining("What's your email?") });
    await w.sendDm(FAN.id, "invented.fan@example.com");
    expect(toFan()[2]).toMatchObject({ kind: "buttons", buttons: [{ type: "web_url" }] });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toEqual({ n: 1 });
  });

  it("never checks on a campaign without it", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, open(id));
    expect(w.meta.calls).not.toContain("getFollowStatus");
    expect(toFan()).toHaveLength(1);
  });

  it("checks a DM keyword at once, since the person wrote first", async () => {
    const id = await w.campaign({ followCheck: true, dmKeyword: true });
    w.meta.personActed(FAN2.id, w.clock.now());
    w.meta.followers.add(FAN2.id);
    await w.sendDm(FAN2.id, "agents");
    expect(w.meta.sentTo(FAN2.id)[0]!.message).toMatchObject({ buttons: [{ type: "web_url" }] });

    await w.sendDm(FAN.id, "agents");
    expect(toFan()[0]).toMatchObject({ text: expect.stringContaining("Follow me first"), buttons: [{ payload: follow(id) }] });
    expect(await conversation()).toMatchObject({ state: "awaiting_follow", follows: 0, follow_asked: 1 });
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(0);
  });

  it("counts who already followed, who was asked, and who followed after the ask", async () => {
    const id = await w.campaign({ followCheck: true });
    w.meta.followers.add(FAN2.id);
    await w.sendComment(w.comment("agents", FAN2));
    await w.tap(FAN2.id, open(id));
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, open(id));
    w.meta.followers.add(FAN.id);
    await w.tap(FAN.id, follow(id));
    const results = await campaignResults(await w.ctx(), { id, mediaId: REEL });
    expect(results.fromComments).toMatchObject({ dmsSent: 2, opened: 2, alreadyFollowed: 1, askedToFollow: 1, followedAfterAsk: 1, links: 2 });
  });
});

describe("follow check in the form", () => {
  const form = (cookie: string, data: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data),
  });
  const base = { name: "Follow", keywords: "FOLLOW", media_id: "all", link_text: "Here:", link_url_0: "https://example.com/f", link_label_0: "Open", active: "on" };

  it("needs the opening button, and saves its texts", async () => {
    const cookie = await w.signIn();
    const noButton = await w.fetch("/dashboard/campaigns/new", form(cookie, { ...base, follow_check: "on", follow_prompt: "Follow me", follow_reask: "Again", follow_button: "Done" }));
    expect(await noButton.text()).toContain("The follow check needs the first DM&#39;s button");
    const ok = await w.fetch(
      "/dashboard/campaigns/new",
      form(cookie, { ...base, opening_text: "Tap", opening_button: "Send it", follow_check: "on", follow_prompt: "Follow me, {name}", follow_reask: "Not yet", follow_button: "Done" }),
    );
    expect(ok.status).toBe(303);
    expect(await env.DB.prepare("SELECT follow_check, follow_prompt, follow_reask, follow_button FROM campaigns").first()).toEqual({
      follow_check: 1,
      follow_prompt: "Follow me, {name}",
      follow_reask: "Not yet",
      follow_button: "Done",
    });
  });

  it("starts new campaigns with it off and the default wording filled in", async () => {
    const cookie = await w.signIn();
    const page = await (await w.fetch("/dashboard/campaigns/new", { headers: { cookie } })).text();
    expect(page).toContain('name="follow_check"');
    expect(page).not.toMatch(/name="follow_check" checked/);
    expect(page).toContain("Follow me first, then tap the button");
  });
});
