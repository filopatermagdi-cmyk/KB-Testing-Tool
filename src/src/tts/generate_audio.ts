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

const QUESTIONS_PATH = path.join("data", "questions.json");
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

async function checkDependency(cmd: string, versionArgs: string[], installHint: string) {
  try {
    await runCommand(cmd, versionArgs);
  } catch (err) {
    console.error(`\n[MISSING DEPENDENCY] Could not run "${cmd}".`);
    console.error(installHint);
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
      await runCommand("edge-tts", [
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

function saveQuestions(questions: Question[]) {
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(questions, null, 2), "utf-8");
}

async function main() {
  console.log("Checking dependencies (edge-tts, ffmpeg)...");
  await checkDependency(
    "edge-tts",
    ["--version"],
    "Install with: pip install edge-tts --break-system-packages"
  );
  await checkDependency(
    "ffmpeg",
    ["-version"],
    "Install ffmpeg and make sure it's on your PATH: https://ffmpeg.org/download.html"
  );

  if (!fs.existsSync(QUESTIONS_PATH)) {
    console.error(`No questions file found at ${QUESTIONS_PATH}`);
    process.exitCode = 1;
    return;
  }

  const questions: Question[] = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf-8"));

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const q of questions) {
    const outPath = path.join(OUTPUT_DIR, `${q.id}.wav`).replace(/\\/g, "/");

    if (RESUME && q.audio_file && fs.existsSync(q.audio_file)) {
      skipped++;
      continue;
    }

    console.log(`Generating audio for ${q.id} (${q.language})...`);
    try {
      await synthesize(q, outPath);
      q.audio_file = outPath;
      generated++;
      saveQuestions(questions); // incremental save, same pattern as Phase 1
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