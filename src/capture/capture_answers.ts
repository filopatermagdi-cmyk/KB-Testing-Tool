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
import { alignAnswersToQuestions } from "../lib/transcript-pairing";

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
  source_file_ids: string[];
  latency_ms: number | null;
  latency_first_audio_chunk_ms: number | null;
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

// A run report (data/runs/run-results-<stamp>.json) is written once per run; its
// per-session artifacts (summary-<stamp>.json, zilla-responses-<stamp>.json) come
// from that same run. Match artifacts by their conversationId (or, failing that,
// second-level stamp) instead of "newest file in the session dir" — the session
// folder accumulates artifacts across MANY runs (browser + direct-WS), and
// zilla-responses is only written by the browser callrunner, so .sort().pop()
// would pair a fresh WS run with a stale browser run's pairing and scramble
// every answer.
function stampSecond(stamp: string): string {
  // run-results-2026-09-09T08-37-43-430Z.json -> 2026-09-09T08-37-43
  return stamp.replace(/\.\d{3}Z?$/, "");
}

function artifactFiles(sessionId: string, kind: "summary" | "zilla-responses"): string[] {
  const dir = path.join(RUNS_DIR, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((x) => x.startsWith(`${kind}-`) && x.endsWith(".json"))
    .sort();
}

function matchConversation(relPath: string, conversationId: string): boolean {
  if (!conversationId) return false;
  try {
    const j = readJson(path.join(RUNS_DIR, relPath));
    return j.conversationId === conversationId;
  } catch {
    return false;
  }
}

// Load the summary-<stamp>.*.json for a session that belongs to the run being
// captured. Preferred match: the summary whose conversationId equals the report
// result's conversationId (survives batch reports whose one stamp differs from
// each session's artifact stamp). Fallbacks: second-level stamp, then newest.
function latestSummary(sessionId: string, runStamp: string, conversationId: string): any {
  let pick = artifactFiles(sessionId, "summary")
    .filter((f) => matchConversation(path.join(sessionId, f), conversationId))
    .pop();
  if (!pick) {
    const want = `summary-${stampSecond(runStamp)}`;
    pick = artifactFiles(sessionId, "summary").filter((x) => x.startsWith(want)).pop();
  }
  if (!pick) {
    const legacy = artifactFiles(sessionId, "summary").pop();
    if (!legacy) return null;
    pick = legacy;
  }
  return readJson(path.join(RUNS_DIR, sessionId, pick));
}

// Load the zilla-responses-<stamp>.*.json for a session. Built by the callrunner
// during the call; it pairs each clip (in play order) with `responded` and the
// reply text. This is the authoritative "did Ziila actually answer" signal,
// independent of how STT garbled the short confirmations. Only valid when it
// belongs to the SAME run as the summary — a zr file from another run (e.g. an
// older browser run lingering in the session dir) must NOT be paired with this
// run's transcript. If no zr matches the run, return null (never the newest).
function latestZillaResponses(sessionId: string, runStamp: string, conversationId: string): any {
  let pick = artifactFiles(sessionId, "zilla-responses")
    .filter((f) => matchConversation(path.join(sessionId, f), conversationId))
    .pop();
  if (!pick) {
    const want = `zilla-responses-${stampSecond(runStamp)}`;
    pick = artifactFiles(sessionId, "zilla-responses").filter((x) => x.startsWith(want)).pop();
  }
  if (!pick) return null;
  return readJson(path.join(RUNS_DIR, sessionId, pick));
}

// The runner stages clips as <NNN>_<questionId>.wav in the ACTUAL play order
// (RESHUFFLE may reorder them at run time, so data/sessions.json is NOT the
// order that was actually spoken). Parse that order so each transcript answer
// gets paired with the question that was really asked, not the built order.
function playedOrderFromSummary(summary: any): string[] {
  const checks = summary?.checks ?? [];
  if (!Array.isArray(checks) || checks.length === 0) return [];
  const order = checks.map((c: any) => String(c?.clip ?? "").replace(/^\d+_/, "").replace(/\.wav$/i, ""));
  return order.filter(Boolean);
}

// Legacy source (#1 back then): the staged clips folder. Kept for old runs whose
// summary predates `checks` — for them the clips are still the play-order record.
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

function captureForSession(session: Session, runStamp: string, reportConversationId: string): CaptureRecord[] {
  const summary = latestSummary(session.session_id, runStamp, reportConversationId);
  if (!summary) {
    console.warn(`  [${session.session_id}] no summary found in ${RUNS_DIR}/${session.session_id} - skipping.`);
    return [];
  }

  const transcript: TranscriptEntry[] = summary.liveTranscript || [];
  const checks: any[] = summary.checks || [];

  // The zilla-responses file is the most faithful pairing: it records, in the
  // exact staged-clip order, one entry per clip with `responded` (was there a
  // reply) and the reply text. Unlike the content-based liveTranscript align,
  // it does NOT drop short/stt-garbled confirmations (e.g. "كمّل"→"تمن") — so
  // it is the authoritative source for whether a turn got a real answer.
  // Must belong to the same run/conversation as the summary we just loaded.
  const zr = latestZillaResponses(session.session_id, runStamp, reportConversationId);
  const appUrl = summary.env?.appUrl || "";
  const conversationId = summary.conversationId || "";
  const agentId = session.agent_id || summary.agentId || "";
  const callUrl =
    appUrl && agentId && conversationId
      ? `${appUrl}/en/agents/${agentId}/conversations/${conversationId}`
      : "";

  const byId = new Map(questions.map((q) => [q.id, q]));

  // Which question was actually asked at each position. The summary's own checks
  // record the play order FOR THIS RUN (covers text-only relay/direct runs,
  // which never stage clips and would otherwise be poisoned by clips left over
  // from an older browser run). Falls back to the staged clip filenames for
  // legacy summaries without checks, then to the built session order.
  const fromChecks = playedOrderFromSummary(summary);
  const played = fromChecks.length === session.messages.length ? fromChecks : playedQuestionOrder(session.session_id);
  const order = played.length === session.messages.length ? played : null;
  if (!order) {
    console.warn(
      `  [${session.session_id}] clips order unavailable (${played.length}/${session.messages.length}) - ` +
        `falling back to built session order`
    );
  }

  // Align answers to questions by content instead of blindly zipping by
  // position — see alignAnswersToQuestions(): STT splits one spoken question
  // into several customer utterances (and may get double replies), which would
  // otherwise shift every answer after the split.
  const aligned = alignAnswersToQuestions(
    transcript,
    order || session.messages.map((mm) => mm.question_id),
    (qid) => {
      const s = byId.get(qid);
      return { question: s?.question ?? "", expected_answer: s?.expected_answer ?? "" };
    }
  );

  // Cumulative source file IDs: each turn sees all files loaded up to + including
  // that turn. The judge needs to know not just the current turn's files but the
  // full KB context Ziila had at that point (files loaded before aren't fetched
  // again, so the cumulative set is what matters).
  // Per-turn source file IDs: the files Zilla actually loaded/used for THAT
  // question (what arrived in its relay frame for this turn), not a running
  // accumulation. Turns with no relay frame (first question before any
  // load_files, or a trailing turn) inherit the most recent known set, since
  // the answer was produced from the same context.
  const perTurnByIdx = new Map<number, { files: string[]; saw: boolean }>();
  for (const entry of summary.sourceFilesByTurn || []) {
    perTurnByIdx.set(entry.turn, {
      files: [...new Set([...(entry.fileIds ?? entry.file_ids ?? []), ...(entry.loadedFiles ?? entry.loaded_files ?? [])])],
      saw: entry.saw_source_frame === true || !("saw_source_frame" in entry),
    });
  }
  const sourceIdsForTurn = (turn: number): string[] => {
    // Walk backwards from this turn to the most recent answer that actually had
    // a source frame. A turn whose frame arrived with an explicit empty set is
    // authoritative too ([] stays []), so it becomes the new baseline; turns
    // with no frame at all inherit from whatever the last frame said.
    for (let t = turn; t >= 1; t--) {
      const e = perTurnByIdx.get(t);
      if (!e) continue;
      if (e.saw) return e.files;
    }
    return [];
  };

  return session.messages.map((m, i) => {
    const qid = order ? order[i] : m.question_id;
    const src = byId.get(qid);
    // Prefer the authoritative zilla-responses pairing (one per clip, in play
    // order). exchanges[0] is the opening greeting (ours:null), so exchanges[i+1]
    // is the reply to clip i. replied[] gives the reliable responded flag.
    const zrExchange = zr?.exchanges?.[i + 1];
    const zrReplied = zr?.replies?.[i]?.responded;
    const zrAnswer = (zrExchange?.zilla || "").trim() || null;
    const haveZr =
      zrExchange !== undefined ||
      zr?.replies?.[i] !== undefined;
    const checkAnswer = (checks[i]?.answerText || "").trim();
    const answer = haveZr
      ? zrAnswer
      : checkAnswer.length > 0
        ? checkAnswer
        : (aligned[i]?.answer ?? null);
    // checks[i].responded is the runner's authoritative per-turn verdict for
    // text/WS runs (which never write zilla-responses): use it when we trust
    // the checks record, so a real reply isn't lost during content alignment.
    const checkResponded = checks[i]?.responded === true &&
      (checkAnswer.length > 0 || !aligned[i]?.answer);
    const answered = haveZr
      ? !!zrReplied || !!zrAnswer
      : checkResponded || !!aligned[i]?.answer;
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
      zilla_answer: answer,
      answered,
      source_chunks: src?.source_chunks || [],
      source_file_ids: sourceIdsForTurn(i + 1),
      latency_ms: zr?.replies?.[i]?.latencyMs ?? checks[i]?.latencyMs ?? null,
      latency_first_audio_chunk_ms: zr?.replies?.[i]?.latencyMsToFirstAudioChunk ?? checks[i]?.latencyMsToFirstAudioChunk ?? null,
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
  // The report's own stamp scopes which per-session artifacts belong to this run.
  // run-results-2026-09-09T08-37-43-430Z.json -> 2026-09-09T08-37-43-430Z
  const runStamp = path.basename(reportPath).replace(/^run-results-/, "").replace(/\.json$/, "");
  const records: CaptureRecord[] = [];
  for (const r of report.results as Array<{ session_id: string }>) {
    const session = bySessionId.get(r.session_id);
    if (!session) {
      console.warn(`  [${r.session_id}] session not in sessions.json - skipping.`);
      continue;
    }
    records.push(...captureForSession(session, runStamp, (r as any)?.conversationId || ""));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(OUT_DIR, `captured-answers-${stamp}.json`);
  const answered = records.filter((r) => r.answered).length;
  const unanswered = records.length - answered;
  const withLatency = records.filter((r) => r.latency_ms !== null);
  const avgLatency = withLatency.length > 0 ? Math.round(withLatency.reduce((s, r) => s + (r.latency_ms || 0), 0) / withLatency.length) : null;
  const withChunkLatency = records.filter((r) => r.latency_first_audio_chunk_ms !== null);
  const avgChunkLatency = withChunkLatency.length > 0 ? Math.round(withChunkLatency.reduce((s, r) => s + (r.latency_first_audio_chunk_ms || 0), 0) / withChunkLatency.length) : null;

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
        avgLatencyFirstAudioChunkMs: avgChunkLatency,
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