// A clean, QA-reviewable extract of "what zilla said" on a call — pulled out of
// the big diagnostic summary so a human (or the QA team) can eyeball a call
// without wading through the full AttemptResult blob.
//
// PURE builder + a thin writer that takes an explicit output dir, so any tool can
// reuse it: CallRunner writes its per-run summary, but a stress/other runner can
// import buildZillaResponses() and write wherever it likes (same reuse pattern as
// similarity.ts, already imported by ../../StressRunner).
import fs from 'fs';
import path from 'path';
import { canonicalSpeaker, type Turn } from './similarity';

// Minimal shape we read. Matches AttemptResult (and the summary-*.json on disk),
// but kept loose so any tool with the same fields can pass its own object.
export interface ZillaResponseSource {
  agentId?: string | null;
  conversationId?: string | null;
  callStartedAt?: string | null;
  passed?: boolean;
  reason?: string;
  env?: { appUrl?: string };
  liveTranscript?: Turn[] | null;
  transcript?: { turns?: Turn[] } | null;
  checks?: Array<{
    clip: string;
    responded: boolean;
    latencyMs: number | null;
    responseSignal?: string;
  }>;
}

export interface ZillaResponses {
  agentId: string | null;
  conversationId: string | null;
  url: string; // clickable conversation link, '' when not resolvable
  callStartedAt: string | null;
  passed: boolean;
  reason: string;
  // Which transcript the conversation came from: 'backend' is the persisted
  // ground truth; 'live' is the in-call DOM scrape (fallback when nothing was
  // persisted yet); 'none' means no transcript at all.
  source: 'backend' | 'live' | 'none';
  conversation: Turn[]; // full exchange, chronological, canonical speakers
  // Paired for review: each object is our caller message + zilla's response to it.
  // `ours` is null for zilla's opening greeting (she speaks before we do); `zilla`
  // is '' if she never replied to that turn.
  exchanges: Array<{ ours: string | null; zilla: string }>;
  replies: Array<{
    clip: string;
    responded: boolean;
    latencyMs: number | null;
    signal?: string;
  }>;
}

function conversationUrl(s: ZillaResponseSource, locale: string): string {
  const appUrl = s.env?.appUrl || '';
  const agentId = s.agentId || '';
  const conversationId = s.conversationId || '';
  return appUrl && agentId && conversationId
    ? `${appUrl}/${locale}/agents/${agentId}/conversations/${conversationId}`
    : '';
}

// Pair the conversation into {ours, zilla} exchanges. Collapse consecutive
// same-speaker turns first, then each caller turn opens an exchange the next agent
// turn closes. A leading agent turn (opening greeting) becomes {ours: null, ...}.
function pairExchanges(conversation: Turn[]): Array<{ ours: string | null; zilla: string }> {
  const segs: Turn[] = [];
  for (const t of conversation) {
    const last = segs[segs.length - 1];
    if (last && last.speaker === t.speaker) last.text += ' ' + t.text;
    else segs.push({ speaker: t.speaker, text: t.text });
  }
  const exchanges: Array<{ ours: string | null; zilla: string }> = [];
  let cur: { ours: string | null; zilla: string } | null = null;
  for (const s of segs) {
    if (s.speaker === 'agent') {
      if (cur) {
        cur.zilla = s.text;
        exchanges.push(cur);
        cur = null;
      } else {
        exchanges.push({ ours: null, zilla: s.text }); // opening greeting
      }
    } else {
      if (cur) exchanges.push(cur); // previous caller turn got no reply
      cur = { ours: s.text, zilla: '' };
    }
  }
  if (cur) exchanges.push(cur); // trailing caller turn with no reply
  return exchanges;
}

// Extract the clean review object. Prefers the backend-persisted transcript
// (ground truth) and falls back to the live DOM scrape when nothing persisted.
export function buildZillaResponses(s: ZillaResponseSource, locale = 'en'): ZillaResponses {
  const backend = (s.transcript?.turns || []).filter((t) => t && t.text);
  const live = (s.liveTranscript || []).filter((t) => t && t.text);
  const raw = backend.length ? backend : live;
  const source: ZillaResponses['source'] = backend.length ? 'backend' : live.length ? 'live' : 'none';
  const conversation = raw.map((t) => ({ speaker: canonicalSpeaker(t.speaker), text: t.text }));
  return {
    agentId: s.agentId ?? null,
    conversationId: s.conversationId ?? null,
    url: conversationUrl(s, locale),
    callStartedAt: s.callStartedAt ?? null,
    passed: s.passed === true,
    reason: s.reason ?? '',
    source,
    conversation,
    exchanges: pairExchanges(conversation),
    replies: (s.checks || []).map((c) => ({
      clip: c.clip,
      responded: c.responded,
      latencyMs: c.latencyMs,
      signal: c.responseSignal,
    })),
  };
}

// Write the review file into `outDir` and return its path. Caller owns the dir
// and run id so this isn't tied to any one tool's layout.
export function writeZillaResponses(
  s: ZillaResponseSource,
  outDir: string,
  stamp: string,
  locale = process.env.APP_LOCALE || 'en',
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `zilla-responses-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(buildZillaResponses(s, locale), null, 2));
  return file;
}
