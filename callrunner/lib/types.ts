// Shared shapes. Types are erased at runtime — pure documentation + safety.
import type { Browser } from 'playwright';
import type { Turn } from './similarity';

export type Check = {
  clip: string;
  responded: boolean;
  latencyMs: number | null;
  clipMs?: number | null;
  responseSignal?: 'message-count' | 'text-change' | 'opening-greeting' | 'none';
  // Additional, non-judgemental signal: time from clip end to the first audio
  // chunk Zilla's voice arrived at (measured from the relay WS audio chunks).
  // Recorded alongside latencyMs — does NOT affect pass/fail or any existing
  // verdict logic.
  latencyMsToFirstAudioChunk?: number | null;
};
// Source provenance Ziila reports for an answer over the relay WS:
// file_ids / loaded_files are the KB file/section ids the answer is grounded on.
export type SourceFrame = {
  at: number;
  fileIds: string[];
  loadedFiles: string[];
  playId: string | null;
};
export type BargeIn = { attempted: boolean; zillaWasSpeaking: boolean; bargeInClip: string };
export type Ctl = {
  browser: Browser | null;
  timedOut: boolean;
  // Best-known attempt progress so far, so a wall-clock timeout doesn't discard
  // the checks/live transcript/call id already captured (e.g. a slow 10-way run).
  partial?: Partial<AttemptResult>;
};
export type Scenario = { name: string; clips: string[] };

// Boundary data from backend JSON is still variable, but the runner-owned summary
// shape below stays explicit so new signals do not drift silently.
export interface ArtifactCheck {
  saved: boolean;
  conversationId: string | null;
  reason: string;
  hasRecordingUrl?: boolean;
  turnCount?: number;
  nonEmptyTurnCount?: number;
  speakerCounts?: Record<string, number>;
  status?: string | null;
  duration?: unknown;
  turns?: Turn[];
}
export interface CallArtifacts {
  saved: boolean;
  conversationId: string | null;
  transcript: ArtifactCheck;
  recording: ArtifactCheck;
  reason: string;
  status?: string | null;
  duration?: unknown;
}
export interface LatencyVerdict {
  maxMs: number | null;
  avgMs: number | null;
  warn: boolean;
  exceededMax: boolean;
  warnMs: number;
  maxAllowedMs: number | null;
  slow: Array<{ clip?: string; latencyMs: number }>;
}
export interface TranscriptMatchVerdict {
  result: 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED';
  reason: string;
  liveCount: number;
  backendCount: number;
  similarity?: number;
  agentSimilarity?: number;
  customerSimilarity?: number;
  threshold?: number;
}
export interface AttemptEvidence {
  agentId: string;
  checks: Check[];
  clipCount: number;
  callStartedAt: string;
  latency: LatencyVerdict;
  bargeIn: BargeIn | null;
  transcriptMatch: TranscriptMatchVerdict;
  liveTranscript: Turn[];
  artifacts: CallArtifacts | null;
  sourceFilesByTurn?: Array<{ turn: number; fileIds: string[]; loadedFiles: string[]; playId: string | null }>;
  sourceFilesUsed?: string[];
  sourceFrameLog?: SourceFrame[];
}
export interface AttemptResult {
  passed: boolean;
  reason: string;
  agentId?: string | null; // absent on the timeout/early-failure fallbacks
  checks: Check[];
  attempt?: number;
  callStartedAt?: string | null;
  conversationId?: string | null;
  env?: { appUrl: string };
  flags?: {
    zillaReply: boolean;
    latencyOk: boolean;
    transcriptSaved: boolean;
    recordingUrl: boolean;
  };
  latency?: LatencyVerdict;
  // Reply latencies (ms) derived from the backend transcript's own timestamps —
  // accurate under load, unlike the DOM-polled checks[].latencyMs. Empty when the
  // backend didn't persist per-turn timings.
  backendLatencyMs?: number[];
  bargeIn?: BargeIn | null;
  transcriptMatch?: TranscriptMatchVerdict;
  liveTranscript?: Turn[];
  artifacts?: CallArtifacts | null;
  transcript?: ArtifactCheck | null;
  recording?: ArtifactCheck | null;
  interruption?: { result: string };
  screenshot?: string;
  video?: string;
  // Per-turn source files Ziila grounded the answer on (relay WS frames),
  // bucketed by reply-detection windows; plus the unique set across the call.
  sourceFilesByTurn?: Array<{ turn: number; fileIds: string[]; loadedFiles: string[]; playId: string | null }>;
  sourceFilesUsed?: string[];
  // Raw relay frames carrying provenance, in arrival order (with epoch ms).
  sourceFrameLog?: SourceFrame[];
}
