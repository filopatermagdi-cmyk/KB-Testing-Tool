import fs from "fs";
import path from "path";

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
  subtopic: string;
  language: string;
  turns: number;
  messages: SessionTurn[];
}

const QUESTIONS_DIR = path.join("data", "questions");
const OUTPUT_DIR = path.join("data", "sessions");
const DEFAULT_SESSION_SIZE = 10;

// --- CLI args --------------------------------------------------------------
//   --topic <name>        only build this topic (default: all topics)
//   --subtopic <name>     only build this sub-topic within --topic (default: all)
//   --size <N>            questions per session (default 10)
//   --ar-sessions <N>     cap number of Arabic sessions (0 = all)
//   --en-sessions <N>     cap number of English sessions (0 = all)
//   --seed <N>            fixed question order (fallback: RANDOM_SEED env).
//                         Empty/absent = random order each build.
function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}
function argInt(name: string, def: number): number {
  const n = parseInt(arg(name, ""), 10);
  return Number.isNaN(n) || n < 0 ? def : n;
}

// Deterministic PRNG (mulberry32) so `--seed N` gives the exact same session
// layout every build; without a seed we use Math.random.
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resolveSeed(): number | null {
  const raw = arg("seed", "") || process.env.RANDOM_SEED || "";
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function loadAllQuestions(topicsOnly: string[], subtopicsOnly: string[]): Map<string, Question[]> {
  const bySubtopic = new Map<string, Question[]>();
  const topics = fs
    .readdirSync(QUESTIONS_DIR)
    .filter((f) => fs.statSync(path.join(QUESTIONS_DIR, f)).isDirectory())
    .filter((f) => topicsOnly.length === 0 || topicsOnly.includes(f))
    .sort();

  for (const topic of topics) {
    const topicDir = path.join(QUESTIONS_DIR, topic);
    const jsonFiles = fs
      .readdirSync(topicDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".chunks.json"))
      .filter((f) => subtopicsOnly.length === 0 || subtopicsOnly.includes(f.replace(/\.json$/, "")))
      .sort();

    for (const jsonFile of jsonFiles) {
      const subtopic = jsonFile.replace(".json", "");
      const data: Question[] = JSON.parse(
        fs.readFileSync(path.join(topicDir, jsonFile), "utf-8")
      );
      bySubtopic.set(`${topic}/${subtopic}`, data);
    }
  }

  return bySubtopic;
}

function buildSessionsForSubtopic(
  subtopicKey: string,
  questions: Question[],
  sessionSize: number,
  maxSessionsAr: number,
  maxSessionsEn: number,
  rng: () => number
): Session[] {
  const sessions: Session[] = [];
  const [topic, subtopicName] = subtopicKey.split("/");

  const arQuestions = shuffle(questions.filter((q) => q.language === "ar"), rng);
  const enQuestions = shuffle(questions.filter((q) => q.language === "en"), rng);

  for (const [lang, langQuestions] of [
    ["ar", arQuestions],
    ["en", enQuestions],
  ] as Array<[string, Question[]]>) {
    const max = lang === "ar" ? maxSessionsAr : maxSessionsEn;
    let built = 0;
    for (let i = 0; i < langQuestions.length; i += sessionSize) {
      let batch = langQuestions.slice(i, i + sessionSize);

      if (batch.length < sessionSize) {
        const needed = sessionSize - batch.length;
        const usedIds = new Set(batch.map((q) => q.id));
        const pool = shuffle(langQuestions.filter((q) => !usedIds.has(q.id)), rng);
        const filler = pool.slice(0, needed);
        batch = [...batch, ...filler];
      }

      const sessionNum = sessions.filter((s) => s.language === lang).length + 1;
      const session: Session = {
        session_id: `${subtopicName.replace(/\s+/g, "")}-${lang}-${String(sessionNum).padStart(3, "0")}`,
        subtopic: subtopicKey,
        language: lang,
        turns: batch.length,
        messages: batch.map((q, idx) => ({
          turn: idx + 1,
          question_id: q.id,
          question: q.question,
          expected_answer: q.expected_answer,
          audio_file: q.audio_file || `wav/${q.id}.wav`,
        })),
      };

      sessions.push(session);
      built++;
      if (max > 0 && built >= max) break;
    }
  }

  return sessions;
}

function main() {
  const topicsOnly = (arg("topic", "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const subtopicsOnly = (arg("subtopic", "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sessionSize = argInt("size", DEFAULT_SESSION_SIZE);
  const maxSessionsAr = argInt("ar-sessions", 0);
  const maxSessionsEn = argInt("en-sessions", 0);
  const seed = resolveSeed();
  const rng = seed === null ? Math.random : createRng(seed);

  const bySubtopic = loadAllQuestions(topicsOnly, subtopicsOnly);
  const allQuestions = [...bySubtopic.values()].flat();

  if (!bySubtopic.size) {
    console.error("No question files found under data/questions/"
      + (topicsOnly.join(",") || "*") + " — import questions first.");
    process.exitCode = 1;
    return;
  }

  console.log(`Found ${allQuestions.length} questions across ${bySubtopic.size} sub-topic(s)`);
  console.log(`session size: ${sessionSize} | AR cap: ${maxSessionsAr || "all"} | EN cap: ${maxSessionsEn || "all"} | seed: ${seed === null ? "random" : seed}\n`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allSessionIds = new Set<string>();
  const allQuestionIds = new Set<string>();
  const perTopicCount: Record<string, number> = {};

  for (const [subtopicKey, questions] of bySubtopic) {
    const [topic, subtopicName] = subtopicKey.split("/");
    const sessions = buildSessionsForSubtopic(
      subtopicKey, questions, sessionSize, maxSessionsAr, maxSessionsEn, rng
    );
    const outDir = path.join(OUTPUT_DIR, topic);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${subtopicName}.json`);

    fs.writeFileSync(outFile, JSON.stringify(sessions, null, 2), "utf-8");

    for (const s of sessions) {
      allSessionIds.add(s.session_id);
      for (const m of s.messages) {
        allQuestionIds.add(m.question_id);
      }
    }
    perTopicCount[topic] = (perTopicCount[topic] || 0) + sessions.length;

    const arCount = questions.filter((q) => q.language === "ar").length;
    const enCount = questions.filter((q) => q.language === "en").length;
    console.log(`${subtopicName}: ${questions.length} questions (${arCount} ar + ${enCount} en) → ${sessions.length} sessions → ${path.relative(process.cwd(), outFile)}`);
  }

  console.log(`\nTotal: ${allSessionIds.size} sessions (${Object.entries(perTopicCount).map(([t, n]) => `${t}=${n}`).join(", ")}), ${allQuestionIds.size}/${allQuestions.length} questions covered`);

  if (allQuestionIds.size !== allQuestions.length) {
    const missing = allQuestions.filter((q) => !allQuestionIds.has(q.id));
    console.error(`WARNING: ${missing.length} questions NOT covered:`, missing.map((q) => q.id).join(", "));
  } else {
    console.log("All questions covered!");
  }
}

main();
