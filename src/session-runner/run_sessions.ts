/*
 * run_sessions.ts — Phase 4A: Session Runner (UI).
 *
 * Reads data/sessions.json and runs each session as a real Zilla call THROUGH
 * the deployed frontend, reusing CallRunner (the proven Playwright + mic-injection
 * driver) as a subprocess — the same reuse pattern stress.ts uses. Per session:
 *
 *   1. stage the session's wav clips (turn order -> 001_<questionId>.wav) into
 *      data/runs/<session_id>/clips/
 *   2. spawn callrunner/e2e.ts with ASSETS_DIR=clips, OUT_DIR=data/runs/<session_id>,
 *      and the right agent for the session's language
 *   3. collect callrunner's summary-*.json + e2e.log into the session OUT_DIR
 *
 * Aggregates every session into data/run-results-<stamp>.json and prints a table.
 *
 * Usage (scheduling is configured in .env, CLI only overrides):
 *   CONCURRENCY=10        total in-flight calls (default 1) — used when the
 *                         per-language budgets below are NOT set
 *   CONCURRENT_AR=4       max Arabic-agent calls running at once
 *   CONCURRENT_EN=6       max English-agent calls running at once
 *                         (if either is set, the runner keeps AR<=CONCURRENT_AR
 *                          and EN<=CONCURRENT_EN in flight at the same time —
 *                          the "waves" of 4 ar + 6 en = 10 that you asked for)
 *   RUNS_DIR=<path>       where per-session outputs go (default data/runs)
 *   --sessions S001_ar,S002_en   only these sessions (optional)
 *   --concurrency N              overrides CONCURRENCY (optional)
 *   --headed                     show the browser (optional)
 *
 * CallRunner is vendored in ./callrunner. Zilla connection (APP_URL,
 * ZILLA_EMAIL, ZILLA_PASSWORD, VITE_API_BASE_URL) is read from this project's
 * .env and forwarded to CallRunner, so it needs no .env of its own.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import dotenv from "dotenv";

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
const RUNS_DIR = process.env.RUNS_DIR
  ? path.resolve(process.env.RUNS_DIR)
  : path.join(ROOT, "data", "runs");

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const HEADED = has("headed");

function intEnv(name: string, def: number): number {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isNaN(n) || n < 1 ? def : n;
}

// Scheduling config: per-language in-flight budgets win over plain concurrency.
// --concurrency (CLI) overrides CONCURRENCY (.env).
const CLI_CONCURRENCY = parseInt(arg("concurrency", ""), 10);
const CONCURRENCY = !Number.isNaN(CLI_CONCURRENCY) && CLI_CONCURRENCY > 0
  ? CLI_CONCURRENCY
  : intEnv("CONCURRENCY", 1);
const CLI_CONCURRENT_AR = parseInt(arg("concurrent-ar", ""), 10);
const CLI_CONCURRENT_EN = parseInt(arg("concurrent-en", ""), 10);
const CONCURRENT_AR = !Number.isNaN(CLI_CONCURRENT_AR) && CLI_CONCURRENT_AR > 0
  ? CLI_CONCURRENT_AR
  : intEnv("CONCURRENT_AR", 0);
const CONCURRENT_EN = !Number.isNaN(CLI_CONCURRENT_EN) && CLI_CONCURRENT_EN > 0
  ? CLI_CONCURRENT_EN
  : intEnv("CONCURRENT_EN", 0);
const MIXED = CONCURRENT_AR > 0 || CONCURRENT_EN > 0;

// RESHUFFLE=true -> re-randomize the question order INSIDE each session on
// every run (no rebuild needed). RESHUFFLE=false (default) -> play each
// session exactly as built by the seeded session builder.
const RESHUFFLE = (process.env.RESHUFFLE ?? "false").toLowerCase() === "true";

// SHUFFLE_SESSIONS=true -> randomize the ORDER sessions run and, together
// with SESSIONS_PER_RUN, WHICH sessions get picked each run. So running
// "SESSIONS_PER_RUN=3" twice can pick different sessions both times (all
// sessions eventually get exercised). SESSIONS_PER_RUN=0 (default) = run all.
const SHUFFLE_SESSIONS = (process.env.SHUFFLE_SESSIONS ?? "false").toLowerCase() === "true";
const SESSIONS_PER_RUN = (() => {
  const cli = parseInt(arg("sessions-per-run", ""), 10);
  if (!Number.isNaN(cli) && cli >= 0) return cli;
  return intEnv("SESSIONS_PER_RUN", 0);
})();

function shuffleArr<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Random pick of K sessions that PRESERVES the AR/EN ratio of the full list.
// From 10 ar + 10 en with K=4 -> exactly 2 ar + 2 en; from 10 ar + 20 en with
// K=6 -> 2 ar + 4 en. The picked sessions are then shuffled for run order.
function pickProportional(all: Session[], k: number): Session[] {
  if (k >= all.length) return shuffleArr(all);
  const ar = all.filter((s) => s.language === "ar");
  const en = all.filter((s) => s.language === "en");
  let wantAr = Math.round((k * ar.length) / all.length);
  let wantEn = k - wantAr;
  if (wantAr > ar.length) {
    wantEn += wantAr - ar.length;
    wantAr = ar.length;
  }
  if (wantEn > en.length) {
    wantAr += wantEn - en.length;
    wantEn = en.length;
  }
  if (wantAr > ar.length) wantAr = ar.length;
  if (wantEn > en.length) wantEn = en.length;
  const picked = shuffleArr(ar).slice(0, wantAr).concat(shuffleArr(en).slice(0, wantEn));
  return shuffleArr(picked);
}

function resolveCallrunner(): string {
  const vendored = path.join(ROOT, "callrunner");
  if (fs.existsSync(path.join(vendored, "e2e.ts"))) return vendored;
  if (process.env.CALLRUNNER_DIR) return path.resolve(process.env.CALLRUNNER_DIR);
  throw new Error(
    "Could not find CallRunner. CallRunner is vendored in ./callrunner (its source was " +
      "copied from the reference repo); alternatively set CALLRUNNER_DIR in .env to a folder " +
      "containing callrunner's e2e.ts."
  );
}

function runCallrunner(
  script: string,
  args: string[],
  env: Record<string, string>
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d;
      process.stdout.write(d);
    });
    p.stderr.on("data", (d: Buffer) => {
      out += d;
      process.stderr.write(d);
    });
    p.on("close", (code) => resolve({ code, out }));
  });
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

async function safeRunSession(session: Session, callrunnerDir: string): Promise<SessionResult> {
  try {
    return await runSession(session, callrunnerDir);
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`FAIL  ${session.session_id.padEnd(12)}  setup error: ${msg}`);
    return {
      session_id: session.session_id,
      language: session.language,
      agent_id: agentIdFor(session),
      turns: session.messages.length,
      passed: false,
      reason: `setup error: ${msg}`,
      replies: 0,
      wallMs: 0,
      conversationId: null,
      callUrl: "",
      flags: { zillaReply: false, transcriptSaved: false, recordingUrl: false },
      latencyMs: { max: null, avg: null },
      transcriptMatch: "N/A",
    };
  }
}

// Mixed scheduler: keeps at most maxAR Arabic + maxEN English sessions in
// flight at the same time. A slot that frees up is immediately reused by the
// next session of the same language, so a batch of 4ar+6en naturally drains
// and refills as a series of 10-call waves.
async function runMixed(
  arSessions: Session[],
  enSessions: Session[],
  maxAR: number,
  maxEN: number,
  callrunnerDir: string
): Promise<SessionResult[]> {
  const results: SessionResult[] = [];
  let arIdx = 0;
  let enIdx = 0;
  let runningAR = 0;
  let runningEN = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (runningAR < maxAR && arIdx < arSessions.length) {
        const s = arSessions[arIdx++];
        runningAR++;
        safeRunSession(s, callrunnerDir)
          .then((r) => {
            results.push(r);
            runningAR--;
            pump();
          });
      }
      while (runningEN < maxEN && enIdx < enSessions.length) {
        const s = enSessions[enIdx++];
        runningEN++;
        safeRunSession(s, callrunnerDir)
          .then((r) => {
            results.push(r);
            runningEN--;
            pump();
          });
      }
      if (
        arIdx >= arSessions.length &&
        enIdx >= enSessions.length &&
        runningAR === 0 &&
        runningEN === 0
      ) {
        resolve();
      }
    };
    pump();
  });
  return results;
}

function stageClips(sessionId: string, messages: SessionTurn[], outDir: string): string[] {
  const clipDir = path.join(outDir, "clips");
  fs.mkdirSync(clipDir, { recursive: true });
  for (const f of fs.readdirSync(clipDir)) {
    if (f.toLowerCase().endsWith(".wav")) fs.rmSync(path.join(clipDir, f), { force: true });
  }
  const clips: string[] = [];
  for (const [i, turn] of messages.entries()) {
    const src = path.resolve(ROOT, turn.audio_file);
    if (!fs.existsSync(src)) {
      throw new Error(
        `missing clip for ${sessionId} turn ${turn.turn}: ${turn.audio_file} ` +
          `(run Phase 2 first: npm run generate-audio)`
      );
    }
    const dst = path.join(clipDir, `${String(i + 1).padStart(3, "0")}_${turn.question_id}.wav`);
    fs.copyFileSync(src, dst);
    clips.push(dst);
  }
  return clips;
}

function readSummary(outDir: string): any {
  try {
    const f = fs
      .readdirSync(outDir)
      .filter((x) => /^summary-.*\.json$/.test(x))
      .sort()
      .pop();
    return f ? JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8")) : null;
  } catch {
    return null;
  }
}

// Count customer turns that got a real agent reply by aligning the live
// transcript (authoritative WS stream) instead of trusting the DOM poller's
// per-clip `checks[].responded`, which can race and miss answers that DID
// arrive (silent-clip false positives). Returns -1 when there's no transcript
// to judge from, so callers fall back to the checks.
function transcriptAnsweredCount(s: any): number {
  const tr: any[] = s?.liveTranscript || s?.transcript?.turns || [];
  if (!Array.isArray(tr) || tr.length === 0) return -1;
  let i = tr.length && String(tr[0]?.speaker).toLowerCase() === "agent" ? 1 : 0;
  let answered = 0;
  for (; i < tr.length; i++) {
    if (String(tr[i]?.speaker).toLowerCase() !== "customer") continue;
    const nxt = tr[i + 1];
    if (nxt && String(nxt.speaker).toLowerCase() === "agent" && String(nxt.text || "").trim()) {
      answered++;
      i++;
    }
  }
  return answered;
}

function agentIdFor(session: Session): string {
  if (session.agent_id) return session.agent_id;
  const byLang = session.language === "ar" ? "ZILLA_AGENT_ID_AR" : "ZILLA_AGENT_ID_EN";
  return process.env[byLang] || "";
}

async function runSession(session: Session, callrunnerDir: string): Promise<SessionResult> {
  const outDir = path.join(RUNS_DIR, session.session_id);
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* best-effort; summaries are never locked */
  }
  fs.mkdirSync(outDir, { recursive: true });
  const messages = RESHUFFLE
    ? shuffleArr(session.messages).map((m, i) => ({ ...m, turn: i + 1 }))
    : session.messages;
  stageClips(session.session_id, messages, outDir);

  const agentId = agentIdFor(session);
  if (!agentId) {
    console.warn(
      `  [${session.session_id}] no agent id for language "${session.language}" ` +
        `(ZILLA_AGENT_ID_${session.language.toUpperCase()} unset) — CallRunner will pick ` +
        `the account's first agent, which may be the wrong language's agent.`
    );
  }

  const started = process.hrtime.bigint();
  const args = ["--no-interruption", ...(HEADED ? ["--headed"] : [])];
  const zillaEnv: Record<string, string> = {};
  for (const k of ["APP_URL", "ZILLA_EMAIL", "ZILLA_PASSWORD", "VITE_API_BASE_URL"]) {
    const v = process.env[k];
    if (v) zillaEnv[k] = v;
  }
  const r = await runCallrunner(path.join(callrunnerDir, "e2e.ts"), args, {
    ASSETS_DIR: path.join(outDir, "clips"),
    OUT_DIR: outDir,
    TRACE_FAILED_CALLS: "1",
    ...zillaEnv,
    ...(agentId ? { ZILLA_AGENT_ID: agentId } : {}),
  });
  const wallMs = Number((process.hrtime.bigint() - started) / 1000000n);
  fs.writeFileSync(path.join(outDir, "e2e.log"), r.out);

  const s = readSummary(outDir);
  const checks = s?.checks || [];
  const transcriptReplies = transcriptAnsweredCount(s);
  // Prefer the live transcript (authoritative) over the DOM poller (races).
  // Cap at the session's own question count: a single spoken question can be
  // split by STT into two utterances and answered twice (e.g. "ما هو" then the
  // full text), which would otherwise inflate the count to turns + 1.
  const replies = Math.min(
    transcriptReplies >= 0
      ? transcriptReplies
      : (checks as any[]).filter((c: any) => c.responded).length,
    session.messages.length
  );
  const transcriptBasedPass = transcriptReplies >= 0 && transcriptReplies >= session.messages.length;
  const passed = s ? (transcriptBasedPass || !!s.passed) : false;
  const reason = passed ? "ok" : (s?.reason || (s ? "ok" : "no summary (setup error)"));
  const appUrl = s?.env?.appUrl || "";
  const conversationId = s?.conversationId || "";
  const callUrl =
    appUrl && agentId && conversationId
      ? `${appUrl}/en/agents/${agentId}/conversations/${conversationId}`
      : "";

  const result: SessionResult = {
    session_id: session.session_id,
    language: session.language,
    agent_id: agentId,
    turns: session.messages.length,
    passed,
    reason,
    replies,
    wallMs,
    conversationId,
    callUrl,
    flags: {
      zillaReply: passed,
      transcriptSaved: !!s?.flags?.transcriptSaved,
      recordingUrl: !!s?.flags?.recordingUrl,
    },
    latencyMs: { max: s?.latency?.maxMs ?? null, avg: s?.latency?.avgMs ?? null },
    transcriptMatch: s?.transcriptMatch?.result || "N/A",
  };

  console.log(
    `${result.passed ? "PASS" : "FAIL"}  ${session.session_id.padEnd(12)} ` +
      `${replies}/${session.messages.length} replies  ` +
      `avg ${result.latencyMs.avg ?? "-"}ms  transcript-match ${result.transcriptMatch}` +
      `${result.passed ? "" : `  (${result.reason})`}`
  );
  return result;
}

async function main(): Promise<void> {
  const fileArg = arg("file", "");
  const sessionsPath = fileArg ? path.resolve(ROOT, fileArg) : SESSIONS_PATH;

  if (!fs.existsSync(sessionsPath)) {
    console.error(`No sessions file found at ${sessionsPath} — run build-sessions first.`);
    process.exitCode = 1;
    return;
  }
  const callrunnerDir = resolveCallrunner();

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

  // Session selection/order for THIS run: pick at random PRESERVING the AR/EN
  // ratio (when capping), then run the picked sessions (shuffled if asked).
  let arCount = 0;
  let enCount = 0;
  if (SESSIONS_PER_RUN > 0 && SESSIONS_PER_RUN < sessions.length) {
    sessions = pickProportional(sessions, SESSIONS_PER_RUN);
    arCount = sessions.filter((s) => s.language === "ar").length;
    enCount = sessions.filter((s) => s.language === "en").length;
  } else if (SHUFFLE_SESSIONS) {
    sessions = shuffleArr(sessions);
    arCount = sessions.filter((s) => s.language === "ar").length;
    enCount = sessions.filter((s) => s.language === "en").length;
  } else {
    arCount = sessions.filter((s) => s.language === "ar").length;
    enCount = sessions.filter((s) => s.language === "en").length;
  }

  const totalARArg = parseInt(arg("total-ar", ""), 10) || 0;
  const totalENArg = parseInt(arg("total-en", ""), 10) || 0;
  if (totalARArg > 0) {
    const arOnly = sessions.filter((s) => s.language === "ar");
    const keepAR = new Set(arOnly.slice(0, totalARArg).map((s) => s.session_id));
    sessions = sessions.filter((s) => s.language !== "ar" || keepAR.has(s.session_id));
  }
  if (totalENArg > 0) {
    const enOnly = sessions.filter((s) => s.language === "en");
    const keepEN = new Set(enOnly.slice(0, totalENArg).map((s) => s.session_id));
    sessions = sessions.filter((s) => s.language !== "en" || keepEN.has(s.session_id));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const arSessions = sessions.filter((s) => s.language === "ar");
  const enSessions = sessions.filter((s) => s.language === "en");
  const concAR = Math.max(parseInt(arg("concurrent-ar", ""), 10) || CONCURRENT_AR || 1, 1);
  const concEN = Math.max(parseInt(arg("concurrent-en", ""), 10) || CONCURRENT_EN || 1, 1);
  // Call quota per language: --total-ar/--total-en is a TARGET number of CALLS.
  // When it exceeds the available sessions, sessions are re-cycled across
  // batches (never twice within one batch, so two copies of the same
  // session_id never touch its output folder at the same time).
  let totalAR = totalARArg > 0 ? totalARArg : arSessions.length;
  let totalEN = totalENArg > 0 ? totalENArg : enSessions.length;
  if (arSessions.length === 0 && totalAR > 0) {
    console.warn(`  [warn] --total-ar ${totalAR} but 0 Arabic sessions in this file — skipping Arabic calls`);
    totalAR = 0;
  }
  if (enSessions.length === 0 && totalEN > 0) {
    console.warn(`  [warn] --total-en ${totalEN} but 0 English sessions in this file — skipping English calls`);
    totalEN = 0;
  }
  const selection =
    (SHUFFLE_SESSIONS ? "shuffle " : "") +
    (SESSIONS_PER_RUN > 0 ? `cap ${SESSIONS_PER_RUN} (AR ${arCount}/EN ${enCount}) ` : "all ") +
    (RESHUFFLE ? "+ reshuffle-in-session " : "") +
    (totalAR !== arSessions.length || totalEN !== enSessions.length
      ? `+ cycle to ${totalAR}ar/${totalEN}en calls ` : "");
  console.log(
    `Running ${sessions.length} unique session(s) (AR ${arSessions.length} -> ${totalAR} call(s) conc=${concAR} / ` +
      `EN ${enSessions.length} -> ${totalEN} call(s) conc=${concEN}) (${selection})via ${callrunnerDir}...`
  );
  const started = Date.now();
  const results: SessionResult[] = [];
  let arSent = 0;
  let enSent = 0;
  let arIdx = 0;
  let enIdx = 0;
  let batchNum = 0;

  while (arSent < totalAR || enSent < totalEN) {
    batchNum++;
    const batchAR: Session[] = [];
    const takenAR = new Set<string>();
    while (batchAR.length < concAR && arSent < totalAR) {
      let placed = false;
      for (let k = 0; k < arSessions.length; k++) {
        const s = arSessions[arIdx % arSessions.length];
        arIdx++;
        if (!takenAR.has(s.session_id)) {
          batchAR.push(s);
          takenAR.add(s.session_id);
          arSent++;
          placed = true;
          break;
        }
      }
      if (!placed) break;
    }
    const batchEN: Session[] = [];
    const takenEN = new Set<string>();
    while (batchEN.length < concEN && enSent < totalEN) {
      let placed = false;
      for (let k = 0; k < enSessions.length; k++) {
        const s = enSessions[enIdx % enSessions.length];
        enIdx++;
        if (!takenEN.has(s.session_id)) {
          batchEN.push(s);
          takenEN.add(s.session_id);
          enSent++;
          placed = true;
          break;
        }
      }
      if (!placed) break;
    }
    const batch = [...batchAR, ...batchEN];
    if (!batch.length) break;

    console.log(
      `  batch ${batchNum}: ${batchAR.length} AR (${arSent}/${totalAR}) + ` +
        `${batchEN.length} EN (${enSent}/${totalEN}) = ${batch.length} call(s)...`
    );

    const batchResults = await pool(batch.map((s) => () => safeRunSession(s, callrunnerDir)), batch.length);
    results.push(...batchResults);
  }

  results.sort((a, b) => a.session_id.localeCompare(b.session_id));
  const wallMs = Date.now() - started;

  const report = {
    stamp,
    startedAt: new Date().toISOString(),
    scheduling: { type: "batch", concurrentAR: concAR, concurrentEN: concEN, batches: batchNum },
    selection: {
      shuffleSessions: SHUFFLE_SESSIONS,
      sessionsPerRun: SESSIONS_PER_RUN > 0 ? SESSIONS_PER_RUN : null,
      picked: arCount + enCount,
      pickedAr: arCount,
      pickedEn: enCount,
      reshuffleInSession: RESHUFFLE,
    },
    sessions: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    wallMs,
    results,
  };
  const reportPath = path.join(RUNS_DIR, `run-results-${stamp}.json`);
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\n===== SESSION RUN SUMMARY =====");
  console.log(`sessions: ${report.sessions}  passed ${report.passed}  failed ${report.failed}`);
  for (const r of results) {
    const line = `  ${r.passed ? "PASS" : "FAIL"}  ${r.session_id}  ${r.replies}/${r.turns} replies  ` +
      `avg ${r.latencyMs.avg ?? "-"}ms  transcript-match ${r.transcriptMatch}`;
    console.log(line);
    if (!r.passed && r.callUrl) console.log(`      ${r.callUrl}`);
    else if (!r.passed) console.log(`      (no saved conversation URL)`);
  }
  console.log(`wall clock: ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`report: ${path.relative(ROOT, reportPath)}`);

  if (report.failed > 0) process.exitCode = 1;
}

main().catch((e: Error) => {
  console.error(`[session-runner] FAIL: ${e.message}`);
  process.exitCode = 1;
});