// Pure transcript text-normalization + similarity primitives, shared by the
// live-vs-backend transcript comparison in e2e.ts. No config, no I/O -- trivially
// unit-testable, which is why they live here rather than in the driver.

// A single transcript turn from either the live DOM scrape or the backend.
// start/end are seconds from call start — present on backend turns, used to derive
// reply latency from the server's own clock (immune to local detection lag).
export type Turn = { speaker: string; text: string; start?: number | null; end?: number | null };

// Canonicalize a speaker label from either side to 'agent' | 'customer'.
export function canonicalSpeaker(s: unknown): string {
  const v = String(s || '').toLowerCase();
  if (/agent|assistant|ai|bot|zilla|ziila/.test(v)) return 'agent';
  if (/customer|caller|user|human|client/.test(v)) return 'customer';
  return v || 'unknown';
}

// Drop Arabic tatweel (U+0640) and tashkeel diacritics (U+064B-U+0670) so that
// decorated/undecorated spellings of the same word compare equal. Done by code
// point rather than a literal regex class, which mixes combining marks that read
// ambiguously in source (and trips no-misleading-character-class).
function stripArabicMarks(str: string): string {
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0640 || (c >= 0x064b && c <= 0x0670)) continue;
    out += ch;
  }
  return out;
}

// Lowercase, strip Arabic marks + punctuation, collapse whitespace.
export function normalizeText(s: unknown): string {
  return stripArabicMarks(String(s || '').toLowerCase())
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Flatten a transcript (optionally a single speaker) into normalized word tokens.
export function transcriptTokens(turns: Turn[] | null | undefined, speaker?: string): string[] {
  return (turns || [])
    .filter((t) => !speaker || t.speaker === speaker)
    .map((t) => normalizeText(t.text))
    .join(' ')
    .split(' ')
    .filter(Boolean);
}

// Tokens of the conversation BODY — everything after Zilla's fixed opening greeting
// (the leading agent turn(s) before the first customer turn). That greeting is
// byte-identical on every call, so including it makes different scenarios look
// alike; dropping it leaves the distinguishing content (our injected clips + her
// substantive replies) for reliably telling one call's conversation from another.
// If there are no customer turns at all, drop just the first (greeting) turn.
export function bodyTokens(turns: Turn[] | null | undefined, speaker?: string): string[] {
  const list = turns || [];
  let i = 0;
  while (i < list.length && canonicalSpeaker(list[i].speaker) === 'agent') i++;
  const body = i >= list.length ? list.slice(1) : list.slice(i);
  return transcriptTokens(body, speaker);
}

// Multiset token Dice coefficient: 2*|A intersect B| / (|A|+|B|). Order-insensitive,
// so it tolerates live/backend segmentation differences while still catching dropped
// or wrong content. 1 = identical token bags, 0 = disjoint.
export function diceSimilarity(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const t of b) counts.set(t, (counts.get(t) || 0) + 1);
  let inter = 0;
  for (const t of a) {
    const c = counts.get(t) || 0;
    if (c > 0) {
      inter++;
      counts.set(t, c - 1);
    }
  }
  return (2 * inter) / (a.length + b.length);
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;
