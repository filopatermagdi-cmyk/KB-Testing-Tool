/*
 * clean.ts - reset generated data so you can restart the pipeline from any phase.
 *
 * Usage:
 *   npm run clean -- --from 5        # delete outputs of phases 5..8 (keep questions + wav)
 *   npm run clean -- --from 1        # delete EVERYTHING generated (full reset)
 *   npm run clean -- --dry --from 5  # dry run: list what WOULD be deleted, don't delete
 *
 * Phase outputs (what each phase produces):
 *   1: data/chunks.json
 *   2: data/questions.json
 *   3: (none - validate reads questions.json)
 *   4: wav/
 *   5: data/sessions.json
 *   6: data/runs/
 *   7: data/captured-answers-*.json
 *   8: data/eval-results-*.json + data/eval-stats-*.json
 *
 * "from N" keeps outputs of phases < N and deletes outputs of phases >= N.
 * Inputs (the KB docx / extracted article) are never touched.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const DEL: Record<number, string[]> = {
  1: [
    "data/chunks.json",
    "data/questions.json",
    "wav",
    "data/sessions.json",
    "data/runs",
    "data/captured-answers-*.json",
    "data/eval-results-*.json",
    "data/eval-stats-*.json",
  ],
  2: [
    "data/questions.json",
    "wav",
    "data/sessions.json",
    "data/runs",
    "data/captured-answers-*.json",
    "data/eval-results-*.json",
    "data/eval-stats-*.json",
  ],
  3: [
    "wav",
    "data/sessions.json",
    "data/runs",
    "data/captured-answers-*.json",
    "data/eval-results-*.json",
    "data/eval-stats-*.json",
  ],
  4: [
    "wav",
    "data/sessions.json",
    "data/runs",
    "data/captured-answers-*.json",
    "data/eval-results-*.json",
    "data/eval-stats-*.json",
  ],
  5: [
    "data/sessions.json",
    "data/runs",
    "data/captured-answers-*.json",
    "data/eval-results-*.json",
    "data/eval-stats-*.json",
  ],
  6: [
    "data/runs",
    "data/captured-answers-*.json",
    "data/eval-results-*.json",
    "data/eval-stats-*.json",
  ],
  7: [
    "data/captured-answers-*.json",
    "data/eval-results-*.json",
    "data/eval-stats-*.json",
  ],
  8: ["data/eval-results-*.json", "data/eval-stats-*.json"],
};

function globFiles(pattern: string): string[] {
  const abs = path.join(ROOT, pattern);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const re = new RegExp("^" + base.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function expand(target: string): string[] {
  return target.includes("*") ? globFiles(target) : [path.join(ROOT, target)];
}

function main() {
  let from = 1;
  const idx = process.argv.indexOf("--from");
  if (idx !== -1 && process.argv[idx + 1]) from = parseInt(process.argv[idx + 1], 10);
  const eq = process.argv.find((a) => a.startsWith("--from="));
  if (eq) from = parseInt(eq.split("=")[1], 10);
  const dry = process.argv.includes("--dry");
  if (isNaN(from) || from < 1 || from > 8) {
    console.error("--from must be 1..8 (1 = full reset)");
    process.exit(1);
  }
  const targets = DEL[from];
  const files = [...new Set(targets.flatMap(expand))].sort();
  console.log(`Clean: starting from phase ${from} -> removing outputs of phases ${from}..8`);
  if (!files.length) {
    console.log("Nothing to delete - already clean.");
    return;
  }
  for (const f of files) console.log(`  - ${path.relative(ROOT, f)}`);
  console.log(`${files.length} item(s)`);
  if (dry) {
    console.log("[dry run] nothing deleted.");
    return;
  }
  for (const f of files) fs.rmSync(f, { recursive: true, force: true });
  console.log("Deleted.");
}

main();