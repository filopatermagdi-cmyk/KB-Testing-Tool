import { callGateFailureReason, backendReplyLatencies } from './validators';
import type { AttemptEvidence, AttemptResult, Check } from './types';

export function pendingAttempt(checks: Check[]): AttemptResult {
  return { passed: false, reason: 'unknown', agentId: null, checks };
}

export function failedAttempt(
  reason: string,
  checks: Check[],
  partial: Partial<AttemptResult> = {},
): AttemptResult {
  return { ...partial, passed: false, reason, checks };
}

export function buildAttemptResult(evidence: AttemptEvidence): AttemptResult {
  const repliesPassed =
    evidence.checks.length === evidence.clipCount && evidence.checks.every((c) => c.responded);
  const latencyPassed = !evidence.latency.exceededMax;
  const transcriptPassed = evidence.artifacts?.transcript?.saved === true;
  const recordingPassed = evidence.artifacts?.recording?.saved === true;
  const reason = callGateFailureReason(
    repliesPassed,
    latencyPassed,
    transcriptPassed,
    recordingPassed,
  );

  return {
    passed: repliesPassed && latencyPassed && transcriptPassed && recordingPassed,
    reason,
    agentId: evidence.agentId,
    checks: evidence.checks,
    callStartedAt: evidence.callStartedAt,
    conversationId: evidence.artifacts?.conversationId || null,
    flags: {
      zillaReply: repliesPassed,
      latencyOk: latencyPassed,
      transcriptSaved: transcriptPassed,
      recordingUrl: recordingPassed,
    },
    latency: evidence.latency,
    backendLatencyMs: backendReplyLatencies(
      evidence.artifacts?.transcript?.turns || [],
      evidence.checks,
    ),
    bargeIn: evidence.bargeIn,
    transcriptMatch: evidence.transcriptMatch,
    liveTranscript: evidence.liveTranscript,
    artifacts: evidence.artifacts,
    transcript: evidence.artifacts?.transcript || null,
    recording: evidence.artifacts?.recording || null,
    ...(evidence.sourceFilesByTurn ? { sourceFilesByTurn: evidence.sourceFilesByTurn } : {}),
    ...(evidence.sourceFilesUsed ? { sourceFilesUsed: evidence.sourceFilesUsed } : {}),
    ...(evidence.sourceFrameLog ? { sourceFrameLog: evidence.sourceFrameLog } : {}),
  };
}
