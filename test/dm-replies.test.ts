import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, OPEN_PAYLOAD_PREFIX } from "../src/campaigns";
import type { OutMessage } from "../src/meta/client";
import { saysExactly } from "../src/match";
import { HOUR, MINUTE } from "../src/time";
import { FAN, OTHER_POST, OWNER, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

const toFan = () => w.meta.sentTo(FAN.id).map((s) => s.message as OutMessage);
const links = async () => (await w.activity()).filter((a) => a.kind === "link" && a.outcome === "sent").map((a) => a.reason);

/** A shared Reel, as Instagram sends it: an attachment and no text. */
async function shareReel(senderId: string) {
  w.meta.personActed(senderId, w.clock.now());
  return w.webhook({
    object: "instagram",
    entry: [
      {
        id: OWNER.id,
        time: w.clock.now(),
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: OWNER.id },
            timestamp: w.clock.now(),
            message: { mid: `mid.share.${w.clock.now()}`, attachments: [{ type: "ig_reel", payload: { reel_video_id: "1" } }] },
          },
        ],
      },
    ],
  });
}

describe("a DM written instead of tapping", () => {
  it("counts as the tap when it comes within an hour of the button", async () => {
    await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    w.clock.advance(50 * MINUTE);
    await w.sendDm(FAN.id, "yes please");
    expect(await links()).toEqual(["reply instead of tap"]);
  });

  it("is an ordinary DM after the hour, so someone who writes about something else gets nothing", async () => {
    await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    w.clock.advance(3 * HOUR);
    await w.sendDm(FAN.id, "hi, saw this and thought of you");
    expect(toFan()).toHaveLength(0);
    expect(await links()).toEqual([]);
    expect((await w.activity()).find((a) => a.kind === "tap")).toMatchObject({ outcome: "skipped", reason: "a DM that doesn't answer the button" });
  });

  it("still counts after the hour when it is the button's words, or the keyword", async () => {
    await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    w.clock.advance(2 * 24 * HOUR);
    await w.sendDm(FAN.id, "can you send me the link");
    expect(await links()).toEqual([]);
    await w.sendDm(FAN.id, "Send me the link!");
    expect(await links()).toEqual(["reply instead of tap"]);
  });

  it("takes the campaign keyword the same way", async () => {
    await w.campaign({ dmKeyword: false });
    await w.sendComment(w.comment("agents", FAN));
    w.clock.advance(5 * HOUR);
    await w.sendDm(FAN.id, "AGENTS 🙏");
    expect(await links()).toEqual(["reply instead of tap"]);
  });

  it("never counts a shared Reel or photo, even right after the button", async () => {
    await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    await shareReel(FAN.id);
    expect(toFan()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT state FROM conversations").first()).toEqual({ state: "opened" });
  });

  it("follows the same rule on the follow button", async () => {
    const id = await w.campaign({ followCheck: true });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    expect(await env.DB.prepare("SELECT state FROM conversations").first()).toEqual({ state: "awaiting_follow" });
    w.meta.followers.add(FAN.id);
    w.clock.advance(2 * HOUR);
    await w.sendDm(FAN.id, "random question about your mic");
    expect(await links()).toEqual([]);
    await w.sendDm(FAN.id, "I'm following");
    expect(await links()).toEqual(["reply instead of tap"]);
  });
});

describe("whole-message phrases", () => {
  it("ignore case, punctuation and emoji, but not extra words", () => {
    expect(saysExactly("Send me the link!", ["Send me the link"])).toBe(true);
    expect(saysExactly("send me the link 🙏", ["Send me the link"])).toBe(true);
    expect(saysExactly("Im following", ["I'm following"])).toBe(true);
    expect(saysExactly("please send me the link", ["Send me the link"])).toBe(false);
    expect(saysExactly("skills", ["SKILL", "SKILLS"])).toBe(true);
    expect(saysExactly("🙌", ["🙌"])).toBe(true);
    expect(saysExactly("🙌🏼 wow", ["🙌"])).toBe(false);
    expect(saysExactly("", ["🙌"])).toBe(false);
  });
});

describe("the guide's title", () => {
  it("goes on its own line under the link message", async () => {
    await w.campaign({ linkTitle: "Run many agents at once" });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendDm(FAN.id, "Send me the link");
    expect(toFan()[0]).toMatchObject({ kind: "buttons", text: `${DEFAULTS.linkText}\nRun many agents at once` });
  });

  it("is left out with several links, and when there is none", async () => {
    await w.campaign({
      linkTitle: "Run many agents at once",
      links: [
        { label: "Guide", url: "https://example.com/a" },
        { label: "Template", url: "https://example.com/b" },
      ],
    });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendDm(FAN.id, "Send me the link");
    expect((toFan()[0] as { text: string }).text).not.toContain("Run many agents at once");
  });
});

describe("the optional email ask", () => {
  it("goes once when two guides are opened back to back, and the email answers both", async () => {
    await w.lead_webhook();
    const first = await w.campaign({ emailMode: "optional", linkTitle: "First guide", links: [{ label: "Open the guide", url: "https://example.com/first" }] });
    const second = await w.campaign({ emailMode: "optional", keywords: ["BOOKS"], mediaId: OTHER_POST, linkTitle: "Second guide", links: [{ label: "Open the guide", url: "https://example.com/second" }] });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendComment(w.comment("books", FAN, { media: OTHER_POST }));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${first}`);
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${second}`);
    w.clock.advance(5_000);
    await openNth(0);
    w.clock.advance(5_000);
    await openNth(1);
    const asks = toFan().filter((m) => m.kind === "text" && m.text.includes("email"));
    expect(asks).toHaveLength(1);
    expect((await w.activity()).find((a) => a.reason === "email ask already waiting from another campaign")).toBeTruthy();

    await w.sendDm(FAN.id, "invented.fan@example.com");
    const leads = await env.DB.prepare("SELECT campaign_id FROM leads ORDER BY campaign_id").all<{ campaign_id: number }>();
    expect(leads.results.map((r) => r.campaign_id)).toEqual([first, second]);
  });

  it("is asked again for a later guide once the person wrote since", async () => {
    const first = await w.campaign({ emailMode: "optional" });
    const second = await w.campaign({ emailMode: "optional", keywords: ["BOOKS"], mediaId: OTHER_POST });
    await w.sendComment(w.comment("agents", FAN));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${first}`);
    await openNth(0);
    w.clock.advance(MINUTE);
    await w.sendComment(w.comment("books", FAN, { media: OTHER_POST }));
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${second}`);
    await openNth(1);
    expect(toFan().filter((m) => m.kind === "text" && m.text.includes("email"))).toHaveLength(2);
  });
});

/** Opens the link in the n-th link message the fan got (0-based). */
async function openNth(n: number) {
  const urls = toFan()
    .flatMap((m) => (m.kind === "buttons" ? m.buttons.flatMap((b) => (b.type === "web_url" ? [b.url] : [])) : []))
    .filter((u) => u.includes("/go/"));
  const url = urls[n];
  if (!url) throw new Error(`no link ${n}`);
  await w.fetch(new URL(url).pathname, {
    headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.27.92" },
    redirect: "manual",
  });
}
