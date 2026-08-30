// Central configuration: env loading, tunable constants, frontend selectors, and
// route templates. Imported by every other module. Loading this module has one
// side effect — it reads .env — so importing it anywhere makes env available.
import fs from 'fs';
import path from 'path';

// This file lives in lib/, so the project root is one level up. ALL project-
// relative paths derive from ROOT, never __dirname (which would resolve to lib/).
export const ROOT = path.join(__dirname, '..');

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let txt;
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq !== -1) {
      const key = s
        .slice(0, eq)
        .trim()
        .replace(/^export\s+/, '');
      if (key) out[key] = parseEnvValue(s.slice(eq + 1));
    }
  }
  return out;
}

function loadEnvFile(file: string): void {
  for (const [key, value] of Object.entries(parseEnvFile(file))) {
    process.env[key] ??= value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

// Default to the committed `assets/` clips so a fresh clone / CI works with no
// setup. For the TTS workflow (npm run tts writes the gitignored assets-tts/),
// set ASSETS_DIR=assets-tts in your .env — then `npm test` still needs no args.
export const ASSETS_DIR = process.env.ASSETS_DIR
  ? path.resolve(process.env.ASSETS_DIR)
  : path.join(ROOT, 'assets');
export const OUT_DIR = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.join(ROOT, 'tmp');
export const VIDEO_DIR = path.join(OUT_DIR, 'videos');
export const SAMPLE_RATE = 16000;

// Frontend config = single source of truth for the API base (to pick an agent).
const FRONTEND_ENV_PATH =
  process.env.FRONTEND_ENV_PATH || path.join(ROOT, '..', 'zilla-frontend', '.env');
const frontendEnv = parseEnvFile(FRONTEND_ENV_PATH);

export const CFG = {
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  apiBase: (process.env.VITE_API_BASE_URL || frontendEnv.VITE_API_BASE_URL || '').replace(
    /\/+$/,
    '',
  ),
  email: process.env.ZILLA_EMAIL,
  password: process.env.ZILLA_PASSWORD,
  agentId: process.env.ZILLA_AGENT_ID || '',
  locale: process.env.APP_LOCALE || 'en',
};
export const HEADED = process.argv.includes('--headed');
export const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '60000', 10);
export const CALL_START_MS = parseInt(process.env.CALL_START_MS || '60000', 10);
export const TURN_TIMEOUT_MS = parseInt(process.env.TURN_TIMEOUT_MS || '60000', 10);
export const SETTLE_MS = parseInt(process.env.SETTLE_MS || '1500', 10);
// Opening turn: Zilla greets first, so our opening line may or may not draw a
// reply. Wait THIS long for one before moving on — long enough not to talk over a
// reply she's forming — but never fail the opening turn if she stays silent (she
// may just be waiting for the real query).
export const OPENING_REPLY_WAIT_MS = parseInt(process.env.OPENING_REPLY_WAIT_MS || '10000', 10);
export const RETRIES = parseInt(process.env.RETRIES || '0', 10); // extra attempts on failure (0 = run each session exactly once)
export const ATTEMPT_TIMEOUT_MS = parseInt(process.env.ATTEMPT_TIMEOUT_MS || '900000', 10); // wall-clock per attempt (15 min: 10 concurrent calls on a dev server can stretch a session)
export const INTERRUPTION_WAIT_S = parseInt(process.env.INTERRUPTION_WAIT_S || '20', 10); // poll for recording readiness
export const ARTIFACT_WAIT_MS = parseInt(
  process.env.ARTIFACT_WAIT_MS || process.env.TRANSCRIPT_WAIT_MS || '180000',
  10,
);
export const ARTIFACT_POLL_MS = parseInt(
  process.env.ARTIFACT_POLL_MS || process.env.TRANSCRIPT_POLL_MS || '3000',
  10,
);
export const TRANSCRIPT_MIN_TURNS = parseInt(process.env.TRANSCRIPT_MIN_TURNS || '2', 10);
// A conversation is always created AFTER its call starts (backend persists it
// post-call), so the candidate window starts at callStartedAt minus only a small
// clock-skew tolerance — NOT a wide window. A wide one let a PRIOR round's
// same-scenario conversation (delayed ~persistence-lag) fall inside a later call's
// window, and identical clips made them indistinguishable → the later call stole
// the earlier one. Keep this ≪ the gap between repeat rounds.
export const CALL_MATCH_SKEW_MS = parseInt(process.env.CALL_MATCH_SKEW_MS || '15000', 10);
export const ROUTE_PROBE_MS = parseInt(process.env.ROUTE_PROBE_MS || '30000', 10); // per-candidate wait for the call Start button (30s: dev servers can be slow to render the call page under load)
export const POLL_MS = parseInt(process.env.POLL_MS || '200', 10); // DOM poll interval (reply / idle / barge-in)
export const CONVERSATION_PAGE_SIZE = parseInt(process.env.CONVERSATION_PAGE_SIZE || '5', 10); // recent-conversations page size for call lookup
export const REPLY_MIN_LATENCY_MS = parseInt(process.env.REPLY_MIN_LATENCY_MS || '800', 10); // ignore "replies" faster than this (stale/streaming bleed, not a real answer)
const VIDEO_ON_FAILURE = process.env.VIDEO_ON_FAILURE !== '0';
export const VIDEO_ALWAYS = process.env.VIDEO_ALWAYS === '1'; // keep passing videos too (debug/demo)
export const RECORD_VIDEO = VIDEO_ON_FAILURE || VIDEO_ALWAYS;
export const REPLY_LATENCY_WARN_MS = parseInt(process.env.REPLY_LATENCY_WARN_MS || '6000', 10); // warn if a reply is slower than this
export const REPLY_LATENCY_MAX_MS = parseInt(process.env.REPLY_LATENCY_MAX_MS || '0', 10); // >0: FAIL the run if any reply exceeds this
export const INTERRUPT = process.argv.includes('--interrupt') || process.env.INTERRUPT === '1'; // active barge-in test (talk over zilla)
export const TMP_KEEP_RUNS = parseInt(process.env.TMP_KEEP_RUNS || '10', 10); // keep this many recent summaries/videos in tmp/
export const TRANSCRIPT_MATCH_MIN = parseFloat(process.env.TRANSCRIPT_MATCH_MIN || '0.95'); // live-vs-backend similarity for PASS — high because both come from the SAME source (relay real-time events), only segmentation differs
export const TRANSCRIPT_MATCH_WARN = parseFloat(process.env.TRANSCRIPT_MATCH_WARN || '0.5'); // below MIN but >= this = WARN, else FAIL
// Confidence bar for CLAIMING a conversation as this call's, on the customer side
// (our injected clips). Our own conversation matches ~1.0; a different scenario —
// even a short one that shares the greeting — stays well below. High on purpose:
// under concurrency, better to keep polling for our own conversation than to grab
// a sibling's that merely shares the opening. Tune down only if real matches miss.
export const CONV_MATCH_MIN = parseFloat(process.env.CONV_MATCH_MIN || '0.75');

// Frontend selectors — the brittle coupling to the web app's markup. If the UI
// changes and runs start timing out with "not found", fix these first (one place).
export const SEL = {
  email: process.env.SEL_EMAIL || 'input[type="email"]',
  password: process.env.SEL_PASSWORD || 'input[type="password"]',
  submit: process.env.SEL_SUBMIT || 'button[type="submit"]',
  startCall: process.env.SEL_START || 'button:has(img[alt="Mic icon button"])',
  endCall: process.env.SEL_END || 'End', // accessible-name substring for getByRole
  zillaMsg: process.env.SEL_ZILLA_MSG || 'img[src*="ziila-logo-avatar.png"]',
  // Marker unique to the pre-call intro screen (InitiateCall), if the build gates
  // the live call behind one. Its own Start button looks identical to the real
  // one, so we detect the intro by this illustration instead. Absent => no intro
  // screen (single-step flow); present => click through it first.
  callIntro: process.env.SEL_CALL_INTRO || 'img[alt="soundwaves"]',
};

// Route templates — {locale} is a locale segment incl. leading slash (or empty),
// {agentId} the resolved agent. Override via LOGIN_PATH / CALL_PATHS if the app's
// routing changes. CALL_PATHS is a comma-separated list of fallbacks, tried in order.
export const ROUTES = {
  login: process.env.LOGIN_PATH || '{locale}/auth/login',
  call: (
    process.env.CALL_PATHS ||
    '{locale}/agents/{agentId}/call'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
export const fillRoute = (tpl: string, vars: Record<string, string>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
// Skip signal 2 (e.g. quick reply-only checks, or when CI runs it as its own step).
export const SKIP_INTERRUPTION =
  process.argv.includes('--no-interruption') || process.env.SKIP_INTERRUPTION === '1';

export const log = (...a: unknown[]) => console.log('[callrunner]', ...a);
export const resultLabel = (passed: boolean) => (passed ? 'PASS' : 'FAIL');
