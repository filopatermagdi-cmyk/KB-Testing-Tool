/*
 * make_prompts.ts — KB Flows: turn data/kb_flows/sources.json into Claude prompts.
 *
 * Each input=1 full KB article (AR + EN). Prompts are batched (default 8 inputs
 * per prompt) so Claude isn't drowned in 66 full documents at once.
 *
 * Usage:
 *   npx tsx src/kb_flows/make_prompts.ts [--file data/kb_flows/sources.json]
 *                                         [--out data/kb_flows/prompts]
 *                                         [--batch 8]
 *                                         [--flows 1,2,3,65]
 *
 * Output: data/kb_flows/prompts/batch-001.md, batch-002.md, ... (one per batch),
 *   plus data/kb_flows/prompts/manifest.json listing every batch and its flows.
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

const SOURCES = path.join(ROOT, arg("file", "data/kb_flows/sources.json"));
const OUT_DIR = path.join(ROOT, arg("out", "data/kb_flows/prompts"));
const BATCH = Math.max(1, parseInt(arg("batch", "8"), 10) || 8);

const INSTRUCTIONS = `You are producing Zilla KB regression-test flow specs.

Below are ${BATCH} Knowledge Base documents. Each document = one flow. For EVERY
flow produce a spec object with EXACTLY this shape (one object per flow, in a
single JSON array as the last block of your reply):

{
  "chunks": [
    { "id": "CHK-<FLOW_ID>-S01_en", "text": "<english step text>" },
    ... one chunk per step, plus
    { "id": "CHK-<FLOW_ID>-CLOSE_en", "text": "<english closing message>" },
    { "id": "CHK-<FLOW_ID>-S01", "text": "<arabic step text>" },
    ... same set in arabic
  ],
  "flows": [
    {
      "id": "<FLOW_ID>-INC-EN",
      "flow_id": "<FLOW_ID>",
      "pair_id": "<FLOW_ID>-INC",
      "mode": "incremental",
      "language": "en",
      "topic": "KnowledgeHub",
      "question": "<a natural way the customer asks for this flow, in english>",
      "steps": [
        { "step_n": 1, "stimulus": "<same question>",
          "expected_answer": "<step 1 english text>",
          "chunk_ids": ["CHK-<FLOW_ID>-S01_en"] },
        { "step_n": 2, "stimulus": "yes",
          "expected_answer": "<step 2 english text>",
          "chunk_ids": ["CHK-<FLOW_ID>-S02_en"] },
        ... one step per KB step; the FINAL step's expected_answer must append
        the closing message, and its chunk_ids must include the CLOSE chunk.
      ]
    },
    {
      "id": "<FLOW_ID>-DUMP-EN",
      "flow_id": "<FLOW_ID>",
      "pair_id": "<FLOW_ID>-DUMP",
      "mode": "full_dump",
      "language": "en",
      "topic": "KnowledgeHub",
      "question": "<same need, but add: "give me all the steps at once">",
      "expected_answer": "1) <step1> 2) <step2> ... <closing>",
      "chunk_ids": ["CHK-<FLOW_ID>-S01_en", "...", "CHK-<FLOW_ID>-CLOSE_en"]
    },
    { "id": "<FLOW_ID>-INC-AR", ... same as INC-EN but language "ar",
      stimuli in arabic: step1 = arabic question, then "نعم", "تمام", "كمّل" ... },
    { "id": "<FLOW_ID>-DUMP-AR", ... same as DUMP-EN but language "ar" }
  ]
}

Rules:
1. <FLOW_ID> = the flow's slug (e.g. OPEN_ACCOUNT) — the "FLOW" heading before each document below.
2. Incremental stimuli between steps MUST be short customer words: english: yes / ok / continue; arabic: نعم / تمام / كمّل.
3. Never invent steps that are not in the source text, and keep every step nearly verbatim from the document.
4. chunk ids: english chunks end with _en; arabic chunks do not. CLOSE chunk per language included only in last step / dump.
5. Respond ONLY with the JSON array block (plus optional short intro line). No markdown fences around the JSON.
`;

function extractDoc(doc: any, slug: string, lang: string): string {
  const parts: string[] = [];
  parts.push(`FLOW: ${slug}  (${lang.toUpperCase()}, file: ${doc.file})`);
  for (const p of doc.paragraphs) parts.push(p);
  for (const t of doc.tables || []) {
    parts.push(`TABLE ${t.table}:`);
    for (const r of t.rows) parts.push(`  - ${r}`);
  }
  return parts.join("\n");
}

function buildBatch(batchIdx: number, entries: any[]): string {
  const lines: string[] = [];
  lines.push(INSTRUCTIONS.replace("${BATCH}", String(entries.length)));
  lines.push("");
  lines.push(`BATCH: ${entries.map((e) => e.slug).join(", ")}`);
  lines.push("");
  for (const e of entries) {
    lines.push(extractDoc(e.ar, e.slug, "ar"));
    lines.push("");
    lines.push(extractDoc(e.en, e.slug, "en"));
    lines.push("");
    lines.push("---");
  }
  return lines.join("\n");
}

function main() {
  if (!fs.existsSync(SOURCES)) {
    console.error(`Missing ${SOURCES} — run extract_sources.py first.`);
    process.exitCode = 1;
    return;
  }
  const sources = JSON.parse(fs.readFileSync(SOURCES, "utf8"));
  const pairs: any[] = sources.pairs || [];
  if (!pairs.length) {
    console.error("No pairs in sources.json — nothing to do.");
    process.exitCode = 1;
    return;
  }

  const flowFilter = (arg("flows", "") || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  const selected = flowFilter.length
    ? pairs.filter((p: any) => flowFilter.includes(p.index))
    : pairs;

  for (const p of selected) p.slug = p.slug || (p.ar && p.ar.slug) || "FLOW";

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest: any[] = [];
  const batchCount = Math.ceil(selected.length / BATCH);
  for (let b = 0; b < batchCount; b++) {
    const batch = selected.slice(b * BATCH, b * BATCH + BATCH);
    const fname = `batch-${String(b + 1).padStart(3, "0")}.md`;
    fs.writeFileSync(path.join(OUT_DIR, fname), buildBatch(b + 1, batch), "utf8");
    manifest.push({ file: fname, flows: batch.map((p: any) => ({ index: p.index, slug: p.slug })) });
  }
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(`Wrote ${batchCount} prompt(s) -> ${OUT_DIR} (from ${selected.length} flows, batch size ${BATCH})`);
  for (const m of manifest) {
    console.log(`  ${m.file}: ${m.flows.map((f: any) => `${f.index}:${f.slug}`).join(", ")}`);
  }
}

main();