/*
 * capture_answers.ts - Phase 5: Response Capture.
 *
 * Turns the raw run artifacts (data/runs/<session_id>/summary-*.json) into a
 * clean per-question dataset that Phase 6 (DeepEval) can consume directly:
 *
 *   { input, actual_output, expected_output, retrieval_context }
 *
 * For every session in a run report it pairs each question (customer turn)
 * with Zilla's answer (the following agent turn) and joins it with the
 * expected answer + source chunks from questions.json, plus latency.
 *
 * Usage:
 *   npm run capture-answers                          # uses the newest run-results-*.json
 *   npm run capture-answers -- --report data/runs/run-results-<stamp>.json
 *
 * Output: data/captured-answers-<stamp>.json  (list of records, one per turn)
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const ROOT = process.cwd();
const RUNS_DIR = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(ROOT, "data", "runs");
const SESSIONS_DIR = path.join(ROOT, "data", "sessions");
const QUESTIONS_DIR = path.join(ROOT, "data", "questions");
const OUT_DIR = path.join(ROOT, "data");

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
interface Question {
  id: string;
  pair_id: string;
  language: "ar" | "en";
  question: string;
  expected_answer: string;
  source_chunks?: string[];
  audio_file?: string;
}
interface TranscriptEntry {
  speaker: string;
  text: string;
}
interface CaptureRecord {
  session_id: string;
  language: string;
  agent_id: string;
  conversation_id: string;
  call_url: string;
  turn: number;
  question_id: string;
  question: string;
  expected_answer: string;
  zilla_answer: string | null;
  answered: boolean;
  source_chunks: string[];
  latency_ms: number | null;
}

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}

function newestReport(): string | null {
  const files = fs
    .readdirSync(RUNS_DIR)
    .filter((f) => /^run-results-.*\.json$/.test(f))
    .sort();
  return files.length ? path.join(RUNS_DIR, files[files.length - 1]) : null;
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function latestSummary(sessionId: string): any {
  const dir = path.join(RUNS_DIR, sessionId);
  if (!fs.existsSync(dir)) return null;
  const f = fs
    .readdirSync(dir)
    .filter((x) => /^summary-.*\.json$/.test(x))
    .sort()
    .pop();
  return f ? readJson(path.join(dir, f)) : null;
}

// Pair every customer utterance with the agent answer that follows it.
// The opening agent greeting has no preceding customer turn, so it is skipped.
function pairTurns(transcript: TranscriptEntry[]): Array<{ question: string; answer: string }> {
  const pairs: Array<{ question: string; answer: string }> = [];
  let pending: string | null = null;
  for (const t of transcript) {
    if (t.speaker === "customer") {
      pending = t.text;
    } else if (t.speaker === "agent" && pending !== null) {
      pairs.push({ question: pending, answer: t.text });
      pending = null;
    }
  }
  return pairs;
}

// The runner stages clips as <NNN>_<questionId>.wav in the ACTUAL play order
// (RESHUFFLE may reorder them at run time, so data/sessions.json is NOT the
// order that was actually spoken). Parse that order so each transcript answer
// gets paired with the question that was really asked, not the built order.
function playedQuestionOrder(sessionId: string): string[] {
  const clipDir = path.join(RUNS_DIR, sessionId, "clips");
  try {
    const files = fs.readdirSync(clipDir).filter((f) => f.endsWith(".wav"));
    files.sort((a, b) => {
      const na = parseInt(a.split("_")[0], 10);
      const nb = parseInt(b.split("_")[0], 10);
      return na - nb;
    });
    return files
      .map((f) => {
        const m = f.match(/^\d+_(.+)\.wav$/);
        return m ? m[1] : "";
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function captureForSession(session: Session): CaptureRecord[] {
  const summary = latestSummary(session.session_id);
  if (!summary) {
    console.warn(`  [${session.session_id}] no summary found in ${RUNS_DIR}/${session.session_id} - skipping.`);
    return [];
  }

  const transcript: TranscriptEntry[] = summary.liveTranscript || [];
  const pairs = pairTurns(transcript);
  const checks: any[] = summary.checks || [];
  const appUrl = summary.env?.appUrl || "";
  const conversationId = summary.conversationId || "";
  const agentId = session.agent_id || summary.agentId || "";
  const callUrl =
    appUrl && agentId && conversationId
      ? `${appUrl}/en/agents/${agentId}/conversations/${conversationId}`
      : "";

  const byId = new Map(questions.map((q) => [q.id, q]));

  // Which question was actually asked at each position (authoritative from the
  // staged clip filenames). Falls back to the built order only if clips are
  // missing (e.g. an old run that predates this pairing fix).
  const played = playedQuestionOrder(session.session_id);
  const order = played.length === session.messages.length ? played : null;
  if (!order) {
    console.warn(
      `  [${session.session_id}] clips order unavailable (${played.length}/${session.messages.length}) - ` +
        `falling back to built session order`
    );
  }

  return session.messages.map((m, i) => {
    const pair = pairs[i];
    const qid = order ? order[i] : m.question_id;
    const src = byId.get(qid);
    return {
      session_id: session.session_id,
      language: session.language,
      agent_id: agentId,
      conversation_id: conversationId,
      call_url: callUrl,
      turn: i + 1,
      question_id: qid,
      question: src?.question ?? m.question,
      expected_answer: src?.expected_answer ?? m.expected_answer,
      zilla_answer: pair ? pair.answer : null,
      answered: !!pair,
      source_chunks: src?.source_chunks || [],
      latency_ms: checks[i]?.latencyMs ?? null,
    };
  });
}

let questions: Question[] = [];

// Load all sessions from data/sessions/{Topic}/*.json (new structure)
// Falls back to data/sessions.json (old flat file) if it exists.
function loadAllSessions(): Session[] {
  const sessions: Session[] = [];

  // New structure: data/sessions/{Topic}/*.json
  if (fs.existsSync(SESSIONS_DIR)) {
    for (const topic of fs.readdirSync(SESSIONS_DIR)) {
      const topicDir = path.join(SESSIONS_DIR, topic);
      if (!fs.statSync(topicDir).isDirectory()) continue;
      for (const f of fs.readdirSync(topicDir).filter((x: string) => x.endsWith(".json"))) {
        try {
          const arr = readJson(path.join(topicDir, f));
          if (Array.isArray(arr)) sessions.push(...arr);
        } catch {}
      }
    }
  }

  // Legacy fallback: data/sessions.json
  const legacy = path.join(ROOT, "data", "sessions.json");
  if (sessions.length === 0 && fs.existsSync(legacy)) {
    try {
      const arr = readJson(legacy);
      if (Array.isArray(arr)) sessions.push(...arr);
    } catch {}
  }

  return sessions;
}

// Load all questions from data/questions/{Topic}/*.json (new structure)
// Falls back to data/questions.json (old flat file) if it exists.
function loadAllQuestions(): Question[] {
  const qs: Question[] = [];

  // New structure: data/questions/{Topic}/*.json
  if (fs.existsSync(QUESTIONS_DIR)) {
    for (const topic of fs.readdirSync(QUESTIONS_DIR)) {
      const topicDir = path.join(QUESTIONS_DIR, topic);
      if (!fs.statSync(topicDir).isDirectory()) continue;
      for (const f of fs.readdirSync(topicDir).filter((x: string) => x.endsWith(".json") && !x.endsWith(".chunks.json"))) {
        try {
          const arr = readJson(path.join(topicDir, f));
          if (Array.isArray(arr)) qs.push(...arr);
        } catch {}
      }
    }
  }

  // Legacy fallback: data/questions.json
  const legacy = path.join(ROOT, "data", "questions.json");
  if (qs.length === 0 && fs.existsSync(legacy)) {
    try {
      const arr = readJson(legacy);
      if (Array.isArray(arr)) qs.push(...arr);
    } catch {}
  }

  return qs;
}

function main() {
  const reportPath = arg("report", "") || newestReport();
  if (!reportPath || !fs.existsSync(reportPath)) {
    console.error(`No run report found in ${RUNS_DIR}. Run Phase 4A first: npm run run-sessions`);
    process.exitCode = 1;
    return;
  }

  const report = readJson(reportPath);
  questions = loadAllQuestions();
  const sessions: Session[] = loadAllSessions();
  const bySessionId = new Map(sessions.map((s) => [s.session_id, s]));

  if (sessions.length === 0) {
    console.error(`No sessions found in ${SESSIONS_DIR} or data/sessions.json - run session builder first.`);
    process.exitCode = 1;
    return;
  }
  if (questions.length === 0) {
    console.error(`No questions found in ${QUESTIONS_DIR} or data/questions.json - run Phase 1 first.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Capturing answers from ${path.basename(reportPath)}...`);
  const records: CaptureRecord[] = [];
  for (const r of report.results as Array<{ session_id: string }>) {
    const session = bySessionId.get(r.session_id);
    if (!session) {
      console.warn(`  [${r.session_id}] session not in sessions.json - skipping.`);
      continue;
    }
    records.push(...captureForSession(session));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(OUT_DIR, `captured-answers-${stamp}.json`);
  const answered = records.filter((r) => r.answered).length;
  const unanswered = records.length - answered;
  const withLatency = records.filter((r) => r.latency_ms !== null);
  const avgLatency = withLatency.length > 0 ? Math.round(withLatency.reduce((s, r) => s + (r.latency_ms || 0), 0) / withLatency.length) : null;

  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        stamp,
        sourceReport: path.basename(reportPath),
        sessions: report.sessions,
        totalTurns: records.length,
        answered,
        unanswered,
        avgLatencyMs: avgLatency,
        records,
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log("\n===== CAPTURE SUMMARY =====");
  console.log("turns: " + records.length + "   answered: " + answered + "   unanswered: " + unanswered + "   avg latency: " + (avgLatency == null ? "-" : String(avgLatency)) + "ms");
  for (const r of records) {
    const status = r.answered ? "answered" : "NO-ANSWER";
    const lat = r.latency_ms == null ? "-" : String(r.latency_ms);
    console.log("  " + r.session_id + "  turn " + r.turn + "  " + r.question_id + "  " + status + "  " + lat + "ms");
  }
  console.log("captured: " + path.relative(ROOT, outPath));
}

main();