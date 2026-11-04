import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { OPEN_PAYLOAD_PREFIX } from "../src/campaigns";
import { MetaError } from "../src/meta/client";
import { DAY, HOUR, MINUTE, PRIVATE_REPLIES_PER_HOUR } from "../src/time";
import { FAN, FAN2, OTHER_POST, OWNER, REEL, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

describe("one private reply per comment", () => {
  it("answers a keyword comment with one DM and one public reply", async () => {
    await w.campaign();
    const c = w.comment("I want the AGENTS library please", FAN);
    const res = await w.sendComment(c);
    expect(res.status).toBe(200);
    const sent = w.meta.sent;
    expect(sent.map((s) => s.kind)).toEqual(["private_reply", "public_reply"]);
    expect(sent[0]!.to).toBe(c.id);
    expect(sent[0]!.message).toMatchObject({ kind: "buttons", buttons: [{ type: "postback", payload: expect.stringMatching(new RegExp(`^${OPEN_PAYLOAD_PREFIX}`)) }] });
  });

  it("handles a comment once when it arrives by webhook and again by poll", async () => {
    await w.campaign();
    const c = w.comment("agents", FAN);
    await w.sendComment(c);
    await w.sendComment(c); // Meta retries webhooks
    await w.cron(); // the poll sees it too
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
  });

  it("never sends a second private reply after a crash between sending and recording", async () => {
    await w.campaign();
    const c = w.comment("agents", FAN);
    await w.sendComment(c);
    // Pretend the row was left mid-way: OwnChats must not try again blindly.
    await env.DB.prepare("UPDATE comments SET status = 'processing', locked_at = 0 WHERE id = ?").bind(c.id).run();
    await w.cron();
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
  });

  it("does not post the public reply when the DM failed", async () => {
    await w.campaign();
    w.meta.failNext("sendPrivateReply", new MetaError("(#200) The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.", 403, 200));
    await w.sendComment(w.comment("agents", FAN));
    expect(w.meta.sent).toHaveLength(0);
    const log = await w.activity();
    expect(log.at(-1)).toMatchObject({ kind: "private_reply", outcome: "failed", reason: expect.stringContaining("Allow access to messages") });
  });

  it("retries a comment later when Meta is rate limiting, and releases the person", async () => {
    await w.campaign();
    w.meta.failNext("sendPrivateReply", new MetaError("Application request limit reached", 400, 4));
    const c = w.comment("agents", FAN);
    await w.sendComment(c);
    expect(w.meta.sent).toHaveLength(0);
    w.clock.advance(MINUTE);
    await w.cron();
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
  });

  it("falls back to plain text when Meta refuses the button template", async () => {
    await w.campaign({ emailMode: "first" });
    w.meta.failNext("sendPrivateReply", new MetaError("Invalid parameter", 400, 100));
    await w.sendComment(w.comment("agents", FAN));
    const dm = w.meta.sent.find((s) => s.kind === "private_reply")!;
    expect(dm.message).toMatchObject({ kind: "text", text: expect.stringContaining("email") });
    // The conversation now waits for the email.
    await w.sendDm(FAN.id, "fan@example.com");
    expect(await env.DB.prepare("SELECT email FROM leads").first()).toMatchObject({ email: "fan@example.com" });
  });
});

describe("7-day window", () => {
  it("skips a comment older than 7 days without calling Meta", async () => {
    // The campaign has to be older than the comment for the 7-day rule to be the reason.
    await w.campaign();
    await env.DB.prepare("UPDATE campaigns SET created_at = ?").bind(w.clock.now() - 30 * DAY).run();
    const c = w.comment("agents", FAN, { ago: 7 * DAY + MINUTE });
    await w.sendComment(c);
    expect(w.meta.calls).not.toContain("sendPrivateReply");
    expect((await w.activity()).at(-1)).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("7 days") });
  });

  it("drops a queued comment that waited past the 7-day window", async () => {
    await w.campaign();
    await env.DB.prepare("UPDATE campaigns SET created_at = ?").bind(w.clock.now() - 30 * DAY).run();
    w.meta.failNext("sendPrivateReply", new MetaError("Service temporarily unavailable", 503, 2));
    await w.sendComment(w.comment("agents", FAN, { ago: 7 * DAY - HOUR }));
    w.clock.advance(2 * HOUR);
    await w.cron();
    expect(w.meta.sent).toHaveLength(0);
    expect((await w.activity()).at(-1)).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("7 days") });
  });

  it("ignores comments written before the campaign started", async () => {
    await w.campaign();
    await w.sendComment(w.comment("agents", FAN, { ago: 2 * HOUR }));
    expect(w.meta.calls).not.toContain("sendPrivateReply");
  });
});

describe("follow-ups only within 24 hours of the person's reply", () => {
  it("sends nothing after the private reply until the person taps or writes", async () => {
    await w.campaign({ emailMode: "first" });
    await w.sendComment(w.comment("agents", FAN));
    for (let i = 0; i < 5; i++) {
      w.clock.advance(HOUR);
      await w.cron();
    }
    expect(w.meta.calls.filter((c) => c === "sendMessage")).toHaveLength(0);
  });

  it("runs the whole email flow: tap, ask, email saved with consent, link", async () => {
    const id = await w.campaign({ emailMode: "first" });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    await w.sendDm(FAN.id, "sure! it's Invented.Fan@Example.com.");
    const toFan = w.meta.sentTo(FAN.id);
    expect(toFan.map((s) => (s.message as { kind: string }).kind)).toEqual(["text", "buttons"]);
    expect(toFan[1]!.message).toMatchObject({ buttons: [{ type: "web_url", url: "https://example.com/library" }] });
    const lead = await env.DB.prepare("SELECT * FROM leads").first<{ email: string; consent_text: string; consented_at: number; username: string }>();
    expect(lead).toMatchObject({ email: "invented.fan@example.com", username: FAN.username, consented_at: w.clock.now() });
    expect(lead!.consent_text).toContain("newsletter");
  });

  it("re-asks once, then sends the link anyway", async () => {
    const id = await w.campaign({ emailMode: "first" });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    await w.sendDm(FAN.id, "what?");
    await w.sendDm(FAN.id, "no thanks");
    const kinds = w.meta.sentTo(FAN.id).map((s) => s.message);
    expect(kinds).toHaveLength(3);
    expect(kinds[1]).toMatchObject({ kind: "text", text: expect.stringContaining("doesn't look like an email") });
    expect(kinds[2]).toMatchObject({ kind: "buttons" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toMatchObject({ n: 0 });
    // Done means done: more messages get nothing.
    await w.sendDm(FAN.id, "hello?");
    expect(w.meta.sentTo(FAN.id)).toHaveLength(3);
  });

  it("does not answer an event that is more than 24 hours old", async () => {
    const id = await w.campaign({ emailMode: "first" });
    await w.sendComment(w.comment("agents", FAN));
    // A tap from 25 hours ago, delivered late (Meta retries webhooks for up to 36 hours).
    const late = w.clock.now();
    w.clock.advance(25 * HOUR);
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`, late);
    expect(w.meta.calls).not.toContain("sendMessage");
    expect((await w.activity()).at(-1)).toMatchObject({ kind: "message", outcome: "skipped", reason: expect.stringContaining("24-hour") });
  });

  it("answers the tap through the messaging id Meta returned, even if it differs from the comment's", async () => {
    const id = await w.campaign();
    w.meta.messagingIds.set(FAN.id, "IGSID_FOR_FAN");
    await w.sendComment(w.comment("agents", FAN));
    await w.tap("IGSID_FOR_FAN", `${OPEN_PAYLOAD_PREFIX}${id}`);
    expect(w.meta.sentTo("IGSID_FOR_FAN")).toHaveLength(1);
    // And a second comment from the same person is still recognised.
    await w.sendComment(w.comment("agents again", FAN));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
  });
});

describe("own comments ignored", () => {
  it("ignores the account owner's comments and OwnChats' own public replies", async () => {
    await w.campaign();
    await w.sendComment(w.comment("AGENTS test from my own account", OWNER));
    await w.sendComment(w.comment("Sent! Check your DMs", OWNER, { parentId: "17900000000000999" }));
    expect(w.meta.calls).not.toContain("sendPrivateReply");
    const log = await w.activity();
    expect(log).toHaveLength(1); // the reply is not worth a line
    expect(log[0]).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("own comment") });
  });

  it("ignores echoes of OwnChats' own DMs", async () => {
    const id = await w.campaign({ emailMode: "first" });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    const before = w.meta.sent.length;
    await w.webhook({
      object: "instagram",
      entry: [{ id: OWNER.id, messaging: [{ sender: { id: OWNER.id }, recipient: { id: FAN.id }, timestamp: w.clock.now(), message: { mid: "mid.echo.1", text: "x@example.com", is_echo: true } }] }],
    });
    expect(w.meta.sent.length).toBe(before);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toMatchObject({ n: 0 });
  });
});

describe("one DM per person per campaign", () => {
  it("sends one DM however many times someone comments", async () => {
    await w.campaign();
    for (let i = 0; i < 3; i++) await w.sendComment(w.comment(`AGENTS ${i}`, FAN));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
    expect(w.meta.sent.filter((s) => s.kind === "public_reply")).toHaveLength(1);
    expect((await w.activity()).filter((a) => a.reason?.includes("already got"))).toHaveLength(2);
  });

  it("still answers other people, and the same person on another campaign", async () => {
    await w.campaign();
    await w.campaign({ name: "Prompts", keywords: ["PROMPTS"], mediaId: OTHER_POST });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendComment(w.comment("agents", FAN2));
    await w.sendComment(w.comment("prompts", FAN, { media: OTHER_POST }));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(3);
  });

  it("a DM keyword after the comment flow resends the link instead of starting over", async () => {
    await w.campaign({ openingButton: "" });
    await w.sendComment(w.comment("agents", FAN));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
    await w.sendDm(FAN.id, "AGENTS");
    expect(w.meta.sentTo(FAN.id)).toHaveLength(1);
    expect((await w.activity()).at(-1)).toMatchObject({ kind: "link", reason: "link sent again on request" });
  });
});

describe("matching", () => {
  it("matches case-insensitively, whole word, with extra spellings", async () => {
    await w.campaign();
    const people = Array.from({ length: 5 }, (_, i) => ({ id: `90000000000010${i}`, username: `fan_${i}` }));
    await w.sendComment(w.comment("Agents!", people[0]!));
    await w.sendComment(w.comment("agent pls", people[1]!));
    await w.sendComment(w.comment("#AGENTS", people[2]!));
    await w.sendComment(w.comment("agentsmith", people[3]!));
    await w.sendComment(w.comment("great reel", people[4]!));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(3);
  });

  it("all-posts campaigns answer any post; a one-post campaign wins on its post", async () => {
    const all = await w.campaign({ name: "Everywhere", mediaId: null });
    const one = await w.campaign({ name: "This reel", openingButton: "Reel only" });
    await w.sendComment(w.comment("agents", FAN, { media: OTHER_POST }));
    await w.sendComment(w.comment("agents", FAN2, { media: REEL }));
    const convs = await env.DB.prepare("SELECT campaign_id, ig_user_id FROM conversations ORDER BY id").all();
    expect(convs.results).toEqual([
      { campaign_id: all, ig_user_id: FAN.id },
      { campaign_id: one, ig_user_id: FAN2.id },
    ]);
  });

  it("any-comment mode answers every comment on its post", async () => {
    await w.campaign({ anyComment: true, keywords: [] });
    await w.sendComment(w.comment("love this", FAN));
    await w.sendComment(w.comment("nice", FAN2, { media: OTHER_POST }));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply").map((s) => s.to)).toHaveLength(1);
  });

  it("picks public reply variants at random, never the same one twice in a row", async () => {
    await w.campaign({ publicReplies: ["one", "two", "three"] });
    const people = Array.from({ length: 8 }, (_, i) => ({ id: `90000000000020${i}`, username: `fan_${i}` }));
    for (const p of people) await w.sendComment(w.comment("agents", p));
    const replies = w.meta.sent.filter((s) => s.kind === "public_reply").map((s) => s.message);
    expect(replies).toHaveLength(8);
    expect(new Set(replies).size).toBeGreaterThan(1);
    replies.forEach((r, i) => i && expect(r, `reply ${i}`).not.toBe(replies[i - 1]));
  });
});

describe("DM keyword", () => {
  it("starts the flow from a DM, without the button and without a private reply", async () => {
    await w.campaign({ emailMode: "first" });
    w.meta.usernames.set(FAN.id, FAN.username);
    await w.sendDm(FAN.id, "hi, AGENTS please");
    expect(w.meta.calls).not.toContain("sendPrivateReply");
    expect(w.meta.sentTo(FAN.id)[0]!.message).toMatchObject({ kind: "text", text: expect.stringContaining("email") });
    await w.sendDm(FAN.id, "fan@example.com");
    expect(await env.DB.prepare("SELECT username FROM leads").first()).toMatchObject({ username: FAN.username });
  });

  it("ignores ordinary DMs", async () => {
    await w.campaign();
    await w.sendDm(FAN.id, "love your content");
    expect(w.meta.calls.filter((c) => c.startsWith("send"))).toHaveLength(0);
    expect(await w.activity()).toHaveLength(0);
  });
});

describe("750 private replies an hour", () => {
  it("queues comments over the hourly cap and sends them when the hour frees up", async () => {
    await w.campaign();
    const at = w.clock.now() - 10 * MINUTE;
    const rows = Array.from({ length: PRIVATE_REPLIES_PER_HOUR }, () =>
      env.DB.prepare("INSERT INTO activity (at, kind, outcome) VALUES (?, 'private_reply', 'sent')").bind(at),
    );
    for (let i = 0; i < rows.length; i += 100) await env.DB.batch(rows.slice(i, i + 100));
    await w.sendComment(w.comment("agents", FAN));
    expect(w.meta.calls).not.toContain("sendPrivateReply");
    expect((await w.activity()).at(-1)).toMatchObject({ outcome: "queued" });
    w.clock.advance(51 * MINUTE);
    await w.cron();
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
  });
});

describe("polling", () => {
  it("finds comments the webhook missed on watched posts, and skips the rest quietly", async () => {
    await w.campaign();
    w.comment("agents", FAN);
    w.comment("nice", FAN2);
    w.comment("agents", { id: "900000000000003", username: "old_fan" }, { ago: 8 * DAY });
    await w.cron();
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
    const log = await w.activity();
    expect(log.filter((l) => l.kind === "comment")).toHaveLength(1); // "nice": no matching campaign; the 8-day-old one is not logged
  });

  it("polls recent posts for all-posts campaigns", async () => {
    await w.campaign({ mediaId: null });
    w.meta.media = [{ id: OTHER_POST, caption: "invented caption", permalink: "", timestamp: w.clock.now(), mediaType: "REELS" }];
    w.comment("agents", FAN, { media: OTHER_POST });
    await w.cron();
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
  });

  it("stays inside the free plan's per-run budget on a busy post", async () => {
    await w.campaign();
    for (let i = 0; i < 50; i++) w.comment("agents", { id: `91000000000${String(i).padStart(4, "0")}`, username: `busy_${i}` });
    await w.cron();
    const first = w.meta.sent.filter((s) => s.kind === "private_reply").length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(50);
    for (let i = 0; i < 10; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(50);
  });
});

describe("email modes", () => {
  it("link only: the tap sends the link, and nothing asks for an email", async () => {
    const id = await w.campaign({ emailMode: "none" });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    const [link] = w.meta.sentTo(FAN.id);
    expect(link!.message).toMatchObject({ kind: "buttons", text: "Here you go:" });
    await w.sendDm(FAN.id, "fan@example.com");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toMatchObject({ n: 0 });
  });

  it("link plus optional email: link and the email line at once, an email reply is saved and thanked", async () => {
    const id = await w.campaign({ emailMode: "optional", consentText: "Newsletter from test_creator" });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    const [link] = w.meta.sentTo(FAN.id);
    expect(link!.message).toMatchObject({ kind: "buttons", text: expect.stringContaining("Reply with your email") });
    expect(link!.message).toMatchObject({ buttons: [{ type: "web_url", url: "https://example.com/library" }] });
    await w.sendDm(FAN.id, "ok here: fan@example.com");
    expect(await env.DB.prepare("SELECT email, consent_text FROM leads").first()).toEqual({ email: "fan@example.com", consent_text: "Newsletter from test_creator" });
    expect(w.meta.sentTo(FAN.id)[1]!.message).toEqual({ kind: "text", text: "Thanks, you're on the list!" });
  });

  it("link plus optional email: other replies get no re-ask, and silence is fine", async () => {
    const id = await w.campaign({ emailMode: "optional" });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    await w.sendDm(FAN.id, "thanks!");
    w.clock.advance(3 * HOUR);
    await w.cron();
    expect(w.meta.sentTo(FAN.id)).toHaveLength(1);
    // The link counts as sent even though the conversation stays open for an email.
    const counts = await env.DB.prepare("SELECT state FROM conversations").first();
    expect(counts).toEqual({ state: "optional_email" });
  });

  it("link plus optional email without the button puts both in the first DM", async () => {
    await w.campaign({ emailMode: "optional", openingButton: "", links: [{ label: "", url: "https://example.com/library" }] });
    await w.sendComment(w.comment("agents", FAN));
    const dm = w.meta.sent.find((s) => s.kind === "private_reply")!;
    expect(dm.message).toEqual({
      kind: "text",
      text: `Here you go:\n\n${"Want more like this? Reply with your email and I'll add you to my newsletter. You can unsubscribe anytime."}\nhttps://example.com/library`,
    });
  });

  it("a keyword for another campaign still works while an optional email is pending", async () => {
    const a = await w.campaign({ emailMode: "optional" });
    await w.campaign({ name: "Prompts", keywords: ["PROMPTS"], mediaId: OTHER_POST, openingButton: "", links: [{ label: "Get it", url: "https://example.com/prompts" }] });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${a}`);
    await w.sendDm(FAN.id, "PROMPTS please");
    expect(w.meta.sentTo(FAN.id).at(-1)!.message).toMatchObject({ buttons: [{ url: "https://example.com/prompts" }] });
  });

  it("email first: the thank-you text goes with the link, and the consent defaults to the question", async () => {
    const id = await w.campaign({ emailMode: "first", emailThanks: "Thanks {name}! Here it is:" });
    w.meta.names.set(FAN.id, "Invented Fan");
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    await w.sendDm(FAN.id, "fan@example.com");
    expect(w.meta.sentTo(FAN.id)[1]!.message).toMatchObject({ kind: "buttons", text: "Thanks Invented Fan! Here it is:" });
    const lead = await env.DB.prepare("SELECT consent_text FROM leads").first<{ consent_text: string }>();
    expect(lead!.consent_text).toContain("What's your email?");
  });
});

describe("editable texts", () => {
  it("fills {name} and {username}, falling back to the username, then to 'there'", async () => {
    const id = await w.campaign({ openingText: "Hey {name}, hi @{username}!", publicReplies: ["Sent, {username}!"], linkText: "For you, {name}:" });
    await w.sendComment(w.comment("agents", FAN));
    // Before they interact, OwnChats only knows the username from the comment.
    expect(w.meta.sent[0]!.message).toMatchObject({ text: `Hey ${FAN.username}, hi @${FAN.username}!` });
    expect(w.meta.sent[1]!.message).toBe(`Sent, ${FAN.username}!`);
    // After the tap Meta shares their name, asked for once.
    w.meta.names.set(FAN.id, "Invented Fan");
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    expect(w.meta.sentTo(FAN.id)[0]!.message).toMatchObject({ text: "For you, Invented Fan:" });
    expect(w.meta.calls.filter((c) => c === "getProfile")).toHaveLength(1);
    const { fill } = await import("../src/campaigns");
    expect(fill("Hey {name}!", { name: "Invented Fan", username: "x" })).toBe("Hey Invented Fan!");
    expect(fill("Hey {name}!", {})).toBe("Hey there!");
  });

  it("sends up to three links as buttons, or in the text when they have no labels", async () => {
    const id = await w.campaign({
      links: [
        { label: "Library", url: "https://example.com/1" },
        { label: "Bonus", url: "https://example.com/2" },
      ],
    });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    expect(w.meta.sentTo(FAN.id)[0]!.message).toMatchObject({
      kind: "buttons",
      buttons: [
        { title: "Library", url: "https://example.com/1" },
        { title: "Bonus", url: "https://example.com/2" },
      ],
    });
    const plain = await w.campaign({ name: "Plain", keywords: ["PLAIN"], openingButton: "", links: [{ label: "", url: "https://example.com/a" }, { label: "", url: "https://example.com/b" }] });
    await w.sendComment(w.comment("plain", FAN2));
    expect(w.meta.sent.find((s) => s.kind === "private_reply" && s.to !== w.meta.sent[0]!.to)!.message).toEqual({
      kind: "text",
      text: "Here you go:\nhttps://example.com/a\nhttps://example.com/b",
    });
    expect(plain).toBeGreaterThan(id);
  });
});
