/*
 * e2e.ts — CallRunner: true end-to-end call test THROUGH the deployed frontend.
 *
 * Drives a headless Chromium against the real web app exactly as a user would:
 *   login (UI form) -> open an agent's in-browser call -> speak each sentence
 *   into the mic -> assert zilla replies appear in the transcript.
 *
 * This file is the ENTRY POINT: it wires the pieces together (run loop, reporting,
 * summary, exit code) and hosts the offline selftest. The implementation lives in
 * lib/: config (env + tunables), scenario, call, results/reporting, validators,
 * mic-inject (browser code), api, interruption. See CONTRIBUTING.md for the layout.
 *
 * The mic is fed via a getUserMedia override (approach B): before the app loads
 * we replace navigator.mediaDevices.getUserMedia with a synthetic MediaStream we
 * drive clip-by-clip, so we get real turn-taking. Works headless and in CI.
 *
 * PASS = zilla produced a new live transcript message after every clip, then the
 * backend persisted a non-empty customer+agent transcript and recording URL. Exit 0/1.
 *
 *   npm test                         # run the call + interruption check, set exit code
 *   npx tsx e2e.ts --headed          # show the browser (local debugging)
 *   npm run test:interrupt           # ALSO deliberately barge in over zilla (active interruption test)
 *   npx tsx e2e.ts --no-interruption # skip only the interruption classifier
 *   npm run selftest                 # offline: WAV assets parse + validators, no browser
 *
 * Two independent signals: RESULT (zilla replied — gates the exit code) and
 * INTERRUPTION_RESULT (agent handled interruptions — reported, non-blocking).
 * Parseable signals: ZILLA_REPLY_RESULT, LATENCY_RESULT, TRANSCRIPT_RESULT,
 * TRANSCRIPT_MATCH_RESULT, RECORDING_RESULT, INTERRUPTION_RESULT.
 *
 * Config: see .env.example. APP_URL, backend API base, and creds are required.
 */
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import {
  CFG,
  OUT_DIR,
  ROOT,
  VIDEO_DIR,
  RETRIES,
  SKIP_INTERRUPTION,
  TMP_KEEP_RUNS,
  REPLY_LATENCY_WARN_MS,
  log,
} from './lib/config';
import { readWavPcm } from './lib/wav';
import { attemptWithTimeout } from './lib/call';
import { runInterruptionCheck } from './lib/interruption';
import { loadAssetsScenario } from './lib/scenario';
import { logRunReport, writeLastCallHandoff, writeRunSummary } from './lib/reporting';
import { buildZillaResponses, writeZillaResponses } from './lib/zilla-responses';
import { bodyTokens } from './lib/similarity';
import {
  RETRYABLE_REASONS,
  validatePersistedTranscript,
  validatePersistedRecording,
  validatePersistedCallArtifacts,
  evaluateLatency,
  backendReplyLatencies,
  compareTranscripts,
  selectConversationForRun,
} from './lib/validators';
import type { AttemptResult } from './lib/types';

function requireConfig() {
  const missing = [];
  if (!CFG.appUrl) missing.push('APP_URL');
  if (!CFG.email || !CFG.password) missing.push('ZILLA_EMAIL + ZILLA_PASSWORD');
  if (!CFG.apiBase) missing.push('VITE_API_BASE_URL (for agent lookup + transcript persistence)');
  if (missing.length) throw new Error(`missing config: ${missing.join(', ')} — see .env.example`);
}

// Keep only the newest `keep` summaries and videos in tmp/ so runs don't pile up.
function pruneTmpArtifacts(keep: number): void {
  const prune = (dir: string, matches: (f: string) => boolean) => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter(matches);
    } catch {
      return;
    }
    entries
      .map((f) => path.join(dir, f))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(keep)
      .forEach(({ f }) => fs.rmSync(f, { force: true }));
  };
  prune(OUT_DIR, (f) => /^summary-.*\.json$/.test(f));
  prune(OUT_DIR, (f) => /^failure-.*\.png$/.test(f));
  prune(VIDEO_DIR, (f) => f.toLowerCase().endsWith('.webm'));
}

async function main(): Promise<void> {
  requireConfig();
  const scenario = loadAssetsScenario();
  if (!scenario.clips.length) throw new Error('no WAV assets — run: npm run prep');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // A stale handoff would make the interruption step analyze a previous run's call.
  fs.rmSync(path.join(OUT_DIR, 'last-call.json'), { force: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // run id: correlates summary + artifacts
  let result!: AttemptResult; // the retry loop below always runs at least once (total >= 1)
  const total = RETRIES + 1;
  for (let n = 1; n <= total; n++) {
    if (n > 1) log(`retry ${n - 1}/${RETRIES} ...`);
    result = await attemptWithTimeout(scenario, stamp, n);
    result.attempt = n;
    if (result.passed) break;
    log(`attempt ${n}/${total} failed: ${result.reason}`);
    if (!RETRYABLE_REASONS.has(result.reason)) {
      if (n < total)
        log(
          `not retrying — "${result.reason}" looks like a setup/config error, not a flaky failure`,
        );
      break;
    }
  }

  result.env = { appUrl: CFG.appUrl };
  writeLastCallHandoff(result);
  logRunReport(result, total);

  // Signal 2 (interruption handling) — independent, non-blocking. Runs only when a
  // call was actually placed; the zilla-replies verdict still owns the exit code.
  // Its verdict is captured into the summary (below), not just printed.
  if (result.callStartedAt && !SKIP_INTERRUPTION) {
    result.interruption = { result: runInterruptionCheck(result) };
  } else if (SKIP_INTERRUPTION) {
    console.log('INTERRUPTION_RESULT=SKIPPED');
    result.interruption = { result: 'SKIPPED' };
  }

  // Summary written last so it captures every signal, including interruption.
  log(`summary: ${writeRunSummary(result, stamp)}`);
  // Clean, QA-reviewable extract of what zilla actually said on the call.
  log(`zilla-responses: ${path.relative(ROOT, writeZillaResponses(result, OUT_DIR, stamp))}`);
  pruneTmpArtifacts(TMP_KEEP_RUNS);

  process.exit(result.passed ? 0 : 1);
}

function selftest(): void {
  // node:assert, not console.assert — the latter never throws, so the selftest
  // could print "OK" with zero assets and still exit 0.
  const files = loadAssetsScenario().clips;
  assert.ok(files.length > 0, 'no WAV assets — run: npm run prep');
  for (const f of files) {
    const pcm = readWavPcm(f);
    assert.ok(pcm.length > 0 && pcm.length % 2 === 0, `bad PCM in ${path.basename(f)}`);
  }
  assert.ok(
    validatePersistedTranscript({
      id: 'conversation-ok',
      transcription: [
        { speaker: 'customer', text: 'hello' },
        { speaker: 'agent', text: 'welcome' },
      ],
    }).saved,
    'valid transcript should pass',
  );
  assert.strictEqual(
    validatePersistedTranscript({
      id: 'conversation-bad',
      transcription: [{ speaker: 'customer', text: 'hello' }],
    }).saved,
    false,
    'single-speaker transcript should fail',
  );
  assert.ok(
    validatePersistedRecording({
      id: 'conversation-recorded',
      recording_url: 'https://example.test/recording.wav',
    }).saved,
    'recording_url should pass',
  );
  assert.strictEqual(
    validatePersistedRecording({
      id: 'conversation-unrecorded',
    }).saved,
    false,
    'missing recording_url should fail',
  );
  assert.ok(
    validatePersistedCallArtifacts({
      id: 'conversation-complete',
      transcription: [
        { speaker: 'customer', text: 'hello' },
        { speaker: 'agent', text: 'welcome' },
      ],
      recording_url: 'https://example.test/recording.wav',
    }).saved,
    'complete call artifacts should pass',
  );
  assert.strictEqual(
    selectConversationForRun(
      [
        { id: 'older-call', createdAt: '2026-07-07T10:59:50.000Z' },
        { id: 'this-run', createdAt: '2026-07-07T11:00:02.000Z' },
      ],
      '2026-07-07T11:00:00.000Z',
    ).id,
    'this-run',
    'conversation matching should prefer a call created after this run started',
  );
  // --- bodyTokens: drops the opening greeting so conversation matching is reliable ---
  assert.deepStrictEqual(
    bodyTokens([
      { speaker: 'agent', text: 'welcome greeting' }, // greeting -> dropped
      { speaker: 'customer', text: 'track my order' },
      { speaker: 'agent', text: 'sure' },
    ]),
    ['track', 'my', 'order', 'sure'],
    'bodyTokens drops the leading agent greeting',
  );
  assert.deepStrictEqual(
    bodyTokens([
      { speaker: 'agent', text: 'greeting' }, // no customer turn -> drop only the first
      { speaker: 'agent', text: 'anything else' },
    ]),
    ['anything', 'else'],
    'bodyTokens with no customer turn drops just the greeting',
  );
  // --- backend reply latency = customer segment duration - clip duration ---
  const backendTurns = [
    { speaker: 'agent', text: 'greeting', start: 0, end: 2 },
    { speaker: 'customer', text: 'hi', start: 2, end: 5.5 }, // opening: skipped
    { speaker: 'agent', text: 'reply', start: 5.5, end: 8 },
    { speaker: 'customer', text: 'q', start: 8, end: 12 }, // seg 4s - clip 1s = 3s
    { speaker: 'agent', text: 'answer', start: 12, end: 14 },
    { speaker: 'customer', text: 'silent-one', start: 14, end: 17 }, // no reply: skipped
  ];
  assert.deepStrictEqual(
    backendReplyLatencies(backendTurns, [
      { clip: 'a', responded: true, latencyMs: null, clipMs: 2000, responseSignal: 'opening-greeting' },
      { clip: 'b', responded: true, latencyMs: 3000, clipMs: 1000, responseSignal: 'message-count' },
      { clip: 'c', responded: false, latencyMs: null, clipMs: 1500, responseSignal: 'none' },
    ]),
    [3000],
    'backend latency = segment - clip; opening-greeting and no-reply turns excluded',
  );
  // --- latency evaluation ---
  const lat = evaluateLatency([
    { responded: true, latencyMs: 1000 },
    { responded: true, latencyMs: 3000 },
    { responded: false, latencyMs: null },
  ]);
  assert.strictEqual(lat.avgMs, 2000, 'avg latency should ignore non-responders');
  assert.strictEqual(lat.maxMs, 3000, 'max latency');
  assert.strictEqual(lat.warn, false, 'fast replies should not warn');
  assert.strictEqual(
    evaluateLatency([{ responded: true, latencyMs: REPLY_LATENCY_WARN_MS + 1 }]).warn,
    true,
    'a reply past the warn threshold should warn',
  );
  // --- transcript comparison (live vs backend) ---
  assert.strictEqual(
    compareTranscripts(
      [
        { speaker: 'customer', text: 'good morning' },
        { speaker: 'agent', text: 'welcome, how can I help' },
      ],
      [
        { speaker: 'customer', text: 'Good morning.' },
        { speaker: 'agent', text: 'Welcome — how can I help?' },
      ],
    ).result,
    'PASS',
    'near-identical transcripts (case/punctuation only) should match',
  );
  assert.strictEqual(
    compareTranscripts(
      [{ speaker: 'agent', text: 'hello world' }],
      [{ speaker: 'agent', text: 'totally unrelated different content here' }],
    ).result,
    'FAIL',
    'disjoint transcripts should fail',
  );
  assert.strictEqual(
    compareTranscripts([], [{ speaker: 'agent', text: 'x' }]).result,
    'SKIPPED',
    'missing live side should skip',
  );
  // --- zilla-responses extract ---
  const zr = buildZillaResponses({
    agentId: 'a1',
    conversationId: 'c1',
    env: { appUrl: 'https://app.test' },
    passed: true,
    liveTranscript: [{ speaker: 'agent', text: 'live only' }],
    transcript: {
      turns: [
        { speaker: 'customer', text: 'hi' },
        { speaker: 'assistant', text: 'welcome' },
      ],
    },
    checks: [{ clip: 'c1.wav', responded: true, latencyMs: 900, responseSignal: 'message-count' }],
  });
  assert.strictEqual(zr.source, 'backend', 'backend transcript should win over live');
  assert.deepStrictEqual(
    zr.exchanges,
    [{ ours: 'hi', zilla: 'welcome' }],
    'exchanges pair our message with zilla reply',
  );
  assert.strictEqual(
    zr.url,
    'https://app.test/en/agents/a1/conversations/c1',
    'conversation url built from agentId + conversationId',
  );
  // Opening greeting (agent speaks first) → ours: null; trailing caller turn with
  // no reply → zilla: ''.
  assert.deepStrictEqual(
    buildZillaResponses({
      transcript: {
        turns: [
          { speaker: 'assistant', text: 'hello' },
          { speaker: 'customer', text: 'q1' },
          { speaker: 'assistant', text: 'a1' },
          { speaker: 'customer', text: 'bye' },
        ],
      },
    }).exchanges,
    [
      { ours: null, zilla: 'hello' },
      { ours: 'q1', zilla: 'a1' },
      { ours: 'bye', zilla: '' },
    ],
    'greeting → ours:null; unanswered trailing turn → zilla:""',
  );
  assert.strictEqual(
    buildZillaResponses({ liveTranscript: [{ speaker: 'agent', text: 'x' }] }).source,
    'live',
    'falls back to live transcript when nothing persisted',
  );
  log(`selftest OK: ${files.length} clip(s)`);
}

(async () => {
  try {
    if (process.argv.includes('--selftest')) return selftest();
    await main();
  } catch (e: any) {
    console.error(`[callrunner] FAIL: ${e.message}`);
    console.log('RESULT=FAIL (setup)');
    process.exit(1);
  }
})();
