import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { nearMiss } from "../src/match";
import { MetaError } from "../src/meta/client";
import { DAY, HOUR, MINUTE } from "../src/time";
import { BASE, FAN, FAN2, OTHER_POST, OWNER, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

// Invented people.
const FAN3 = { id: "900000000000003", username: "third_invented_fan" };

beforeEach(async () => {
  w = await setupWorld();
});

const post = (cookie: string, path: string, data: Record<string, string>) =>
  w.fetch(path, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) });
const privateReplies = () => w.meta.sent.filter((s) => s.kind === "private_reply");
const status = async (id: string) => (await env.DB.prepare("SELECT status, reason, campaign_id FROM comments WHERE id = ?").bind(id).first()) as Record<string, unknown>;

describe("near misses", () => {
  it("catch typos, plurals, and joined or split words, with the spelling to add", () => {
    expect(nearMiss("PROMTS please", ["PROMPTS"])).toEqual({ keyword: "PROMPTS", spelling: "PROMTS" });
    expect(nearMiss("promptss 🙏", ["PROMPTS"])).toEqual({ keyword: "PROMPTS", spelling: "PROMPTSS" });
    expect(nearMiss("TEMPLATES!", ["TEMPLATE"])?.spelling).toBe("TEMPLATES");
    expect(nearMiss("templete", ["TEMPLATE"])?.spelling).toBe("TEMPLETE");
    expect(nearMiss("work shop", ["WORKSHOP"])?.spelling).toBe("WORK SHOP");
    expect(nearMiss("Set-up", ["SETUP"])?.spelling).toBe("SET UP");
    expect(nearMiss("Setup", ["SET UP"])?.spelling).toBe("SETUP");
    expect(nearMiss("agnets", ["AGENTS"])?.spelling).toBe("AGNETS"); // swapped letters are one typo
    expect(nearMiss("gears", ["GEAR"])?.spelling).toBe("GEARS");
    expect(nearMiss("whats the gearlist", ["GEAR"])).toEqual({ keyword: "GEAR", spelling: null });
  });

  it("leave ordinary comments, and comments that already match, alone", () => {
    for (const text of ["love this", "great tips", "🔥🔥🔥", "agency life", "magenta", "following for more", ""]) {
      expect(nearMiss(text, ["AGENTS", "PROMPTS", "TEMPLATE", "WORKSHOP"]), text).toBeNull();
    }
    for (const text of ["hear hear", "dear", "year"]) expect(nearMiss(text, ["GEAR"]), text).toBeNull();
    expect(nearMiss("AGENTS please", ["AGENTS"])).toBeNull();
  });
});

describe("answering a missed comment", () => {
  it("lists a near miss, adds the spelling on request, and sends one DM", async () => {
    const id = await w.campaign();
    const c = w.comment("agnets pls", FAN);
    await w.sendComment(c);
    expect(privateReplies()).toHaveLength(0);
    const cookie = await w.signIn();

    expect(await (await w.fetch("/dashboard", { headers: { cookie } })).text()).toContain("1 comment to check");
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("To check (1)");
    expect(page).toContain("Close to AGENTS");
    expect(page).toContain('Add "AGNETS" and answer');
    expect(page).not.toContain("—");

    const res = await post(cookie, `/dashboard/campaigns/${id}/answer`, { comment_id: c.id, spelling: "AGNETS" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/dashboard/campaigns/${id}?answered=${c.id}#to-check`);
    expect(privateReplies().map((s) => s.to)).toEqual([c.id]);
    expect(w.meta.sent.filter((s) => s.kind === "public_reply").map((s) => s.to)).toEqual([c.id]);
    expect(await status(c.id)).toMatchObject({ status: "done", campaign_id: id });
    expect(await env.DB.prepare("SELECT keywords FROM campaigns WHERE id = ?").bind(id).first()).toEqual({ keywords: '["AGENTS","AGENT","AGNETS"]' });

    const after = await (await w.fetch(res.headers.get("location")!, { headers: { cookie } })).text();
    expect(after).toContain(`Answered: the DM went to @${FAN.username}`);
    expect(after).not.toContain("To check (");

    // A second click, or the same form sent again, sends nothing.
    const again = await post(cookie, `/dashboard/campaigns/${id}/answer`, { comment_id: c.id });
    expect(again.headers.get("location")).toContain("problem=gone");
    expect(privateReplies()).toHaveLength(1);
  });

  it("keeps the chosen campaign when Meta asks to wait, though the text matches no keyword", async () => {
    const id = await w.campaign();
    const c = w.comment("agnets", FAN);
    await w.sendComment(c);
    w.meta.failNext("sendPrivateReply", new MetaError("Application request limit reached", 400, 4));
    const cookie = await w.signIn();
    const res = await post(cookie, `/dashboard/campaigns/${id}/answer`, { comment_id: c.id });
    expect(await status(c.id)).toMatchObject({ status: "queued", campaign_id: id });
    expect(await (await w.fetch(res.headers.get("location")!, { headers: { cookie } })).text()).toContain("On its way");
    w.clock.advance(MINUTE);
    await w.cron();
    expect(privateReplies().map((s) => s.to)).toEqual([c.id]);
    expect(await status(c.id)).toMatchObject({ status: "done", campaign_id: id });
    await w.cron();
    expect(privateReplies()).toHaveLength(1);
  });

  it("answers a comment written before the campaign started, only when asked", async () => {
    const id = await w.campaign();
    const c = w.comment("agents", FAN, { ago: 2 * HOUR });
    await w.sendComment(c);
    await w.cron();
    expect(await status(c.id)).toMatchObject({ status: "skipped", reason: "written before the campaign started" });
    expect(privateReplies()).toHaveLength(0);
    const cookie = await w.signIn();
    expect(await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text()).toContain("Written before the campaign started.");
    await post(cookie, `/dashboard/campaigns/${id}/answer`, { comment_id: c.id });
    expect(privateReplies().map((s) => s.to)).toEqual([c.id]);
  });

  it("offers a comment that came in while the campaign was off, and answers it once the campaign is on", async () => {
    const id = await w.campaign({ active: false });
    const c = w.comment("agents", FAN);
    await w.sendComment(c);
    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("The campaign is off. Switch it on to answer these.");
    expect(page).not.toContain(">Answer</button>");
    const refused = await post(cookie, `/dashboard/campaigns/${id}/answer`, { comment_id: c.id });
    expect(refused.headers.get("location")).toContain("problem=off");
    expect(privateReplies()).toHaveLength(0);

    await env.DB.prepare("UPDATE campaigns SET active = 1 WHERE id = ?").bind(id).run();
    expect(await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text()).toContain("Has the keyword now");
    await post(cookie, `/dashboard/campaigns/${id}/answer`, { comment_id: c.id });
    expect(privateReplies().map((s) => s.to)).toEqual([c.id]);
  });

  it("never offers or answers a comment past Meta's 7 days, from someone already answered, on another post, or the owner's", async () => {
    const id = await w.campaign();
    const old = w.comment("agnets", FAN2, { ago: 6 * DAY });
    await w.sendComment(old);
    await w.sendComment(w.comment("agents", FAN));
    const again = w.comment("agnets", FAN);
    await w.sendComment(again);
    const elsewhere = w.comment("agnets", FAN3, { media: OTHER_POST });
    await w.sendComment(elsewhere);
    const own = w.comment("agnets", OWNER);
    await w.sendComment(own);
    const cookie = await w.signIn();

    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("To check (1)"); // only the six-day-old one, for now
    w.clock.advance(1.5 * DAY);
    expect(await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text()).not.toContain("To check (");

    const sent = w.meta.sent.length;
    const tries: Array<[string, string]> = [
      [old.id, "window"],
      [again.id, "already"],
      [elsewhere.id, "gone"],
      [own.id, "gone"],
      ["17999999999999999", "gone"],
    ];
    for (const [commentId, problem] of tries) {
      const res = await post(cookie, `/dashboard/campaigns/${id}/answer`, { comment_id: commentId });
      expect(res.headers.get("location"), commentId).toContain(`problem=${problem}`);
    }
    expect(w.meta.sent.length).toBe(sent);
  });

  it("refuses a spelling that doesn't match the comment, and only answers on a signed-in, same-site POST", async () => {
    const id = await w.campaign();
    const c = w.comment("agnets", FAN);
    await w.sendComment(c);
    const cookie = await w.signIn();
    const res = await post(cookie, `/dashboard/campaigns/${id}/answer`, { comment_id: c.id, spelling: "SOMETHING ELSE" });
    expect(res.headers.get("location")).toContain("problem=spelling");
    expect(await env.DB.prepare("SELECT keywords FROM campaigns WHERE id = ?").bind(id).first()).toEqual({ keywords: '["AGENTS","AGENT"]' });

    expect((await w.fetch(`/dashboard/campaigns/${id}/answer`, { headers: { cookie } })).status).toBe(404);
    expect(await (await w.fetch(`/dashboard/campaigns/${id}?problem=toString`, { headers: { cookie } })).text()).not.toContain("function");
    const crossSite = await w.fetch(`/dashboard/campaigns/${id}/answer`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ comment_id: c.id }),
    });
    expect(crossSite.status).toBe(403);
    const signedOut = await w.fetch(`/dashboard/campaigns/${id}/answer`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ comment_id: c.id }),
    });
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toContain("/login");
    expect(privateReplies()).toHaveLength(0);
    expect(await status(c.id)).toMatchObject({ status: "skipped", reason: "no matching campaign" });
  });
});
