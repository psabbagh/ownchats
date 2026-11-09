import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { baseUrlAfterVisit } from "../src/pages/setup";
import { saveSettings } from "../src/settings";
import { setupWorld } from "./helpers";

const WORKER = "https://ownchats.example.workers.dev";
const CUSTOM = "https://go.example.com";

describe("the address OwnChats remembers", () => {
  it("takes the first address it sees", () => {
    expect(baseUrlAfterVisit(undefined, WORKER)).toBe(WORKER);
    expect(baseUrlAfterVisit(undefined, CUSTOM)).toBe(CUSTOM);
  });

  it("moves from workers.dev to a custom domain", () => {
    expect(baseUrlAfterVisit(WORKER, CUSTOM)).toBe(CUSTOM);
  });

  it("keeps a custom domain when the workers.dev address is opened", () => {
    expect(baseUrlAfterVisit(CUSTOM, WORKER)).toBe(CUSTOM);
  });

  it("follows a move from one custom domain to another, and from one workers.dev address to another", () => {
    expect(baseUrlAfterVisit(CUSTOM, "https://links.example.com")).toBe("https://links.example.com");
    expect(baseUrlAfterVisit(WORKER, "https://renamed.example.workers.dev")).toBe("https://renamed.example.workers.dev");
  });

  it("isn't fooled by a custom domain with workers.dev in its name", () => {
    expect(baseUrlAfterVisit(WORKER, "https://workers.dev.example.com")).toBe("https://workers.dev.example.com");
    expect(baseUrlAfterVisit("https://workers.dev.example.com", WORKER)).toBe("https://workers.dev.example.com");
  });

  it("stays on the custom domain after an admin page is opened on the workers.dev address", async () => {
    const world = await setupWorld();
    await saveSettings(env.DB, env.ADMIN_PASSWORD, { base_url: CUSTOM });
    const cookie = await world.signIn();

    const res = await world.fetch("/setup", { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'base_url'").first("value")).toBe(CUSTOM);
  });
});
