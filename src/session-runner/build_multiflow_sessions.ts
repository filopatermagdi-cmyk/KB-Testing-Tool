/*
 * build_multiflow_sessions.ts — KB Flows: compose ONE session from MULTIPLE flows.
 *
 * The pattern you asked for, per language:
 *   [flow1 incremental]  trigger question -> "نعم" -> "تمام" -> "كمّل"  (all steps, one per turn)
 *   [flow2 incremental]  next-flow trigger question -> confirms... (all steps)
 *   [flow3 full_dump]    any OTHER flow, all steps recited once
 *
 * Reads flat question files from data/questions/<topic>/ (the format produced
 * by flows_to_questions.ts) and writes data/sessions/<topic>/<name>.json with
 * the SAME shape run_sessions.ts already consumes (session_id/language/turns/
 * messages[{turn,question_id,question,expected_answer,audio_file}]).
 *
 * Usage:
 *   npm run build-multiflow -- --topic KnowledgeHub \
 *       --first  ShareAccountInfo --second ShareAccountInfo \
 *       --third  RANDOM --name MultiFlow --langs ar,en \
 *       --count 1 --seed 7
 *
 *   --first/--second   base name of an Incremental_<LANG>.json question file
 *   --third            base name of a FullDump_<LANG>.json file, or "RANDOM"
 *                      to pick a different flow from whatever FullDump files exist
 *   --count N          number of sessions to build (only used with RANDOM, else 1)
 *   --langs ar,en       which languages to build (default: any present)
 *   --name <id>        output filename + session prefix (default MultiFlow)
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}

const TOPIC = arg("topic", "KnowledgeHub");
const FIRST = arg("first", "");
const SECOND = arg("second", "");
const THIRD = arg("third", "RANDOM");
const NAME = arg("name", "MultiFlow");
const LANGS = (arg("langs", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const COUNT = Math.max(1, parseInt(arg("count", "1"), 10) || 1);
const SEED = parseInt(arg("seed", ""), 10);
const AUTO = process.argv.includes("--auto");

const QUESTIONS_DIR = path.join(ROOT, "data", "questions", TOPIC);
const OUTPUT_DIR = path.join(ROOT, "data", "sessions", TOPIC);

interface QRow {
  id: string;
  language: string;
  question: string;
  expected_answer: string;
}

function loadJson(p: string): QRow[] {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadLang(rows: QRow[], lang: string): QRow[] {
  return rows.filter((r) => r.language === lang);
}

// Deterministic PRNG so --seed gives reproducible "random" third flows.
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

function main() {
  const files = fs.readdirSync(QUESTIONS_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".chunks.json")).sort();
  // Group by "<base>" -> { Incremental: {ar:rows,en:rows}, FullDump: {...} }
  const flows = new Map<string, Record<string, Record<string, QRow[]>>>();
  for (const file of files) {
    const m = file.match(/^(.+?)-(Incremental|FullDump)_(ar|en)\.json$/i);
    if (!m) continue;
    const [, base, mode, lang] = m;
    const langLower = lang.toLowerCase();
    const byFlow = flows.get(base) || {};
    byFlow[mode.toLowerCase()] = byFlow[mode.toLowerCase()] || {};
    byFlow[mode.toLowerCase()][langLower] = byFlow[mode.toLowerCase()][langLower] || [];
    byFlow[mode.toLowerCase()][langLower].push(...loadJson(path.join(QUESTIONS_DIR, file)));
    flows.set(base, byFlow);
  }

  const bases = [...flows.keys()].sort();
  if (!bases.length) {
    console.error(`No flows found under ${QUESTIONS_DIR}`);
    process.exitCode = 1;
    return;
  }

  // Languages: requested langs or every lang that has ANY incremental rows.
  const langs = LANGS.length
    ? LANGS
    : [...new Set([...bases.flatMap((b) => Object.keys(flows.get(b)!.incremental || {}))])];
  if (!langs.length) {
    console.error(`No languages found in ${QUESTIONS_DIR}`);
    process.exitCode = 1;
    return;
  }

  const rng = Number.isNaN(SEED) ? Math.random : createRng(SEED);

  // ---- AUTO mode: sessions = floor(#flows / 2); each session = 2 random
  // ---- incremental flows (a "pair") + one random full_dump from a DIFFERENT
  // ---- flow. All drawn deterministically from --seed.
  if (AUTO) {
    const shuffled = [...bases];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const sessionCount = Math.max(1, Math.floor(shuffled.length / 2));
    if (!Number.isNaN(SEED)) console.log(`AUTO: ${shuffled.length} flows -> ${sessionCount} session(s) (seed ${SEED})`);

    // Build sessionCount pairs from the shuffled flows (drop any remainder).
    const pairs: { first: string; second: string }[] = [];
    for (let i = 0; i < sessionCount * 2; i += 2) {
      pairs.push({ first: shuffled[i], second: shuffled[i + 1] });
    }

    // Pick a distinct full-dump flow per session, never from that session's pair.
    const dumpPool = bases.filter((b) => flows.get(b)?.fulldump);
    const chosen = sessionCount < 2 && dumpPool.length
      ? [dumpPool[Math.floor(rng() * dumpPool.length)]]
      : (() => {
          // rotate: prefers flows NOT in the current pair first
          const used: string[] = [];
          const pick = (excl: Set<string>): string | null => {
            const avail = dumpPool.filter((b) => !used.includes(b) && !excl.has(b));
            if (!avail.length) return dumpPool.find((b) => !excl.has(b)) || null;
            return avail[Math.floor(rng() * avail.length)];
          };
          const out: (string | null)[] = pairs.map((p) => pick(new Set([p.first, p.second])));
          for (let i = 0; i < out.length; i++) if (!out[i]) used.push(out[i] = dumpPool[0]);
          return out;
        })();

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outputName = `${NAME}.json`;
    const allSessions: any[] = [];
    let sessionNumber = 0;

    pairs.forEach((p, i) => {
      const dumpBase = chosen[i];
      if (!dumpBase || !flows.get(dumpBase)?.fulldump) return;
      for (const lang of langs) {
        const inc1 = loadLang(flows.get(p.first)!.incremental[lang] || [], lang);
        const inc2 = loadLang(flows.get(p.second)!.incremental[lang] || [], lang);
        const dump = loadLang(flows.get(dumpBase)!.fulldump[lang] || [], lang);
        if (!inc1.length || !inc2.length || !dump.length) continue;
        const messages = [
          ...inc1.map((q, idx) => ({ turn: idx + 1, question_id: q.id, question: q.question, expected_answer: q.expected_answer, audio_file: `wav/${q.id}.wav` })),
          ...inc2.map((q, idx) => ({ turn: inc1.length + idx + 1, question_id: q.id, question: q.question, expected_answer: q.expected_answer, audio_file: `wav/${q.id}.wav` })),
          ...dump.map((q, idx) => ({ turn: inc1.length + inc2.length + idx + 1, question_id: q.id, question: q.question, expected_answer: q.expected_answer, audio_file: `wav/${q.id}.wav` })),
        ];
        sessionNumber++;
        allSessions.push({
          session_id: `${NAME}-${lang}-${String(sessionNumber).padStart(3, "0")}`,
          subtopic: `${TOPIC}/${NAME}`,
          language: lang,
          turns: messages.length,
          messages,
        });
      }
    });

    fs.writeFileSync(path.join(OUTPUT_DIR, outputName), JSON.stringify(allSessions, null, 2) + "\n", "utf8");
    console.log(`Wrote ${allSessions.length} session(s) -> ${path.join(OUTPUT_DIR, outputName)}`);
    for (const s of allSessions) {
      const ids = s.messages.map((m: any) => m.question_id).join(", ");
      console.log(`  ${s.session_id} (${s.turns} turns): ${ids}`);
    }
    console.log(`\nPairs: ${pairs.map((p) => `${p.first}+${p.second}`).join(" | ")}`);
    console.log(`Dumps: ${chosen.join(", ")}`);
    return;
  }

  if (!FIRST || !SECOND) {
    console.error("Usage: --first <base> --second <base> [--third <base|RANDOM>] [--name MultiFlow] [--langs ar,en] [--count N] [--seed N] | --auto [--name MultiFlow] [--langs ar,en] [--seed N]");
    process.exitCode = 1;
    return;
  }

  if (!flows.has(FIRST)) {
    console.error(`--first "${FIRST}" not found. Available: ${bases.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (!flows.has(SECOND)) {
    console.error(`--second "${SECOND}" not found. Available: ${bases.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const dumpPool = bases.filter((b) => b !== FIRST && b !== SECOND && flows.get(b)?.fulldump);
  if (!dumpPool.length) {
    console.error(`No FullDump files to use for the third flow under ${QUESTIONS_DIR}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputName = `${NAME}.json`;
  const allSessions: any[] = [];
  let sessionNumber = 0;

  const thirdBase = THIRD === "RANDOM"
    ? dumpPool[Math.floor(rng() * dumpPool.length)]
    : THIRD;
  for (const f of [FIRST, SECOND]) {
    if (!flows.get(f)?.incremental) {
      console.error(`Flow "${f}" has no Incremental files.`);
      process.exitCode = 1;
      return;
    }
  }
  if (!flows.get(thirdBase)?.fulldump) {
    console.error(`Third flow "${thirdBase}" has no FullDump files.`);
    process.exitCode = 1;
    return;
  }

  for (let i = 0; i < COUNT; i++) {
    const chosenThird = THIRD === "RANDOM"
      ? dumpPool[Math.floor(rng() * dumpPool.length)]
      : thirdBase;
    for (const lang of langs) {
      const inc1 = loadLang(flows.get(FIRST)!.incremental[lang] || [], lang);
      const inc2 = loadLang(flows.get(SECOND)!.incremental[lang] || [], lang);
      const dump = loadLang(flows.get(chosenThird)!.fulldump[lang] || [], lang);
      if (!inc1.length || !inc2.length || !dump.length) continue;

      const messages = [
        ...inc1.map((q, idx) => ({ turn: idx + 1, question_id: q.id, question: q.question, expected_answer: q.expected_answer, audio_file: `wav/${q.id}.wav` })),
        ...inc2.map((q, idx) => ({ turn: inc1.length + idx + 1, question_id: q.id, question: q.question, expected_answer: q.expected_answer, audio_file: `wav/${q.id}.wav` })),
        ...dump.map((q, idx) => ({ turn: inc1.length + inc2.length + idx + 1, question_id: q.id, question: q.question, expected_answer: q.expected_answer, audio_file: `wav/${q.id}.wav` })),
      ];

      sessionNumber++;
      allSessions.push({
        session_id: `${NAME}-${lang}-${String(sessionNumber).padStart(3, "0")}`,
        subtopic: `${TOPIC}/${NAME}`,
        language: lang,
        turns: messages.length,
        messages,
      });
    }
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, outputName), JSON.stringify(allSessions, null, 2) + "\n", "utf8");
  console.log(`Wrote ${allSessions.length} session(s) -> ${path.join(OUTPUT_DIR, outputName)}`);
  for (const s of allSessions) {
    const ids = s.messages.map((m: any) => m.question_id).join(", ");
    console.log(`  ${s.session_id} (${s.turns} turns): ${ids}`);
  }
  if (THIRD === "RANDOM") {
    console.log(`\nThird flow selected (seed ${Number.isNaN(SEED) ? "random" : SEED}): ${thirdBase}`);
  }
}

main();