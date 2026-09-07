/*
 * server.ts - Web dashboard / UI for zilla-kb-tool.
 *
 * Local-only server (stdlib, no extra deps - anyone who clones the project
 * just runs `npm run ui`). Serves a dashboard where you can:
 *   - edit every .env config value (with hover tooltips explaining each one)
 *   - run any phase by hand, or run a sequence automatically
 *   - watch every call: question -> Zilla's answer (animated), per-turn
 *     DeepEval metrics, the call link, and Zilla's latency
 *
 * Usage:
 *   npm run ui                    # starts on http://localhost:5173, opens browser
 *   UI_PORT=8080 npm run ui       # custom port
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { pairTranscript } from "../lib/transcript-pairing";

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".env");
const HTML_PATH = path.join(ROOT, "src", "ui", "index.html");
const DATA_DIR = path.join(ROOT, "data");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const WAV_DIR = path.join(ROOT, "wav");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

const PORT_BASE = parseInt(process.env.UI_PORT || "5173", 10);

// --- phases: id -> npm script + arg hint -------------------------------------
const PHASES: Array<{ id: string; label: string; script: string; hint: string; needs?: string }> = [
  { id: "extractChunks", label: "1. Extract KB chunks", script: "extract-chunks", hint: "spl_kb.docx data/chunks.json" },
  { id: "generateQuestions", label: "2. Generate questions", script: "generate-questions", hint: "" },
  { id: "validateQuestions", label: "3. Validate questions", script: "validate-questions", hint: "" },
  { id: "generateAudio", label: "4. Generate audio (TTS)", script: "generate-audio", hint: "" },
  { id: "buildSessions", label: "5. Build sessions", script: "build-sessions", hint: "" },
  { id: "runSessionsWs", label: "6. Run sessions (WebSocket)", script: "run-sessions-ws", hint: "--file sessions/Loan/Car Loan.json" },
  { id: "runSessions", label: "6. Run sessions (live calls)", script: "run-sessions", hint: "--sessions S001_ar --concurrency 2 --headed" },
  { id: "captureAnswers", label: "7. Capture answers", script: "capture-answers", hint: "--report data/runs/run-results-...json" },
  { id: "evaluate", label: "8. Evaluate (DeepEval)", script: "evaluate", hint: "(empty = ALL questions of latest capture) | --sample N | --no-resume" },
  { id: "clean", label: "9. Clean / reset data", script: "clean", hint: "--from 5 (delete outputs of phase 5..8)" },
];
const PHASE_BY_ID = new Map(PHASES.map((p) => [p.id, p]));

// --- config docs (Arabic tooltips for the ℹ️ icons) ---------------------------
const CONFIG_DOCS: Record<string, string> = {
  LLM_PROVIDER: "LLM provider for generating questions: gemini (free) or openai (paid).",
  GEMINI_API_KEY: "Free Gemini key from aistudio.google.com - required when provider is gemini.",
  GEMINI_MODEL: "Gemini model used for generating questions.",
  OPENAI_API_KEY: "OpenAI key - required when provider is openai.",
  OPENAI_MODEL: "OpenAI model used for generating questions.",
  SAMPLE_SIZE: "How many KB chunks to generate questions from, or 'all' to cover everything.",
  GENERATE_ENGLISH: "Generate an English version of every question.",
  GENERATE_ARABIC: "Generate an Arabic version of every question.",
  RESUME: "Skip questions already generated when re-running.",
  REQUEST_DELAY_MS: "Pause between each LLM call (ms) - raise it for large KBs.",
  MAX_RETRIES: "Retry count after a rate limit (429).",
  MESSAGES_PER_SESSION: "How many questions (turns) go into one call/session.",
  TOTAL_SESSIONS_AR: "How many calls to build on the Arabic agent.",
  TOTAL_SESSIONS_EN: "How many calls to build on the English agent.",
  RANDOM_SEED: "Random seed for question ordering - same seed + same data = same sessions.",
  ALLOW_REPEAT_QUESTIONS: "Allow a question in more than one session once the pool runs out.",
  ZILLA_AGENT_ID_AR: "Zilla agent id (Arabic) - updated automatically by `npm run agents`.",
  ZILLA_AGENT_ID_EN: "Zilla agent id (English) - updated automatically by `npm run agents`.",
  ZILLA_AGENT_AR: "Arabic agent NAME - type it here, run `npm run agents` to resolve to the id.",
  ZILLA_AGENT_EN: "English agent NAME - type it here, run `npm run agents` to resolve to the id.",
  APP_URL: "Zilla platform URL.",
  ZILLA_EMAIL: "Zilla login email.",
  ZILLA_PASSWORD: "Zilla login password.",
  VITE_API_BASE_URL: "Zilla API base URL.",
  CONCURRENCY: "Max calls running at once (when not splitting per language).",
  CONCURRENT_AR: "Max Arabic calls running at the same time.",
  CONCURRENT_EN: "Max English calls running at the same time.",
  RESHUFFLE: "Re-randomize question order inside each session at run time.",
  SHUFFLE_SESSIONS: "Randomize which sessions run and in what order each run.",
  SESSIONS_PER_RUN: "How many sessions to run this run (0 = all).",
  EVAL_LLM_PROVIDER: "Eval judge provider: ollama (local/free) or openai (Groq/OpenAI) or gemini.",
  EVAL_MODEL: "Judge model (Groq: e.g. openai/gpt-oss-120b; Ollama: `ollama pull` first).",
  EVAL_LLM_BASE_URL: "API base: https://api.groq.com/openai/v1 (free Groq) or local Ollama http://localhost:11434/v1.",
  GROQ_API_KEY: "Free Groq key from console.groq.com - works with EVAL_LLM_PROVIDER=openai.",
  RUNS_DIR: "Folder for run results (default data/runs).",
  CALLRUNNER_DIR: "Alternate CallRunner copy path (optional - vendored copy is default).",
  TTS_OUTPUT_DIR: "Audio output folder (default wav).",
  TTS_RESUME: "Skip existing audio files when re-running.",
  TTS_REQUEST_DELAY_MS: "Pause between each audio file (ms).",
  TTS_MAX_RETRIES: "Retry count for audio generation failures.",
  PYTHON_CMD: "Python command (default python on Windows / python3 elsewhere).",
  UI_PORT: "Dashboard port (default 5173).",
};

// --- which phase uses which config key (for the grouped .env editor) ---------
const CONFIG_GROUPS: { header: string; keys: string[] }[] = [
  {
    header: "Phase 2 — Generate questions",
    keys: [
      "LLM_PROVIDER", "GEMINI_API_KEY", "GEMINI_MODEL",
      "OPENAI_API_KEY", "OPENAI_MODEL",
      "SAMPLE_SIZE", "GENERATE_ENGLISH", "GENERATE_ARABIC",
      "RESUME", "REQUEST_DELAY_MS", "MAX_RETRIES",
    ],
  },
  {
    header: "Phase 4 — Generate audio (TTS)",
    keys: ["TTS_OUTPUT_DIR", "TTS_RESUME", "TTS_REQUEST_DELAY_MS", "TTS_MAX_RETRIES", "EDGE_TTS_VOICE_AR", "EDGE_TTS_VOICE_EN", "PYTHON_CMD"],
  },
  {
    header: "Phase 5 — Build sessions",
    keys: ["MESSAGES_PER_SESSION", "TOTAL_SESSIONS_AR", "TOTAL_SESSIONS_EN", "RANDOM_SEED", "ALLOW_REPEAT_QUESTIONS", "ZILLA_AGENT_ID_AR", "ZILLA_AGENT_ID_EN"],
  },
  {
    header: "Agents (Zilla) — used by Phase 5/6 + agents tool",
    keys: ["APP_URL", "VITE_API_BASE_URL", "ZILLA_EMAIL", "ZILLA_PASSWORD", "ZILLA_AGENT_AR", "ZILLA_AGENT_EN"],
  },
  {
    header: "Phase 6 — Run sessions (live calls)",
    keys: ["CALLRUNNER_DIR", "RUNS_DIR", "CONCURRENCY", "CONCURRENT_AR", "CONCURRENT_EN", "RESHUFFLE", "SHUFFLE_SESSIONS", "SESSIONS_PER_RUN"],
  },
  {
    header: "Phase 8 — Evaluate (DeepEval)",
    keys: ["EVAL_LLM_PROVIDER", "EVAL_MODEL", "EVAL_LLM_BASE_URL", "GROQ_API_KEY"],
  },
  {
    header: "Dashboard",
    keys: ["UI_PORT"],
  },
];

const CONFIG_GROUP_OF = new Map<string, string>();
for (const g of CONFIG_GROUPS) for (const k of g.keys) CONFIG_GROUP_OF.set(k, g.header);
const CONFIG_GROUP_ORDER = new Map(CONFIG_GROUPS.map((g, i) => [g.header, i]));

// --- .env read/write (preserves comments and order) --------------------------
function readEnv(): { lines: string[]; values: Record<string, string> } {
  const text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const values: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) values[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
  return { lines, values };
}

function writeEnvValues(values: Record<string, string>): void {
  const { lines } = readEnv();
  const updated = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (m && m[2] in values) {
      const v = values[m[2]];
      const needsQuote = /[\s#]/.test(v) && !/^".*"$/.test(v);
      return `${m[1]}${m[2]}${m[3]}${needsQuote ? `"${v}"` : v}`;
    }
    return line;
  });
  fs.writeFileSync(ENV_PATH, updated.join("\n"), "utf8");
}

// --- helpers -----------------------------------------------------------------
function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function newest(pattern: RegExp, dir: string = DATA_DIR): string | null {
  try {
    // Sort by the ISO stamp embedded in the filename (eval-results-<stamp>-<judge>.json),
    // NOT alphabetically - judge suffixes like "zzz-local-backup" would otherwise win.
    // Files without a parseable stamp (e.g. backups, poison fixtures) rank last.
    const stamp = (f: string): string => {
      const m = f.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z?)/);
      return m ? m[1] : "";
    };
    const files = fs.readdirSync(dir).filter((f) => pattern.test(f));
    if (!files.length) return null;
    files.sort((a, b) => {
      const sa = stamp(a);
      const sb = stamp(b);
      if (sa !== sb) return sb.localeCompare(sa);
      // same embedded stamp (e.g. two judges over one capture): most recently WRITTEN wins
      try {
        return (
          fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs
        );
      } catch {
        return b.localeCompare(a);
      }
    });
    return path.join(dir, files[0]);
  } catch {
    return null;
  }
}

function sendJson(res: http.ServerResponse, data: any): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// --- status ------------------------------------------------------------------
function status(): any {
  const qs = readJson(path.join(DATA_DIR, "questions.json"));
  const sessions = readJson(path.join(DATA_DIR, "sessions.json"));
  let wavCount = 0;
  try {
    wavCount = fs.readdirSync(WAV_DIR).filter((f) => f.endsWith(".wav")).length;
  } catch {
    /* no wav dir yet */
  }
  const runFile = newest(/^run-results-.*\.json$/, RUNS_DIR);
  const run = runFile ? readJson(runFile) : null;
  const capFile = newest(/^captured-answers-.*\.json$/);
  const cap = capFile ? readJson(capFile) : null;
  const evFile = newest(/^eval-results-.*\.json$/);
  const ev = evFile ? readJson(evFile) : null;
  const byLang = (arr: any[]) =>
    arr.reduce((a: Record<string, number>, x: any) => {
      a[x.language] = (a[x.language] || 0) + 1;
      return a;
    }, {});
  return {
    questions: Array.isArray(qs) ? qs.length : null,
    questionsByLang: Array.isArray(qs) ? byLang(qs) : {},
    sessions: Array.isArray(sessions) ? sessions.length : null,
    sessionsByLang: Array.isArray(sessions) ? byLang(sessions) : {},
    wav: wavCount,
    run: run
      ? { file: path.basename(runFile!), sessions: run.sessions, passed: run.passed, failed: run.failed, wallMs: run.wallMs }
      : null,
    captured: cap
      ? { file: path.basename(capFile!), totalTurns: cap.totalTurns, answered: cap.answered, unanswered: cap.unanswered, avgLatencyMs: cap.avgLatencyMs, avgLatencyFirstAudioChunkMs: cap.avgLatencyFirstAudioChunkMs }
      : null,
    eval: ev ? { file: path.basename(evFile!), summary: ev.summary, provider: ev.provider, model: ev.model } : null,
  };
}

// Read live transcript from a session's summary-*.json as fallback turns
function turnsFromSummary(sessionId: string): any[] {
  const dir = path.join(RUNS_DIR, sessionId);
  try {
    const files = fs.readdirSync(dir).filter((f: string) => /^summary-.*\.json$/.test(f)).sort();
    if (!files.length) return [];
    const summary = readJson(path.join(dir, files[files.length - 1]));
    const transcript: any[] = summary.liveTranscript || summary.transcript?.turns || [];
    const checks: any[] = summary.checks || [];
    const conversationId = summary.conversationId || summary.artifacts?.conversationId || "";
    const agentId = summary.agentId || "";
    const appUrl = summary.env?.appUrl || "";
    const callUrl = (appUrl && agentId && conversationId)
      ? `${appUrl}/en/agents/${agentId}/conversations/${conversationId}` : "";

    // Per-turn source file IDs: files Zilla loaded/used for THAT question, not
    // cumulative. Turns with no relay frame inherit the most recent known set.
    const perTurnByIdx = new Map<number, string[]>();
    for (const entry of summary.sourceFilesByTurn || []) {
      perTurnByIdx.set(
        entry.turn,
        [...new Set([...(entry.fileIds || []), ...(entry.loadedFiles || [])])],
      );
    }
    const sourceIdsForTurn = (turn: number): string[] => {
      const direct = perTurnByIdx.get(turn);
      if (direct && direct.length) return direct;
      for (let t = turn - 1; t >= 1; t--) {
        const prev = perTurnByIdx.get(t);
        if (prev && prev.length) return prev;
      }
      return [];
    };

    // Pair the authoritative WS transcript's questions → answers (merging
    // stray customer fragments and grading by the first later agent reply),
    // then zip each pair with its clip check for the question id/latency.
    // The transcript decides whether a reply exists — never the DOM poller's
    // checks[].responded, which can race and miss answers that DID arrive.
    const pairs = pairTranscript(transcript);
    const result: any[] = [];
    for (let ci = 0; ci < checks.length; ci++) {
      const check = checks[ci];
      const clipName = check.clip || "";
      const qidMatch = clipName.match(/^\d+_(.+)\.wav$/);
      const questionId = qidMatch ? qidMatch[1] : "";
      const pair = pairs[ci] || { question: { text: "" }, answer: null };
      const agentText = pair.answer && String(pair.answer.text || "").trim()
        ? pair.answer.text
        : null;
      result.push({
        turn: ci + 1,
        question_id: questionId,
        question: pair.question?.text || "",
        expected_answer: "",
        zilla_answer: agentText,
        source_chunks: [],
        source_file_ids: sourceIdsForTurn(ci + 1),
        latency_ms: check.latencyMs ?? null,
        latency_first_audio_chunk_ms: check.latencyMsToFirstAudioChunk ?? null,
        conversation_id: conversationId,
        call_url: callUrl,
        responded: !!agentText,
        metrics: null,
        evalError: null,
      });
    }
    return result;
  } catch { return []; }
}

// --- calls view: run report + captured turns + eval metrics -------------------
function buildCalls(): any {
  const runFile = newest(/^run-results-.*\.json$/, RUNS_DIR);
  const capFile = newest(/^captured-answers-.*\.json$/);
  const evFile = newest(/^eval-results-.*\.json$/);
  const run = runFile ? readJson(runFile) : null;
  const cap = capFile ? readJson(capFile) : null;
  const ev = evFile ? readJson(evFile) : null;
  const capMatchesRun = !!(cap && runFile && cap.sourceReport && path.basename(String(cap.sourceReport)) === path.basename(runFile));

  const evalByKey = new Map<string, any>();
  for (const r of ev?.records || []) {
    evalByKey.set(`${r.session_id}|${r.question_id}`, r);
  }

  // Primary: captured-answers — only when this capture belongs to the run being shown
  const turnsBySession = new Map<string, any[]>();
  for (const r of (capMatchesRun ? cap?.records || [] : [])) {
    const list = turnsBySession.get(r.session_id) || [];
    const er = evalByKey.get(`${r.session_id}|${r.question_id}`);
    list.push({
      turn: r.turn,
      question_id: r.question_id,
      question: r.question,
      expected_answer: r.expected_answer,
      zilla_answer: r.zilla_answer,
      source_chunks: r.source_chunks,
      source_file_ids: r.source_file_ids || [],
      latency_ms: r.latency_ms,
      latency_first_audio_chunk_ms: r.latency_first_audio_chunk_ms,
      conversation_id: r.conversation_id,
      call_url: r.call_url,
      responded: r.answered,
      metrics: er?.metrics || null,
      evalError: er?.error || null,
    });
    turnsBySession.set(r.session_id, list);
  }

  // Fallback: read directly from summary-*.json for sessions not in captured-answers
  for (const s of run?.results || []) {
    if (!turnsBySession.has(s.session_id)) {
      const fallback = turnsFromSummary(s.session_id);
      if (fallback.length) turnsBySession.set(s.session_id, fallback);
    }
  }

  const sessions = (run?.results || []).map((s: any) => ({
    ...s,
    turns: turnsBySession.get(s.session_id) || [],
  }));

  return {
    run: run ? { file: path.basename(runFile!), stamp: run.stamp, scheduling: run.scheduling, selection: run.selection, sessions: run.sessions, passed: run.passed, failed: run.failed, wallMs: run.wallMs } : null,
    capturedFile: capFile ? path.basename(capFile!) : null,
    evalFile: evFile ? path.basename(evFile!) : null,
    sessions,
  };
}

// --- run a phase, streaming output -------------------------------------------
const running = new Set<any>();

function killProcessTree(child: any): void {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill();
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// Phases that should auto-trigger capture-answers after successful completion
const CHAIN_CAPTURE = new Set(["runSessions", "runSessionsWs"]);

function runPhase(phaseId: string, args: string[], res: http.ServerResponse): void {
  const cfg = PHASE_BY_ID.get(phaseId);
  if (!cfg) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("unknown phase: " + phaseId);
    return;
  }
  const isWin = process.platform === "win32";
  const cmd = isWin ? "cmd.exe" : "npm";
  const fullArgs = isWin ? ["/c", "npm", "run", cfg.script, "--", ...args] : ["run", cfg.script, "--", ...args];
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.write(`> npm run ${cfg.script}${args.length ? " -- " + args.join(" ") : ""}\n`);
  const child = spawn(cmd, fullArgs, { cwd: ROOT });
  running.add(child);
  const done = () => { running.delete(child); };
  child.stdout.on("data", (d) => res.write(d));
  child.stderr.on("data", (d) => res.write(d));
  child.on("close", (code) => {
    done();
    res.write(`\n[exit ${code}]\n`);
    if (code === 0 && CHAIN_CAPTURE.has(phaseId)) {
      res.write(`\n--- auto: capture-answers ---\n`);
      const capArgs = isWin ? ["/c", "npm", "run", "capture-answers"] : ["run", "capture-answers"];
      const capChild = spawn(cmd, capArgs, { cwd: ROOT });
      running.add(capChild);
      capChild.stdout.on("data", (d) => res.write(d));
      capChild.stderr.on("data", (d) => res.write(d));
      capChild.on("close", (cc) => { running.delete(capChild); res.write(`\n[capture-answers exit ${cc}]\n`); res.end(); });
      capChild.on("error", (e) => { running.delete(capChild); res.write(`\n[capture-answers error: ${e.message}]\n`); res.end(); });
    } else {
      res.end();
    }
  });
  child.on("error", (e) => {
    done();
    res.write(`\n[spawn error] ${e.message}\n`);
    res.end();
  });
}

// --- server ------------------------------------------------------------------
function serveStatic(file: string, type: string, res: http.ServerResponse): void {
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      serveStatic(HTML_PATH, "text/html", res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/env") {
      sendJson(res, { values: readEnv().values, docs: CONFIG_DOCS, groups: CONFIG_GROUPS });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/env") {
      const body = JSON.parse(await readBody(req));
      writeEnvValues(body.values || {});
      sendJson(res, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, status());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/calls") {
      sendJson(res, buildCalls());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = JSON.parse(await readBody(req));
      const args = Array.isArray(body.args)
        ? body.args.map((a: any) => String(a)).filter((a: string) => a.length)
        : [];
      runPhase(String(body.phase || ""), args, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const n = running.size;
      for (const child of [...running]) killProcessTree(child);
      running.clear();
      sendJson(res, { stopped: n });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      const body = JSON.parse(await readBody(req));
      const topic = String(body.topic || "").trim();
      const sub_topic = String(body.sub_topic || "").trim();
      const questions = body.questions || (Array.isArray(body.data) ? body.data : null);
      const chunks = body.chunks || [];

      if (!topic || !sub_topic) { sendJson(res, { error: "missing topic or sub_topic" }); return; }
      if (!Array.isArray(questions) || questions.length === 0) { sendJson(res, { error: "empty questions array" }); return; }

      const REQ = ["id", "pair_id", "language", "topic", "sub_topic", "question", "expected_answer", "source_chunks"];
      const issues: string[] = [];
      const seen = new Set<string>();
      const dups: string[] = [];
      const chunkSet = new Set(chunks.map((c: any) => c.id));
      const broken: string[] = [];

      for (const q of questions) {
        for (const k of REQ) {
          const v = q[k];
          if (v === undefined || v === null || v === "" || (Array.isArray(v) && k !== "chunk_ids" && v.length === 0)) {
            if (issues.length < 15) issues.push(`${q.id || "?"}: missing/empty "${k}"`);
          }
        }
        if (seen.has(q.id)) dups.push(q.id);
        seen.add(q.id);
        if (chunks.length > 0) {
          for (const cid of (q.chunk_ids || [])) {
            if (!chunkSet.has(cid)) broken.push(`${q.id} -> ${cid}`);
          }
        }
      }
      if (issues.length || dups.length || broken.length) {
        sendJson(res, { error: "validation failed", issues, dups: dups.slice(0, 10), broken: broken.slice(0, 10) });
        return;
      }

      const topicDir = path.join(DATA_DIR, "questions", topic);
      fs.mkdirSync(topicDir, { recursive: true });
      fs.writeFileSync(path.join(topicDir, `${sub_topic}.json`), JSON.stringify(questions, null, 2), "utf8");
      if (chunks.length > 0) {
        fs.writeFileSync(path.join(topicDir, `${sub_topic}.chunks.json`), JSON.stringify(chunks, null, 2), "utf8");
      }

      const manifest: any = { version: 1, topics: {} };
      for (const t of fs.readdirSync(path.join(DATA_DIR, "questions"))) {
        const tDir = path.join(DATA_DIR, "questions", t);
        if (!fs.statSync(tDir).isDirectory()) continue;
        const subs: any[] = [];
        for (const f of fs.readdirSync(tDir).filter((x: string) => x.endsWith(".json") && !x.endsWith(".chunks.json"))) {
          const qs = readJson(path.join(tDir, f)) || [];
          const na = qs.filter((q: any) => q.language === "ar").length;
          subs.push({ sub_topic: f.replace(/\.json$/, ""), file: `questions/${t}/${f}`, ar: na, en: qs.length - na, total: qs.length });
        }
        manifest.topics[t] = { sub_topics: subs, total: subs.reduce((a: number, s: any) => a + s.total, 0) };
      }
      fs.writeFileSync(path.join(DATA_DIR, "questions", "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

      sendJson(res, { ok: true, questions: questions.length, chunks: chunks.length });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/agents") {
      const isWin = process.platform === "win32";
      const cmd = isWin ? "cmd.exe" : "npm";
      const args = isWin ? ["/c", "npm", "run", "agents", "--", "--json"] : ["run", "agents", "--", "--json"];
      const child = spawn(cmd, args, { cwd: ROOT });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        const lastLine = out.split(/\r?\n/).filter(Boolean).pop() || "";
        let data: any = null;
        try {
          data = JSON.parse(lastLine);
        } catch {
          /* not JSON */
        }
        if (code === 0 && data) sendJson(res, data);
        else sendJson(res, { error: `agents failed (exit ${code})\n${err || out}`.trim() });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/session-files") {
      const topics: Record<string, any[]> = {};
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const topic of fs.readdirSync(SESSIONS_DIR)) {
          const topicDir = path.join(SESSIONS_DIR, topic);
          if (!fs.statSync(topicDir).isDirectory()) continue;
          const files: any[] = [];
          for (const f of fs.readdirSync(topicDir).filter((x: string) => x.endsWith(".json"))) {
            const sessions = readJson(path.join(topicDir, f)) || [];
            const ar = sessions.filter((s: any) => s.language === "ar").length;
            const en = sessions.filter((s: any) => s.language === "en").length;
            const totalQ = sessions.reduce((a: number, s: any) => a + (s.turns || 0), 0);
            files.push({
              name: f.replace(".json", ""),
              file: `sessions/${topic}/${f}`,
              arSessions: ar,
              enSessions: en,
              totalSessions: sessions.length,
              totalQuestions: totalQ,
            });
          }
          topics[topic] = files;
        }
      }
      sendJson(res, { topics });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/question-files") {
      const topics: Record<string, any[]> = {};
      const QUESTIONS_DIR = path.join(DATA_DIR, "questions");
      if (fs.existsSync(QUESTIONS_DIR)) {
        for (const topic of fs.readdirSync(QUESTIONS_DIR).sort()) {
          const topicDir = path.join(QUESTIONS_DIR, topic);
          if (!fs.statSync(topicDir).isDirectory()) continue;
          const files: any[] = [];
          for (const f of fs
            .readdirSync(topicDir)
            .filter((x: string) => x.endsWith(".json") && !x.endsWith(".chunks.json"))
            .sort()) {
            const questions = readJson(path.join(topicDir, f)) || [];
            const ar = questions.filter((q: any) => q.language === "ar").length;
            const en = questions.filter((q: any) => q.language === "en").length;
            files.push({
              name: f.replace(".json", ""),
              file: `questions/${topic}/${f}`,
              arQuestions: ar,
              enQuestions: en,
              totalQuestions: questions.length,
            });
          }
          topics[topic] = files;
        }
      }
      sendJson(res, { topics });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/run-sessions") {
      const body = JSON.parse(await readBody(req));
      const file = String(body.file || "").trim();
      const lang = String(body.lang || "").trim();
      const totalAr = String(body.totalAr || "0").trim();
      const totalEn = String(body.totalEn || "0").trim();
      const concurrentAr = String(body.concurrentAr || "3").trim();
      const concurrentEn = String(body.concurrentEn || "3").trim();
      const mode = String(body.mode || "ws").trim();
      const autoToken = body.autoToken === true;

      if (!file) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("missing file");
        return;
      }

      const args: string[] = ["--file", `data/${file}`];
      if (lang && lang !== "all") args.push("--sessions", lang);
      args.push("--concurrent-ar", concurrentAr);
      args.push("--concurrent-en", concurrentEn);
      if (parseInt(totalAr) > 0) args.push("--total-ar", totalAr);
      if (parseInt(totalEn) > 0) args.push("--total-en", totalEn);
      if (autoToken && mode === "ws") args.push("--auto-token");

      if (mode === "ui") {
        runPhase("runSessions", args, res);
      } else {
        runPhase("runSessionsWs", args, res);
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/build-sessions") {
      const body = JSON.parse(await readBody(req));
      const topic = String(body.topic || "").trim();
      const subtopic = String(body.subtopic || "").trim();
      const size = parseInt(String(body.size || "10"), 10);
      const arSessions = parseInt(String(body.arSessions || "0"), 10);
      const enSessions = parseInt(String(body.enSessions || "0"), 10);
      const seed = String(body.seed || "").trim();

      if (!topic) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("missing topic");
        return;
      }

      const args: string[] = [];
      args.push("--topic", topic);
      if (subtopic) args.push("--subtopic", subtopic);
      const bSize = Number.isNaN(size) || size < 1 ? 10 : Math.round(size);
      args.push("--size", String(bSize));
      if (!Number.isNaN(arSessions) && arSessions > 0) args.push("--ar-sessions", String(arSessions));
      if (!Number.isNaN(enSessions) && enSessions > 0) args.push("--en-sessions", String(enSessions));
      if (seed) args.push("--seed", seed);

      runPhase("buildSessions", args, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/generate-audio") {
      const body = JSON.parse(await readBody(req));
      const file = String(body.file || "").trim();
      if (!file) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("missing file");
        return;
      }
      // Pass the full relative path (e.g. "questions/Loan/Car Loan.json") so the
      // UI can pick any question file from a dropdown instead of typing a command.
      runPhase("generateAudio", ["--only", file], res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (e: any) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
    }
    res.end("error: " + (e?.message || e));
  }
});

function openBrowser(url: string): void {
  try {
    const plat = process.platform;
    if (plat === "win32") spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else if (plat === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* browser open is best-effort */
  }
}

function listen(port: number): void {
  server.once("error", (e: any) => {
    if (e?.code === "EADDRINUSE" && port < PORT_BASE + 10) {
      listen(port + 1);
    } else {
      console.error(`[ui] could not bind port: ${e?.message}`);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  Zilla KB Tool dashboard running at: ${url}\n  (Ctrl+C to stop)\n`);
    openBrowser(url);
  });
}

listen(PORT_BASE);