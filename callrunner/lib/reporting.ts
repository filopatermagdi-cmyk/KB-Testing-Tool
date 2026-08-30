import fs from 'fs';
import path from 'path';
import { CFG, OUT_DIR, ROOT, log, resultLabel } from './config';
import type { AttemptResult } from './types';

export function latencyResultLabel(result: AttemptResult): string {
  if (!result.latency || result.latency.maxMs == null) return 'PASS';
  if (result.latency.exceededMax) return 'FAIL';
  return result.latency.warn ? 'WARN' : 'PASS';
}

export function writeLastCallHandoff(result: AttemptResult): void {
  if (!result.callStartedAt) return;
  fs.writeFileSync(
    path.join(OUT_DIR, 'last-call.json'),
    JSON.stringify(
      {
        agentId: result.agentId,
        apiBase: CFG.apiBase,
        appUrl: CFG.appUrl,
        callStartedAt: result.callStartedAt,
        endedAt: new Date().toISOString(),
        conversationId: result.conversationId || null,
      },
      null,
      2,
    ),
  );
}

export function writeRunSummary(result: AttemptResult, stamp: string): string {
  const summaryPath = path.join(OUT_DIR, `summary-${stamp}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(result, null, 2));
  return path.relative(ROOT, summaryPath);
}

export function logRunReport(result: AttemptResult, totalAttempts: number): void {
  const checks = result.checks || [];
  const replies = checks.filter((c) => c.responded).length;
  const zillaReplyPassed = result.flags?.zillaReply === true;
  const transcriptPassed = result.flags?.transcriptSaved === true;
  const recordingPassed = result.flags?.recordingUrl === true;

  log(
    `checks: ${replies}/${checks.length} clips got a reply (attempt ${result.attempt}/${totalAttempts})`,
  );
  if (result.transcript) {
    log(
      `transcript: saved ${result.transcript.nonEmptyTurnCount} turn(s) in ${result.transcript.conversationId}`,
    );
  }
  if (result.recording) {
    log(
      `recording: ${result.recording.hasRecordingUrl ? 'recording_url present' : result.recording.reason}`,
    );
  }
  logLatency(result);
  logBargeIn(result);
  if (result.video) log(`video: ${result.video}`);
  logTranscriptMatch(result);
  log(`ZILLA_REPLY_RESULT=${resultLabel(zillaReplyPassed)}`);
  log(`LATENCY_RESULT=${latencyResultLabel(result)}`);
  log(`TRANSCRIPT_RESULT=${resultLabel(transcriptPassed)}`);
  log(`TRANSCRIPT_MATCH_RESULT=${result.transcriptMatch?.result || 'SKIPPED'}`);
  log(`RECORDING_RESULT=${resultLabel(recordingPassed)}`);
  log(`RESULT=${result.passed ? 'PASS' : `FAIL (${result.reason})`}`);
}

function logLatency(result: AttemptResult): void {
  if (!result.latency || result.latency.maxMs == null) return;
  log(
    `latency: max ${result.latency.maxMs}ms, avg ${result.latency.avgMs}ms ` +
      `(warn>${result.latency.warnMs}ms${
        result.latency.maxAllowedMs ? `, fail>${result.latency.maxAllowedMs}ms` : ''
      })`,
  );
  for (const slowReply of result.latency.slow) {
    log(`  ⚠ slow reply: ${slowReply.clip} ${slowReply.latencyMs}ms`);
  }
}

function logBargeIn(result: AttemptResult): void {
  if (!result.bargeIn) return;
  log(
    `interrupt: deliberate barge-in fired${
      result.bargeIn.zillaWasSpeaking ? ' over zilla mid-reply' : ''
    } — verdict in INTERRUPTION_RESULT below`,
  );
}

function logTranscriptMatch(result: AttemptResult): void {
  if (!result.transcriptMatch || result.transcriptMatch.result === 'SKIPPED') return;
  log(
    `transcript-match: ${result.transcriptMatch.result} — similarity ${result.transcriptMatch.similarity} ` +
      `(live ${result.transcriptMatch.liveCount} vs backend ${result.transcriptMatch.backendCount} turns)`,
  );
}
