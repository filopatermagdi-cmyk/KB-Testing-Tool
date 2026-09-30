/*
 * import_unified.ts — KB Flows: split one big Claude reply into per-flow files.
 *
 * Claude's reply to a make_prompts batch (or a pasted file) is a unified
 * structure with `chunks` + `flows` (array of scenario entries, one per
 * mode x language). We group entries by `flow_id` and write ONE file per flow:
 *
 *   data/flows/KnowledgeHub/<FLOW_ID>.unified.json
 *     { "flow_id": ..., "title": ..., "chunks": [...], "flows": [...] }
 *
 * Usage:
 *   npx tsx src/kb_flows/import_unified.ts data/kb_flows/claude-reply.json
 *                                           [--dir data/flows/KnowledgeHub]
 *                                           [--dry-run]
 *
 * Accepts either { "flows": [...] , "chunks": [...] } or a bare array of
 * flow objects. Prints per-flow file writes + validation problems.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

interface FlowEntry {
  id?: string;
  flow_id?: string;
  pair_id?: string;
  mode?: string; // "incremental" | "full_dump"
  language?: "ar" | "en";
  question?: string;
  expected_answer?: string;
  steps?: any[];
  chunk_ids?: string[];
  topic?: string;
  sub_topic?: string;
}

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const DRY_RUN = has("dry-run");
const OUT_DIR = path.join(ROOT, arg("dir", "data/flows/KnowledgeHub"));
const INPUT = process.argv[2];

function normalize(input: any): { chunks: any[]; flows: FlowEntry[] } {
  if (Array.isArray(input)) {
    // Bare array: could be flow-scenario entries OR flat question records.
    const scenarios = input.filter((x) => x && (x.mode || x.steps));
    const questions = input.filter((x) => x && !x.mode && !x.steps && x.question !== undefined);
    if (scenarios.length) return { chunks: [], flows: scenarios };
    // Flat question records (id/question/language/expected_answer): wrap each
    // language+mode group into scenario entries so downstream tools work.
    const byKey = new Map<string, any[]>();
    for (const q of questions) {
      const mode = q.pair_id && /dump/i.test(String(q.pair_id)) ? "full_dump" : "incremental";
      const key = `${q.sub_topic || q.topic || "FLOW"}|${q.language}|${mode}`;
      const list = byKey.get(key) || [];
      list.push(q);
      byKey.set(key, list);
    }
    const flows: FlowEntry[] = [];
    for (const [key, list] of byKey) {
      const [sub, language, mode] = key.split("|");
      const last = list[list.length - 1];
      const lang = (language === "en" ? "en" : "ar") as "en" | "ar";
      if (mode === "full_dump") {
        flows.push({
          id: `${sub}-DUMP-${String(language).toUpperCase()}`,
          flow_id: sub,
          pair_id: `${sub}-DUMP`,
          mode,
          language: lang,
          question: list[0]?.question,
          expected_answer: list.map((q: any) => q.expected_answer).join(" "),
          chunk_ids: [],
          sub_topic: sub,
        });
      } else {
        flows.push({
          id: `${sub}-INC-${String(language).toUpperCase()}`,
          flow_id: sub,
          pair_id: `${sub}-INC`,
          mode,
          language: lang,
          question: list[0]?.question,
          steps: list.map((q: any, i: number) => ({
            step_n: i + 1,
            stimulus: q.question,
            expected_answer: q.expected_answer,
            chunk_ids: q.chunk_ids || [],
          })),
          sub_topic: sub,
        });
      }
    }
    return { chunks: [], flows };
  }
  // Object: { chunks?, flows? } as Claude is told to produce — or a single FlowEntry.
  if (input.flows && Array.isArray(input.flows)) return { chunks: input.chunks || [], flows: input.flows };
  if (input.flow_id || input.id) return { chunks: [], flows: [input] };
  return { chunks: input.chunks || [], flows: input.flows || [] };
}

function validate(entry: FlowEntry): string[] {
  const issues: string[] = [];
  const fid = entry.flow_id || entry.id || "?";
  if (!entry.flow_id && !entry.id) issues.push(`${fid}: missing flow_id/id`);
  if (!entry.language) issues.push(`${fid}: missing language`);
  if (!entry.mode) issues.push(`${fid}: missing mode`);
  if (!entry.question) issues.push(`${fid}: missing question`);
  if (entry.mode === "full_dump" && !entry.expected_answer) issues.push(`${fid}: full_dump missing expected_answer`);
  if (entry.mode === "incremental" && !Array.isArray(entry.steps)) issues.push(`${fid}: incremental missing steps[]`);
  if (Array.isArray(entry.steps)) {
    entry.steps.forEach((s, i) => {
      if (!s.expected_answer) issues.push(`${fid} step${i + 1}: missing expected_answer`);
      if (!s.stimulus) issues.push(`${fid} step${i + 1}: missing stimulus`);
    });
  }
  return issues.slice(0, 8);
}

function main() {
  if (!INPUT) {
    console.error("Usage: tsx src/kb_flows/import_unified.ts <claude-reply.json | dir-with-jsons> [--dir data/flows/KnowledgeHub] [--dry-run]");
    process.exitCode = 1;
    return;
  }
  const raw = path.resolve(ROOT, INPUT);
  // If INPUT is a directory, import EVERY *.json inside (the 167-file batch the
  // user drops in one place) and merge scenarios by flow_id.
  let files: string[] = [];
  try {
    if (fs.statSync(raw).isDirectory()) {
      files = fs
        .readdirSync(raw)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => path.join(raw, f));
      if (!files.length) {
        console.error(`No .json files in ${raw}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Importing ${files.length} reply file(s) from ${raw}`);
    } else {
      files = [raw];
    }
  } catch {
    files = [raw];
  }

  const allChunks: any[] = [];
  const allFlows: FlowEntry[] = [];
  const badFiles: string[] = [];
  let readOk = 0;
  for (const p of files) {
    if (!fs.existsSync(p)) continue;
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e: any) {
      badFiles.push(`${path.basename(p)} (${e.message})`);
      continue;
    }
    const { chunks, flows } = normalize(data);
    for (const c of chunks) allChunks.push(c);
    for (const f of flows) allFlows.push(f);
    readOk++;
  }
  if (!readOk || !allFlows.length) {
    console.error(`No readable flows found${files.length ? ` among ${files.length} file(s)` : " in input"}.`);
    if (badFiles.length) console.error(badFiles.join("\n"));
    process.exitCode = 1;
    return;
  }
  const chunks = allChunks;

  const byFlow = new Map<string, FlowEntry[]>();
  const problems: string[] = [];
  for (const f of allFlows) {
    problems.push(...validate(f));
    // Detect mojibake: 3+ consecutive replacement characters in text fields.
    const badField = (name: string, v: unknown) => {
      if (typeof v === "string" && /\?{3,}/.test(v)) problems.push(`${f.id || f.flow_id}: ${name} has ??? pattern (mojibake / encoding loss)`);
    };
    badField("sub_topic", (f as any).sub_topic);
    badField("question", (f as any).question);
    badField("expected_answer", (f as any).expected_answer);
    for (const s of (f as any).steps || []) {
      badField(`step stimulus`, s.stimulus);
      badField(`step expected_answer`, s.expected_answer);
    }
    const key = f.flow_id || f.id || "UNKNOWN";
    const list = byFlow.get(key) || [];
    list.push(f);
    byFlow.set(key, list);
  }
  if (problems.length) {
    console.log(`Validation problems (${problems.length}):`);
    for (const pr of problems) console.log(`  ! ${pr}`);
    if (!DRY_RUN) {
      console.error("\nAborting — fix the input or use --dry-run to preview writes only.");
      process.exitCode = 1;
      return;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let written = 0;
  for (const [flowId, entries] of byFlow) {
    const title =
      (entries.find((e) => e.sub_topic)?.sub_topic) ||
      flowId.replace(/_/g, " ");
    const out = specFile(flowId);
    const payload = {
      flow_id: flowId,
      title,
      topic: "KnowledgeHub",
      chunks,
      flows: entries,
    };
    if (DRY_RUN) {
      console.log(`[dry] ${out}  (${entries.length} scenarios)`);
    } else {
      fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", "utf8");
      written++;
    }
  }

  if (DRY_RUN) {
    console.log(`\nDRY RUN — would write ${byFlow.size} files to ${OUT_DIR}`);
  } else {
    console.log(`\nWrote ${written} flow file(s) -> ${OUT_DIR}${problems.length ? " (with validation problems above)" : ""}`);
  }
  if (badFiles.length) {
    console.log(`\nUnreadable file(s): ${badFiles.length} -> `);
    for (const bf of badFiles) console.log(`  ! ${bf}`);
  }
}

function specFile(flowId: string): string {
  return path.join(OUT_DIR, `${flowId.replace(/[\\/:*?"<>|]/g, "_")}.unified.json`);
}

main();