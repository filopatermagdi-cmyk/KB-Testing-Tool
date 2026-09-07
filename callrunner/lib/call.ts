// The call driver: drive a headless browser through login -> open call -> preload
// clips -> speak each clip -> validate persistence, and race the whole attempt
// against a wall-clock timeout. attemptWithTimeout() is the entry the runner calls.
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, Page, Locator } from 'playwright';
import type { Turn } from './similarity';
import type { Check, BargeIn, Ctl, CallArtifacts, AttemptResult, Scenario, SourceFrame } from './types';
import {
  CFG,
  SEL,
  ROUTES,
  fillRoute,
  log,
  ROOT,
  OUT_DIR,
  VIDEO_DIR,
  SAMPLE_RATE,
  HEADED,
  RECORD_VIDEO,
  VIDEO_ALWAYS,
  INTERRUPT,
  NAV_TIMEOUT_MS,
  CALL_START_MS,
  TURN_TIMEOUT_MS,
  OPENING_REPLY_WAIT_MS,
  SETTLE_MS,
  ROUTE_PROBE_MS,
  POLL_MS,
  REPLY_MIN_LATENCY_MS,
  ATTEMPT_TIMEOUT_MS,
} from './config';
import { readWavPcm } from './wav';
import { micOverrideInit } from './mic-inject';
import { pickFirstAgentId, fetchRemainingConversations } from './api';
import { evaluateLatency, compareTranscripts, waitForPersistedCallArtifacts } from './validators';
import { buildAttemptResult, failedAttempt, pendingAttempt } from './results';

type BrowserSession = { browser: Browser; context: BrowserContext; page: Page };
type ActiveCall = {
  callStartedAt: string;
  endBtn: Locator;
  zillaMsgs: Locator;
  conversationId: string | null;
  sources: SourceFrame[];
  audioFrames: { at: number; bytes: number }[];
};
type AttemptProgress = Pick<AttemptResult, 'agentId' | 'callStartedAt'>;
type AgentSnapshot = { count: number; fingerprint: string };
type ReplySignal = NonNullable<Check['responseSignal']>;
type ReplyWaitResult = { responded: boolean; latencyMs: number | null; signal: ReplySignal };
type AudioFrame = { at: number; bytes: number };

function scenarioFromInput(input: Scenario | string[]): Scenario {
  return Array.isArray(input) ? { name: 'assets', clips: input } : input;
}

async function launchBrowser(ctl: Ctl): Promise<Browser> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      // No fake media device: if our injected mic fails, getUserMedia should fail
      // loudly instead of recording Chrome's synthetic beep as a false "call".
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  ctl.browser = browser;
  return browser;
}

async function createCallContext(browser: Browser): Promise<BrowserContext> {
  if (RECORD_VIDEO) fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const contextOptions: any = { permissions: ['microphone'] };
  if (RECORD_VIDEO) contextOptions.recordVideo = { dir: VIDEO_DIR };
  return browser.newContext(contextOptions);
}

async function installMicOverride(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    'globalThis.__name = globalThis.__name || function (f) { return f; };',
  );
  await context.addInitScript(micOverrideInit);
}

async function createCallPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  page.on('console', (m) => {
    if (m.type() === 'error') log('page-error:', m.text());
  });
  // Surface the actual reason a call fails to connect. Without this, a call that
  // never reaches the in-call state only reports "End button not visible" — which
  // hides WHY. A 4xx/5xx or a failed request to the API/relay here means the call
  // couldn't be established server-side (staging problem, not our automation);
  // silence here with a mic/JS error above means it's client-side.
  page.on('requestfailed', (r) =>
    log('req-failed:', r.method(), r.url(), '-', r.failure()?.errorText || ''),
  );
  page.on('response', (r) => {
    if (r.status() >= 400) log(`http-${r.status()}:`, r.request().method(), r.url());
  });
  // The call is WebRTC/WebSocket to the relay. If NO ws opens after clicking
  // Start, the click never triggered the call (client/selector). If one opens
  // then errors/closes, the relay refused it. If it opens and just hangs (no
  // End button, no close), the relay accepted but never completed — server-side.
  page.on('websocket', (ws) => {
    log('ws-open:', ws.url());
    ws.on('socketerror', (e) => log('ws-error:', ws.url(), String(e)));
    ws.on('close', () => log('ws-close:', ws.url()));
  });
  return page;
}

async function createBrowserSession(ctl: Ctl): Promise<BrowserSession> {
  const browser = await launchBrowser(ctl);
  const context = await createCallContext(browser);
  await installMicOverride(context);
  const page = await createCallPage(context);
  return { browser, context, page };
}

async function closeContextAndKeepFailureVideo(
  page: Page,
  context: BrowserContext,
  passed: boolean,
  runId: string,
  n: number,
  keepEvenIfPassed = false,
): Promise<string | undefined> {
  const video = RECORD_VIDEO ? page.video() : null;
  await context.close().catch(() => {});
  if (!video) return undefined;

  // Delete a passing call's video UNLESS it's worth reviewing — a failure, an
  // explicit VIDEO_ALWAYS, or a transcript live/backend mismatch (keepEvenIfPassed).
  // Doing the delete here, in-process, lets Playwright manage its own file handle
  // (reliable) instead of a caller racing the OS for a just-released lock.
  if (passed && !VIDEO_ALWAYS && !keepEvenIfPassed) {
    await video.delete().catch((e: any) => log(`could not delete passing video: ${e.message}`));
    return undefined;
  }

  let videoPath = await video.path().catch(() => null);
  if (!videoPath) return undefined;
  // Rename off Playwright's hash to the run id so it correlates with the summary.
  const named = path.join(VIDEO_DIR, `${runId}-a${n}.webm`);
  try {
    fs.renameSync(videoPath, named);
    videoPath = named;
  } catch {
    /* keep original if rename fails */
  }
  const relativeVideoPath = path.relative(ROOT, videoPath);
  const label = !passed
    ? 'failure video'
    : keepEvenIfPassed
      ? 'transcript-mismatch video'
      : 'video (VIDEO_ALWAYS)';
  log(`${label}: ${relativeVideoPath}`);
  return relativeVideoPath;
}

// Log in through the deployed UI. Throws with a diagnostic message pointing at
// the likely cause (bad creds / URL / stale login selectors) so a failure here
// is self-explanatory in CI logs.
async function loginThroughUI(page: Page): Promise<void> {
  log(`opening ${CFG.appUrl}`);
  try {
    await page.goto(`${CFG.appUrl}${fillRoute(ROUTES.login, { locale: `/${CFG.locale}` })}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator(SEL.email).fill(CFG.email!); // presence guaranteed by requireConfig()
    await page.locator(SEL.password).fill(CFG.password!);
    await page.locator(SEL.submit).click();
    await page.waitForURL((u: URL) => !u.pathname.includes('/auth/login'), {
      timeout: NAV_TIMEOUT_MS,
    });
  } catch (e: any) {
    throw new Error(
      `login failed (${e.message.split('\n')[0]}) — check ZILLA_EMAIL/ZILLA_PASSWORD ` +
        `and APP_URL, or the login selectors in SEL (email/password/submit) if the form markup changed`,
      { cause: e },
    );
  }
  log(`logged in (at ${page.url()})`);
}

// Navigate to the in-browser call page and return the (visible) Start button.
// Locale is an OPTIONAL route param ({-$locale}) — the default locale is omitted
// from the URL. Detect it from the post-login path, and try the known route
// shapes until the start button appears. Throws if none match.
async function openCallPage(page: Page, agentId: string): Promise<Locator> {
  const seg = new URL(page.url()).pathname.split('/').filter(Boolean);
  const loc = /^[a-z]{2}$/.test(seg[0] || '') ? `/${seg[0]}` : '';
  const startBtn = page.locator(SEL.startCall);
  const candidates = ROUTES.call.map(
    (tpl) => `${CFG.appUrl}${fillRoute(tpl, { locale: loc, agentId })}`,
  );
  for (const url of candidates) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await startBtn.waitFor({ state: 'visible', timeout: ROUTE_PROBE_MS });
      log(`call page: ${url}`);
      return startBtn;
    } catch {
      /* try next candidate */
    }
  }
  throw new Error(
    `call start button (SEL.startCall="${SEL.startCall}") not found at any known ` +
      `route (last: ${page.url()}) — the call-page route or button markup may have changed`,
  );
}

// Load every caller clip into the page as base64 PCM, keyed by index, so the
// turn loop can trigger each by index with no further I/O mid-call.
async function preloadClips(page: Page, playlist: string[]): Promise<void> {
  for (let i = 0; i < playlist.length; i++) {
    const b64 = readWavPcm(playlist[i]).toString('base64');
    await page.evaluate(({ i, b64, sr }) => (window as any).__cr.load(i, b64, sr), {
      i,
      b64,
      sr: SAMPLE_RATE,
    });
  }
}

async function agentSnapshot(zillaMsgs: Locator): Promise<AgentSnapshot> {
  // SEL.zillaMsg matches Zilla's avatar <img>, one per agent message — an <img>
  // has no text, so allTextContents() here returned all empty strings and the
  // count was always 0 (reply detection never fired). Read each message's actual
  // text from the sibling <p dir="auto">, same as scrapeLiveTranscript.
  const texts = (
    await zillaMsgs.evaluateAll((imgs) =>
      imgs.map((img) => {
        const p = img.parentElement && img.parentElement.querySelector('p[dir="auto"]');
        return (p && p.textContent ? p.textContent : '').replace(/\s+/g, ' ').trim();
      }),
    )
  ).filter(Boolean);
  return { count: texts.length, fingerprint: texts.join('\n---\n') };
}

function changedAgentSnapshot(current: AgentSnapshot, baseline: AgentSnapshot): boolean {
  return current.count !== baseline.count || current.fingerprint !== baseline.fingerprint;
}

// Wait until Zilla's visible transcript text is stable for SETTLE_MS. Count-only
// settling is too eager while a message bubble is still streaming under load.
async function waitZillaIdle(page: Page, zillaMsgs: Locator): Promise<AgentSnapshot> {
  const start = Date.now();
  let last = await agentSnapshot(zillaMsgs);
  let stableSince = Date.now();
  while (Date.now() - start < TURN_TIMEOUT_MS) {
    await page.waitForTimeout(POLL_MS);
    const current = await agentSnapshot(zillaMsgs);
    if (changedAgentSnapshot(current, last)) {
      last = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= SETTLE_MS) break;
  }
  return last;
}

async function playCallerClip(page: Page, index: number): Promise<number> {
  return Number(await page.evaluate((idx: number) => (window as any).__cr.playClip(idx), index));
}

async function waitForReplyAfterClip(
  page: Page,
  zillaMsgs: Locator,
  beforeClip: AgentSnapshot,
  clipEnd: number,
  timeoutMs: number = TURN_TIMEOUT_MS,
): Promise<ReplyWaitResult> {
  let baseline = beforeClip;
  while (Date.now() - clipEnd < timeoutMs) {
    const current = await agentSnapshot(zillaMsgs);
    if (Date.now() - clipEnd < REPLY_MIN_LATENCY_MS) {
      if (changedAgentSnapshot(current, baseline)) baseline = current;
    } else if (changedAgentSnapshot(current, baseline)) {
      return {
        responded: true,
        latencyMs: Date.now() - clipEnd,
        signal: current.count !== baseline.count ? 'message-count' : 'text-change',
      };
    }
    await page.waitForTimeout(POLL_MS);
  }
  return { responded: false, latencyMs: null, signal: 'none' };
}

// Turn-taking: for each clip, let Zilla settle, speak the clip, then wait for a
// genuinely NEW message. Appends one {clip, responded, latencyMs} per clip into
// `checks` (appends rather than returns so a mid-loop throw still surfaces the
// partial results the caller already put in its result object).
async function runTurns(
  page: Page,
  zillaMsgs: Locator,
  playlist: string[],
  checks: Check[],
  turnEndAt: number[],
  audioFrames: AudioFrame[],
): Promise<void> {
  for (let i = 0; i < playlist.length; i++) {
    const name = path.basename(playlist[i]);
    const before = await waitZillaIdle(page, zillaMsgs); // prior turn fully done
    log(`▶ clip [${i + 1}/${playlist.length}]: ${name}`);
    // Zilla opens the call by greeting first, so our opening line may or may not
    // draw a reply. Give her OPENING_REPLY_WAIT_MS to answer — long enough that we
    // don't talk over a reply she's forming (the bug: we used to fire the next clip
    // instantly and cut her off) — but NEVER fail the opening turn on silence, since
    // she may simply be waiting for the real query.
    if (i === 0 && before.count > 0) {
      const clipMs = await playCallerClip(page, i); // still play it — keep the call realistic
      const clipEnd = Date.now();
      const reply = await waitForReplyAfterClip(
        page,
        zillaMsgs,
        before,
        clipEnd,
        OPENING_REPLY_WAIT_MS,
      );
      checks.push({
        clip: name,
        responded: true, // opening turn never fails on "no reply"
        latencyMs: reply.responded ? reply.latencyMs : null,
        clipMs,
        responseSignal: reply.responded ? reply.signal : 'opening-greeting',
      });
      turnEndAt.push(Date.now());
      if (reply.responded) {
        log(`  ✓ zilla replied to opening (${reply.latencyMs}ms via ${reply.signal}, clip ${clipMs}ms)`);
        await waitZillaIdle(page, zillaMsgs); // let her finish before the next clip
      } else {
        log(`  ✓ opening turn: no reply in ${OPENING_REPLY_WAIT_MS}ms (she greeted first), clip ${clipMs}ms`);
      }
      continue;
    }
    const clipMs = await playCallerClip(page, i); // resolves at clip end
    const clipEnd = Date.now();
    // A real reply to THIS clip cannot arrive in a few ms — a near-instant count
    // bump is a trailing/streaming message from the PRIOR turn bleeding into this
    // window (common under load, and previously counted as a false reply). Absorb
    // any bump before REPLY_MIN_LATENCY_MS into the baseline, then only accept a
    // genuinely-new message after that floor.
    const reply = await waitForReplyAfterClip(page, zillaMsgs, before, clipEnd);
    checks.push({
      clip: name,
      responded: reply.responded,
      latencyMs: reply.latencyMs,
      clipMs,
      responseSignal: reply.signal,
    });
    turnEndAt.push(Date.now());
    if (reply.responded) {
      log(`  ✓ zilla replied (${reply.latencyMs}ms via ${reply.signal}, clip ${clipMs}ms)`);
      await waitZillaIdle(page, zillaMsgs);
    } else {
      log(`  ✗ NO REPLY after ${TURN_TIMEOUT_MS}ms (clip ${clipMs}ms)`);
    }
  }
}

// Active interruption test (opt-in): deliberately talk over Zilla. Prompt her,
// wait for her reply to START, then immediately play another clip over her
// speech (no idle wait) — a real barge-in on the human channel. The Python
// classifier run afterward judges whether she yielded (handled) or talked over
// us (failed); this just manufactures the overlap for it to score. Returns a
// bargeIn descriptor, or null when the probe is off / not enough clips.
async function bargeInProbe(
  page: Page,
  zillaMsgs: Locator,
  playlist: string[],
): Promise<BargeIn | null> {
  if (!(INTERRUPT && playlist.length >= 2)) {
    if (INTERRUPT) log('⚡ interrupt: skipped — needs at least 2 clips');
    return null;
  }
  // Prompt with a question (elicits a spoken answer), then after a fixed offset
  // near her typical reply latency, play a clip OVER her answer to force a
  // talk-over. The classifier scores whether she yielded — that is the
  // authoritative verdict; the DOM "was she speaking" flag is best-effort info
  // only (message-count detection is unreliable this late in the call).
  const INTERRUPT_DELAY_MS = parseInt(process.env.INTERRUPT_DELAY_MS || '2500', 10);
  const idle = await waitZillaIdle(page, zillaMsgs);
  const promptIdx = playlist.length > 1 ? 1 : 0;
  const bargeIdx = 0;
  log(
    `⚡ interrupt: prompt ${path.basename(playlist[promptIdx])}, wait ${INTERRUPT_DELAY_MS}ms, barge-in ${path.basename(playlist[bargeIdx])}`,
  );
  await page.evaluate((i: number) => (window as any).__cr.playClip(i), promptIdx);
  const t0 = Date.now();
  let speaking = false;
  while (Date.now() - t0 < INTERRUPT_DELAY_MS) {
    if (!speaking && (await zillaMsgs.count()) > idle.count) speaking = true;
    await page.waitForTimeout(POLL_MS);
  }
  await page.evaluate((i: number) => (window as any).__cr.playClip(i), bargeIdx); // talk over her reply
  log(
    `  ⚡ barge-in fired${speaking ? ' over zilla mid-reply' : ''} — verdict in INTERRUPTION_RESULT`,
  );
  return {
    attempted: true,
    zillaWasSpeaking: speaking,
    bargeInClip: path.basename(playlist[bargeIdx]),
  };
}

// Scrape the live in-call transcript from the DOM: each CallTranscription block is
// an avatar img (ziila-logo-avatar = agent, user-default-logo = customer) + its
// content <p dir="auto">. Returns [{speaker, text}] in DOM (chronological) order.
async function scrapeLiveTranscript(page: Page): Promise<Turn[]> {
  try {
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('img[alt="agent avatar logo"]'))
        .map((img) => {
          const el = img as HTMLImageElement;
          const speaker = /ziila-logo-avatar/.test(el.src) ? 'agent' : 'customer';
          const p = el.parentElement && el.parentElement.querySelector('p[dir="auto"]');
          return { speaker, text: (p && p.textContent ? p.textContent : '').trim() };
        })
        .filter((m) => m.text),
    );
  } catch {
    return [];
  }
}

async function assertMicOverrideInstalled(page: Page): Promise<void> {
  const micInstalled = await page.evaluate(() => (window as any).__cr?.installed === true);
  if (micInstalled) return;
  throw new Error(
    'mic-override-not-installed: window.__cr.installed is not true — the injected getUserMedia ' +
      'override failed (likely a transpiler helper like __name not serialized into the page). ' +
      'Aborting so we do not record the fake device instead of the caller clips.',
  );
}

async function resolveAgentId(context: BrowserContext): Promise<string> {
  const agentId = CFG.agentId || (await pickFirstAgentId(context));
  log(`agent: ${agentId}`);
  return agentId;
}

async function startCall(
  page: Page,
  context: BrowserContext,
  startBtn: Locator,
): Promise<ActiveCall> {
  const callStartedAt = new Date().toISOString();
  const endBtn = page.getByRole('button', { name: SEL.endCall });
  // The relay announces the call's conversation id in its first frame
  // ({"type":"session","sessionId":...}). The id doubles as the backend
  // conversation id, so we can link the call immediately instead of waiting for
  // the STT transcript to persist. Captured any time during the call; falls back
  // to BE lookup (below) when the frame doesn't carry one.
  let wsConversationId: string | null = null;
  const sources: SourceFrame[] = [];
  // DEBUG-AUDIO: observe every relay frame (JSON type + binary size) and log the
  // first frames after each clip against DOM-reply timing, to find an "first audio
  // chunk" signal earlier than the DOM text census. Temporary; remove after we fix
  // the latency source. Gate on env so normal runs are not spammed.
  const audioFrames: AudioFrame[] = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (e: { payload: string | Buffer }) => {
      const at = Date.now();
      const payload = e.payload;
      if (Buffer.isBuffer(payload)) {
        audioFrames.push({ at, bytes: payload.length });
        return;
      }
      const raw = typeof payload === 'string' ? payload : '';
      if (!raw.startsWith('{')) return;
      try {
        const j = JSON.parse(raw);
        // Zilla's voice arrives as JSON frames with a base64 PCM audio chunk.
        // The first such chunk after a clip's END is the earliest audible-reply
        // signal. Track it for the first-audio latency measurement.
        if (typeof j?.chunk === 'string' && j.chunk.length > 4) {
          const bytes = Math.floor((j.chunk.length / 4) * 3); // base64 length -> raw bytes
          audioFrames.push({ at, bytes });
        }
        const id =
          (j && j.type === 'session' && typeof j.sessionId === 'string' && j.sessionId) ||
          (j && typeof j.session_id === 'string' && j.session_id);
        if (id && !wsConversationId) {
          wsConversationId = id;
          log(`early conversation id from WS relay: ${id}`);
        }
        // Provenance: file_ids / loaded_files are the KB file/section ids Zilla
        // grounded the running answer on; play_id identifies the playback turn.
        const fileIds = Array.isArray(j?.file_ids) ? j.file_ids.filter((x: unknown) => typeof x === 'string') : [];
        const loaded = Array.isArray(j?.loaded_files) ? j.loaded_files.filter((x: unknown) => typeof x === 'string') : [];
        const playId = typeof j?.play_id === 'string' && j.play_id ? j.play_id : null;
        if (fileIds.length || loaded.length || playId) {
          sources.push({ at: Date.now(), fileIds, loadedFiles: loaded, playId });
          log(
            `source files from relay: [${fileIds.join(', ')}]${
              playId ? ` (play ${playId.slice(0, 8)}…)` : ''
            }`,
          );
        }
      } catch {}
    });
  });
  // Some builds gate the live call behind an intro screen (InitiateCall) whose
  // Start button is identical to the real one. Detect that screen by its own
  // illustration (SEL.callIntro) — NOT by "a Start button exists", because the
  // real Start briefly re-enables while connecting and would be misread as the
  // intro. When the intro is up, click through it to reach the real call screen
  // first. No-op on the single-step flow (marker absent).
  if (await page.locator(SEL.callIntro).first().isVisible().catch(() => false)) {
    log('call intro screen detected — clicking through to the live call');
    await startBtn.click(); // advances InitiateCall -> ConversationDetails
    await page
      .locator(SEL.callIntro)
      .first()
      .waitFor({ state: 'hidden', timeout: CALL_START_MS })
      .catch(() => {});
    await page.locator(SEL.startCall).first().waitFor({ state: 'visible', timeout: CALL_START_MS });
  }
  // Click the real Start and wait for End — the only proof the call is live.
  await page.locator(SEL.startCall).first().click();
  try {
    await endBtn.waitFor({ state: 'visible', timeout: CALL_START_MS });
  } catch (e) {
    // The frontend silently no-ops Start when the account's conversation quota is
    // exhausted — the only symptom is this timeout. Name the real cause.
    const remaining = await fetchRemainingConversations(context);
    if (remaining === 0)
      throw new Error(
        'quota-exhausted: the account has 0 remainingConversations ' +
          '(GET /accounts/consumption-details) — the frontend silently ignores Start-call. ' +
          'Raise/reset the account quota to run calls.',
        { cause: e },
      );
    throw e;
  }
  log('call started');
  return { callStartedAt, endBtn, zillaMsgs: page.locator(SEL.zillaMsg), conversationId: wsConversationId, sources, audioFrames };
}

async function collectPersistedArtifacts(
  context: BrowserContext,
  agentId: string,
  callStartedAt: string,
  repliesPassed: boolean,
  liveTranscript: Turn[],
  conversationId: string | null,
): Promise<CallArtifacts | null> {
  // Normally skip the artifact lookup when a reply was missed — CI fails fast and
  // retries anyway. But set TRACE_FAILED_CALLS=1 to still resolve the conversation
  // so a failed call is traceable (gets a clickable URL); the stress runner does
  // this. The pass/fail verdict is unchanged either way (repliesPassed already
  // false), we're only recovering the conversationId for diagnostics.
  if (!repliesPassed && process.env.TRACE_FAILED_CALLS !== '1') return null;
  const artifacts = await waitForPersistedCallArtifacts(
    context,
    agentId,
    callStartedAt,
    liveTranscript,
    conversationId,
  );
  if (artifacts.transcript.saved) {
    log(
      `transcript saved: ${artifacts.transcript.nonEmptyTurnCount} turn(s) in ${artifacts.conversationId}`,
    );
  }
  if (artifacts.recording.saved) log(`recording URL saved in ${artifacts.conversationId}`);
  return artifacts;
}

async function captureFailureScreenshot(
  page: Page,
  runId: string,
  n: number,
): Promise<string | undefined> {
  const shot = path.join(OUT_DIR, `failure-${runId}-a${n}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  return path.relative(ROOT, shot);
}

async function runCallLifecycle(
  session: BrowserSession,
  scenario: Scenario,
  checks: Check[],
  progress: AttemptProgress,
  ctl: Ctl,
): Promise<AttemptResult> {
  await loginThroughUI(session.page);
  const agentId = await resolveAgentId(session.context);
  progress.agentId = agentId;
  const startBtn = await openCallPage(session.page, agentId);
  await preloadClips(session.page, scenario.clips);
  await assertMicOverrideInstalled(session.page);

  const activeCall = await startCall(session.page, session.context, startBtn);
  progress.callStartedAt = activeCall.callStartedAt;
  const turnEndAt: number[] = [];
  await runTurns(session.page, activeCall.zillaMsgs, scenario.clips, checks, turnEndAt, activeCall.audioFrames);
  // Supplementary, non-judgemental latency: the first audio chunk Zilla's voice
  // arrived at after each clip's END (measured from the relay WS audio chunks).
  // Recorded alongside the DOM-based latencyMs; does NOT affect pass/fail or the
  // latency verdict. Computed here after all turns so all chunks are available.
  checks.forEach((c, i) => {
    if (i < turnEndAt.length && c.latencyMs != null) {
      const clipEnd = turnEndAt[i] - c.latencyMs;
      const first = activeCall.audioFrames
        .filter((f) => f.at >= clipEnd)
        .sort((a, b) => a.at - b.at)[0];
      c.latencyMsToFirstAudioChunk = first ? Math.round(first.at - clipEnd) : null;
    }
  });
  ctl.partial = { ...ctl.partial, agentId, callStartedAt: activeCall.callStartedAt, checks: [...checks] };
  const bargeIn = await bargeInProbe(session.page, activeCall.zillaMsgs, scenario.clips);
  const liveTranscript = await scrapeLiveTranscript(session.page);
  if (liveTranscript.length) log(`live transcript: ${liveTranscript.length} message(s) captured`);
  ctl.partial = { ...ctl.partial, liveTranscript };
  ctl.partial = { ...ctl.partial, conversationId: activeCall.conversationId || undefined };

  await activeCall.endBtn.click().catch(() => {});
  const latency = evaluateLatency(checks);
  const repliesPassed = checks.length === scenario.clips.length && checks.every((c) => c.responded);
  const artifacts = await collectPersistedArtifacts(
    session.context,
    agentId,
    activeCall.callStartedAt,
    repliesPassed,
    liveTranscript,
    activeCall.conversationId,
  );
  ctl.partial = { ...ctl.partial, artifacts, conversationId: artifacts?.conversationId || undefined };
  const transcriptMatch = compareTranscripts(liveTranscript, artifacts?.transcript?.turns || []);
  if (transcriptMatch.result !== 'SKIPPED') {
    log(`transcript match: ${transcriptMatch.result} — ${transcriptMatch.reason}`);
  }

  // Bucket the relay provenance frames into per-turn windows: turn i's sources
  // are the frames that arrived between the previous reply-detection and this
  // one (turn 1 starts at call start).
  const callStartTs = Date.parse(activeCall.callStartedAt) || 0;
  const sourceFilesByTurn = turnEndAt.map((end, i) => {
    const start = i === 0 ? callStartTs : turnEndAt[i - 1];
    const frames = activeCall.sources.filter((f) => f.at >= start && f.at <= end + SETTLE_MS);
    return {
      turn: i + 1,
      fileIds: [...new Set(frames.flatMap((f) => f.fileIds))],
      loadedFiles: [...new Set(frames.flatMap((f) => f.loadedFiles))],
      playId: frames[frames.length - 1]?.playId || null,
    };
  });
  const srcTurns = sourceFilesByTurn.filter(
    (r) => r.fileIds.length || r.loadedFiles.length || r.playId,
  );
  const sourceFilesUsed = [...new Set(activeCall.sources.flatMap((f) => f.fileIds))].sort();
  if (sourceFilesUsed.length) log(`source files used: [${sourceFilesUsed.join(', ')}]`);

  return buildAttemptResult({
    agentId,
    checks,
    clipCount: scenario.clips.length,
    callStartedAt: activeCall.callStartedAt,
    latency,
    bargeIn,
    transcriptMatch,
    liveTranscript,
    artifacts,
    ...(srcTurns.length ? { sourceFilesByTurn: srcTurns } : {}),
    ...(sourceFilesUsed.length ? { sourceFilesUsed } : {}),
    ...(activeCall.sources.length ? { sourceFrameLog: activeCall.sources } : {}),
  });
}

// One full call attempt. Returns a result; never exits. `ctl.browser` is exposed
// so the global timeout can force-close a hung browser. runId+n name artifacts.
async function attempt(
  input: Scenario | string[],
  ctl: Ctl,
  runId: string,
  n: number,
): Promise<AttemptResult> {
  const scenario = scenarioFromInput(input);
  const checks: Check[] = [];
  const progress: AttemptProgress = { agentId: null, callStartedAt: null };
  let result = pendingAttempt(checks);
  let session: BrowserSession | null = null;

  try {
    session = await createBrowserSession(ctl);
    result = await runCallLifecycle(session, scenario, checks, progress, ctl);
  } catch (e: any) {
    result = failedAttempt(ctl.timedOut ? 'attempt-timeout' : e.message, checks, {
      ...result,
      ...progress,
    });
    if (!ctl.timedOut && session) {
      result.screenshot = await captureFailureScreenshot(session.page, runId, n).catch(
        () => undefined,
      );
      log(`ERROR: ${e.message} (screenshot: ${result.screenshot})`);
    } else if (!ctl.timedOut) {
      log(`ERROR: ${e.message}`);
    }
  } finally {
    if (session) {
      // Keep a passing call's video too if its transcript live/backend match is
      // off (WARN/FAIL) — that's exactly the case you want to eyeball.
      const mism = result.transcriptMatch?.result;
      const keepForMismatch = mism === 'WARN' || mism === 'FAIL';
      result.video = await closeContextAndKeepFailureVideo(
        session.page,
        session.context,
        result.passed,
        runId,
        n,
        keepForMismatch,
      );
      await session.browser.close().catch(() => {});
    } else if (ctl.browser) {
      await ctl.browser.close().catch(() => {});
    }
    ctl.browser = null;
  }
  return result;
}

// Race one attempt against a wall-clock timeout; kill the browser if it hangs.
export function attemptWithTimeout(
  scenario: Scenario | string[],
  runId: string,
  n: number,
): Promise<AttemptResult> {
  const ctl: Ctl = { browser: null, timedOut: false };
  let timeoutId: ReturnType<typeof setTimeout>;
  const work = attempt(scenario, ctl, runId, n)
    .catch((e: any) => ({
      passed: false,
      reason: ctl.timedOut ? 'attempt-timeout' : e.message,
      checks: [],
    }))
    // Clear the timer once the attempt settles, or it fires during a LATER
    // attempt and logs a spurious "attempt exceeded".
    .finally(() => clearTimeout(timeoutId));
  const timeout = new Promise<AttemptResult>((resolve) => {
    timeoutId = setTimeout(async () => {
      ctl.timedOut = true;
      log(`attempt exceeded ATTEMPT_TIMEOUT_MS=${ATTEMPT_TIMEOUT_MS} — aborting`);
      if (ctl.browser) await ctl.browser.close().catch(() => {});
      resolve({
        ...ctl.partial,
        passed: false,
        reason: 'attempt-timeout',
        checks: ctl.partial?.checks ?? [],
      });
    }, ATTEMPT_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]);
}
