import { iso } from "./time";

/**
 * How an alert goes out to the owner's alert URL. One message, four shapes, chosen by
 * the URL and the format saved in Settings:
 *  - Slack and Discord incoming webhooks, recognised by their address, get the JSON
 *    their chat expects;
 *  - "text" (the default): the message as plain text, with ntfy's Title, Click, Tags and
 *    Priority headers, so an ntfy.sh topic URL is a phone push with no account, and any
 *    other service that takes a plain POST shows the text;
 *  - "json": every field, for the owner's own tools.
 * Alerts never carry a username, a comment or an email: an ntfy topic can be read by
 * anyone who knows its name.
 */
export type AlertFormat = "text" | "json";

export interface AlertPayload {
  /** Which problem: comments, webhook, token, waiting, gave_up, untaken, failures, or test. */
  problem: string;
  status: "open" | "reminder" | "fixed" | "test";
  title: string;
  message: string;
  /** How many people (or posts, or campaigns, as the message says) it affects. 0 when it can't be counted. */
  people: number;
  /** The dashboard page where to act. */
  url: string;
  opened_at: number | null;
}

export function alertFormat(saved: string | undefined): AlertFormat {
  return saved === "json" ? "json" : "text";
}

/** What the URL's host says about the receiver. */
export function receiverOf(url: string): "slack" | "discord" | "other" {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "other";
  }
  if (host === "hooks.slack.com") return "slack";
  if ((host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) && new URL(url).pathname.startsWith("/api/webhooks/")) return "discord";
  return "other";
}

/**
 * The title as a person sees it: "OwnChats: " in front, so an alert reads on its own in a
 * channel other services share (healthchecks.io's ntfy integration, a Slack channel).
 * The JSON keeps the bare title, since a tool names its sources itself.
 */
export function shownTitle(title: string): string {
  return title.startsWith("OwnChats") ? title : `OwnChats: ${title}`;
}

/** Header values must be plain ASCII; the titles OwnChats writes are, and anything else is dropped rather than garbled. */
function headerSafe(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 200);
}

/** The request for one attempt: its body and the headers beyond OwnChats' own. */
export function alertRequest(
  url: string,
  format: AlertFormat,
  p: AlertPayload,
  delivery: { id: string; now: number; test: boolean },
): { body: string; headers: Record<string, string> } {
  const link = p.url ? `\n${p.url}` : "";
  const receiver = receiverOf(url);
  if (receiver === "slack") return { body: JSON.stringify({ text: `*${shownTitle(p.title)}*\n${p.message}${p.url ? `\n<${p.url}|Open OwnChats>` : ""}` }), headers: { "content-type": "application/json" } };
  if (receiver === "discord") return { body: JSON.stringify({ content: `**${shownTitle(p.title)}**\n${p.message}${link}` }), headers: { "content-type": "application/json" } };
  if (format === "json") {
    return {
      body: JSON.stringify({
        event: "alert",
        delivery_id: delivery.id,
        sent_at: iso(delivery.now),
        test: delivery.test,
        problem: p.problem,
        status: p.status,
        title: p.title,
        message: p.message,
        people: p.people,
        url: p.url || null,
        opened_at: p.opened_at ? iso(p.opened_at) : null,
      }),
      headers: { "content-type": "application/json" },
    };
  }
  // ntfy reads these headers; other services ignore them and show the body.
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    title: headerSafe(shownTitle(p.title)),
    tags: p.status === "fixed" ? "white_check_mark" : p.status === "test" ? "bell" : "warning",
    priority: p.status === "open" ? "high" : "default",
  };
  if (p.url) headers.click = p.url;
  return { body: `${p.message}${link}`, headers };
}
