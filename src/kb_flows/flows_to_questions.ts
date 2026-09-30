/*
 * flows_to_questions.ts — KB Flows: convert flow specs into flat question files.
 *
 * Reads every data/flows/KnowledgeHub/<FLOW_ID>.unified.json and writes the
 * standard question format the rest of the pipeline consumes:
 *
 *   data/questions/<topic>/<Title>-Incremental_AR.json
 *   data/questions/<topic>/<Title>-Incremental_EN.json
 *   data/questions/<topic>/<Title>-FullDump_AR.json
 *   data/questions/<topic>/<Title>-FullDump_EN.json
 *
 * Each incremental step -> one flat question {id, pair_id, language, question
 * (=stimulus), expected_answer, source_chunks, chunk_ids}. full_dump -> one
 * question. This makes `generate-audio` (wav/<id>.wav), `build-sessions`,
 * `/api/import` and the dashboard question dropdowns all work with the 66 flows.
 *
 * Usage:
 *   npx tsx src/kb_flows/flows_to_questions.ts
 *                      [--flows data/flows/KnowledgeHub]   (glob/dir)
 *                      [--topic KnowledgeHub]
 *                      [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FLOWS_DIR = path.join(ROOT, "data", "flows");
const QUESTIONS_DIR = path.join(ROOT, "data", "questions");

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const DRY_RUN = has("dry-run");
const TOPIC = arg("topic", "KnowledgeHub");
const SPECS_SUBDIR = arg("flows", "KnowledgeHub").replace(/\\/g, "/").replace(/^data\/flows\//, "");

interface UnifiedFlowFile {
  flow_id: string;
  title?: string;
  topic?: string;
  chunks?: { id: string; text: string }[];
  flows?: FlowScenario[];
}
interface FlowScenario {
  id: string;
  flow_id?: string;
  pair_id?: string;
  mode: string;
  language: "ar" | "en";
  question: string;
  expected_answer?: string;
  steps?: { step_n?: number; stimulus: string; expected_answer: string; chunk_ids?: string[] }[];
  chunk_ids?: string[];
  sub_topic?: string;
}

function collectSpecFiles(): string[] {
  const specSub = SPECS_SUBDIR.replace(/^data[/\\]flows[/\\]/, "");
  const dirBase = path.join(FLOWS_DIR, specSub);
  const direct = path.resolve(ROOT, SPECS_SUBDIR);
  const dirs = [dirBase, direct].filter((d, i, arr) => arr.indexOf(d) === i);
  const files: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    files.push(
      ...fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(dir, f)),
    );
  }
  return files
    .filter((f, i, arr) => arr.indexOf(f) === i)
    .filter((f) => {
      try {
        const d = JSON.parse(fs.readFileSync(f, "utf8"));
        return Array.isArray(d.flows) && d.flows.length > 0;
      } catch {
        return false;
      }
    });
}

function chunkTextMap(spec: UnifiedFlowFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of spec.chunks || []) if (c.id && c.text) m.set(c.id, c.text);
  return m;
}

function sourceChunks(ids: string[] | undefined, cmap: Map<string, string>): string[] {
  if (!ids) return [];
  return ids.map((id) => cmap.get(id)).filter((t): t is string => !!t);
}

function buildQuestions(spec: UnifiedFlowFile): any[] {
  const cmap = chunkTextMap(spec);
  const flowId = spec.flow_id || "FLOW";
  const title = (spec.title || flowId).replace(/[\\/:*?"<>|]/g, "");
  const scenarios = spec.flows || [];
  const out: any[] = [];

  for (const sc of scenarios) {
    const lang = sc.language;
    const mode = (sc.mode || "").toLowerCase();
    const pairKey = (sc.pair_id || `${flowId}-${mode.toUpperCase()}`).toUpperCase();
    const fileMode = mode === "incremental" ? "Incremental" : "FullDump";

    if (mode === "incremental") {
      for (const [i, st] of (sc.steps || []).entries()) {
        const qid = `${flowId.slice(0, 10)}-INC-${lang.toUpperCase()}-${String(i + 1).padStart(3, "0")}`;
        out.push({
          id: qid,
          pair_id: pairKey,
          language: lang,
          topic: TOPIC,
          sub_topic: `${title}-${fileMode}`,
          question: st.stimulus,
          expected_answer: st.expected_answer,
          source_chunks: sourceChunks(st.chunk_ids, cmap),
          chunk_ids: st.chunk_ids || [],
        });
      }
    } else {
      out.push({
        id: `${flowId.slice(0, 10)}-DUMP-${lang.toUpperCase()}-001`,
        pair_id: pairKey,
        language: lang,
        topic: TOPIC,
        sub_topic: `${title}-${fileMode}`,
        question: sc.question,
        expected_answer: sc.expected_answer || "",
        source_chunks: sourceChunks(sc.chunk_ids, cmap),
        chunk_ids: sc.chunk_ids || [],
      });
    }
  }
  return out;
}

function questionFileName(spec: UnifiedFlowFile, q: any): string {
  const mode = /-INC-/.test(q.id) ? "Incremental" : "FullDump";
  const title = (spec.title || spec.flow_id).replace(/[\\/:*?"<>|]/g, "");
  return `${title}-${mode}_${q.language.toUpperCase()}.json`;
}

function main() {
  const files = collectSpecFiles();
  if (!files.length) {
    console.error(`No unified flow specs found under data/flows/${SPECS_SUBDIR}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.join(QUESTIONS_DIR, TOPIC), { recursive: true });
  let totalQuestions = 0;
  let filesWritten = 0;

  for (const file of files) {
    const spec: UnifiedFlowFile = JSON.parse(fs.readFileSync(file, "utf8"));
    const questions = buildQuestions(spec);
    if (!questions.length) continue;

    const byOut = new Map<string, any[]>();
    for (const q of questions) {
      const name = questionFileName(spec, q);
      const list = byOut.get(name) || [];
      list.push(q);
      byOut.set(name, list);
    }

    for (const [name, list] of byOut) {
      const outPath = path.join(QUESTIONS_DIR, TOPIC, name);
      if (DRY_RUN) {
        console.log(`[dry] ${name}: ${list.length} questions`);
      } else {
        fs.writeFileSync(outPath, JSON.stringify(list, null, 2) + "\n", "utf8");
      }
      totalQuestions += list.length;
      filesWritten++;
    }

    if (!DRY_RUN) {
      console.log(`${spec.flow_id}: gen ${byOut.size} file(s) from ${file}`);
    }
  }

  console.log(`\n${DRY_RUN ? "DRY RUN — would write" : "Wrote"} ${filesWritten} question file(s), ${totalQuestions} questions total -> ${path.join(QUESTIONS_DIR, TOPIC)}`);
}

main();