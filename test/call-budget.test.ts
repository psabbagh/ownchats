import { beforeEach, describe, expect, it } from "vitest";
import { DAY, MINUTE } from "../src/time";
import { setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

/**
 * The Meta calls the Cron makes in an hour with the load of 2026-11-21: 18 one-post
 * campaigns on Reels from the last 17 days, 30 more posts in the last 90 days, and one
 * campaign waiting for the next post. No comments and no DMs: background reads only.
 * Measured as the average hour of a day, after 3 hours, so the account days and the
 * first reads have settled: daily reads (a Reel's watch time and skip rate) count too.
 */
async function cronCallsPerHour(hours: number): Promise<Record<string, number>> {
  const reel = (id: number, ageDays: number) => ({
    id: `1800000000000${String(id).padStart(4, "0")}`,
    caption: `Invented reel ${id}. Comment WORD${id}`,
    permalink: `https://example.com/p/${id}`,
    timestamp: w.clock.now() - ageDays * DAY,
    mediaType: "REELS",
  });
  const watched = [0.5, ...Array.from({ length: 17 }, (_, i) => i + 1)].map((age, i) => reel(i + 1, age));
  const others = Array.from({ length: 30 }, (_, i) => reel(100 + i, 18 + i * 2.4));
  w.meta.media = [...watched, ...others].sort((a, b) => b.timestamp - a.timestamp);
  for (const [i, m] of watched.entries()) await w.campaign({ name: `Campaign ${i}`, keywords: [`WORD${i + 1}`], mediaId: m.id });
  await w.campaign({ name: "Waiting", keywords: ["NEXTWORD"], mediaId: null, mediaLabel: null, nextPostAfter: w.clock.now() });
  for (let i = 0; i < 3 * 60; i++) {
    w.clock.advance(MINUTE);
    await w.cron();
  }
  const before = w.meta.calls.length;
  for (let i = 0; i < hours * 60; i++) {
    w.clock.advance(MINUTE);
    await w.cron();
  }
  const calls = w.meta.calls.slice(before);
  const out: Record<string, number> = { total: calls.length };
  for (const c of calls) out[c] = (out[c] ?? 0) + 1;
  // An average hour.
  for (const k of Object.keys(out)) out[k] = Math.round((out[k]! / hours) * 10) / 10;
  return out;
}

describe("Meta calls an hour", () => {
  it("stay well inside Meta's app limit with 18 watched posts and one waiting campaign", { timeout: 120_000 }, async () => {
    const calls = await cronCallsPerHour(24);
    console.log("Cron Meta calls in one hour:", JSON.stringify(calls));
    // About 58 since new posts are polled every 15 minutes (2026-11-21), from about 177.
    expect(calls.total).toBeLessThan(80);
  });
});
