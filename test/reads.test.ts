import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../src/context";
import { peopleCounts } from "../src/refused";
import { campaignTotals } from "../src/stats";
import { setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

/**
 * D1 on the Workers Free plan allows 5 million rows read a day for the whole account, so these
 * hold the rows the campaign totals read. The data has the shape of a live copy on 2026-11-24
 * (invented): 22 campaigns, 1,210 conversations, 5,500 activity rows of which 616 are taps and
 * 550 are other received DMs, 638 tracked links of which 517 were clicked, 99 leads.
 */
const SIZE = { campaigns: 22, conversations: 1210, taps: 616, received: 550, failed: 176, other: 4158, links: 638, clicked: 517, leads: 99 };

/** Rows read by each statement the code under test runs through batch, in order. */
interface Read {
  sql: string;
  rows: number;
}

function measured(ctx: Ctx): { ctx: Ctx; reads: Read[] } {
  const reads: Read[] = [];
  const db = new Proxy(ctx.db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          // The statement's SQL isn't exposed; the order of results matches the statements.
          results.forEach((r, i) => reads.push({ sql: String((statements[i] as unknown as { statement?: string }).statement ?? i), rows: r.meta.rows_read }));
          return results;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { ctx: { ...ctx, db }, reads };
}

const total = (reads: Read[]) => reads.reduce((n, r) => n + r.rows, 0);

beforeEach(async () => {
  w = await setupWorld();
  for (let i = 0; i < SIZE.campaigns; i++) await w.campaign({ name: `Campaign ${i}`, keywords: [`WORD${i}`] });
  const ids = (await env.DB.prepare("SELECT id FROM campaigns ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
  const t = w.clock.now();
  const series = (n: number) => `WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < ${n})`;
  const campaign = `(SELECT value FROM json_each(?1) WHERE key = i % ${ids.length})`;
  const json = JSON.stringify(ids);
  await env.DB.batch([
    env.DB.prepare(
      `${series(SIZE.conversations)}
       INSERT INTO conversations (campaign_id, ig_user_id, trigger, state, first_sent_at, answered_by_hand_at, created_at, updated_at)
       SELECT ${campaign}, 'user' || i, 'comment', CASE i % 4 WHEN 0 THEN 'opened' WHEN 1 THEN 'done' WHEN 2 THEN 'optional_email' ELSE 'awaiting_open' END,
         CASE WHEN i % 10 = 0 THEN NULL ELSE ?2 END, CASE WHEN i % 50 = 0 THEN ?2 ELSE NULL END, ?2, ?2 FROM s`,
    ).bind(json, t),
    env.DB.prepare(
      `${series(SIZE.taps)} INSERT INTO activity (at, kind, outcome, campaign_id, ig_user_id) SELECT ?2, 'tap', 'received', ${campaign}, 'user' || (i % 560) FROM s`,
    ).bind(json, t),
    env.DB.prepare(
      `${series(SIZE.received)} INSERT INTO activity (at, kind, outcome, campaign_id, ig_user_id) SELECT ?2, 'message', 'received', ${campaign}, 'user' || i FROM s`,
    ).bind(json, t),
    env.DB.prepare(
      `${series(SIZE.failed)} INSERT INTO activity (at, kind, outcome, campaign_id, ig_user_id) SELECT ?2, CASE i % 3 WHEN 0 THEN 'private_reply' WHEN 1 THEN 'public_reply' ELSE 'message' END, 'failed', ${campaign}, 'user' || i FROM s`,
    ).bind(json, t),
    env.DB.prepare(
      `${series(SIZE.other)} INSERT INTO activity (at, kind, outcome, campaign_id, ig_user_id) SELECT ?2, CASE i % 3 WHEN 0 THEN 'private_reply' WHEN 1 THEN 'public_reply' ELSE 'comment' END, 'sent', ${campaign}, 'user' || i FROM s`,
    ).bind(json, t),
    env.DB.prepare(
      `${series(SIZE.links)} INSERT INTO tracked_links (id, conversation_id, campaign_id, link_index, url, first_clicked_at, created_at)
       SELECT 'link' || i, (SELECT id FROM conversations WHERE ig_user_id = 'user' || i), ${campaign}, 0, 'https://example.com/guide', CASE WHEN i < ${SIZE.clicked} THEN ?2 ELSE NULL END, ?2 FROM s`,
    ).bind(json, t),
    env.DB.prepare(
      `${series(SIZE.leads)} INSERT INTO leads (campaign_id, ig_user_id, email, consent_text, consented_at) SELECT ${campaign}, 'user' || i, 'person' || i || '@example.com', 'ok', ?2 FROM s`,
    ).bind(json, t),
  ]);
});

describe("rows read by the campaign totals", () => {
  it("reads each counted row once, from an index, on the dashboard and GET /api/campaigns", async () => {
    const { ctx, reads } = measured(await w.ctx());
    const totals = await campaignTotals(ctx);
    const ids = [...totals.counts.keys()];
    await peopleCounts(ctx, ids, new Map(), totals.people);
    // Conversations, taps, leads, failures, clicks: nothing more, since peopleCounts reused the totals.
    expect(reads).toHaveLength(5);
    const [conv, taps, leads, failed, clicks] = reads.map((r) => r.rows);
    // One index entry per row counted, plus SQLite's step past the last one.
    expect(conv).toBeLessThanOrEqual(SIZE.conversations + 1);
    expect(taps).toBeLessThanOrEqual(SIZE.taps + 1);
    expect(leads).toBeLessThanOrEqual(SIZE.leads + 1);
    expect(failed).toBeLessThanOrEqual(SIZE.failed + 1);
    expect(clicks).toBeLessThanOrEqual(SIZE.clicked + 1);
    // 2,619 here. Before migration 0017 and the shared read, the same view read 7,184 rows in 7 queries.
    expect(total(reads)).toBeLessThanOrEqual(2_700);
  });

  it("reads only the campaign's own rows on its Results page", async () => {
    const { ctx, reads } = measured(await w.ctx());
    const [id] = (await env.DB.prepare("SELECT id FROM campaigns ORDER BY id LIMIT 1").all<{ id: number }>()).results.map((r) => r.id);
    const counts = (await peopleCounts(ctx, [id!], new Map())).get(id!)!;
    expect(counts.asked).toBe(Math.ceil(SIZE.conversations / SIZE.campaigns));
    // 55 conversations and 28 taps for this campaign: 89 rows here, 114 before migration 0017.
    expect(total(reads)).toBeLessThanOrEqual(95);
  });

  it("counts the same people whether the totals are shared or read again", async () => {
    const ctx = await w.ctx();
    const totals = await campaignTotals(ctx);
    const ids = [...totals.counts.keys()];
    const shared = await peopleCounts(ctx, ids, new Map(), totals.people);
    const own = await peopleCounts(ctx, ids, new Map());
    expect(shared).toEqual(own);
  });
});
