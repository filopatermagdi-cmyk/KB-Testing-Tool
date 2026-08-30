import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

interface Question {
  id: string;
  pair_id: string;
  language: "ar" | "en";
  question: string;
  expected_answer: string;
  source_chunks?: string[];
  audio_file?: string;
}

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

const QUESTIONS_PATH = path.join("data", "questions.json");
const SESSIONS_PATH = path.join("data", "sessions.json");

const MESSAGES_PER_SESSION = parseInt(process.env.MESSAGES_PER_SESSION || "3", 10);
const TOTAL_SESSIONS_AR = parseInt(process.env.TOTAL_SESSIONS_AR || "2", 10);
const TOTAL_SESSIONS_EN = parseInt(process.env.TOTAL_SESSIONS_EN || "2", 10);
const RANDOM_SEED = process.env.RANDOM_SEED || "42";
const ALLOW_REPEAT_QUESTIONS = (process.env.ALLOW_REPEAT_QUESTIONS ?? "false").toLowerCase() === "true";

const AGENT_ID_BY_LANG: Record<string, string | null> = {
  ar: process.env.ZILLA_AGENT_ID_AR || null,
  en: process.env.ZILLA_AGENT_ID_EN || null,
};

// Seeded PRNG (mulberry32) so the same RANDOM_SEED always produces the same
// session composition/order — matches the reproducibility rule from the
// ground rules ("make randomized test generation reproducible via a seed").
function seedToInt(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildSessionsForLanguage(
  language: "ar" | "en",
  pool: Question[],
  totalSessions: number,
  messagesPerSession: number,
  rand: () => number
): Session[] {
  const sessions: Session[] = [];

  if (pool.length === 0) {
    console.warn(`  [${language}] No usable questions available (missing audio_file?) — skipping.`);
    return sessions;
  }

  let workingPool = shuffle(pool, rand);
  let cursor = 0;
  const seen = new Set<string>();
  let totalTurns = 0;
  let firstRepeatTurn: number | null = null;

  for (let s = 0; s < totalSessions; s++) {
    const turns: SessionTurn[] = [];
    let exhausted = false;

    for (let m = 0; m < messagesPerSession; m++) {
      if (cursor >= workingPool.length) {
        if (!ALLOW_REPEAT_QUESTIONS) {
          exhausted = true;
          break;
        }
        // reshuffle and continue, allowing repeats
        workingPool = shuffle(pool, rand);
        cursor = 0;
      }

      const q = workingPool[cursor++];
      totalTurns++;
      if (seen.has(q.id)) {
        if (firstRepeatTurn === null) firstRepeatTurn = totalTurns;
        if (seen.size < pool.length) {
          console.warn(
            `  [${language}] REPEAT before all questions used! (seen ${seen.size}/${pool.length} at turn ${totalTurns}, question ${q.id})`
          );
        }
      } else {
        seen.add(q.id);
      }
      turns.push({
        turn: m + 1,
        question_id: q.id,
        question: q.question,
        expected_answer: q.expected_answer,
        audio_file: q.audio_file as string,
      });
    }

    if (exhausted) {
      // Don't emit a partial session — a session shorter than
      // MESSAGES_PER_SESSION silently breaks the config contract and would
      // mislead anything downstream that assumes uniform session length.
      console.warn(
        `  [${language}] Stopped after ${sessions.length}/${totalSessions} sessions — ran out of ` +
          `unique questions (pool size ${pool.length}, needed ${totalSessions * messagesPerSession}). ` +
          `Set ALLOW_REPEAT_QUESTIONS=true to allow reuse, or lower MESSAGES_PER_SESSION / ` +
          `TOTAL_SESSIONS_${language.toUpperCase()}.`
      );
      break;
    }

    sessions.push({
      session_id: `S${String(sessions.length + 1).padStart(3, "0")}_${language}`,
      language,
      agent_id: AGENT_ID_BY_LANG[language],
      messages: turns,
    });
  }

  // Guarantee check: with ALLOW_REPEAT_QUESTIONS=true, no question is ever
  // repeated before every other pool question has appeared at least once.
  if (firstRepeatTurn === null) {
    console.log(
      `  [${language}] No repeats needed - ${seen.size} unique question(s) covered all ${sessions.length} sessions (no question repeated).`
    );
  } else if (seen.size === pool.length) {
    console.log(
      `  [${language}] VERIFIED: all ${pool.length} unique questions appeared before the first repeat (first repeat at turn ${firstRepeatTurn}).`
    );
  } else {
    console.warn(
      `  [${language}] CHECK FAILED: repeat started at turn ${firstRepeatTurn} before all ${pool.length} questions were used (seen only ${seen.size}).`
    );
  }

  return sessions;
}

function main() {
  if (!fs.existsSync(QUESTIONS_PATH)) {
    console.error(`No questions file found at ${QUESTIONS_PATH}`);
    process.exitCode = 1;
    return;
  }

  const allQuestions: Question[] = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf-8"));

  // Only questions that actually have generated audio can go into a session
  // (a session is a voice call — no audio_file means no way to feed it in).
  const withAudio = allQuestions.filter((q) => !!q.audio_file);
  const missingAudio = allQuestions.length - withAudio.length;
  if (missingAudio > 0) {
    console.warn(`${missingAudio} question(s) have no audio_file and will be excluded from sessions.`);
  }

  const arPool = withAudio.filter((q) => q.language === "ar");
  const enPool = withAudio.filter((q) => q.language === "en");

  if (!AGENT_ID_BY_LANG.ar) console.warn("ZILLA_AGENT_ID_AR is not set in .env — Arabic sessions will have agent_id: null.");
  if (!AGENT_ID_BY_LANG.en) console.warn("ZILLA_AGENT_ID_EN is not set in .env — English sessions will have agent_id: null.");

  const rand = mulberry32(seedToInt(RANDOM_SEED));

  console.log(`Building sessions (seed=${RANDOM_SEED}, messages/session=${MESSAGES_PER_SESSION})...`);
  const arSessions = buildSessionsForLanguage("ar", arPool, TOTAL_SESSIONS_AR, MESSAGES_PER_SESSION, rand);
  const enSessions = buildSessionsForLanguage("en", enPool, TOTAL_SESSIONS_EN, MESSAGES_PER_SESSION, rand);

  const allSessions = [...arSessions, ...enSessions];

  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(allSessions, null, 2), "utf-8");

  console.log(`\nDone. Wrote ${allSessions.length} sessions to ${SESSIONS_PATH}`);
  console.log(`  ar: ${arSessions.length} sessions (pool size ${arPool.length})`);
  console.log(`  en: ${enSessions.length} sessions (pool size ${enPool.length})`);
}

main();