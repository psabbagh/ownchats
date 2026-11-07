import { beforeEach, describe, expect, it } from "vitest";
import { OPEN_PAYLOAD_PREFIX } from "../src/campaigns";
import { MetaError } from "../src/meta/client";
import { campaignResults, listCampaignComments } from "../src/stats";
import { DAY, HOUR } from "../src/time";
import { BASE, FAN, FAN2, OTHER_POST, OWNER, REEL, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

// Invented people.
const FAN3 = { id: "900000000000003", username: "third_invented_fan" };
const FAN4 = { id: "900000000000004", username: "fourth_invented_fan" };

beforeEach(async () => {
  w = await setupWorld();
});

const form = (cookie: string, data: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});

/** A Reel with a bit of everything: two answered, one tap, three skipped, one own reply, one DM keyword. */
async function busyReel(): Promise<number> {
  const id = await w.campaign();
  const first = w.comment("agents please", FAN);
  await w.sendComment(first);
  await w.sendComment(w.comment("AGENT", FAN2));
  await w.tap(FAN2.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
  await w.sendComment(w.comment("agnets <script>x</script>", FAN3));
  await w.sendComment(w.comment("agents again", FAN));
  await w.sendComment(w.comment("agents", FAN4, { ago: 2 * HOUR }));
  await w.sendComment(w.comment("Sent! Check your DMs", OWNER, { parentId: first.id }));
  await w.sendComment(w.comment("agents", FAN3, { media: OTHER_POST }));
  await w.sendDm("900000000000005", "agents");
  return id;
}

describe("campaign results", () => {
  it("count every comment on the Reel, why the skipped ones were skipped, and the funnel from comments and DMs", async () => {
    const id = await busyReel();
    const ctx = await w.ctx();
    const r = await campaignResults(ctx, { id, mediaId: REEL });

    // The own reply and the comment on another post are not this Reel's comments.
    const tally = { total: 5, answered: 2, answeredElsewhere: 0, skipped: 3, failed: 0, waiting: 0 };
    expect(r.day).toEqual(tally);
    expect(r.month).toEqual(tally);
    expect(r.skipReasons).toEqual([
      { reason: "no matching campaign", n: 1 },
      { reason: "this person already got this campaign's DM", n: 1 },
      { reason: "written before the campaign started", n: 1 },
    ]);
    expect(r.fromComments).toEqual({ dmsSent: 2, opened: 1, emails: 0, links: 1, clicks: 0 });
    expect(r.fromDms).toEqual({ dmsSent: 1, opened: 1, emails: 0, links: 1, clicks: 0 });
    expect(r.lastDay).toEqual({ dmsSent: 3, taps: 1, emails: 0, links: 2, clicks: 0 });
    expect(r.failures).toEqual([]);

    // Two days on, the last 24 hours are empty and the 30 days keep everything.
    w.clock.advance(2 * DAY);
    const later = await campaignResults(await w.ctx(), { id, mediaId: REEL });
    expect(later.day.total).toBe(0);
    expect(later.lastDay).toEqual({ dmsSent: 0, taps: 0, emails: 0, links: 0, clicks: 0 });
    expect(later.month).toEqual(tally);
    expect(later.fromComments.dmsSent).toBe(2);
  });

  it("list each comment with how far its DM got, and filter to the skipped ones", async () => {
    const id = await busyReel();
    const ctx = await w.ctx();
    const all = await listCampaignComments(ctx, { id, mediaId: REEL });
    // Newest first; the one written two hours ago comes last.
    expect(all.map((c) => c.text)).toEqual(["agents again", "agnets <script>x</script>", "AGENT", "agents please", "agents"]);
    const byText = new Map(all.map((c) => [c.text, c]));
    expect(byText.get("agents please")).toMatchObject({ status: "done", state: "opened" });
    expect(byText.get("AGENT")).toMatchObject({ status: "done", state: "done" });
    const skipped = await listCampaignComments(ctx, { id, mediaId: REEL }, { show: "skipped" });
    expect(skipped.map((c) => c.status)).toEqual(["skipped", "skipped", "skipped"]);

    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("Last 24 hours");
    expect(page).toContain("no keyword matched");
    expect(page).toContain("DM sent, no tap yet");
    expect(page).toContain("1 (50%)"); // one of the two tapped
    expect(page).toContain("agnets &lt;script&gt;x&lt;/script&gt;");
    expect(page).not.toContain("<script>x</script>");
    expect(page).not.toContain("—");
    const skippedPage = await (await w.fetch(`/dashboard/campaigns/${id}?show=skipped`, { headers: { cookie } })).text();
    expect(skippedPage).toContain("agents again");
    expect(skippedPage).not.toContain("agents please");
  });

  it("count only matched comments for an all-posts campaign", async () => {
    const id = await w.campaign({ mediaId: null, mediaLabel: null });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendComment(w.comment("agents", FAN2, { media: OTHER_POST }));
    await w.sendComment(w.comment("nice video", FAN3));
    const r = await campaignResults(await w.ctx(), { id, mediaId: null });
    expect(r.month).toMatchObject({ total: 2, answered: 2, skipped: 0 });
    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("watches all posts");
    expect(page).not.toContain("nice video");
  });

  it("show a comment another campaign answered on the same Reel", async () => {
    const reel = await w.campaign();
    await w.campaign({ name: "Prompts", keywords: ["PROMPTS"], mediaId: null, mediaLabel: null });
    await w.sendComment(w.comment("prompts", FAN));
    const r = await campaignResults(await w.ctx(), { id: reel, mediaId: REEL });
    expect(r.month).toMatchObject({ total: 1, answered: 0, answeredElsewhere: 1 });
    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${reel}`, { headers: { cookie } })).text();
    expect(page).toContain("by Prompts");
  });

  it("list Meta's refusals", async () => {
    const id = await w.campaign();
    w.meta.failNext("sendPrivateReply", new MetaError("(#200) The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.", 403, 200));
    await w.sendComment(w.comment("agents", FAN));
    const r = await campaignResults(await w.ctx(), { id, mediaId: REEL });
    expect(r.month).toMatchObject({ total: 1, failed: 1 });
    expect(r.failures).toEqual([{ kind: "private_reply", reason: expect.stringContaining("Allow access to messages"), n: 1, last: w.clock.now() }]);
    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("First DM: ");
  });

  it("put the form behind Edit, and come back to the results after saving", async () => {
    const id = await w.campaign();
    const cookie = await w.signIn();
    const results = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(results).toContain(`href="/dashboard/campaigns/${id}/edit"`);
    expect(results).not.toContain('name="opening_text"');
    const edit = await (await w.fetch(`/dashboard/campaigns/${id}/edit`, { headers: { cookie } })).text();
    expect(edit).toContain('name="opening_text"');
    expect(edit).toContain(`action="/dashboard/campaigns/${id}"`);
    const saved = await w.fetch(
      `/dashboard/campaigns/${id}`,
      form(cookie, { name: "Renamed", keywords: "AGENTS", media_id: REEL, link_text: "Here:", link_url_0: "https://example.com/a", link_label_0: "Open", active: "on" }),
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/dashboard/campaigns/${id}`);
    expect((await w.fetch(`/dashboard/campaigns/999`, { headers: { cookie } })).status).toBe(404);
  });
});
