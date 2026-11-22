import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MetaError } from "../src/meta/client";
import { loadSettings, saveSettings } from "../src/settings";
import { BASE, FAN, FAN2, setupWorld } from "./helpers";

// Everything here is invented: ids, names, comments.
type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

const likesOn = () => saveSettings(env.DB, env.ADMIN_PASSWORD, { like_comments: "on" });
const settings = () => loadSettings(env.DB, env.ADMIN_PASSWORD);
const NO_PERMISSION = () => new MetaError("(#10) Application does not have permission for this action", 403, 10);

describe("liking answered comments", () => {
  it("is off unless the owner turns it on", async () => {
    await w.campaign();
    const c = w.comment("agents", FAN);
    await w.sendComment(c);
    expect(w.meta.liked.size).toBe(0);
    expect(w.meta.calls).not.toContain("likeComment");
  });

  it("likes the comment it answers, once the DM went out", async () => {
    await likesOn();
    await w.campaign();
    const c = w.comment("agents", FAN);
    await w.sendComment(c);
    expect([...w.meta.liked]).toEqual([c.id]);
    const calls = w.meta.calls.filter((m) => m === "sendPrivateReply" || m === "likeComment" || m === "replyToComment");
    expect(calls).toEqual(["sendPrivateReply", "likeComment", "replyToComment"]);
    expect((await w.activity()).find((a) => a.kind === "like")).toMatchObject({ outcome: "sent", comment_id: c.id });
  });

  it("doesn't like a comment it doesn't answer", async () => {
    await likesOn();
    await w.campaign();
    await w.sendComment(w.comment("nice video", FAN));
    expect(w.meta.liked.size).toBe(0);
  });

  it("doesn't like a comment whose DM Meta refused", async () => {
    await likesOn();
    await w.campaign();
    w.meta.failNext("sendPrivateReply", new MetaError("The comment is invalid for a private reply", 400, 100, 2534025));
    await w.sendComment(w.comment("agents", FAN));
    expect(w.meta.liked.size).toBe(0);
  });

  it("still sends the public reply when Meta refuses a private account's comment, and needs nothing from the owner", async () => {
    await likesOn();
    await w.campaign();
    w.meta.privateAccounts.add(FAN.id);
    await w.sendComment(w.comment("agents", FAN));
    expect(w.meta.sent.map((s) => s.kind)).toEqual(["private_reply", "public_reply"]);
    const like = (await w.activity()).find((a) => a.kind === "like")!;
    expect(like.outcome).toBe("failed");
    expect(like.reason).toContain("private");
    expect((await settings()).like_problem).toBeUndefined();
  });

  it("keeps a missing permission for Settings, and clears it once a like works", async () => {
    await likesOn();
    await w.campaign();
    w.meta.failNext("likeComment", NO_PERMISSION());
    await w.sendComment(w.comment("agents", FAN));
    expect(w.meta.sent.map((s) => s.kind)).toEqual(["private_reply", "public_reply"]);
    expect((await w.activity()).find((a) => a.kind === "like")!.reason).toContain("instagram_manage_engagement");
    expect((await settings()).like_problem).toContain("does not have permission");

    const cookie = await w.signIn();
    const page = await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text();
    expect(page).toContain("Meta refused the last like for a missing permission");

    await w.sendComment(w.comment("agents", FAN2));
    expect((await settings()).like_problem).toBeUndefined();
  });

  it("is turned on and off from Settings", async () => {
    const cookie = await w.signIn();
    const post = (value: string) =>
      w.fetch("/dashboard/settings/likes", { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ do: value }), redirect: "manual" });
    await post("on");
    expect((await settings()).like_comments).toBe("on");
    expect(await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text()).toContain("Stop liking comments");
    await post("off");
    expect((await settings()).like_comments).toBeUndefined();
  });
});
