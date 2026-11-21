import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { OPEN_PAYLOAD_PREFIX } from "../src/campaigns";
import { MetaError } from "../src/meta/client";
import { DAY, MINUTE } from "../src/time";
import { BASE, FAN, FAN2, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

// Invented people.
const FAN3 = { id: "900000000000003", username: "third_invented_fan" };
const FAN4 = { id: "900000000000004", username: "fourth_invented_fan" };
const OUTAGE = () => new MetaError("Service temporarily unavailable", 503, 2);
const form = (cookie: string, path: string, data: Record<string, string>) =>
  w.fetch(path, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) });

async function apiCounts(cookie: string): Promise<Record<string, unknown>> {
  const tokenPage = await (await form(cookie, "/dashboard/settings/api-token", { do: "new" })).text();
  const token = tokenPage.match(/oc_[A-Za-z0-9_-]+/)![0];
  const api = (await (await w.fetch("/api/campaigns", { headers: { authorization: `Bearer ${token}` } })).json()) as { campaigns: Array<{ counts: Record<string, unknown> }> };
  return api.campaigns[0]!.counts;
}

describe("people, not attempts", () => {
  it("counts each refused person once: got it on a retry, answered by hand, or waiting", async () => {
    const id = await w.campaign();
    const cookie = await w.signIn();
    // FAN: refused, then the Cron's retry goes through.
    w.meta.failNext("sendPrivateReply", OUTAGE());
    await w.sendComment(w.comment("agents", FAN));
    // FAN2: refused, then answered by hand.
    w.meta.failNext("sendPrivateReply", OUTAGE());
    const c2 = w.comment("agents", FAN2);
    await w.sendComment(c2);
    await form(cookie, `/dashboard/campaigns/${id}/by-hand`, { type: "comment", id: c2.id });
    // FAN3: tapped, the link refused every time: still waiting.
    await w.sendComment(w.comment("agents", FAN3));
    for (let i = 0; i < 20; i++) w.meta.failNext("sendMessage", OUTAGE());
    await w.tap(FAN3.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    // FAN4: answered at once.
    await w.sendComment(w.comment("agents", FAN4));
    for (let i = 0; i < 40; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }

    const counts = await apiCounts(cookie);
    expect(counts).toMatchObject({
      asked: 4,
      answeredAutomatically: 3,
      answeredByHand: 1,
      tapped: 1,
      waitingOnYou: 1,
      refused: { people: 3, recovered: 1, answeredByHand: 1, waiting: 1, unreached: 0 },
    });
    // The attempts are still there, for diagnosis.
    expect(Number(counts.failedDms)).toBeGreaterThan(3);

    const card = await (await w.fetch("/dashboard", { headers: { cookie } })).text();
    expect(card).toContain("<b>4</b>asked");
    expect(card).toContain("<b>4</b>answered <span class=\"muted\">(1 by hand)</span>");
    expect(card).toContain("<b>1</b>tapped");
    expect(card).toContain("Waiting on you: 1</a>");
    expect(card).not.toContain("DMs sent");
    expect(card).not.toContain("failed</div>");
    expect(card).toContain("Agents library: 1 person tapped and got nothing");

    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("<b>4 asked</b>: 3 answered by OwnChats, 1 by hand,");
    expect(page).toContain("Instagram refused 3 people at some point: 1 got it on a retry, 1 answered by hand, 1 waiting.");
    expect(page).toContain("What Instagram refused, attempt by attempt (for diagnosis)");
    expect(page).not.toContain("<h2>Comments</h2>");
  });

  it("shows no waiting line on a card when nobody waits", async () => {
    await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    const cookie = await w.signIn();
    const card = await (await w.fetch("/dashboard", { headers: { cookie } })).text();
    expect(card).not.toContain("Waiting on you");
    expect(card).toContain("Nothing needs you right now.");
  });
});

describe("Reply by hand", () => {
  it("marks the person and gives a reply with their own tracked link, whose click counts", async () => {
    const id = await w.campaign();
    for (let i = 0; i < 20; i++) w.meta.failNext("sendPrivateReply", OUTAGE());
    const c = w.comment("agents", FAN);
    await w.sendComment(c);
    const cookie = await w.signIn();
    const res = await form(cookie, `/dashboard/campaigns/${id}/by-hand`, { type: "comment", id: c.id, reply: "1" });
    const location = res.headers.get("location")!;
    expect(location).toMatch(new RegExp(`^/dashboard/campaigns/${id}\\?sent=byhand&reply=\\d+#to-check$`));
    const page = await (await w.fetch(location, { headers: { cookie } })).text();
    expect(page).toContain(`Marked @${FAN.username} as answered by hand. Paste this in your Instagram reply:`);
    const link = page.match(/https:\/\/ownchats\.example\.workers\.dev\/go\/[A-Za-z0-9_-]+/)![0];
    expect(await w.realUrl(link)).toBe("https://example.com/library");
    expect(w.meta.sent).toHaveLength(0);

    // The person opens it from the hand reply: the campaign counts the click.
    await w.fetch(new URL(link).pathname, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Instagram 400.0.0.27.92" }, redirect: "manual" });
    expect(await apiCounts(cookie)).toMatchObject({ clicks: 1, answeredByHand: 1 });
  });

  it("gives no reply for someone not answered by hand", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    const conversationId = (await env.DB.prepare("SELECT id FROM conversations").first<{ id: number }>())!.id;
    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${id}?sent=byhand&reply=${conversationId}`, { headers: { cookie } })).text();
    expect(page).not.toContain("Paste this in your Instagram reply");
    w.clock.advance(DAY);
  });
});
