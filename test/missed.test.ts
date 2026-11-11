import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { listCampaigns } from "../src/campaigns";
import { CommentText, editDistanceWithin, KeywordSet, nearMiss } from "../src/match";
import { missedComments } from "../src/missed";
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

describe("bounded edit distance", () => {
  /** The full table, as a reference: swapping two neighbouring letters counts as one edit. */
  function full(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
    return d[a.length]![b.length]!;
  }

  it("agrees with the full table up to its limit, and stops early beyond it", () => {
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const word = () => Array.from({ length: Math.floor(rnd() * 10) }, () => "abcd"[Math.floor(rnd() * 4)]).join("");
    for (let n = 0; n < 3000; n++) {
      const a = word();
      const b = word();
      const max = Math.floor(rnd() * 4);
      expect(editDistanceWithin(a, b, max), `${a} ${b} ${max}`).toBe(Math.min(full(a, b), max + 1));
    }
    expect(editDistanceWithin("agnets", "agents", 1)).toBe(1);
    expect(editDistanceWithin("a".repeat(60), "b".repeat(60), 2)).toBe(3);
  });

  it("gives the same answers when keywords and comments are prepared once for many checks", () => {
    const keywords = new KeywordSet(["PROMPTS", "SET UP"]);
    for (const text of ["PROMTS please", "promts", "love this", "Setup", "set up", "agents"]) {
      const t = new CommentText(text);
      expect(keywords.nearMiss(t), text).toEqual(nearMiss(text, ["PROMPTS", "SET UP"]));
      expect(keywords.nearMiss(t), `${text}, again`).toEqual(nearMiss(text, ["PROMPTS", "SET UP"]));
    }
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

  it("says why Meta refused: in plain words when the refusal is known, in Meta's own otherwise", async () => {
    const id = await w.campaign();
    const cookie = await w.signIn();
    const answer = async (c: { id: string }) => {
      const res = await post(cookie, `/dashboard/campaigns/${id}/answer`, { comment_id: c.id });
      return (await w.fetch(res.headers.get("location")!, { headers: { cookie } })).text();
    };

    const gone = w.comment("agnets", FAN);
    await w.sendComment(gone);
    w.meta.failNext("sendPrivateReply", new MetaError("(#100) The requested user cannot be found.", 400, 100, 2534014));
    const calls = w.meta.calls.length;
    const first = await answer(gone);
    expect(first).toContain(`The DM to @${FAN.username} did not go out: Meta can&#39;t find this person to message`);
    expect(first).not.toContain("—");
    // Not a refused button, so it is not sent again as text.
    expect(w.meta.calls.slice(calls).filter((m) => m === "sendPrivateReply")).toHaveLength(1);
    expect(await status(gone.id)).toMatchObject({ status: "failed" });

    const odd = w.comment("agnets", FAN2);
    await w.sendComment(odd);
    w.meta.failNext("sendPrivateReply", new MetaError("An invented refusal", 400, 999));
    const second = await answer(odd);
    expect(second).toContain("Meta said &quot;An invented refusal (HTTP 400, code 999)&quot;. Nothing was sent.");
    expect(second).not.toContain("did not go out: Meta refused");
    expect(privateReplies()).toHaveLength(0);
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

  it("lists near misses on any post for an all-posts campaign, and only on its own post otherwise", async () => {
    const all = await w.campaign({ name: "Gear", keywords: ["GEAR"], mediaId: null, mediaLabel: null });
    const reel = await w.campaign();
    const gears = w.comment("gears please", FAN, { media: OTHER_POST });
    await w.sendComment(gears);
    await w.sendComment(w.comment("agnets", FAN2, { media: OTHER_POST }));
    const ctx = await w.ctx();
    const missed = await missedComments(ctx, await listCampaigns(env.DB, true));
    expect(missed.get(all)?.map((m) => [m.id, m.spelling])).toEqual([[gears.id, "GEARS"]]);
    expect(missed.get(reel)).toBeUndefined();
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
