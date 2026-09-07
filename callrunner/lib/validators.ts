// Validation + scoring: does a persisted conversation have a real transcript and
// recording, how fast were the replies, and does the live transcript match the
// backend one. The pure functions here are what selftest exercises offline.
import type { BrowserContext } from 'playwright';
import {
  canonicalSpeaker,
  transcriptTokens,
  bodyTokens,
  diceSimilarity,
  round2,
  type Turn,
} from './similarity';
import type { ArtifactCheck, CallArtifacts, Check, TranscriptMatchVerdict } from './types';
import {
  TRANSCRIPT_MIN_TURNS,
  REPLY_LATENCY_WARN_MS,
  REPLY_LATENCY_MAX_MS,
  TRANSCRIPT_MATCH_MIN,
  TRANSCRIPT_MATCH_WARN,
  CONV_MATCH_MIN,
  CALL_MATCH_SKEW_MS,
  ARTIFACT_WAIT_MS,
  ARTIFACT_POLL_MS,
  log,
} from './config';
import {
  accessTokenFromCookies,
  parseIsoMs,
  sleep,
  fetchRecentConversations,
  fetchConversation,
} from './api';

export function transcriptSpeaker(turn: any): string {
  return String(turn?.speaker || turn?.role || turn?.type || '').toLowerCase();
}

export function transcriptText(turn: any): string {
  return String(turn?.text || turn?.message || turn?.content || turn?.transcript || '').trim();
}

// Backend turns carry timing in seconds-from-call-start. Field names vary
// (start/startTime, end/endTime); read either, return null when absent.
export function transcriptStart(turn: any): number | null {
  const v = turn?.start ?? turn?.startTime ?? turn?.start_time;
  return Number.isFinite(v) ? Number(v) : null;
}
export function transcriptEnd(turn: any): number | null {
  const v = turn?.end ?? turn?.endTime ?? turn?.end_time;
  return Number.isFinite(v) ? Number(v) : null;
}

// Reply latency per turn, load-immune. The backend segments the call into
// CONTIGUOUS turns (each turn's end == the next's start), so a customer turn spans
// from the caller's first word to the moment the agent starts replying. Subtract
// the caller clip's own duration and what's left is the gap = Zilla's reply
// latency. It uses the server's segmentation + the known clip length, so it's
// independent of local detection lag — which balloons the DOM-polled numbers to
// tens of seconds that never happened under high stress concurrency. Customer
// turns pair with the caller clips by order (i-th utterance = i-th clip). Skips
// the opening-greeting turn (Zilla greets first, so its segment runs until she
// resumes — not a real reply; DOM reports null for it too) and clips she never
// answered. ms.
export function backendReplyLatencies(turns: Turn[], checks: Check[]): number[] {
  const customer = turns.filter((t) => canonicalSpeaker(t.speaker) === 'customer');
  const out: number[] = [];
  for (let i = 0; i < customer.length && i < checks.length; i++) {
    const chk = checks[i];
    if (!chk.responded || chk.responseSignal === 'opening-greeting') continue;
    const start = transcriptStart(customer[i]);
    const end = transcriptEnd(customer[i]);
    const clip = chk.clipMs;
    if (start == null || end == null || clip == null || !Number.isFinite(clip)) continue;
    const lat = Math.round((end - start) * 1000 - clip);
    if (lat >= 0) out.push(lat);
  }
  return out;
}

export function validatePersistedTranscript(conversation: any): ArtifactCheck {
  const transcription = Array.isArray(conversation?.transcription)
    ? conversation.transcription
    : [];
  const nonEmpty = transcription.filter((turn: any) => transcriptText(turn));
  const speakerCounts: Record<string, number> = {};
  for (const turn of nonEmpty) {
    const speaker = transcriptSpeaker(turn) || 'unknown';
    speakerCounts[speaker] = (speakerCounts[speaker] || 0) + 1;
  }
  // Same speaker classification as the transcript comparison — reuse canonicalSpeaker
  // so "what identifies agent vs customer" stays defined in exactly one place.
  const hasCustomer = nonEmpty.some(
    (turn: any) => canonicalSpeaker(transcriptSpeaker(turn)) === 'customer',
  );
  const hasAgent = nonEmpty.some(
    (turn: any) => canonicalSpeaker(transcriptSpeaker(turn)) === 'agent',
  );

  const details = {
    saved: false,
    conversationId: conversation?.id || null,
    turnCount: transcription.length,
    nonEmptyTurnCount: nonEmpty.length,
    speakerCounts,
    status: conversation?.status || null,
    duration: conversation?.duration ?? null,
    turns: nonEmpty.map((turn: any) => ({
      speaker: canonicalSpeaker(transcriptSpeaker(turn)),
      text: transcriptText(turn),
      start: transcriptStart(turn),
      end: transcriptEnd(turn),
    })),
  };

  if (nonEmpty.length < TRANSCRIPT_MIN_TURNS) {
    return {
      ...details,
      reason: `persisted transcript has ${nonEmpty.length}/${TRANSCRIPT_MIN_TURNS} non-empty turn(s)`,
    };
  }
  if (!hasCustomer || !hasAgent) {
    return {
      ...details,
      reason: 'persisted transcript does not contain both customer and agent turns',
    };
  }
  return { ...details, saved: true, reason: 'ok' };
}

export function validatePersistedRecording(conversation: any): ArtifactCheck {
  const recordingUrl =
    typeof conversation?.recording_url === 'string' ? conversation.recording_url.trim() : '';
  return {
    saved: Boolean(recordingUrl),
    conversationId: conversation?.id || null,
    hasRecordingUrl: Boolean(recordingUrl),
    reason: recordingUrl ? 'ok' : 'persisted conversation has no recording_url',
  };
}

export function validatePersistedCallArtifacts(conversation: any): CallArtifacts {
  const transcript = validatePersistedTranscript(conversation);
  const recording = validatePersistedRecording(conversation);
  const saved = transcript.saved && recording.saved;
  return {
    saved,
    conversationId: conversation?.id || null,
    status: conversation?.status || null,
    duration: conversation?.duration ?? null,
    transcript,
    recording,
    reason: saved
      ? 'ok'
      : [transcript, recording]
          .filter((v) => !v.saved)
          .map((v) => v.reason)
          .join('; '),
  };
}

// Reply-latency verdict from the per-clip timings. Pure function (unit-tested in
// selftest). WARN is informational; only REPLY_LATENCY_MAX_MS (if set) can fail.
export function evaluateLatency(
  checks: Array<{ responded: boolean; latencyMs: number | null; clip?: string }>,
) {
  const lat = checks
    .filter((c) => c.responded && Number.isFinite(c.latencyMs))
    .map((c) => c.latencyMs as number);
  const slow = checks
    .filter(
      (c) =>
        c.responded &&
        Number.isFinite(c.latencyMs) &&
        (c.latencyMs as number) > REPLY_LATENCY_WARN_MS,
    )
    .map((c) => ({ clip: c.clip, latencyMs: c.latencyMs as number }));
  const maxMs = lat.length ? Math.max(...lat) : null;
  const avgMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  const exceededMax = REPLY_LATENCY_MAX_MS > 0 && maxMs != null && maxMs > REPLY_LATENCY_MAX_MS;
  return {
    maxMs,
    avgMs,
    warnMs: REPLY_LATENCY_WARN_MS,
    maxAllowedMs: REPLY_LATENCY_MAX_MS || null,
    slow,
    warn: slow.length > 0,
    exceededMax,
  };
}

// Compare the live in-call transcript to the backend-persisted one. Non-blocking:
// returns a verdict + similarity, never throws. SKIPPED when either side is empty.
export function compareTranscripts(live: Turn[], backend: Turn[]): TranscriptMatchVerdict {
  const liveOk = Array.isArray(live) && live.length > 0;
  const beOk = Array.isArray(backend) && backend.length > 0;
  if (!liveOk || !beOk) {
    return {
      result: 'SKIPPED',
      reason: !liveOk ? 'no live transcript captured' : 'no backend transcript to compare',
      liveCount: (live || []).length,
      backendCount: (backend || []).length,
    };
  }
  const overall = round2(diceSimilarity(transcriptTokens(live), transcriptTokens(backend)));
  const agent = round2(
    diceSimilarity(transcriptTokens(live, 'agent'), transcriptTokens(backend, 'agent')),
  );
  const customer = round2(
    diceSimilarity(transcriptTokens(live, 'customer'), transcriptTokens(backend, 'customer')),
  );
  const result: TranscriptMatchVerdict['result'] =
    overall >= TRANSCRIPT_MATCH_MIN ? 'PASS' : overall >= TRANSCRIPT_MATCH_WARN ? 'WARN' : 'FAIL';
  return {
    result,
    similarity: overall,
    agentSimilarity: agent,
    customerSimilarity: customer,
    liveCount: live.length,
    backendCount: backend.length,
    threshold: TRANSCRIPT_MATCH_MIN,
    reason: `similarity ${overall} (agent ${agent}, customer ${customer}) vs min ${TRANSCRIPT_MATCH_MIN}`,
  };
}

export function callGateFailureReason(
  repliesPassed: boolean,
  latencyPassed: boolean,
  transcriptPassed: boolean,
  recordingPassed: boolean,
): string {
  if (!repliesPassed) return 'silent-clip';
  if (!latencyPassed) return 'reply-too-slow';
  if (!transcriptPassed) return 'transcript-not-saved';
  if (!recordingPassed) return 'recording-url-missing';
  return 'ok';
}

// Only these failure reasons are worth a retry — they're plausibly transient
// (flaky AI, persistence lag, a hung attempt). Setup/config errors (bad creds,
// changed selectors, missing assets) are deterministic, so retrying just burns
// another few minutes to fail the same way.
export const RETRYABLE_REASONS = new Set([
  'silent-clip',
  'reply-too-slow',
  'transcript-not-saved',
  'recording-url-missing',
  'attempt-timeout',
]);

export function selectConversationForRun(
  rows: any[],
  callStartedAt: string | null | undefined,
): any {
  const startMs = parseIsoMs(callStartedAt);
  const minMs = startMs == null ? null : startMs - CALL_MATCH_SKEW_MS;
  const withTimestamps = rows
    .map((row: any) => ({
      row,
      createdMs: parseIsoMs(row?.createdAt || row?.callStartedAt),
    }))
    .filter((entry) => entry.row?.id && entry.createdMs != null);

  if (startMs != null) {
    const afterStart = withTimestamps
      .filter((entry) => entry.createdMs! >= startMs)
      .sort((a, b) => a.createdMs! - b.createdMs!);
    if (afterStart.length) return afterStart[0].row;
  }

  const skewMatches = withTimestamps
    .filter((entry) => minMs == null || entry.createdMs! >= minMs)
    .sort(
      (a, b) =>
        Math.abs(a.createdMs! - (startMs ?? a.createdMs!)) -
        Math.abs(b.createdMs! - (startMs ?? b.createdMs!)),
    );
  if (skewMatches.length) return skewMatches[0].row;

  return rows.find((row: any) => row?.id) || null;
}

// All plausible conversations for THIS run (created at/after the call start minus
// clock skew), nearest-start-first. Unlike selectConversationForRun this returns
// the whole candidate list so the caller can break time-based ties by content —
// essential under concurrency, where N calls to one agent all match by time and
// the earliest-after-start pick collides (several runs grab the same row).
export function rankConversationCandidates(
  rows: any[],
  callStartedAt: string | null | undefined,
): any[] {
  const startMs = parseIsoMs(callStartedAt);
  const minMs = startMs == null ? null : startMs - CALL_MATCH_SKEW_MS;
  return rows
    .map((row: any) => ({ row, createdMs: parseIsoMs(row?.createdAt || row?.callStartedAt) }))
    .filter((e) => e.row?.id && e.createdMs != null && (minMs == null || e.createdMs! >= minMs))
    .sort(
      (a, b) =>
        Math.abs(a.createdMs! - (startMs ?? a.createdMs!)) -
        Math.abs(b.createdMs! - (startMs ?? b.createdMs!)),
    )
    .map((e) => e.row);
}

export async function waitForPersistedCallArtifacts(
  context: BrowserContext,
  agentId: string,
  callStartedAt: string,
  liveTranscript: Turn[] = [],
  knownConversationId: string | null = null,
): Promise<CallArtifacts> {
  const token = accessTokenFromCookies(await context.cookies());
  if (!token) throw new Error('no accessToken cookie before call artifact persistence check');

  // The WS relay announced this call's conversation id in its first frame
  // ({"type":"session","sessionId":...}) — that id IS the backend conversation id,
  // so there is no need to identify the call by body similarity or risk grabbing a
  // sibling's row. Fetch it directly. Give the backend a short grace to persist
  // the transcript/recording, but ALWAYS return the conversationId so the run can
  // link to the call even when the transcript has not landed yet.
  if (knownConversationId) {
    const graceMs = Math.min(ARTIFACT_WAIT_MS, 30000);
    const deadline = Date.now() + graceMs;
    let last = 'no backend transcript yet';
    while (Date.now() <= deadline) {
      try {
        const row = await fetchConversation(context, token, knownConversationId);
        const verdict = validatePersistedCallArtifacts(row || {});
        if (verdict.saved) return verdict;
        last = verdict.reason;
      } catch (e: any) {
        last = e.message;
      }
      await sleep(ARTIFACT_POLL_MS);
    }
    log(
      `early conversation id ${knownConversationId} known; transcript not persisted within ${graceMs}ms grace: ${last}`,
    );
    return {
      saved: false,
      conversationId: knownConversationId,
      status: null,
      duration: null,
      transcript: { saved: false, reason: last, conversationId: knownConversationId },
      recording: { saved: false, hasRecordingUrl: false, reason: last, conversationId: knownConversationId },
      reason: `call link ready (conversation ${knownConversationId}); STT transcript still persisting at the backend: ${last}`,
    };
  }

  const deadline = Date.now() + ARTIFACT_WAIT_MS;
  let last = 'no conversation rows returned';
  let latestVerdict: CallArtifacts | null = null;
  // Correlate by the conversation BODY (everything after Zilla's fixed opening
  // greeting): our injected clips + her substantive replies uniquely identify THIS
  // call's conversation. Including the greeting collided badly under concurrency —
  // it's identical on every call, so sibling conversations scored high and calls
  // grabbed each other's (wrong URL/transcript, spurious WARNs). Body tokens carry
  // signal even when the live customer scrape came up empty (short calls under
  // load), so those still route through the confidence-gated match below instead of
  // a blind time pick. Ties (same scenario across rounds) can't arise: prior rounds'
  // conversations are excluded by createdAt (a call's conversation is created after
  // it starts). Empty body (no transcript scraped) falls back to the time pick.
  const liveTokens = bodyTokens(liveTranscript);
  const disambiguate = liveTokens.length > 0;
  while (Date.now() <= deadline) {
    try {
      const rows = await fetchRecentConversations(context, token, agentId);
      if (!disambiguate) {
        const row = selectConversationForRun(rows, callStartedAt);
        if (!row) {
          last = 'no matching conversation found for this run';
        } else {
          const verdict = validatePersistedCallArtifacts(
            await fetchConversation(context, token, row.id),
          );
          if (verdict.saved) return verdict;
          latestVerdict = verdict;
          last = `conversation ${row.id}: ${verdict.reason}`;
        }
      } else {
        // Consider only SAVED candidates and match on the conversation body.
        // rankConversationCandidates already excludes conversations created before
        // this call started (a call's conversation is always created after it), so
        // a prior round's same-scenario conversation is never in the pool.
        let best: CallArtifacts | null = null;
        let bestSim = -1;
        for (const row of rankConversationCandidates(rows, callStartedAt)) {
          const verdict = validatePersistedCallArtifacts(
            await fetchConversation(context, token, row.id),
          );
          const turns = verdict.transcript.turns || [];
          if (!turns.length || !verdict.saved) continue;
          const sim = diceSimilarity(liveTokens, bodyTokens(turns));
          if (sim > bestSim) {
            bestSim = sim;
            best = verdict;
          }
          if (sim >= TRANSCRIPT_MATCH_MIN) break; // unmistakably ours
        }
        // Only claim a conversation on a CONFIDENT body match. A different scenario
        // (greeting excluded) scores near zero, so rather than grab a sibling's
        // conversation before ours has persisted, keep polling until our own (body
        // sim ~1.0) shows up. If it never does within the window we return the
        // not-found stub below (an honest transcript-not-saved) instead of a
        // misattributed sibling.
        if (best && bestSim >= CONV_MATCH_MIN) return best;
        last = best
          ? `best body match sim ${round2(bestSim)} < ${CONV_MATCH_MIN} (conversation ${best.conversationId}) — our own not persisted yet`
          : 'no candidate conversation has a transcript yet';
      }
    } catch (e: any) {
      last = e.message;
    }
    await sleep(ARTIFACT_POLL_MS);
  }
  return (
    latestVerdict || {
      saved: false,
      conversationId: null,
      status: null,
      duration: null,
      transcript: { saved: false, reason: last, conversationId: null },
      recording: { saved: false, hasRecordingUrl: false, reason: last, conversationId: null },
      reason: `call artifacts not ready after ${ARTIFACT_WAIT_MS}ms: ${last}`,
    }
  );
}
