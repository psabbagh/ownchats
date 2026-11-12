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
  return matchesNormalised(normalise(text), keywords);
}

/** Compiled keyword patterns, kept between requests: each keyword is compiled once. */
const PATTERNS = new Map<string, RegExp | null>();

/** A keyword as matching reads it: NFKC, lower case, each run of spaces and dashes as one space. */
function canonical(raw: string): string {
  return normalise(raw).replace(GAP, " ").trim();
}

function keywordPattern(raw: string): RegExp | null {
  let pattern = PATTERNS.get(raw);
  if (pattern === undefined) {
    const keyword = canonical(raw);
    pattern = keyword
      ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(keyword).replace(/ /g, "[\\s\\p{Pd}]+")}(?![\\p{L}\\p{N}_])`, "u")
      : null;
    if (PATTERNS.size >= 2000) PATTERNS.clear();
    PATTERNS.set(raw, pattern);
  }
  return pattern;
}

function matchesNormalised(haystack: string, keywords: string[]): boolean {
  return keywords.some((raw) => keywordPattern(raw)?.test(haystack) ?? false);
}

/**
 * Whether a caption asks people to comment one of these keywords: "Comment AGENTS",
 * "comment 'agents' 👇", "Comment: SET-UP", "Comment the word AGENTS". Only spaces,
 * punctuation, emoji and "the word" may sit between "comment" and the keyword, so a
 * caption that merely mentions the word ("my agents bring traffic") doesn't count.
 */
export function captionAsksFor(caption: string, keywords: string[]): boolean {
  const text = normalise(caption);
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])comment\p{L}*/gu)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 100);
    const gap = /^[^\p{L}\p{N}]{1,8}(?:(?:the\s+)?word[^\p{L}\p{N}]{1,8})?/u.exec(rest);
    if (!gap) continue;
    const after = rest.slice(gap[0].length);
    if (keywords.some((k) => keywordPattern(k)?.exec(after)?.index === 0)) return true;
  }
  return false;
}

/** The keywords without those in `remove`, compared the way matching compares them: "set-up" removes SET UP. */
export function withoutKeywords(keywords: string[], remove: string[]): string[] {
  if (!remove.length) return keywords;
  const drop = new Set(remove.map(canonical));
  return keywords.filter((k) => !drop.has(canonical(k)));
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

// Reused between calls, so the edit distance allocates nothing.
let rows = [new Int32Array(48), new Int32Array(48), new Int32Array(48)];

/**
 * Edit distance where swapping two neighbouring letters counts as one edit, so
 * "agnets" is one typo away from "agents". It stops as soon as the distance is
 * sure to be more than `max`, and then returns `max + 1`.
 */
export function editDistanceWithin(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  if (max <= 0) return 1;
  const n = b.length;
  if (rows[0]!.length <= n) rows = [new Int32Array(n + 1), new Int32Array(n + 1), new Int32Array(n + 1)];
  let [before, prev, cur] = rows as [Int32Array, Int32Array, Int32Array];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const ai = a.charCodeAt(i - 1);
    cur[0] = i;
    let least = i;
    for (let j = 1; j <= n; j++) {
      const bj = b.charCodeAt(j - 1);
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ai === bj ? 0 : 1));
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) v = Math.min(v, before[j - 2]! + 1);
      cur[j] = v;
      if (v < least) least = v;
    }
    // No later row can go below this one's smallest value.
    if (least > max) return max + 1;
    [before, prev, cur] = [prev, cur, before];
  }
  return Math.min(prev[n]!, max + 1);
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

const WORD = /[\p{L}\p{N}]+/gu;
/** Near misses are looked for in a comment's first words only: keyword comments are short. */
const NEAR_MISS_WORDS = 60;

/** A comment read once, for checking against many campaigns: its normalised text and first words. */
export class CommentText {
  readonly text: string;
  readonly words: string[];
  constructor(raw: string) {
    this.text = normalise(raw);
    this.words = (this.text.match(WORD) ?? []).slice(0, NEAR_MISS_WORDS);
  }
}

/**
 * One campaign's keywords, prepared once for checking many comments. It
 * remembers each word it has judged, since the same words come back in comment
 * after comment ("please", "link", "love this").
 */
export class KeywordSet {
  private readonly prepared: Array<{ raw: string; flat: string; tol: number }>;
  private readonly seen = new Map<string, NearMiss | null>();
  /** Words or pairs shorter or longer than these can't be within a typo of any keyword. */
  private readonly minLength: number;
  private readonly maxLength: number;
  readonly keywords: string[];

  constructor(keywords: string[]) {
    this.keywords = keywords;
    this.prepared = keywords
      .map((raw) => {
        const flat = normalise(raw).replace(GAP, "");
        return { raw, flat, tol: tolerance(flat.length) };
      })
      .filter((k) => k.flat.length >= 3);
    this.minLength = Math.min(...this.prepared.map((k) => k.flat.length - k.tol));
    this.maxLength = Math.max(...this.prepared.map((k) => k.flat.length + k.tol));
  }

  matches(t: CommentText): boolean {
    return matchesNormalised(t.text, this.keywords);
  }

  /**
   * Whether a comment that matched none of the keywords came close to one: a
   * typo or two ("PROMTS"), a plural ("TEMPLATES"), joined or split words
   * ("work shop" for WORKSHOP, "setup" for SET UP), or a word that starts with
   * the keyword ("gearlist"). Used to point the owner at comments worth answering
   * by hand; nothing is sent on its basis.
   */
  nearMiss(t: CommentText): NearMiss | null {
    return this.matches(t) ? null : this.closeTo(t);
  }

  /** The near-miss check alone, for a comment already known not to match. */
  closeTo(t: CommentText): NearMiss | null {
    if (!this.prepared.length) return null;
    const words = t.words;
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      const next = words[i + 1];
      const hit = this.word(word) ?? (next !== undefined ? this.pair(word, next) : null);
      if (hit) return hit;
    }
    return null;
  }

  private word(word: string): NearMiss | null {
    // Most words in a comment are too short to be a typo away from any keyword.
    if (word.length < this.minLength) return null;
    if (word.length > this.maxLength) return this.prefix(word);
    return this.remember(word, () => {
      for (const k of this.prepared) {
        if (editDistanceWithin(word, k.flat, k.tol) <= k.tol) return { keyword: k.raw, spelling: word.toUpperCase() };
      }
      return this.prefix(word);
    });
  }

  /** Two words read as one: "work shop" for WORKSHOP, "set up" for SETUP. */
  private pair(word: string, next: string): NearMiss | null {
    const length = word.length + next.length;
    if (length < this.minLength || length > this.maxLength) return null;
    const spelling = `${word} ${next}`;
    return this.remember(spelling, () => {
      const joined = word + next;
      for (const k of this.prepared) {
        if (editDistanceWithin(joined, k.flat, k.tol) <= k.tol) return { keyword: k.raw, spelling: spelling.toUpperCase() };
      }
      return null;
    });
  }

  /** A word that starts with a keyword: "gears" is worth a spelling, "gearlist" is better answered once by hand. */
  private prefix(word: string): NearMiss | null {
    for (const k of this.prepared) {
      if (k.flat.length >= 4 && word.length > k.flat.length && word.startsWith(k.flat)) {
        return { keyword: k.raw, spelling: word.length - k.flat.length <= 2 ? word.toUpperCase() : null };
      }
    }
    return null;
  }

  private remember(key: string, judge: () => NearMiss | null): NearMiss | null {
    const known = this.seen.get(key);
    if (known !== undefined) return known;
    const verdict = judge();
    if (this.seen.size < 20_000) this.seen.set(key, verdict);
    return verdict;
  }
}

/** A near miss for one comment and one keyword list. To check many comments, use KeywordSet. */
export function nearMiss(text: string, keywords: string[]): NearMiss | null {
  return new KeywordSet(keywords).nearMiss(new CommentText(text));
}
