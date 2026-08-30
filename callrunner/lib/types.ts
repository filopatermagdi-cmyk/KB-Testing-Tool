// Shared shapes. Types are erased at runtime — pure documentation + safety.
import type { Browser } from 'playwright';
import type { Turn } from './similarity';

export type Check = {
  clip: string;
  responded: boolean;
  latencyMs: number | null;
  clipMs?: number | null;
  responseSignal?: 'message-count' | 'text-change' | 'opening-greeting' | 'none';
};
export type BargeIn = { attempted: boolean; zillaWasSpeaking: boolean; bargeInClip: string };
export type Ctl = { browser: Browser | null; timedOut: boolean };
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
}
