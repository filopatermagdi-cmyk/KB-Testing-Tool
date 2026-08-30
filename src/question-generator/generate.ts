/**
 * generate.ts — Question Generator (Phase 1, step 2)
 *
 * Reads data/chunks.json (produced by extract_chunks.py) and generates a
 * small sample of test questions: for each selected chunk (or pair of
 * chunks from the same KB table), asks an LLM for one realistic question a
 * customer might ask, and the correct answer grounded ONLY in that chunk's
 * text. Writes data/questions.json.
 *
 * Bilingual pairs: when both GENERATE_ENGLISH and GENERATE_ARABIC are true
 * (the default), EVERY selected chunk produces BOTH an English and an
 * Arabic version of the SAME question — not different chunks split across
 * languages. The two versions share a `pair_id` so you can always find the
 * other-language twin of a given question.
 *
 * Scaling to a full/large KB: set SAMPLE_SIZE=all to generate a question for
 * every usable chunk instead of picking a fixed number. For a large KB this
 * can be a lot of LLM calls, so this script is safe to run at that scale:
 *   - Resumable: re-running with SAMPLE_SIZE=all picks up where a previous
 *     run left off (or stopped/crashed) instead of starting over — it skips
 *     any chunk+language combo already present in data/questions.json.
 *     Set RESUME=false to force a clean regeneration instead.
 *   - Paced: REQUEST_DELAY_MS waits between calls so you don't blow through
 *     a free-tier rate limit (e.g. Gemini's free tier is ~15 requests/min
 *     for Flash — try REQUEST_DELAY_MS=4000 to stay under that).
 *   - Retried: a 429 (rate limited) response is retried with backoff
 *     instead of failing the whole run.
 *   - Saved incrementally: data/questions.json is rewritten after every
 *     successful question, not just at the end — an interruption partway
 *     through a large run doesn't lose the questions already generated.
 *
 * Why an LLM and not pure string templates: writing a natural question from
 * a declarative KB sentence is a language-generation task, not a lookup —
 * the same reason CallRunner's evaluate.py already uses an LLM (via
 * OPENAI_API_KEY + deepeval) to judge answers. This keeps the same
 * dependency, just used one step earlier in the pipeline.
 *
 * Two providers are supported so you can start on a free tier:
 *   - "gemini" (default) — Google AI Studio, free tier, no card required
 *   - "openai" — same OPENAI_API_KEY convention as evaluate.py, paid
 *
 * Usage:
 *   npx tsx src/question-generator/generate.ts
 *
 * Config (.env):
 *   LLM_PROVIDER        "gemini" (default) or "openai"
 *   GEMINI_API_KEY       required if LLM_PROVIDER=gemini
 *   OPENAI_API_KEY       required if LLM_PROVIDER=openai
 *   SAMPLE_SIZE          how many KB chunks to select (default 5), or "all"
 *                        to generate from every usable chunk. Each selected
 *                        chunk produces one question PER enabled language.
 *   GENERATE_ENGLISH     "true"/"false" — include English questions
 *   GENERATE_ARABIC      "true"/"false" — include Arabic questions
 *   RESUME               "true" (default) — skip chunk+language combos
 *                        already in data/questions.json; "false" starts over
 *   REQUEST_DELAY_MS      pause between LLM calls, in ms (default 0)
 *   MAX_RETRIES           retries for a rate-limited (429) call (default 5)
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const CHUNKS_PATH = path.join(DATA_DIR, "chunks.json");
const QUESTIONS_PATH = path.join(DATA_DIR, "questions.json");

const LLM_PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SAMPLE_SIZE_RAW = (process.env.SAMPLE_SIZE || "5").trim().toLowerCase();
const SAMPLE_ALL = SAMPLE_SIZE_RAW === "all";
const SAMPLE_SIZE = SAMPLE_ALL ? Infinity : Number(SAMPLE_SIZE_RAW);
const GENERATE_ENGLISH = (process.env.GENERATE_ENGLISH ?? "true") === "true";
const GENERATE_ARABIC = (process.env.GENERATE_ARABIC ?? "true") === "true";
const RESUME = (process.env.RESUME ?? "true") === "true";
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 0);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);

type Chunk = {
  id: string;
  type: "paragraph" | "table_row";
  text: string;
  language: "en" | "ar";
  group: string | null;
};

type Question = {
  id: string;
  pair_id: string; // links the en/ar versions of the SAME underlying question
  language: "en" | "ar";
  question: string;
  expected_answer: string;
  source_chunks: string[];
};

function loadChunks(): Chunk[] {
  if (!fs.existsSync(CHUNKS_PATH)) {
    throw new Error(
      `Missing ${CHUNKS_PATH} — run extract_chunks.py first:\n` +
        `  python src/question-generator/extract_chunks.py spl_kb.docx data/chunks.json`
    );
  }
  return JSON.parse(fs.readFileSync(CHUNKS_PATH, "utf-8"));
}

// A chunk too short ("الأهداف :", a bare heading) can't support a real
// question — skip it as a generation source.
const MIN_CHARS = 15;

function isUsable(c: Chunk): boolean {
  return c.text.length >= MIN_CHARS;
}

type Candidate =
  | { kind: "standalone"; chunks: [Chunk] }
  | { kind: "combined"; chunks: [Chunk, Chunk] };

/** Build candidate chunk selections: standalone chunks, and pairs of rows
 * that share the same table (`group`), which the KB's own structure already
 * marks as topically related — good raw material for a "combined" question
 * that needs more than one chunk to answer correctly. */
function buildCandidates(chunks: Chunk[]): Candidate[] {
  const usable = chunks.filter(isUsable);
  const standalone: Candidate[] = usable.map((c) => ({ kind: "standalone", chunks: [c] }));

  const byGroup = new Map<string, Chunk[]>();
  for (const c of usable) {
    if (!c.group) continue;
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group)!.push(c);
  }
  const combined: Candidate[] = [];
  for (const rows of byGroup.values()) {
    if (rows.length >= 2) {
      combined.push({ kind: "combined", chunks: [rows[0], rows[1]] });
    }
  }

  // Interleave so a small sample naturally includes both kinds.
  const out: Candidate[] = [];
  const maxLen = Math.max(standalone.length, combined.length);
  for (let i = 0; i < maxLen; i++) {
    if (standalone[i]) out.push(standalone[i]);
    if (combined[i]) out.push(combined[i]);
  }
  return out;
}

const SYSTEM_INSTRUCTION =
  "You write regression test questions for a customer-support knowledge base. " +
  "Given ONLY the provided knowledge-base content, write one realistic question a " +
  "real customer might ask, and the correct answer using ONLY facts present in the " +
  "content (never invent details). Respond with strict JSON: " +
  '{"question": "...", "expected_answer": "..."}';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries on HTTP 429 (rate limited) with exponential backoff, honoring a
 * Retry-After header when the provider sends one. Any other error is
 * re-thrown immediately — only rate limiting is worth retrying here. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status;
      if (status !== 429 || attempt >= MAX_RETRIES) throw err;
      const retryAfterMs = err?.retryAfterMs;
      const backoffMs = retryAfterMs ?? Math.min(2 ** attempt * 1000, 60_000);
      process.stdout.write(`\n    rate limited, retrying in ${Math.round(backoffMs / 1000)}s... `);
      await sleep(backoffMs);
    }
  }
}

async function callOpenAI(prompt: string): Promise<{ question: string; expected_answer: string }> {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY — add it to .env (see .env.example)");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_INSTRUCTION },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const err: any = new Error(`OpenAI API error ${res.status}: ${body}`);
    err.status = res.status;
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
    throw err;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Unexpected OpenAI response shape: ${JSON.stringify(data)}`);
  return parseLLMJson(content);
}

async function callGemini(prompt: string): Promise<{ question: string; expected_answer: string }> {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY — add it to .env (see .env.example)");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` +
    `?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const err: any = new Error(`Gemini API error ${res.status}: ${body}`);
    err.status = res.status;
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
    throw err;
  }

  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error(`Unexpected Gemini response shape: ${JSON.stringify(data)}`);
  return parseLLMJson(content);
}

function parseLLMJson(content: string): { question: string; expected_answer: string } {
  const parsed = JSON.parse(content);
  if (!parsed.question || !parsed.expected_answer) {
    throw new Error(`LLM response missing question/expected_answer: ${content}`);
  }
  return parsed;
}

async function callLLM(prompt: string): Promise<{ question: string; expected_answer: string }> {
  const call = () => {
    if (LLM_PROVIDER === "openai") return callOpenAI(prompt);
    if (LLM_PROVIDER === "gemini") return callGemini(prompt);
    throw new Error(`Unknown LLM_PROVIDER "${LLM_PROVIDER}" — use "gemini" or "openai"`);
  };
  return withRetry(call);
}

function buildPrompt(candidate: Candidate, language: "en" | "ar"): string {
  const langInstruction =
    language === "ar"
      ? "Write the question and answer in Arabic."
      : "Write the question and answer in English (translate the content's meaning faithfully — do not fabricate).";

  if (candidate.kind === "standalone") {
    return `${langInstruction}\n\nKnowledge base content:\n"""\n${candidate.chunks[0].text}\n"""`;
  }

  return (
    `${langInstruction}\n\nThe question must require BOTH pieces of content below to answer ` +
    `(a question answerable from only one of them is not acceptable).\n\n` +
    `Knowledge base content 1:\n"""\n${candidate.chunks[0].text}\n"""\n\n` +
    `Knowledge base content 2:\n"""\n${candidate.chunks[1].text}\n"""`
  );
}

function enabledLanguages(): ("en" | "ar")[] {
  const langs: ("en" | "ar")[] = [];
  if (GENERATE_ARABIC) langs.push("ar");
  if (GENERATE_ENGLISH) langs.push("en");
  if (langs.length === 0) {
    throw new Error("Both GENERATE_ENGLISH and GENERATE_ARABIC are false — nothing to generate");
  }
  return langs;
}

function validateQuestions(questions: Question[], validChunkIds: Set<string>): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const [i, q] of questions.entries()) {
    const where = `questions[${i}] (${q.id ?? "no id"})`;
    if (!q.id || !/^Q\d+$/.test(q.id)) errors.push(`${where}: invalid id`);
    if (q.id && seenIds.has(q.id)) errors.push(`${where}: duplicate id`);
    if (q.id) seenIds.add(q.id);
    if (!q.pair_id) errors.push(`${where}: missing pair_id`);
    if (q.language !== "en" && q.language !== "ar") errors.push(`${where}: language must be en/ar`);
    if (!q.question || typeof q.question !== "string" || !q.question.trim())
      errors.push(`${where}: question is empty`);
    if (!q.expected_answer || typeof q.expected_answer !== "string" || !q.expected_answer.trim())
      errors.push(`${where}: expected_answer is empty`);
    if (!Array.isArray(q.source_chunks) || q.source_chunks.length === 0)
      errors.push(`${where}: source_chunks must be a non-empty array`);
    else {
      for (const cid of q.source_chunks) {
        if (!validChunkIds.has(cid)) errors.push(`${where}: unknown source chunk "${cid}"`);
      }
    }
  }
  return errors;
}

function candidateKey(candidate: Candidate): string {
  return candidate.chunks
    .map((c) => c.id)
    .slice()
    .sort()
    .join(",");
}

function loadExistingQuestions(): Question[] {
  if (!RESUME || !fs.existsSync(QUESTIONS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf-8"));
  } catch {
    console.warn(`Could not parse existing ${QUESTIONS_PATH} — starting fresh.`);
    return [];
  }
}

function maxNumericSuffix(ids: string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    const m = id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

async function main() {
  const chunks = loadChunks();
  const validChunkIds = new Set(chunks.map((c) => c.id));
  const allCandidates = buildCandidates(chunks);
  const selected = SAMPLE_ALL ? allCandidates : allCandidates.slice(0, SAMPLE_SIZE);
  const languages = enabledLanguages();

  const questions: Question[] = loadExistingQuestions();
  const existingByKey = new Map<string, { pairId: string; langs: Set<string> }>();
  for (const q of questions) {
    const key = q.source_chunks.slice().sort().join(",");
    if (!existingByKey.has(key)) existingByKey.set(key, { pairId: q.pair_id, langs: new Set() });
    existingByKey.get(key)!.langs.add(q.language);
  }
  let qNum = maxNumericSuffix(questions.map((q) => q.id), "Q");
  let pairNum = maxNumericSuffix(questions.map((q) => q.pair_id), "P");

  // Plan the work up front so progress numbers and the resume summary are
  // accurate, and so an already-fully-generated candidate is skipped
  // entirely (no LLM call at all) rather than discovered mid-loop.
  type Task = { candidate: Candidate; language: "en" | "ar"; pairId: string };
  const tasks: Task[] = [];
  let skippedCandidates = 0;

  for (const candidate of selected) {
    const key = candidateKey(candidate);
    const existing = existingByKey.get(key);
    const needed = languages.filter((l) => !existing?.langs.has(l));
    if (needed.length === 0) {
      skippedCandidates++;
      continue;
    }
    const pairId = existing?.pairId ?? `P${String(++pairNum).padStart(3, "0")}`;
    for (const language of needed) tasks.push({ candidate, language, pairId });
  }

  console.log(
    `${selected.length} chunk(s) selected` + (SAMPLE_ALL ? " (all)" : "") + ` from ${chunks.length} total.` +
      (skippedCandidates > 0
        ? ` ${skippedCandidates} already fully generated — skipping (RESUME=${RESUME}).`
        : "") +
      ` ${tasks.length} question(s) to generate now.`
  );

  for (let i = 0; i < tasks.length; i++) {
    const { candidate, language, pairId } = tasks[i];
    const chunkIds = candidate.chunks.map((c) => c.id).join(", ");
    const prompt = buildPrompt(candidate, language);

    process.stdout.write(`  [${i + 1}/${tasks.length}] ${candidate.kind} (${language}) <- ${chunkIds} ... `);
    try {
      const { question, expected_answer } = await callLLM(prompt);
      console.log("ok");

      qNum++;
      questions.push({
        id: `Q${String(qNum).padStart(3, "0")}`,
        pair_id: pairId,
        language,
        question,
        expected_answer,
        source_chunks: candidate.chunks.map((c) => c.id),
      });

      // Save after every success — an interruption partway through a large
      // run (rate limit exhausted, network drop, Ctrl+C) doesn't lose the
      // questions already generated, and re-running with SAMPLE_SIZE=all
      // picks up exactly where this left off.
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(questions, null, 2), "utf-8");
    } catch (err: any) {
      console.log(`FAILED: ${err.message}`);
      console.log(
        `\n${questions.length} question(s) saved to ${QUESTIONS_PATH} before this failure. ` +
          `Re-run with RESUME=true (default) to continue from here.`
      );
      throw err;
    }

    if (REQUEST_DELAY_MS > 0 && i < tasks.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  const errors = validateQuestions(questions, validChunkIds);
  if (errors.length) {
    console.error("\nValidation FAILED:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nValidation OK.`);
  console.log(`${questions.length} question(s) total in ${QUESTIONS_PATH} (${tasks.length} generated this run).`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  // exitCode (not process.exit()) lets Node close open network handles on
  // its own before quitting — process.exit() right after a fetch() error
  // can trigger a spurious libuv assertion crash on Windows.
  process.exitCode = 1;
});
