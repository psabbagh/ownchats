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

/** A message's words alone: NFKC, lower case, apostrophes dropped ("I'm" = "Im"), anything else that isn't a letter or digit as a space. */
function wordsOnly(text: string): string {
  return normalise(text).replace(/['\u2019]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Emoji and symbols alone, for a phrase with no words in it (🙌): spaces, punctuation and variation selectors dropped. */
function symbolsOnly(text: string): string {
  return normalise(text).replace(/[\s\p{P}\uFE0E\uFE0F]+/gu, "");
}

/**
 * Whether the whole message is one of these phrases, ignoring case, punctuation and
 * emoji: "Send the guide!" and "send the guide 🙏" say "Send the guide", while
 * "can you send the guide" does not. A phrase made only of emoji (🙌) must be the
 * whole message, emoji and all.
 */
export function saysExactly(text: string, phrases: string[]): boolean {
  const words = wordsOnly(text);
  return phrases.some((phrase) => {
    const want = wordsOnly(phrase);
    if (want) return want === words;
    const symbols = symbolsOnly(phrase);
    return symbols !== "" && !words && symbols === symbolsOnly(text);
  });
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
  /** Its words for the comment rule, or null when it is too long to be answered by itself. */
  readonly ruleWords: string[] | null;
  constructor(raw: string) {
    this.text = normalise(raw);
    this.words = (this.text.match(WORD) ?? []).slice(0, NEAR_MISS_WORDS);
    this.ruleWords = ruleWords(this.text);
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
  private readonly rule: CommentRule;

  constructor(keywords: string[]) {
    this.keywords = keywords;
    this.rule = new CommentRule(keywords);
    this.prepared = keywords
      .map((raw) => {
        const flat = normalise(raw).replace(GAP, "");
        return { raw, flat, tol: tolerance(flat.length) };
      })
      .filter((k) => k.flat.length >= 3);
    this.minLength = Math.min(...this.prepared.map((k) => k.flat.length - k.tol));
    this.maxLength = Math.max(...this.prepared.map((k) => k.flat.length + k.tol));
  }

  /** Whether the comment rule answers this comment (see CommentRule). */
  matches(t: CommentText): boolean {
    return this.rule.strength(t.text, t.ruleWords) !== null;
  }

  /** Whether the comment rule answers this comment with a keyword spelled exactly, as shortcuts need. */
  matchesExactly(t: CommentText): boolean {
    return this.rule.strength(t.text, t.ruleWords) === "exact";
  }

  /** Whether the comment holds a keyword as a whole word anywhere, however long it is. */
  contains(t: CommentText): boolean {
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
    return this.matches(t) || this.contains(t) ? null : this.closeTo(t);
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

/** How many words besides the keyword a comment may hold and still be answered by itself. */
export const MAX_OTHER_WORDS = 3;
/** A comment with more words than this can't be short enough, whatever it says. */
const MAX_COMMENT_WORDS = 40;
const MENTION = /@[\p{L}\p{N}._]+/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** How a comment matched: its letters spell the keyword ("exact"), or are one letter off ("typo"). */
export type Strength = "exact" | "typo";

/** A keyword as the comment rule reads it: its letters and digits run together, and the typos allowed. */
interface RuleKeyword {
  flat: string;
  tol: number;
}

/** Typos a comment may make and still be answered: one, and only in a keyword of 5 letters or more. */
function autoTolerance(length: number): number {
  return length >= 5 ? 1 : 0;
}

/** The words of a comment for the comment rule: no @mentions, no emoji or punctuation; null when it is too long to count. */
function ruleWords(normalised: string): string[] | null {
  const words = normalised.replace(MENTION, " ").match(WORD) ?? [];
  return words.length > MAX_COMMENT_WORDS ? null : words;
}

/**
 * The comment rule: a comment is answered when it is the keyword, give or take a
 * few words. Emoji, punctuation, @mentions and repeats of the keyword don't count,
 * and up to MAX_OTHER_WORDS other words may sit around it, so "listen listen
 * listen", "Listen 🙌" and "yes listen please" match LISTEN, and "So now I have
 * to read instead listen?" does not. Spacing doesn't matter ("list en", "l i s t
 * e n", "setup" for SET UP), and in a keyword of 5 letters or more one letter may
 * be off ("lisen", "listten", "litsen"). Keywords with no letters or digits (🙌)
 * match anywhere, as before.
 */
class CommentRule {
  private readonly words: RuleKeyword[] = [];
  private readonly symbols: string[] = [];

  constructor(keywords: string[]) {
    for (const raw of keywords) {
      const canon = canonical(raw);
      if (!canon) continue;
      if (!LETTER_OR_DIGIT.test(canon)) {
        this.symbols.push(raw);
        continue;
      }
      const flat = (canon.match(WORD) ?? []).join("");
      this.words.push({ flat, tol: autoTolerance(flat.length) });
    }
  }

  strength(normalised: string, words: string[] | null): Strength | null {
    if (this.symbols.length && matchesNormalised(normalised, this.symbols)) return "exact";
    if (!this.words.length || !words) return null;
    let other = 0;
    let exact = false;
    let typo = false;
    for (let i = 0; i < words.length; ) {
      let span = this.exactAt(words, i);
      if (span) exact = true;
      // "a listen" is a word and then LISTEN, not "alisten" one letter off.
      else if (!this.exactAt(words, i + 1) && (span = this.typoAt(words, i))) typo = true;
      if (span) i += span;
      else {
        if (++other > MAX_OTHER_WORDS) return null;
        i++;
      }
    }
    return exact ? "exact" : typo ? "typo" : null;
  }

  /** How many words, from word `i`, spell out a keyword exactly ("list en"), or 0. */
  private exactAt(words: string[], i: number): number {
    for (const k of this.words) {
      let joined = "";
      for (let j = i; j < words.length; j++) {
        joined += words[j];
        if (joined.length > k.flat.length) break;
        if (joined === k.flat) return j - i + 1;
      }
    }
    return 0;
  }

  /** How many words (one or two), from word `i`, spell a keyword one letter off ("lisen", "lis tten"), or 0. */
  private typoAt(words: string[], i: number): number {
    for (const k of this.words) {
      if (!k.tol) continue;
      let joined = "";
      for (let j = i; j < words.length && j < i + 2; j++) {
        joined += words[j];
        if (joined.length > k.flat.length + k.tol) break;
        if (editDistanceWithin(joined, k.flat, k.tol) <= k.tol) return j - i + 1;
      }
    }
    return 0;
  }
}

/** How a comment matches these keywords under the comment rule (see CommentRule), or null. */
export function commentMatch(text: string, keywords: string[]): Strength | null {
  const normalised = normalise(text);
  return new CommentRule(keywords).strength(normalised, ruleWords(normalised));
}

/** A near miss for one comment and one keyword list. To check many comments, use KeywordSet. */
export function nearMiss(text: string, keywords: string[]): NearMiss | null {
  return new KeywordSet(keywords).nearMiss(new CommentText(text));
}
