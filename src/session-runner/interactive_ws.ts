/*
 * interactive_ws.ts — Qwen-driven interactive customer over Zilla's WebSocket.
 *
 * Unlike run_sessions_ws.ts (scripted, fixed question order), this starts a
 * WS call and lets a Qwen LLM decide each customer turn reactively, based on
 * the full conversation so far. The caller text is generated fresh every turn
 * (goal-driven, can ask follow-ups, go off-track, or end by emitting [[DONE]]).
 *
 * LLM backend resolution (auto-detected):
 *   1. Ollama local (default): http://localhost:11434/v1 with model QWEN_LOCAL
 *      (default qwen2.5:7b). Override the root with OLLAMA_BASE_URL.
 *   2. Fallback: the OpenAI-compatible endpoint from EVAL_LLM_BASE_URL with
 *      GROQ_API_KEY/OPENAI_API_KEY (the evaluator convention) and EVAL_MODEL.
 *   3. Force one of them with INTERACTIVE_LLM=local|groq.
 *
 * Uses the same WS handshake + text-turn + settle-window shape as run_sessions_ws.
 *
 * Usage:
 *   npx tsx src/session-runner/interactive_ws.ts --language ar --goal "اسأل عن كيفية مشاركة معلومات الحساب واتبع خطوات المساعد حتى النهاية"
 *   npx tsx src/session-runner/interactive_ws.ts --language en --goal "Ask how to share my IBAN and follow the agent until the end" --max-turns 8
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

const ROOT = process.cwd();
const RUNS_DIR = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(ROOT, "data", "runs");

const WS_URL = process.env.WS_URL || "";
const WS_MODE = (process.env.WS_MODE || "text").toLowerCase();
const WS_SETTLE_MS = intEnv("WS_SETTLE_MS", 5000);
const WS_CONFIRM_MS = intEnv("WS_CONFIRM_MS", 500);
const WS_TURN_TIMEOUT_MS = intEnv("WS_TURN_TIMEOUT_MS", 20000);
const WS_INTER_TURN_MS = intEnv("WS_INTER_TURN_MS", 400);
const WS_CONNECT_TIMEOUT_MS = intEnv("WS_CONNECT_TIMEOUT_MS", 10000);
const WS_CONNECT_ATTEMPTS = intEnv("WS_CONNECT_ATTEMPTS", 3);
const WS_CONNECT_STAGGER_MS = intEnv("WS_CONNECT_STAGGER_MS", 1500);

// ---- LLM backend resolution (see header) ----
const OLLAMA_ROOT = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_V1 = `${OLLAMA_ROOT}/v1`;
const QWEN_LOCAL_MODEL = process.env.QWEN_LOCAL || "qwen2.5:7b";
const GROQ_MODEL = process.env.EVAL_MODEL || "qwen/qwen3.6-27b";
const GROQ_BASE = process.env.EVAL_LLM_BASE_URL || "https://api.groq.com/openai/v1";
const GROQ_KEY = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || "";
const DONE_TOKEN = "[[DONE]]";

type LlmEndpoint = { base: string; key: string; model: string };
let LLM: LlmEndpoint = { base: OLLAMA_V1, key: "", model: QWEN_LOCAL_MODEL };

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Ollama has no /v1 health route; hit its native root API instead.
async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_ROOT}/api/tags`, { method: "GET", signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data: any = await res.json();
    const names: string[] = (data?.models || []).map((m: any) => m.name.toLowerCase());
    return names.some((n) => n === QWEN_LOCAL_MODEL.toLowerCase());
  } catch {
    return false;
  }
}

async function resolveLlm(): Promise<void> {
  const forced = (process.env.INTERACTIVE_LLM || "").toLowerCase();
  if (forced === "groq" || forced === "groq-openai" || forced === "openai") {
    LLM = { base: GROQ_BASE, key: GROQ_KEY, model: GROQ_MODEL };
    return;
  }
  if (forced === "local" || forced === "ollama") {
    LLM = { base: OLLAMA_V1, key: "", model: QWEN_LOCAL_MODEL };
    return;
  }
  if (await ollamaAvailable()) {
    LLM = { base: OLLAMA_V1, key: "", model: QWEN_LOCAL_MODEL };
  } else {
    if (!GROQ_KEY) throw new Error("Ollama offline and no GROQ_API_KEY set for the fallback");
    LLM = { base: GROQ_BASE, key: GROQ_KEY, model: GROQ_MODEL };
  }
}

function resolveToken(): string {
  return process.env.WS_TOKEN || "";
}

function agentIdFor(language: string): string {
  const byLang = language === "ar" ? "ZILLA_AGENT_ID_AR" : "ZILLA_AGENT_ID_EN";
  return process.env[byLang] || "";
}

function buildSystemPrompt(language: string, goal: string): string {
  if (language === "ar") {
    return [
      "أنت العميل/الزبون في مكالمة هاتفية مع مساعد بنك الاتحاد الصوتي (Ziila) اللي بتحكي بلهجة شامية عامية.",
      "دورك أنت فقط العميل اللي بيسأل وبيجاوب إجابات قصيرة وطبيعية مثل (آه، تمام، ماشي، تمام شكراً، إيوه).",
      "ممنوع منعاً باتاً أنك تشرح أو تعيد صياغة الخطوات بنفسك، وممنوع تستخدم كلمات زي \"الخطوة التالية\" أو ترقيم الخطوات — كلام الخطوات ده كله على المساعدة، إنت بس بتقول تمام وتطلب الاستمرار.",
      `هدفك في هالمكالمة: ${goal}`,
      "بعد كل رد من المساعدة، قرر طبيعي شو هتجاوب/هتسأل بعدها (جملة جملتين بس).",
      "الرد مطلوب بالعربي العامي فقط. لو طلعت أي حرف بغير العربية أو تعليق أو فكرة داخلية — خرجك يعتبر فاشل.",
      "لما تكمل المساعدة كل اللي بدك إياه وترتاح أنت تماماً، رجّع بس التوكن الخاصة بالنهاية `[DONE]` من غير أي كلام تاني. لا تعتبر المهمة منجزة قبل إكمال كل الخطوات المطلوبة منك.",
    ].join(" ");
  }
  return [
    "You are the CUSTOMER in a phone call with an Arabic bank's voice assistant (Ziila from Bank al Etihad) who speaks Levantine Arabic.",
    "Your ONLY role: the customer. Reply with short, natural utterances (yes, ok sure, please continue, and short follow-up questions).",
    "STRICTLY FORBIDDEN: explaining or restating any banking steps yourself, numbering steps, or using words like 'next step is...' — guidance belongs to the agent; you only confirm and ask to continue.",
    `Your goal in this call: ${goal}`,
    "After each agent reply, decide what you would naturally say/ask next (1-2 short casual sentences).",
    "Output ONLY English or plain Arabic as a spoken utterance. Never output commentary, reasoning, or any language other than English/Arabic.",
    `When the agent has fully served your need and you are satisfied, reply with exactly the token ${DONE_TOKEN} and only that. Do not end before every step you need is given.`,
  ].join(" ");
}

type TranscriptTurn = { speaker: "customer" | "agent"; text: string };
type TurnOutcome = {
  utterance: string;
  answer: string;
  responded: boolean;
  latencyMs: number | null;
  fileIds: string[];
};

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

async function connectWithRetry(): Promise<WebSocket> {
  const attempts = Math.max(WS_CONNECT_ATTEMPTS, 1);
  let lastErr = "";
  for (let a = 1; a <= attempts; a++) {
    if (a > 1) await sleep(500 + Math.round(Math.random() * Math.max(WS_CONNECT_STAGGER_MS - 500, 0)));
    try {
      return await openSocketOnce();
    } catch (e) {
      lastErr = (e as Error).message;
      console.warn(`  connect attempt ${a}/${attempts} failed: ${lastErr}`);
    }
  }
  throw new Error(`connection did not open (${attempts} attempts${lastErr ? `: ${lastErr}` : ""})`);
}

async function chatCompletion(system: string, history: TranscriptTurn[]): Promise<string> {
  const messages: any[] = [{ role: "system", content: system }];
  for (const t of history) {
    messages.push({
      role: t.speaker === "agent" ? "assistant" : "user",
      content: t.text,
    });
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (LLM.key) headers.Authorization = `Bearer ${LLM.key}`;
  const res = await fetch(`${LLM.base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: LLM.model,
      messages,
      temperature: 0.8,
      max_tokens: 200,
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    throw new Error(`LLM ${LLM.base} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data: any = await res.json();
  const content: string = (data?.choices?.[0]?.message?.content || "").trim();
  // qwen2.5 may prepend reasoning / thinking paragraphs — take the last block.
  const paras = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras.length ? paras[paras.length - 1] : content;
}

async function main(): Promise<void> {
  const language = (arg("language", "ar") || "ar").toLowerCase();
  const goal = arg("goal", "");
  const maxTurns = parseInt(arg("max-turns", ""), 10) || 12;
  if (!goal) {
    console.error('Missing --goal "..." — the customer objective for the call.');
    process.exitCode = 1;
    return;
  }
  if (language !== "ar" && language !== "en") {
    console.error(`--language must be ar or en (got "${language}")`);
    process.exitCode = 1;
    return;
  }
  if (WS_MODE !== "text") {
    console.error(`WS_MODE=${WS_MODE} — expected "text" (only text turns are implemented).`);
    process.exitCode = 1;
    return;
  }
  if (!WS_URL) {
    console.error("WS_URL is not set in .env");
    process.exitCode = 1;
    return;
  }

  await resolveLlm();
  const system = buildSystemPrompt(language, goal);
  const agentId = agentIdFor(language);
  const token = resolveToken();
  const sessionId = `Interactive-${language}-${Date.now().toString(36)}`;

  if (!agentId) console.warn(`  no agent id for "${language}" — handshake sends an empty agentId.`);
  if (!token) {
    console.warn(
      '  WS_TOKEN is empty — if calls fail with 401, run:\n    npm run run-sessions-ws -- --auto-token\n  first to refresh it.',
    );
  }

  console.log(
    `\nInteractive ${language} via ${LLM.base} (${LLM.model}), max ${maxTurns} turns — goal: ${goal}`,
  );

  const ws = await connectWithRetry();
  const outcomes: TurnOutcome[] = [];
  const transcript: TranscriptTurn[] = [];

  let settleTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;
  let confirmTimer: NodeJS.Timeout | null = null;
  let fatalWs: string | null = null;
  let firstFrameAt: number | null = null;
  let sentences: string[] = [];
  let ctxFileIds: string[] = [];
  let sessionIdFromServer: string | null = null;
  let resolveWaiting: (() => void) | null = null;
  let resolveConfirm: (() => void) | null = null;

  const clearTimers = () => {
    if (settleTimer) clearTimeout(settleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (confirmTimer) clearTimeout(confirmTimer);
    settleTimer = null;
    hardTimer = null;
    confirmTimer = null;
  };
  const armSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (resolveWaiting) {
        const r = resolveWaiting;
        resolveWaiting = null;
        clearTimers();
        r();
      }
    }, WS_SETTLE_MS);
  };
  const armHardTimeout = () => {
    hardTimer = setTimeout(() => {
      if (resolveWaiting) {
        const r = resolveWaiting;
        resolveWaiting = null;
        clearTimers();
        r();
      }
    }, WS_TURN_TIMEOUT_MS);
  };
  const waitForSettle = (): Promise<void> =>
    new Promise((res) => {
      resolveWaiting = res;
      armHardTimeout();
    });
  const waitForConfirm = (): Promise<void> =>
    new Promise((res) => {
      resolveConfirm = res;
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        const r = resolveConfirm;
        resolveConfirm = null;
        confirmTimer = null;
        r && r();
      }, WS_CONFIRM_MS);
    });
  const notifyFrames = () => {
    if (resolveConfirm) {
      const r = resolveConfirm;
      resolveConfirm = null;
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = null;
      r();
    }
  };

  ws.on("message", (raw: WebSocket.RawData) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // binary/audio frames we don't need in text mode
    }
    if (msg.session_id && !sessionIdFromServer) {
      sessionIdFromServer = msg.session_id;
      console.log(`  session confirmed: ${msg.session_id}`);
    }
    if (Array.isArray(msg.file_ids) && msg.file_ids.length) ctxFileIds = msg.file_ids;
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
      fatalWs = typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error);
      armSettle();
      notifyFrames();
    } else if (msg.detection || msg.text) {
      armSettle();
      notifyFrames();
    }
  });
  ws.on("error", (err: Error) => {
    fatalWs = fatalWs || `ws error: ${err.message}`;
    if (resolveWaiting) {
      const r = resolveWaiting;
      resolveWaiting = null;
      clearTimers();
      r();
    }
    if (resolveConfirm) {
      const r = resolveConfirm;
      resolveConfirm = null;
      clearTimers();
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
      clearTimers();
      r();
    }
  });

  try {
    ws.send(JSON.stringify({ agentId, token }));
    ws.send(JSON.stringify({ type: "session", sessionId }));
    console.log(`  ws open → handshake sent (agentId=${agentId || "<empty>"})`);
  } catch (e) {
    throw new Error(`handshake send failed: ${(e as Error).message}`);
  }

  // Drain the opening greeting so the first customer turn lands after it.
  await waitForSettle();

  async function oneTurn(utterance: string, idx: number): Promise<{ answer: string; responded: boolean; latencyMs: number | null }> {
    sentences = [];
    firstFrameAt = null;
    ctxFileIds = [];
    const sentAt = Date.now();
    console.log(`  → [${idx + 1}] customer: ${utterance}`);
    ws.send(JSON.stringify({ text: utterance }));
    await waitForSettle();
    for (;;) {
      const snapshot = sentences.length;
      await waitForConfirm();
      if (sentences.length === snapshot) break;
      await waitForSettle();
    }
    const answer = sentences.join(" ").trim();
    const latencyMs = firstFrameAt !== null ? firstFrameAt - sentAt : null;
    console.log(
      `  ← agent${answer && latencyMs !== null ? ` (${latencyMs}ms)` : ""}: ${answer.slice(0, 240) || "(no reply)"}`,
    );
    return { answer, responded: answer.length > 0, latencyMs };
  }

  let done = false;
  // Opening: use the goal verbatim as the customer's first ask.
  const opening = goal.trim();
  let first = await oneTurn(opening, 0);
  outcomes.push({
    utterance: opening,
    answer: first.answer,
    responded: first.responded,
    latencyMs: first.latencyMs,
    fileIds: [...ctxFileIds],
  });
  transcript.push({ speaker: "customer", text: opening });
  transcript.push({ speaker: "agent", text: first.answer });

  if (!first.responded) {
    throw new Error(`no reply to opening — ${fatalWs || "agent silent"}`);
  }

  for (let i = 1; i <= maxTurns; i++) {
    if (ws.readyState !== WebSocket.OPEN) throw new Error("connection closed mid-call");
    let next = (await chatCompletion(system, transcript)).trim();
    if (!next || next === DONE_TOKEN) {
      // Empty or premature DONE right after a partial answer: nudge once.
      const guard = [...transcript];
      guard.push({
        speaker: "customer",
        text: "سؤال: هل انتهيت من الشرح؟ كمل لكل خطوة من فضلك" + (language === "en" ? "\nMe: Did you finish? Please continue with every step." : ""),
      });
      next = (await chatCompletion(system, guard)).trim();
    }
    console.log(`  ✎ qwen: ${next}`);
    // Qwen may embed the DONE token inside a sentence ("...العملية `[DONE]`").
    // Split it off: keep the pre-token text as the utterance, and mark done so
    // we don't keep chatting after the farewell.
    let doneUtterance = next;
    const doneIdx = next.indexOf(DONE_TOKEN);
    if (doneIdx !== -1) {
      doneUtterance = next.slice(0, doneIdx).trim();
      done = true;
      console.log("  ✓ qwen signalled goal handled");
    }
    if (!doneUtterance) break;
    const t = await oneTurn(doneUtterance, i + 1);
    outcomes.push({
      utterance: next,
      answer: t.answer,
      responded: t.responded,
      latencyMs: t.latencyMs,
      fileIds: [...ctxFileIds],
    });
    transcript.push({ speaker: "customer", text: doneUtterance });
    transcript.push({ speaker: "agent", text: t.answer });
    if (!t.responded) console.warn(`  ✗ no agent reply at turn ${i + 1} — continuing`);
    await sleep(WS_INTER_TURN_MS);
  }

  const srcFiles = [...new Set(outcomes.flatMap((o) => o.fileIds))].sort();
  const outDir = path.join(RUNS_DIR, sessionId);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summary = {
    session_id: sessionId,
    language,
    goal,
    backend: LLM.base,
    model: LLM.model,
    ended: done ? "clean-done" : "max-turns",
    conversationId: sessionIdFromServer,
    agentId,
    turns: outcomes.length,
    sourceFilesUsed: srcFiles,
    transcript,
    outcomes,
  };
  fs.writeFileSync(path.join(outDir, `interactive-${stamp}.json`), JSON.stringify(summary, null, 2));
  try {
    ws.close();
  } catch {
    /* already closed */
  }

  console.log(`\n===== INTERACTIVE ${language.toUpperCase()} SUMMARY =====`);
  console.log(`  turns: ${outcomes.length}${done ? " (goal handled, client ended)" : " (max-turns reached)"}`);
  console.log(`  sources: [${srcFiles.join(", ")}]`);
  console.log(`  saved: data/runs/${sessionId}/interactive-${stamp}.json`);
}

main().catch((e: Error) => {
  console.error(`[interactive] FAIL: ${e.message}`);
  process.exitCode = 1;
});