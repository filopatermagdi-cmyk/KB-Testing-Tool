import fs from "fs";
import path from "path";
import { spawn } from "child_process";
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

const QUESTIONS_DIR = path.join("data", "questions");
const OUTPUT_DIR = process.env.TTS_OUTPUT_DIR || "wav";
const RESUME = (process.env.TTS_RESUME ?? "true").toLowerCase() !== "false";
const REQUEST_DELAY_MS = parseInt(process.env.TTS_REQUEST_DELAY_MS || "0", 10);
const MAX_RETRIES = parseInt(process.env.TTS_MAX_RETRIES || "3", 10);

// Arabic voice matches CallRunner's already-verified choice (6/6 in their tests).
// English voice is a reasonable edge-tts default; override via .env if you have a preference.
const VOICE_BY_LANG: Record<string, string> = {
  ar: process.env.EDGE_TTS_VOICE_AR || "ar-EG-SalmaNeural",
  en: process.env.EDGE_TTS_VOICE_EN || "en-US-JennyNeural",
};

// Call edge-tts via "python -m edge_tts" instead of the bare "edge-tts" command.
// On Windows, pip-installed console scripts often aren't on PATH even though
// the "python" command itself is (which is why "pip install" succeeds but a
// bare "edge-tts" spawn fails with ENOENT). Going through python sidesteps that.
const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function collectAllQuestions(onlyFile?: string): Question[] {
  const questions: Question[] = [];
  
  // Walk through all topic folders
  const topics = fs.readdirSync(QUESTIONS_DIR).filter(f => 
    fs.statSync(path.join(QUESTIONS_DIR, f)).isDirectory()
  );

  // Support passing a full relative path like "questions/Loan/Car Loan.json"
  // (covering any leading "data/" or "questions/" prefix) in addition to the
  // legacy bare file name. The UI sends the full topic/file path.
  let onlyAsSubPath: string | null = null;
  if (onlyFile) {
    const normalized = onlyFile.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
    const noDataPrefix = normalized.replace(/^data\//, "");
    const noQPrefix = noDataPrefix.replace(/^questions\//, "");
    if (noQPrefix.includes("/")) onlyAsSubPath = noQPrefix;
  }
  
  for (const topic of topics) {
    const topicDir = path.join(QUESTIONS_DIR, topic);
    const jsonFiles = fs.readdirSync(topicDir).filter(f => f.endsWith('.json') && !f.endsWith('.chunks.json'));
    
    for (const jsonFile of jsonFiles) {
      const filePath = path.join(topicDir, jsonFile);

      if (onlyAsSubPath) {
        // Full path given: match only the exact "<topic>/<file>.json".
        const rel = `${topic}/${jsonFile}`.toLowerCase().replace(/\\/g, "/");
        if (rel !== onlyAsSubPath) continue;
      } else if (onlyFile) {
        // Windows filenames are case-insensitive, so compare everything
        // lowercased, tolerate stray quotes, and auto-append ".json" when the
        // user only typed the base name ("Loans Gen" -> "Loans Gen.json").
        const clean = onlyFile.replace(/^["']|["']$/g, "").trim();
        const withExt = clean.toLowerCase().endsWith(".json") ? clean : `${clean}.json`;
        const target = withExt.toLowerCase().replace(/\\/g, "/");

        const rel = path.join(topic, jsonFile).replace(/\\/g, "/").toLowerCase();
        const base = path.basename(jsonFile).toLowerCase();
        const baseOnly = base.replace(/\.json$/, "");
        const filePathLower = filePath.toLowerCase();

        const matches = filePathLower === target
          || base === target
          || base === path.basename(target)
          || baseOnly === path.basename(target, path.extname(target))
          || rel === target
          || rel.endsWith(`/${target}`)
          || target.endsWith(`/${rel}`);
        if (!matches) continue;
      }

      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      questions.push(...data);
    }
  }
  
  return questions;
}

async function checkDependency(cmd: string, versionArgs: string[], installHint: string) {
  try {
    await runCommand(cmd, versionArgs);
  } catch (err) {
    console.error(`\n[MISSING DEPENDENCY] Could not run "${cmd}".`);
    console.error(installHint);
    throw err;
  }
}

async function checkEdgeTts() {
  try {
    await runCommand(PYTHON_CMD, ["-c", "import edge_tts"]);
  } catch (err) {
    console.error(`\n[MISSING DEPENDENCY] Could not import edge_tts via "${PYTHON_CMD}".`);
    console.error("Install with: pip install edge-tts --break-system-packages");
    console.error(`If "${PYTHON_CMD}" isn't your Python, set PYTHON_CMD in .env (e.g. PYTHON_CMD=py).`);
    throw err;
  }
}

async function synthesize(question: Question, outPath: string) {
  const voice = VOICE_BY_LANG[question.language];
  if (!voice) {
    throw new Error(`No voice configured for language "${question.language}"`);
  }

  const tmpMp3 = outPath.replace(/\.wav$/, ".mp3");

  let attempt = 0;
  while (true) {
    try {
      // 1. edge-tts generates mp3/opus (it does NOT produce raw WAV natively)
      await runCommand(PYTHON_CMD, [
        "-m", "edge_tts",
        "--voice", voice,
        "--text", question.question,
        "--write-media", tmpMp3,
      ]);

      // 2. Convert to real WAV via ffmpeg (mic-injection needs actual WAV clips,
      //    per the handoff's mic-injection description)
      await runCommand("ffmpeg", [
        "-y",
        "-i", tmpMp3,
        "-ar", "16000",
        "-ac", "1",
        outPath,
      ]);

      fs.unlinkSync(tmpMp3);
      return;
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES) throw err;
      console.warn(`  retry ${attempt}/${MAX_RETRIES} for ${question.id}: ${(err as Error).message}`);
      await sleep(1000 * attempt);
    }
  }
}

// npm on Windows runs scripts through cmd.exe, which often strips the quotes
// around `--only "Car Loan.json"` and turns it into `--only Car Loan.json`
// (two argv tokens). Since --only is the only flag, join everything after it
// back together so file names with spaces always work.
function parseOnlyFile(argv: string[]): string | undefined {
  const eq = argv.find((a) => a.startsWith("--only="));
  if (eq) return eq.slice("--only=".length);

  const idx = argv.indexOf("--only");
  if (idx >= 0) {
    const rest = argv.slice(idx + 1).join(" ");
    return rest || "";
  }
  return undefined;
}

async function main() {
  console.log("Checking dependencies (edge-tts, ffmpeg)...");
  await checkEdgeTts();
  await checkDependency(
    "ffmpeg",
    ["-version"],
    "Install ffmpeg and make sure it's on your PATH: https://ffmpeg.org/download.html"
  );

  const onlyFile = parseOnlyFile(process.argv);

  const questions = collectAllQuestions(onlyFile);
  
  if (questions.length === 0) {
    console.error(`No questions found in ${QUESTIONS_DIR}${onlyFile ? ` for --only "${onlyFile}"` : ""}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Found ${questions.length} questions${onlyFile ? ` (from ${onlyFile})` : ""}`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const q of questions) {
    const outPath = path.join(OUTPUT_DIR, `${q.id}.wav`).replace(/\\/g, "/");

    if (RESUME && fs.existsSync(outPath)) {
      skipped++;
      continue;
    }

    console.log(`Generating audio for ${q.id} (${q.language})...`);
    try {
      await synthesize(q, outPath);
      generated++;
    } catch (err) {
      console.error(`  FAILED ${q.id}: ${(err as Error).message}`);
      failed++;
    }

    if (REQUEST_DELAY_MS > 0) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log(`\nDone. Generated: ${generated}, Skipped (resume): ${skipped}, Failed: ${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});