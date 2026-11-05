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

/**
 * Edit distance where swapping two neighbouring letters counts as one edit, so
 * "agnets" is one typo away from "agents".
 */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

export interface NearMiss {
  /** The campaign keyword the comment came close to. */
  keyword: string;
  /** What to add as a spelling so comments like it match, or null when adding one makes no sense. */
  spelling: string | null;
}

/** Typos allowed: none for short keywords, where they would catch ordinary words. */
function tolerance(length: number): number {
  return length >= 8 ? 2 : length >= 5 ? 1 : 0;
}

/**
 * Whether a comment that matched none of the keywords came close to one: a typo
 * or two ("PROMTS"), a plural ("TEMPLATES"), joined or split words ("work shop"
 * for WORKSHOP, "setup" for SET UP), or a word that starts with the keyword
 * ("gearlist"). Used to point the owner at comments worth answering by hand;
 * nothing is sent on its basis.
 */
export function nearMiss(text: string, keywords: string[]): NearMiss | null {
  if (matchesKeyword(text, keywords)) return null;
  const words = normalise(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return null;
  for (const raw of keywords) {
    const keyword = normalise(raw).replace(GAP, "");
    if (keyword.length < 3) continue;
    const tol = tolerance(keyword.length);
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      const pair = i + 1 < words.length ? `${word}${words[i + 1]}` : null;
      if (Math.abs(word.length - keyword.length) <= tol && editDistance(word, keyword) <= tol) {
        return { keyword: raw, spelling: word.toUpperCase() };
      }
      if (pair && Math.abs(pair.length - keyword.length) <= tol && editDistance(pair, keyword) <= tol) {
        return { keyword: raw, spelling: `${word} ${words[i + 1]}`.toUpperCase() };
      }
      if (keyword.length >= 4 && word.length > keyword.length && word.startsWith(keyword)) {
        // "gears" is worth a spelling; "gearlist" is better answered once by hand.
        return { keyword: raw, spelling: word.length - keyword.length <= 2 ? word.toUpperCase() : null };
      }
    }
  }
  return null;
}
