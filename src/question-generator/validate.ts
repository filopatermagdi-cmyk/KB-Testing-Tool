/**
 * validate.ts — standalone validator for questions.json
 *
 * Same checks generate.ts runs inline, exposed separately so you can
 * re-validate after manually editing questions.json, or validate a file
 * produced another way.
 *
 * Usage:
 *   npx tsx src/question-generator/validate.ts [path/to/questions.json] [path/to/chunks.json]
 */
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const questionsPath = process.argv[2] || path.join(DATA_DIR, "questions.json");
const chunksPath = process.argv[3] || path.join(DATA_DIR, "chunks.json");

type Question = {
  id: string;
  pair_id: string;
  language: string;
  question: string;
  expected_answer: string;
  source_chunks: string[];
};

// source_chunks may contain EITHER chunk ids (chunk_###, checked against
// chunks.json when it exists) OR free-text KB excerpts. Free text is accepted
// so questions can be generated directly from the KB (e.g. by an external
// model) without relying on the chunker; DeepEval consumes these excerpts as
// retrieval_context.
let validChunkIds: Set<string> | null = null;
if (fs.existsSync(chunksPath)) {
  try {
    const chunks: { id: string }[] = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));
    validChunkIds = new Set(chunks.map((c) => c.id));
  } catch {
    validChunkIds = null;
  }
}

  function main() {
  const questions: Question[] = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));

  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const [i, q] of questions.entries()) {
    const where = `questions[${i}] (${q.id ?? "no id"})`;
    if (!q.id || !/^Q\d+$/.test(q.id)) errors.push(`${where}: invalid id`);
    if (q.id && seenIds.has(q.id)) errors.push(`${where}: duplicate id`);
    if (q.id) seenIds.add(q.id);
    if (!q.pair_id) errors.push(`${where}: missing pair_id`);
    if (q.language !== "en" && q.language !== "ar") errors.push(`${where}: language must be en/ar`);
    if (!q.question?.trim()) errors.push(`${where}: question is empty`);
    if (!q.expected_answer?.trim()) errors.push(`${where}: expected_answer is empty`);
    if (!Array.isArray(q.source_chunks) || q.source_chunks.length === 0) {
      errors.push(`${where}: source_chunks must be a non-empty array`);
    } else {
      for (const cid of q.source_chunks) {
        if (typeof cid !== "string" || !cid.trim()) {
          errors.push(`${where}: source_chunks entries must be non-empty strings`);
        } else if (
          validChunkIds &&
          /^chunk_\d+$/.test(cid.trim()) &&
          !validChunkIds.has(cid.trim())
        ) {
          errors.push(`${where}: unknown source chunk "${cid}"`);
        }
      }
    }
  }

  console.log(`Checked ${questions.length} question(s).`);
  if (errors.length) {
    console.error(`\n${errors.length} problem(s) found:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("All valid.");
}

main();
