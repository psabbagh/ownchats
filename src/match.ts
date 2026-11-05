/** Text normalisation shared by keywords and messages: NFKC, lower case. */
function normalise(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Spaces and dashes of any kind (hyphen, en dash, em dash...) between the words of a keyword. */
const GAP = /[\s\p{Pd}]+/gu;

/**
 * Whole-word, case-insensitive match of any keyword. "Agents", "AGENTS!" and
 * "#agents" match AGENTS; "agentsmith" does not. Keywords may contain spaces,
 * and a space or dash in a keyword matches any run of spaces and dashes, so
 * SET UP matches "set-up" with any kind of dash, and CHEAT-SHEET matches "cheat sheet".
 */
export function matchesKeyword(text: string, keywords: string[]): boolean {
  const haystack = normalise(text);
  return keywords.some((raw) => {
    const keyword = normalise(raw).replace(GAP, " ").trim();
    if (!keyword) return false;
    const pattern = escapeRegExp(keyword).replace(/ /g, "[\\s\\p{Pd}]+");
    return new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, "u").test(haystack);
  });
}

/** Splits a keyword field typed as "AGENTS, AGENT" into a clean list. */
export function parseKeywords(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(/[,\n]/)) {
    const k = part.trim().replace(/\s+/g, " ");
    if (k && !seen.has(normalise(k))) {
      seen.add(normalise(k));
      out.push(k);
    }
  }
  return out;
}

const EMAIL = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}/u;

/**
 * Finds an email address in a free-text reply ("sure, it's Name@Example.com!").
 * Instagram has no email quick reply, so people type it. Returns it lower-cased,
 * or null.
 */
export function extractEmail(text: string): string | null {
  const m = text.normalize("NFKC").match(EMAIL);
  if (!m) return null;
  const email = m[0].replace(/^[.'+-]+/, "").toLowerCase();
  const [local, domain] = email.split("@") as [string, string];
  if (!local || local.length > 64 || email.length > 254) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (domain.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))) return null;
  return email;
}
