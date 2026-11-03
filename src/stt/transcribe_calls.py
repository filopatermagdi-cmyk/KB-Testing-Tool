#!/usr/bin/env python3
"""
Batch transcribe bank call recordings with speaker labels (AGENT / CUSTOMER),
fully online, no heavy local models.

Two-step pipeline per call (both on Groq's free tier):
  1. whisper-large-v3 -> verbatim transcript split into timestamped segments
  2. an LLM turns those segments into speaker turns, cutting wherever the
     speaker changes, while copying the text word-for-word. A text-similarity
     check verifies nothing was paraphrased; if it fails, we fall back to a
     safer per-segment classifier.

The output text is ALWAYS Whisper's exact wording; the LLM only decides who
says what, so nothing is invented.

Each call -> one .txt file (e.g. Calls_Arab_Bank_calls_3.txt):
    AGENT: ...
    CUSTOMER: ...

At the end all .txt files are zipped into one archive.

Usage:
    python src/stt/transcribe_calls.py
    python src/stt/transcribe_calls.py --in <folder> --out <folder>
    python src/stt/transcribe_calls.py --llm qwen/qwen3.8-27b
    python src/stt/transcribe_calls.py --force        # redo even if .txt exists
    python src/stt/transcribe_calls.py --no-zip       # skip the zip step

Resumable: files that already have a non-empty .txt are skipped unless --force.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time
import zipfile
from difflib import SequenceMatcher

from openai import OpenAI

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DEFAULT_IN = r"C:\Users\LOQ\Downloads\Arab_Bank_calls\Arab_Bank_calls"
GROQ_BASE = "https://api.groq.com/openai/v1"

RESEGMENT_PROMPT = """You are given the transcript of a customer-service phone call between a bank AGENT and a CUSTOMER, split into numbered segments. A single segment may contain a change of speaker.

Rewrite the ENTIRE transcript as a sequence of speaker turns. Start a new line EVERY TIME the speaker changes, and label each line with its speaker.

CRITICAL RULES:
- Copy the words EXACTLY as they appear in the segments. Do NOT add, remove, reword, translate, shorten, punctuate differently, or "clean up" ANY text. Keep every hesitation (e.g. ااا, آآ) and every mistake exactly as written.
- The ONLY change you may make is inserting a new line + speaker label at each change of speaker. Concatenating your lines (ignoring the labels) must equal the original transcript word-for-word.
- Every line must begin with exactly "AGENT: " or "CUSTOMER: ".

WHO IS WHO (very important):
- The AGENT is the bank employee: says the bank name ("بنك عربي"), gives their own name as the agent ("فاطمة معك", "معك فاطمة"), asks for the customer's name, account number, ID, birth date, and says things like "كيف بساعدك", "ثواني لحظات", "تحملني", "من قسم الشكاوى", "أي خدمة تانية", "شاكرة اتصالك".
- The CUSTOMER is the caller with the problem: asks "مين معي / مين بيحكلم / مين أنت" (who is this?), describes their issue, answers the verification questions, gives their account number/birth date.

Worked example of the OUTPUT STYLE (this is a DIFFERENT call, just for format):
AGENT: بنك العربي، نور معك، تفضلي.
CUSTOMER: مرحبا، مين معي؟
AGENT: معك نور، كيف بقدر أساعدك؟
CUSTOMER: عندي مشكلة بالرصيد ما عم يظهر.

Now output ONLY the labeled lines for the real transcript, nothing else.

Segments:
{numbered}
"""

CLASSIFY_PROMPT = """You are given the consecutive segments of a customer-service phone call between a bank AGENT and a CUSTOMER, in the order they were spoken.

For EACH segment, decide whether the bank AGENT or the CUSTOMER is speaking.
- The AGENT works for the bank: greets, asks for account/ID verification, asks security questions, says "one moment", "I'll check", "your complaint number", closes the call.
- The CUSTOMER is the one calling with a question or problem.

Return ONLY a JSON array of strings, one element per segment, in the same order as the segments. Each element must be exactly "AGENT" or "CUSTOMER". Do not add any explanation, and do not merge or split segments.

Segments:
{numbered}
"""


def find_env() -> str | None:
    d = ROOT
    for _ in range(4):
        p = os.path.join(d, ".env")
        if os.path.isfile(p):
            return p
        d = os.path.dirname(d)
    return None


def load_env(name: str, default: str | None = None) -> str | None:
    env = find_env()
    if env:
        with open(env, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                if line.split("=", 1)[0].strip() == name:
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get(name, default)


def num_key(path: str) -> int:
    m = re.findall(r"\d+", os.path.basename(path))
    return int(m[-1]) if m else 0


def with_retry(fn, max_retries: int, base_delay: float = 8.0):
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            code = getattr(e, "status_code", None) or getattr(e, "code", None)
            retryable = code in (429, 503) or isinstance(e, (TimeoutError, ConnectionError))
            if not retryable and hasattr(e, "response"):
                retryable = getattr(getattr(e, "response", None), "status_code", None) in (429, 503)
            if not retryable or attempt == max_retries:
                raise
            wait = min(base_delay * (2 ** attempt), 120)
            print(f"      retry in {wait:.0f}s ({attempt + 1}/{max_retries}): "
                  f"{type(e).__name__} {e}", flush=True)
            time.sleep(wait)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def parse_labeled_lines(reply: str):
    """Parse 'AGENT: ...' / 'CUSTOMER: ...' lines -> [(SPEAKER, text)] or []."""
    turns = []
    for line in (reply or "").splitlines():
        line = line.strip()
        if not line:
            continue
        line = re.sub(r"^\d+\.\s*", "", line)
        m = re.match(r"^(AGENT|CUSTOMER|BANK|CALLER)\s*:\s*(.*)$", line, re.IGNORECASE)
        if not m:
            return []  # a non-labelled line means the format broke
        spk = m.group(1).upper()
        spk = "AGENT" if spk in ("AGENT", "BANK") else "CUSTOMER"
        turns.append((spk, m.group(2).strip()))
    return turns if turns else []


def extract_labels(text: str, expected: int) -> list[str]:
    if not text:
        return []
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip()).strip()
    start, end = t.find("["), t.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        arr = json.loads(t[start:end + 1])
    except json.JSONDecodeError:
        return []
    labels = []
    for x in arr:
        s = str(x).strip().upper()
        if s.startswith(("AGENT", "BANK")):
            labels.append("AGENT")
        elif s.startswith(("CUSTOMER", "CALLER")):
            labels.append("CUSTOMER")
        else:
            labels.append("UNKNOWN")
    return labels if len(labels) == expected else []


def build_turns(segments: list[dict], labels: list[str]) -> str:
    lines: list[str] = []
    cur = None
    buf: list[str] = []
    for seg, lab in zip(segments, labels):
        txt = seg.get("text", "").strip()
        if not txt:
            continue
        if lab != cur:
            if buf and cur:
                lines.append(f"{cur}: {' '.join(buf)}")
            cur = lab
            buf = [txt]
        else:
            buf.append(txt)
    if buf and cur:
        lines.append(f"{cur}: {' '.join(buf)}")
    return "\n".join(lines)


def _chat(client, args, prompt, max_tokens=None):
    return with_retry(lambda: client.chat.completions.create(
        model=args.llm,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
        max_tokens=max_tokens or args.max_tokens), args.max_retries)


def _classify_chunk(client, args, chunk) -> list[str]:
    numbered = "\n".join(f"{n}. {s['text']}" for n, s in enumerate(chunk, 1))
    for _ in range(3):
        r = _chat(client, args, CLASSIFY_PROMPT.format(numbered=numbered))
        labels = extract_labels((r.choices[0].message.content or ""), len(chunk))
        if labels:
            return labels
    return ["UNKNOWN"] * len(chunk)


def label_speakers(client, segments, args):
    """Re-segment each chunk at speaker changes (verbatim, verified); classify on failure."""
    size = max(1, args.chunk)
    chunks = [segments[i:i + size] for i in range(0, len(segments), size)]
    all_turns: list[tuple[str, str]] = []
    last_speaker: str | None = None
    used_reseg = False

    for chunk in chunks:
        numbered = "\n".join(f"{n}. {s['text']}" for n, s in enumerate(chunk, 1))
        orig = norm(" ".join(s["text"] for s in chunk))
        ctx = (f"Context: the chunk right before this one ended with the "
               f"{last_speaker} speaking.\n" if last_speaker else "")
        prompt = ctx + RESEGMENT_PROMPT.format(numbered=numbered)

        turns: list[tuple[str, str]] = []
        for _ in range(2):
            r = _chat(client, args, prompt)
            turns = parse_labeled_lines((r.choices[0].message.content or ""))
            if turns:
                rebuilt = norm(" ".join(t for _, t in turns))
                if SequenceMatcher(None, orig, rebuilt).ratio() >= 0.85:
                    break
                turns = []

        if turns:
            used_reseg = True
            all_turns.extend(turns)
            last_speaker = turns[-1][0]
        else:  # fallback: classify this whole chunk
            labels = _classify_chunk(client, args, chunk)
            for s, lab in zip(chunk, labels):
                if s["text"].strip():
                    all_turns.append((lab, s["text"].strip()))
            last_speaker = labels[-1] if labels else last_speaker

    body = "\n".join(f"{spk}: {txt}" for spk, txt in all_turns)
    return body, ("resegment" if used_reseg else "classify")


def main() -> None:
    ap = argparse.ArgumentParser(description="Batch transcribe + label AGENT/CUSTOMER (online, Groq).")
    ap.add_argument("--in", dest="inp", default=DEFAULT_IN)
    ap.add_argument("--out", dest="out", default=None, help="default: <in>/transcripts_final")
    ap.add_argument("--asr", default="whisper-large-v3")
    ap.add_argument("--llm", default="openai/gpt-oss-120b")
    ap.add_argument("--max-tokens", dest="max_tokens", type=int, default=4000,
                    help="cap per LLM call (keep under the model's free-tier TPM)")
    ap.add_argument("--chunk", type=int, default=12,
                    help="segments per LLM request (smaller = safer under TPM limits)")
    ap.add_argument("--delay", type=float, default=6.0)
    ap.add_argument("--max-retries", type=int, default=6)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-zip", action="store_true")
    args = ap.parse_args()

    inp = os.path.abspath(args.inp)
    out = os.path.abspath(args.out) if args.out else os.path.join(inp, "transcripts_final")
    os.makedirs(out, exist_ok=True)

    api_key = load_env("GROQ_API_KEY")
    if not api_key:
        sys.exit("GROQ_API_KEY not found in .env")
    client = OpenAI(api_key=api_key, base_url=GROQ_BASE)

    files = sorted(glob.glob(os.path.join(inp, "*.wav")) + glob.glob(os.path.join(inp, "*.mp3")),
                   key=num_key)
    if not files:
        sys.exit(f"No .wav/.mp3 files found in {inp}")

    total = len(files)
    print(f"{total} audio file(s) -> {out}", flush=True)
    print(f"asr: {args.asr}   llm: {args.llm}   delay: {args.delay}s", flush=True)
    print("-" * 60, flush=True)

    ok = fail = skip = 0
    failed: list[str] = []
    t0 = time.time()

    for i, path in enumerate(files, 1):
        base = os.path.splitext(os.path.basename(path))[0]
        out_path = os.path.join(out, base + ".txt")
        if not args.force and os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
            skip += 1
            print(f"[{i}/{total}] skip (done) {base}.txt", flush=True)
            continue

        start = time.time()
        try:
            with open(path, "rb") as f:
                tr = with_retry(lambda: client.audio.transcriptions.create(
                    model=args.asr, file=f, response_format="verbose_json"), args.max_retries)

            def fld(s, name, default=None):
                return s.get(name, default) if isinstance(s, dict) else getattr(s, name, default)

            segments = [{"text": (fld(s, "text", "") or "").strip()}
                        for s in (fld(tr, "segments", None) or [])
                        if (fld(s, "text", "") or "").strip()]
            if not segments:
                txt = (fld(tr, "text", "") or "").strip()
                if not txt:
                    raise RuntimeError("empty transcript")
                segments = [{"text": txt}]

            body, method = label_speakers(client, segments, args)
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(body)

            dt = time.time() - start
            n_turns = len([l for l in body.splitlines() if l.strip()])
            print(f"[{i}/{total}] OK   {base}.txt  ({len(segments)} segs, "
                  f"{n_turns} turns, {dt:.0f}s, {method})", flush=True)
            ok += 1
        except Exception as e:  # noqa: BLE001
            dt = time.time() - start
            print(f"[{i}/{total}] FAIL {base}  {type(e).__name__}: {e}  ({dt:.0f}s)", flush=True)
            failed.append(base)
            fail += 1

        if i < total and args.delay:
            time.sleep(args.delay)

    elapsed = (time.time() - t0) / 60
    print("-" * 60, flush=True)
    print(f"done: {ok} ok, {fail} failed, {skip} skipped  ({elapsed:.1f} min)", flush=True)
    if failed:
        print("failed: " + ", ".join(failed), flush=True)

    if not args.no_zip:
        zip_path = os.path.join(inp, "Arab_Bank_calls_transcripts.zip")
        txts = sorted(glob.glob(os.path.join(out, "*.txt")), key=num_key)
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for t in txts:
                z.write(t, arcname=os.path.basename(t))
        print(f"zip -> {zip_path}  ({len(txts)} file(s))", flush=True)


if __name__ == "__main__":
    main()
