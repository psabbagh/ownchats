import { describe, expect, it } from "vitest";
import { decryptText, encryptText, signValue, verifySigned } from "../src/crypto";
import { extractEmail, matchesKeyword, parseKeywords } from "../src/match";
import { isTemplateRejection, MetaError, plainText } from "../src/meta/client";
import { fmtDate, fmtTime } from "../src/pages/html";
import { timeZoneOf } from "../src/time";
import { parsePayload } from "../src/webhook";

describe("keywords", () => {
  it("match whole words, ignoring case and punctuation", () => {
    const k = ["AGENTS"];
    expect(matchesKeyword("agents", k)).toBe(true);
    expect(matchesKeyword("AGENTS!!", k)).toBe(true);
    expect(matchesKeyword("send me the #agents list", k)).toBe(true);
    expect(matchesKeyword("Agents🙏", k)).toBe(true);
    expect(matchesKeyword("agentsmith", k)).toBe(false);
    expect(matchesKeyword("subagents", k)).toBe(false);
    expect(matchesKeyword("free guide", ["Free Guide"])).toBe(true);
    expect(matchesKeyword("free   guide please", ["free guide"])).toBe(true);
    expect(matchesKeyword("CAFÉ", ["café"])).toBe(true);
  });

  it("treat a dash between the words of a keyword like a space", () => {
    const k = ["SET UP"];
    expect(matchesKeyword("Set-up", k)).toBe(true);
    expect(matchesKeyword("set–up please", k)).toBe(true); // en dash
    expect(matchesKeyword("set—up", k)).toBe(true); // em dash, from a phone keyboard
    expect(matchesKeyword("set - up", k)).toBe(true);
    expect(matchesKeyword("Cheat sheet!", ["CHEAT-SHEET"])).toBe(true);
    expect(matchesKeyword("30-day plan", ["30 DAY PLAN"])).toBe(true);
    // Joining or splitting words is still up to the extra spellings.
    expect(matchesKeyword("setup", k)).toBe(false);
    expect(matchesKeyword("set up", ["SETUP"])).toBe(false);
    expect(matchesKeyword("upset-up", k)).toBe(false);
    // A one-word keyword already matched beside a dash.
    expect(matchesKeyword("AI-agents", ["AGENTS"])).toBe(true);
    expect(matchesKeyword("-", ["-"])).toBe(false);
  });

  it("parse a typed list without duplicates", () => {
    expect(parseKeywords("AGENTS, agent,  AGENTS ,\n")).toEqual(["AGENTS", "agent"]);
  });
});

describe("times on the pages", () => {
  const winter = Date.parse("2026-11-04T12:00:00Z");
  const summer = Date.parse("2026-07-01T12:00:00Z");
  it("show in the owner's zone, with its abbreviation, daylight saving included", () => {
    expect(fmtTime(winter, "UTC")).toBe("2026-11-04 12:00 UTC");
    expect(fmtTime(winter, "America/Toronto")).toBe("2026-11-04 07:00 EST");
    expect(fmtTime(summer, "America/Toronto")).toBe("2026-07-01 08:00 EDT");
    expect(fmtTime(Date.parse("2026-11-04T05:30:00Z"), "UTC")).toBe("2026-11-04 05:30 UTC");
    expect(fmtTime(0, "UTC")).toBe("");
  });

  it("give the day in that zone, which can differ from UTC's", () => {
    const evening = Date.parse("2026-11-05T03:00:00Z");
    expect(fmtDate(evening, "UTC")).toBe("2026-11-05");
    expect(fmtDate(evening, "America/Toronto")).toBe("2026-11-04");
  });

  it("use UTC until a valid zone is saved", () => {
    expect(timeZoneOf({})).toBe("UTC");
    expect(timeZoneOf({ time_zone: "Mars/Olympus" })).toBe("UTC");
    expect(timeZoneOf({ time_zone: "America/Toronto" })).toBe("America/Toronto");
  });
});

describe("email extraction", () => {
  it("finds an address in a free-text reply", () => {
    expect(extractEmail("sure! it's Name.Surname+news@Example.co.uk.")).toBe("name.surname+news@example.co.uk");
    expect(extractEmail("mail: someone@example.com thanks")).toBe("someone@example.com");
  });
  it("rejects things that are not addresses", () => {
    for (const t of ["no thanks", "me@home", "a@b.c", "@handle", "x..y@example.com", "name@-bad.com"]) expect(extractEmail(t), t).toBeNull();
  });
});

describe("crypto", () => {
  it("encrypts and refuses to decrypt with another password", async () => {
    const sealed = await encryptText("password-one-long", "secret value");
    expect(sealed).not.toContain("secret");
    expect(await decryptText("password-one-long", sealed)).toBe("secret value");
    expect(await decryptText("password-two-long", sealed)).toBeNull();
  });
  it("signs values", async () => {
    const s = await signValue("pw-long-enough", "123");
    expect(await verifySigned("pw-long-enough", s)).toBe("123");
    expect(await verifySigned("pw-long-enough", s.replace("123", "124"))).toBeNull();
  });
});

describe("Meta message helpers", () => {
  it("turns a link button into the link itself", () => {
    expect(plainText({ kind: "buttons", text: "Here:", buttons: [{ type: "web_url", title: "Open", url: "https://example.com" }] })).toEqual({
      kind: "text",
      text: "Here:\nhttps://example.com",
    });
  });
  it("only treats template-shaped errors as template rejections", () => {
    expect(isTemplateRejection(new MetaError("Invalid parameter", 400, 100))).toBe(true);
    expect(isTemplateRejection(new MetaError("The comment is invalid for a private reply", 400, 100, 2534025))).toBe(false);
    expect(isTemplateRejection(new MetaError("rate", 400, 4))).toBe(false);
    expect(isTemplateRejection(new MetaError("(#100) The requested user cannot be found.", 400, 100, 2534014))).toBe(false);
  });
});

describe("webhook parsing", () => {
  it("reads comments, DMs, taps, and skips deleted messages", () => {
    const { comments, events } = parsePayload(
      {
        object: "instagram",
        entry: [
          {
            id: "1",
            time: 1_762_257_600,
            changes: [{ field: "comments", value: { id: "c1", text: "hi", from: { id: "u1", username: "n" }, media: { id: "m1" } } }],
            messaging: [
              { sender: { id: "u2" }, timestamp: 1_762_257_600_000, message: { mid: "m.1", text: "x" } },
              { sender: { id: "u3" }, timestamp: 1_762_257_600_000, postback: { mid: "m.2", payload: "P", title: "T" } },
              { sender: { id: "u4" }, timestamp: 1_762_257_600_000, message: { mid: "m.3", is_deleted: true } },
            ],
          },
        ],
      },
      0,
    );
    expect(comments).toEqual([{ id: "c1", mediaId: "m1", text: "hi", timestamp: 1_762_257_600_000, fromId: "u1", fromUsername: "n", parentId: undefined }]);
    expect(events.map((e) => e.mid)).toEqual(["m.1", "m.2"]);
  });
  it("ignores other objects", () => {
    expect(parsePayload({ object: "page", entry: [{ changes: [{ field: "comments", value: { id: "c", media: { id: "m" } } }] }] }, 0).comments).toEqual([]);
  });
});
