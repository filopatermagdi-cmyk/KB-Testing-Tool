/*
 * run_sessions_ws.ts — Phase 4B: Session Runner (direct WebSocket).
 *
 * Connects straight to Ziila's WS endpoint per ZIILA_WEBSOCKET_INTEGRATION.pdf
 * (WS /audio/{token}) instead of driving the browser UI. One connection per
 * session; each turn's question is sent as {"text": question} (WS_MODE=text —
 * see .env), the streamed sentence-by-sentence reply is buffered until it
 * settles, then the next turn is sent.
 *
 * Output is written in the SAME shape Phase 4A (run_sessions.ts) produces —
 * data/runs/<session_id>/summary-<stamp>.json and data/runs/run-results-<stamp>.json —
 * so capture-answers, evaluate, and the dashboard all work against whichever
 * runner ran last without any changes.
 *
 * Usage:
 *   npm run run-sessions-ws
 *   npm run run-sessions-ws -- --sessions S001_ar,S002_en
 *   npm run run-sessions-ws -- --concurrency 4
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

interface SessionTurn {
  turn: number;
  question_id: string;
  question: string;
  expected_answer: string;
  audio_file: string;
}
interface Session {
  session_id: string;
  language: "ar" | "en";
  agent_id: string | null;
  messages: SessionTurn[];
}
interface Check {
  clip: string;
  responded: boolean;
  latencyMs: number | null;
}
interface SessionResult {
  session_id: string;
  language: string;
  agent_id: string;
  turns: number;
  passed: boolean;
  reason: string;
  replies: number;
  wallMs: number;
  conversationId: string | null;
  callUrl: string;
  flags: { zillaReply: boolean; transcriptSaved: boolean; recordingUrl: boolean };
  latencyMs: { max: number | null; avg: number | null };
  transcriptMatch: string;
}

const ROOT = process.cwd();
const SESSIONS_PATH = path.join(ROOT, "data", "sessions.json");
const RUNS_DIR = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(ROOT, "data", "runs");

const WS_URL = process.env.WS_URL || "";
const WS_MODE = (process.env.WS_MODE || "text").toLowerCase();
const WS_SETTLE_MS = intEnv("WS_SETTLE_MS", 5000);
const WS_TURN_TIMEOUT_MS = intEnv("WS_TURN_TIMEOUT_MS", 20000);
const WS_INTER_TURN_MS = intEnv("WS_INTER_TURN_MS", 400);
// How long the turn must stay totally silent (no frames at all) BEFORE we
// finalize the answer and move on. This confirm pass is what prevents a late
// sentence of answer N from bleeding into question N+1's buffer: we only treat
// the answer as final once a full confirm window passes with zero frames.
const WS_CONFIRM_MS = intEnv("WS_CONFIRM_MS", 500);
// How long to wait for one WS handshake to reach OPEN before counting that
// attempt as failed (the proxy can reject/drop simultaneous connects).
const WS_CONNECT_TIMEOUT_MS = intEnv("WS_CONNECT_TIMEOUT_MS", 10000);
// Max connect attempts per session. Each failed attempt is a fresh socket.
const WS_CONNECT_ATTEMPTS = intEnv("WS_CONNECT_ATTEMPTS", 3);
// Random stagger (ms) applied before the first connect of a session and
// between retries, so a whole batch doesn't hammer the proxy at once.
const WS_CONNECT_STAGGER_MS = intEnv("WS_CONNECT_STAGGER_MS", 2500);
const CONCURRENCY = intEnv("CONCURRENCY", 1);
const CONCURRENT_AR = intEnv("CONCURRENT_AR", 0);
const CONCURRENT_EN = intEnv("CONCURRENT_EN", 0);
const MIXED = CONCURRENT_AR > 0 || CONCURRENT_EN > 0;

function intEnv(name: string, def: number): number {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isNaN(n) || n < 1 ? def : n;
}

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}

// WS_TOKEN takes precedence over the URL path token (needed for the new
// intella.digital proxy which requires a full JWT instead of the short token).
function resolveToken(): string {
  return process.env.WS_TOKEN || "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Opens a single WS connection and resolves once `open` fires. Rejects if the
// socket closes before opening, errors, or the handshake doesn't complete in
// WS_CONNECT_TIMEOUT_MS — the caller decides whether to retry.
function openSocketOnce(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let opened = false;
    let errMsg = "";
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeAllListeners("open");
      ws.removeAllListeners("error");
      ws.removeAllListeners("close");
    };
    const fail = (why: string) => {
      if (opened) return;
      opened = true;
      cleanup();
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail("handshake timeout"), WS_CONNECT_TIMEOUT_MS);
    ws.on("open", () => {
      if (opened) return;
      opened = true;
      cleanup();
      resolve(ws);
    });
    ws.on("error", (e: Error) => {
      errMsg = e.message || "ws error";
    });
    ws.on("close", () => fail(errMsg ? `refused: ${errMsg}` : "closed before open"));
  });
}

// Tries WS_CONNECT_ATTEMPTS fresh sockets, with a jittered pause between them.
// Throws only when every attempt failed — the caller marks the session failed.
async function connectWithRetry(sessionId: string): Promise<WebSocket> {
  const attempts = Math.max(WS_CONNECT_ATTEMPTS, 1);
  let lastErr = "";
  for (let a = 1; a <= attempts; a++) {
    if (a > 1) await sleep(500 + Math.round(Math.random() * Math.max(WS_CONNECT_STAGGER_MS - 500, 0)));
    try {
      return await openSocketOnce();
    } catch (e) {
      lastErr = (e as Error).message;
      console.warn(`  [${sessionId}] connect attempt ${a}/${attempts} failed: ${lastErr}`);
    }
  }
  throw new Error(`connection did not open (${attempts} attempts${lastErr ? `: ${lastErr}` : ""})`);
}

function agentIdFor(session: Session): string {
  if (session.agent_id) return session.agent_id;
  const byLang = session.language === "ar" ? "ZILLA_AGENT_ID_AR" : "ZILLA_AGENT_ID_EN";
  return process.env[byLang] || "";
}

async function refreshToken(): Promise<void> {
  const { chromium } = await import("playwright");
  const appUrl = process.env.APP_URL || "";
  const email = process.env.ZILLA_EMAIL || "";
  const password = process.env.ZILLA_PASSWORD || "";
  const loginPath = process.env.LOGIN_PATH || "{locale}/auth/login";
  const locale = process.env.APP_LOCALE || "en";

  if (!appUrl || !email || !password) {
    throw new Error("APP_URL, ZILLA_EMAIL, ZILLA_PASSWORD must be set for --auto-token");
  }

  const loginUrl = `${appUrl}/${loginPath.replace("{locale}", locale)}`;
  console.log(`[auto-token] Logging in to ${loginUrl} ...`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u: URL) => !u.pathname.includes("/auth/login"), { timeout: 20_000 });

    const cookies = await ctx.cookies();
    const token = cookies.find((c) => c.name === "accessToken")?.value;
    if (!token) throw new Error("no accessToken cookie found after login");

    // Update .env
    const envPath = path.join(ROOT, ".env");
    let raw = fs.readFileSync(envPath, "utf8");
    const re = /^WS_TOKEN=.*$/m;
    if (re.test(raw)) raw = raw.replace(re, `WS_TOKEN=${token}`);
    else raw += `\nWS_TOKEN=${token}\n`;
    fs.writeFileSync(envPath, raw, "utf8");
    process.env.WS_TOKEN = token;

    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      const exp = new Date(payload.exp * 1000);
      console.log(`[auto-token] ✓ Token refreshed (expires ${exp.toISOString()}, ${Math.round((payload.exp * 1000 - Date.now()) / 60_000)} min from now)`);
    } catch {
      console.log(`[auto-token] ✓ Token refreshed (length=${token.length})`);
    }
  } finally {
    await browser.close();
  }
}

interface TurnOutcome {
  question_id: string;
  question: string;
  answerText: string;
  responded: boolean;
  latencyMs: number | null;
  sessionIdFromServer: string | null;
  error: string | null;
  fileIds?: string[];
  loadedFiles?: string[];
  playId?: string | null;
}

// Runs every turn of one session over a single WS connection. Resolves with
// per-turn outcomes plus whatever session id Ziila reported (if any).
function runSessionOverWs(session: Session, agentId: string): Promise<TurnOutcome[]> {
  return new Promise(async (resolve) => {
    if (WS_MODE !== "text") {
      resolve(
        session.messages.map((m) => ({
          question_id: m.question_id,
          question: m.question,
          answerText: "",
          responded: false,
          latencyMs: null,
          sessionIdFromServer: null,
          error: `WS_MODE=${WS_MODE} not implemented yet (only "text" is built)`,
        }))
      );
      return;
    }
    if (!WS_URL) {
      resolve(
        session.messages.map((m) => ({
          question_id: m.question_id,
          question: m.question,
          answerText: "",
          responded: false,
          latencyMs: null,
          sessionIdFromServer: null,
          error: "WS_URL is not set in .env",
        }))
      );
      return;
    }

    const outcomes: TurnOutcome[] = [];
    const token = resolveToken();

    let ws: WebSocket;
    try {
      ws = await connectWithRetry(session.session_id);
    } catch (e) {
      const err = (e as Error).message;
      for (const m of session.messages) {
        outcomes.push({
          question_id: m.question_id,
          question: m.question,
          answerText: "",
          responded: false,
          latencyMs: null,
          sessionIdFromServer: null,
          error: err,
        });
      }
      resolve(outcomes);
      return;
    }

    let settled = false;
    let settleTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    let confirmTimer: NodeJS.Timeout | null = null;
    let fatalError: string | null = null;
    let sentAt = 0;
    let firstFrameAt: number | null = null;
    let sentences: string[] = [];
    let sessionIdFromServer: string | null = null;
    // Source provenance Ziila reports per turn (file_ids / loaded_files /
    // play_id) — reset on every turn start, captured from whatever frames
    // arrive while that turn is in flight.
    let ctxFileIds: string[] = [];
    let ctxLoadedFiles: string[] = [];
    let ctxPlayId: string | null = null;

    const clearTimers = () => {
      if (settleTimer) clearTimeout(settleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (confirmTimer) clearTimeout(confirmTimer);
      settleTimer = null;
      hardTimer = null;
      confirmTimer = null;
    };

    // Resolved once per pending turn (or once for the initial welcome-drain).
    let resolveWaiting: (() => void) | null = null;
    // Separate waiter for the final "answer complete?" confirm pass.
    let resolveConfirm: (() => void) | null = null;

    function armSettle() {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (resolveWaiting) {
          const r = resolveWaiting;
          resolveWaiting = null;
          clearTimers();
          r();
        }
      }, WS_SETTLE_MS);
    }

    function armHardTimeout() {
      hardTimer = setTimeout(() => {
        if (resolveWaiting) {
          const r = resolveWaiting;
          resolveWaiting = null;
          clearTimers();
          r();
        }
      }, WS_TURN_TIMEOUT_MS);
    }

    // Waits either for the settle window to close after the last frame, or
    // for the hard timeout if nothing ever arrives.
    function waitForSettle(): Promise<void> {
      return new Promise((res) => {
        resolveWaiting = res;
        armHardTimeout();
      });
    }

    // A short quiet window used to CONFIRM the answer is final. Resolves early
    // (via the message handler) the moment a frame arrives — meaning the answer
    // is still flowing and the confirm has failed. Resolves on its own after
    // WS_CONFIRM_MS of total silence — the answer is final.
    function waitForConfirm(): Promise<void> {
      return new Promise((res) => {
        resolveConfirm = res;
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => {
          const r = resolveConfirm;
          resolveConfirm = null;
          confirmTimer = null;
          r && r();
        }, WS_CONFIRM_MS);
      });
    }

    function notifyFrames() {
      if (resolveConfirm) {
        // A frame arrived during the confirm window - the answer wasn't done.
        const r = resolveConfirm;
        resolveConfirm = null;
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = null;
        r();
      }
    }

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // binary/audio frame we don't need in text mode
      }
      if (msg.session_id && !sessionIdFromServer) {
        sessionIdFromServer = msg.session_id;
        console.log(`[${session.session_id}] session confirmed: ${msg.session_id}`);
      }
      if (Array.isArray(msg.file_ids) && msg.file_ids.length) ctxFileIds = msg.file_ids;
      if (Array.isArray(msg.loaded_files) && msg.loaded_files.length) ctxLoadedFiles = msg.loaded_files;
      if (typeof msg.play_id === "string" && msg.play_id) ctxPlayId = msg.play_id;
      if (typeof msg.llm_message_sentence === "string") {
        if (firstFrameAt === null) firstFrameAt = Date.now();
        sentences.push(msg.llm_message_sentence);
        armSettle();
        notifyFrames();
      } else if (msg.chunk) {
        if (firstFrameAt === null) firstFrameAt = Date.now();
        armSettle();
        notifyFrames();
      } else if (msg.error) {
        fatalError = typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error);
        armSettle();
        notifyFrames();
      } else if (msg.detection || msg.text) {
        // speech-detection / user-transcription echo — not relevant to text-input turns
        armSettle();
        notifyFrames();
      }
    });

    ws.on("error", (err: Error) => {
      fatalError = fatalError || `ws error: ${err.message}`;
      if (resolveWaiting) {
        const r = resolveWaiting;
        resolveWaiting = null;
        clearTimers();
        r();
      }
      if (resolveConfirm) {
        const r = resolveConfirm;
        resolveConfirm = null;
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = null;
        r();
      }
    });

    ws.on("close", () => {
      if (resolveWaiting) {
        const r = resolveWaiting;
        resolveWaiting = null;
        clearTimers();
        r();
      }
      if (resolveConfirm) {
        const r = resolveConfirm;
        resolveConfirm = null;
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = null;
        r();
      }
    });

    async function drainWelcome(): Promise<void> {
      sentences = [];
      firstFrameAt = null;
      await waitForSettle();
      sentences = [];
      firstFrameAt = null;
    }

    async function runTurns(): Promise<void> {
      await drainWelcome();
      let qIdx = 0;
      for (const m of session.messages) {
        if (fatalError && outcomes.length === 0) {
          // Auth/setup failed before we ever got a real turn out — bail the whole session.
          for (const rest of session.messages) {
            outcomes.push({
              question_id: rest.question_id,
              question: rest.question,
              answerText: "",
              responded: false,
              latencyMs: null,
              sessionIdFromServer,
              error: fatalError,
            });
          }
          return;
        }
        sentences = [];
        firstFrameAt = null;
        ctxFileIds = [];
        ctxLoadedFiles = [];
        ctxPlayId = null;
        const turnError = fatalError;
        fatalError = null;
        sentAt = Date.now();
        qIdx++;
        console.log(`[${session.session_id}] Q${qIdx}/${session.messages.length} → ${m.question.slice(0, 80)}`);
        try {
          ws.send(JSON.stringify({ text: m.question }));
        } catch (e) {
          outcomes.push({
            question_id: m.question_id,
            question: m.question,
            answerText: "",
            responded: false,
            latencyMs: null,
            sessionIdFromServer,
            error: `send failed: ${(e as Error).message}`,
          });
          break;
        }
        await waitForSettle();
        // Final-answer pass: the answer is only final once a full confirm window
        // passes with NO new sentences. If anything arrives during confirms we
        // settle again and reconfirm, so a slow tail of answer N can never be
        // misattributed to question N+1 (which we only send after this passes).
        for (;;) {
          const snapshot = sentences.length;
          await waitForConfirm();
          if (sentences.length === snapshot) break;
          await waitForSettle();
        }
        const answerText = sentences.join(" ").trim();
        const latencyMs = firstFrameAt !== null ? firstFrameAt - sentAt : null;
        const srcTag = ctxFileIds.length ? ` [src: ${ctxFileIds.join(", ")}]` : "";
        console.log(
          `[${session.session_id}]   ${answerText.length > 0 ? "✓" : "✗ no reply"}` +
            `${latencyMs !== null ? ` after ${latencyMs}ms` : ""}${srcTag} → ${answerText.slice(0, 80) || "(empty)"}`
        );
        outcomes.push({
          question_id: m.question_id,
          question: m.question,
          answerText,
          responded: answerText.length > 0,
          latencyMs,
          sessionIdFromServer,
          error: answerText.length === 0 ? fatalError || turnError || "no reply" : null,
          ...(ctxFileIds.length ? { fileIds: [...ctxFileIds] } : {}),
          ...(ctxLoadedFiles.length ? { loadedFiles: [...ctxLoadedFiles] } : {}),
          ...(ctxPlayId ? { playId: ctxPlayId } : {}),
        });
        if (ws.readyState !== WebSocket.OPEN) break;
        await new Promise((r) => setTimeout(r, WS_INTER_TURN_MS));
      }
    }

    // Socket is OPEN already (connectWithRetry guarantees it) — handshake and
    // run the turns directly. Connection-open failures are handled above by the
    // retry loop; mid-session drops are covered by the hard turn timeouts.
    try {
      ws.send(JSON.stringify({ agentId, token }));
      ws.send(JSON.stringify({ type: "session", sessionId: session.session_id }));
      console.log(`[${session.session_id}] ws open → handshake sent (agentId=${agentId || "<empty>"})`);
    } catch (e) {
      fatalError = `handshake send failed: ${(e as Error).message}`;
      settled = true;
      resolve(
        session.messages.map((m) => ({
          question_id: m.question_id,
          question: m.question,
          answerText: "",
          responded: false,
          latencyMs: null,
          sessionIdFromServer: null,
          error: fatalError,
        }))
      );
      return;
    }
    runTurns()
      .catch((e) => {
        fatalError = `runner error: ${(e as Error).message}`;
      })
      .finally(() => {
        for (const m of session.messages) {
          if (!outcomes.find((o) => o.question_id === m.question_id)) {
            outcomes.push({
              question_id: m.question_id,
              question: m.question,
              answerText: "",
              responded: false,
              latencyMs: null,
              sessionIdFromServer,
              error: fatalError || "not attempted (connection closed early)",
            });
          }
        }
        settled = true;
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve(outcomes);
      });
  });
}

function buildTranscript(outcomes: TurnOutcome[]): Array<{ speaker: string; text: string }> {
  const t: Array<{ speaker: string; text: string }> = [];
  for (const o of outcomes) {
    t.push({ speaker: "customer", text: o.question });
    t.push({ speaker: "agent", text: o.responded ? o.answerText : "" });
  }
  return t;
}

// Stagger session starts inside a batch so the proxy isn't hit by a burst of
// simultaneous WS handshakes (each session also retries on open failure).
async function sessionWithStagger(session: Session): Promise<SessionResult> {
  await sleep(Math.round(Math.random() * WS_CONNECT_STAGGER_MS));
  return runSession(session);
}

async function runSession(session: Session): Promise<SessionResult> {
  const agentId = agentIdFor(session);
  if (!agentId) {
    console.warn(
      `  [${session.session_id}] no agent id for language "${session.language}" ` +
        `(ZILLA_AGENT_ID_${session.language.toUpperCase()} unset) — handshake will send an empty agentId.`
    );
  }
  const started = Date.now();
  const outcomes = await runSessionOverWs(session, agentId);
  const wallMs = Date.now() - started;

  const checks: Check[] = outcomes.map((o) => ({
    clip: o.question_id,
    responded: o.responded,
    latencyMs: o.latencyMs,
  }));
  const replies = checks.filter((c) => c.responded).length;
  const passed = checks.length === session.messages.length && checks.every((c) => c.responded);
  const firstError = outcomes.find((o) => o.error)?.error || null;
  const reason = passed ? "ok" : firstError || `only ${replies}/${session.messages.length} turns answered`;
  const conversationId = outcomes.find((o) => o.sessionIdFromServer)?.sessionIdFromServer || null;

  const latencies = checks.map((c) => c.latencyMs).filter((n): n is number => n !== null);
  const maxMs = latencies.length ? Math.max(...latencies) : null;
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  const outDir = path.join(RUNS_DIR, session.session_id);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sourceFilesByTurn = outcomes
    .map((o, i) => ({
      turn: i + 1,
      question_id: o.question_id,
      file_ids: o.fileIds || [],
      loaded_files: o.loadedFiles || [],
      play_id: o.playId || null,
    }))
    .filter((r) => r.file_ids.length || r.loaded_files.length || r.play_id);
  const sourceFilesUsed = [...new Set(sourceFilesByTurn.flatMap((r) => r.file_ids))].sort();
  const summary = {
    passed,
    reason,
    agentId,
    conversationId,
    env: { appUrl: "" },
    checks,
    flags: { zillaReply: replies > 0, transcriptSaved: true, recordingUrl: false },
    latency: { maxMs, avgMs },
    transcriptMatch: { result: "N/A", reason: "direct WebSocket run — no browser transcript to compare" },
    liveTranscript: buildTranscript(outcomes),
    ...(sourceFilesUsed.length ? { sourceFilesUsed } : {}),
    ...(sourceFilesByTurn.length ? { sourceFilesByTurn } : {}),
  };
  fs.writeFileSync(path.join(outDir, `summary-${stamp}.json`), JSON.stringify(summary, null, 2));

  console.log(
    `${passed ? "PASS" : "FAIL"}  ${session.session_id.padEnd(12)} ` +
      `${replies}/${session.messages.length} replies  avg ${avgMs ?? "-"}ms` +
      `${passed ? "" : `  (${reason})`}`
  );

  return {
    session_id: session.session_id,
    language: session.language,
    agent_id: agentId,
    turns: session.messages.length,
    passed,
    reason,
    replies,
    wallMs,
    conversationId,
    callUrl: "",
    flags: { zillaReply: replies > 0, transcriptSaved: true, recordingUrl: false },
    latencyMs: { max: maxMs, avg: avgMs },
    transcriptMatch: "N/A",
  };
}

async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}

async function main(): Promise<void> {
  const fileArg = arg("file", "");
  const sessionsPath = fileArg ? path.resolve(ROOT, fileArg) : SESSIONS_PATH;

  // Refresh the WS token BEFORE opening any connection when asked to. Without
  // this the runner only ever uses the WS_TOKEN captured at startup, which
  // goes stale (HTTP 401 "Wrong authentication token").
  if (process.argv.includes("--auto-token") || process.env.AUTO_TOKEN === "1") {
    await refreshToken();
  }

  if (!fs.existsSync(sessionsPath)) {
    console.error(`No sessions file found at ${sessionsPath} — run build-sessions first.`);
    process.exitCode = 1;
    return;
  }
  if (!WS_URL) {
    console.error(`WS_URL is not set in .env — see ZIILA_WEBSOCKET_INTEGRATION.pdf for the expected format.`);
    process.exitCode = 1;
    return;
  }

  let sessions: Session[] = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  const only = arg("sessions", "");
  if (only) {
    const langs = only.split(",").map((x) => x.trim().toLowerCase());
    const langSet = new Set(langs);
    const isLang = langs.every((l) => l === "ar" || l === "en");
    if (isLang) {
      sessions = sessions.filter((s) => langSet.has(s.language));
    } else {
      const want = new Set(only.split(",").map((x) => x.trim()));
      sessions = sessions.filter((s) => want.has(s.session_id));
    }
  }
  if (!sessions.length) {
    console.error("No sessions to run (--sessions matched none).");
    process.exitCode = 1;
    return;
  }

  const sessionsPerRun = parseInt(arg("sessions-per-run", ""), 10) || parseInt(process.env.SESSIONS_PER_RUN || "0", 10);
  if (sessionsPerRun > 0 && sessionsPerRun < sessions.length) {
    sessions = sessions.slice(0, sessionsPerRun);
  }

  const totalARArg = parseInt(arg("total-ar", ""), 10) || 0;
  const totalENArg = parseInt(arg("total-en", ""), 10) || 0;
  if (totalARArg > 0) {
    const arSessions = sessions.filter((s) => s.language === "ar");
    const keepAR = new Set(arSessions.slice(0, totalARArg).map((s) => s.session_id));
    sessions = sessions.filter((s) => s.language !== "ar" || keepAR.has(s.session_id));
  }
  if (totalENArg > 0) {
    const enSessions = sessions.filter((s) => s.language === "en");
    const keepEN = new Set(enSessions.slice(0, totalENArg).map((s) => s.session_id));
    sessions = sessions.filter((s) => s.language !== "en" || keepEN.has(s.session_id));
  }

  const concAR = Math.max(parseInt(arg("concurrent-ar", ""), 10) || CONCURRENT_AR || 1, 1);
  const concEN = Math.max(parseInt(arg("concurrent-en", ""), 10) || CONCURRENT_EN || 1, 1);

  const arQueue = sessions.filter((s) => s.language === "ar");
  const enQueue = sessions.filter((s) => s.language === "en");

  console.log(
    `Running ${sessions.length} session(s) over direct WebSocket (${WS_URL.replace(/\/[^/]+$/, "/***")}) ` +
      `mode=${WS_MODE} — AR=${arQueue.length} conc=${concAR}, EN=${enQueue.length} conc=${concEN}...`
  );

  const started = Date.now();
  const results: SessionResult[] = [];
  let arIdx = 0;
  let enIdx = 0;
  let batchNum = 0;

  while (arIdx < arQueue.length || enIdx < enQueue.length) {
    batchNum++;
    const batchAR = arQueue.slice(arIdx, arIdx + concAR);
    const batchEN = enQueue.slice(enIdx, enIdx + concEN);
    const batch = [...batchAR, ...batchEN];
    if (!batch.length) break;

    console.log(
      `  batch ${batchNum}: ${batchAR.length} AR + ${batchEN.length} EN = ${batch.length} call(s)...`
    );

    const batchResults = await pool(
      batch.map(
        (s) =>
          () =>
            sessionWithStagger(s)
      ),
      batch.length
    );
    results.push(...batchResults);

    for (const r of batchResults) {
      console.log(
        `    ${r.passed ? "PASS" : "FAIL"}  ${r.session_id}  ${r.replies}/${r.turns} replies  ` +
          `avg ${r.latencyMs.avg ?? "-"}ms${r.passed ? "" : `  (${r.reason})`}`
      );
    }

    arIdx += batchAR.length;
    enIdx += batchEN.length;
  }

  results.sort((a, b) => a.session_id.localeCompare(b.session_id));
  const wallMs = Date.now() - started;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    stamp,
    startedAt: new Date().toISOString(),
    scheduling: { type: "batch-ws", concurrentAR: concAR, concurrentEN: concEN, batches: batchNum },
    selection: { shuffleSessions: false, sessionsPerRun: null, picked: results.length },
    sessions: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    wallMs,
    results,
  };
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const reportPath = path.join(RUNS_DIR, `run-results-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\n===== WS SESSION RUN SUMMARY =====");
  console.log(`sessions: ${report.sessions}  passed ${report.passed}  failed ${report.failed}`);
  for (const r of results) {
    console.log(
      `  ${r.passed ? "PASS" : "FAIL"}  ${r.session_id}  ${r.replies}/${r.turns} replies  ` +
        `avg ${r.latencyMs.avg ?? "-"}ms${r.passed ? "" : `  (${r.reason})`}`
    );
  }
  console.log(`wall clock: ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`report: ${path.relative(ROOT, reportPath)}`);

  if (report.failed > 0) process.exitCode = 1;
}

main().catch((e: Error) => {
  console.error(`[session-runner-ws] FAIL: ${e.message}`);
  process.exitCode = 1;
});
