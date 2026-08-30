// WAV reading for the caller clips. Clips must be mono 16k PCM16 (produced by
// prep.ts); readWavPcm returns the raw PCM16 bytes, validating the format first.
import fs from 'fs';
import path from 'path';
import { SAMPLE_RATE } from './config';

export function readWavPcm(file: string): Buffer {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path.basename(file)}: not RIFF/WAVE`);
  }
  let off = 12;
  let fmt: { audioFormat: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path.basename(file)}: missing fmt/data`);
  if (fmt.audioFormat !== 1 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE || fmt.bits !== 16) {
    throw new Error(
      `${path.basename(file)}: need PCM16 mono ${SAMPLE_RATE}Hz — re-run: npm run prep`,
    );
  }
  return data;
}

export function sortedWav(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => path.extname(f).toLowerCase() === '.wav')
    .sort()
    .map((f) => path.join(dir, f));
}
