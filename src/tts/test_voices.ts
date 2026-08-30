import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const TEST_TEXT = "ما هي أنواع القروض التي يقدمها بنك الاتحاد؟";
const OUT_DIR = "wav-voice-test";

const VOICES: Record<string, string> = {
  "ar-EG-SalmaNeural": "ar-EG-SalmaNeural (مصري)",
  "ar-EG-SalmaNeural-fast": "ar-EG-SalmaNeural (مصري - بطيء)",
  "ar-JO-SanaNeural": "ar-JO-SanaNeural (أردني)",
  "ar-SA-ZariyahNeural": "ar-SA-ZariyahNeural (سعودي)",
  "ar-AE-FatimaNeural": "ar-AE-FatimaNeural (إماراتي)",
  "ar-LB-LaylaNeural": "ar-LB-LaylaNeural (لبناني)",
  "ar-SY-AmanyNeural": "ar-SY-AmanyNeural (سوري)",
  "ar-KW-NourahNeural": "ar-KW-NourahNeural (كويتي)",
};

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "pipe" });
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exit ${c}`))));
    p.on("error", reject);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Also test with rate override
  const entries = Object.entries(VOICES);

  for (let i = 0; i < entries.length; i++) {
    const [voice, label] = entries[i];
    const baseName = voice.replace(/[^a-zA-Z0-9-]/g, "_");
    const mp3 = path.join(OUT_DIR, `${baseName}.mp3`);
    const wav = path.join(OUT_DIR, `${baseName}.wav`);

    const rateArgs = voice.includes("-fast") ? ["--rate", "-20%"] : [];

    console.log(`[${i + 1}/${entries.length}] ${label}...`);

    // edge-tts
    const ttsArgs = ["-m", "edge_tts", "--voice", voice, "--text", TEST_TEXT, "--write-media", mp3, ...rateArgs];
    try {
      await run("python", ttsArgs);
    } catch {
      console.log(`  FAILED to generate MP3 for ${voice}`);
      continue;
    }

    // ffmpeg to WAV PCM16 mono 16kHz
    try {
      await run("ffmpeg", ["-y", "-i", mp3, "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", wav]);
      fs.unlinkSync(mp3);
      console.log(`  ✓ ${wav}`);
    } catch {
      console.log(`  FAILED to convert ${voice}`);
      try { fs.unlinkSync(mp3); } catch {}
    }
  }

  console.log(`\nDone! Listen to files in "${OUT_DIR}/" and compare.`);
  console.log(`Test text: "${TEST_TEXT}"`);
}

main().catch(console.error);
