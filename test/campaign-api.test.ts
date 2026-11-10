import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE, setupWorld } from "./helpers";

// Everything here is invented: ids, names, links.
type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;
let cookie: string;
let auth: { headers: { authorization: string } };

beforeEach(async () => {
  w = await setupWorld();
  cookie = await w.signIn();
  const page = await (await w.fetch("/dashboard/settings/api-token", form({ do: "new" }))).text();
  auth = { headers: { authorization: `Bearer ${page.match(/oc_[A-Za-z0-9_-]+/)![0]}` } };
});

function form(data: Record<string, string>): RequestInit {
  return { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) };
}

async function apiCampaigns(): Promise<Array<Record<string, any>>> {
  return ((await (await w.fetch("/api/campaigns", auth)).json()) as { campaigns: Array<Record<string, any>> }).campaigns;
}

const NEW = { name: "SEO guide", keywords: "SEO", media_id: "all", link_text: "Here:", link_url_0: "https://example.com/seo", email_mode: "none", active: "on" };

describe("video id", () => {
  it("is set on the campaign form, shown on the edit page and served by the API", async () => {
    const res = await w.fetch("/dashboard/campaigns/new", form({ ...NEW, video_id: "SF-14" }));
    expect(res.status).toBe(303);
    expect(await env.DB.prepare("SELECT video_id FROM campaigns").first()).toEqual({ video_id: "SF-14" });
    const edit = await (await w.fetch(`${res.headers.get("location")}/edit`, { headers: { cookie } })).text();
    expect(edit).toContain('name="video_id" type="text" value="SF-14"');
    expect((await apiCampaigns())[0]).toMatchObject({ name: "SEO guide", video_id: "SF-14" });
  });

  it("is null in the API when empty, as on campaigns made before it existed", async () => {
    await w.campaign();
    expect((await apiCampaigns())[0]!.video_id).toBeNull();
  });

  it("refuses an id with spaces or other characters", async () => {
    const res = await w.fetch("/dashboard/campaigns/new", form({ ...NEW, video_id: "SF 14!" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The video id can use letters, digits");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM campaigns").first()).toEqual({ n: 0 });
  });
});
