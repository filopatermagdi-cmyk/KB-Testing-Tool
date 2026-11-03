# zilla-kb-tool — Tool Guide

> A living guide to how the tool actually works, written from the **code** (not the README,
> which is out of date). Built up section by section; see [Guide status](#guide-status).
> File/line references are to the current source so you can open them and follow along.
>
> Note: `data/TOOL-GUIDE.html` / `.pdf` are an older guide (2026-08-22) that describes the
> original Phase 1–6 pipeline. This file supersedes it.

---

## 1. What the tool is

**zilla-kb-tool is an automated QA robot for Zilla**, intella.me's bank voice agent. It asks
Zilla a large set of known questions (Arabic + English), records every answer, and prepares
those answers for an LLM judge that decides whether each one was correct.

Its purpose is **regression testing**: when the KB, the agent prompt, or the model changes,
re-run and see whether answers got worse.

Zilla can fail in three ways the tool is designed to catch:

| Failure | Meaning |
|---|---|
| Wrong retrieval | pulls the wrong KB section, answers confidently but wrongly |
| Hallucination | adds facts (numbers, steps, limits) that aren't in the KB |
| Deflection | "I don't have details, let me transfer you" when the KB *does* have the answer |

The key design idea: **every question carries its own answer key** — `expected_answer` plus
`source_chunks` (the actual KB text it came from) — so grading can be automated.

## 2. Architecture: a pipeline of independent steps

There is no single long-running "app". The tool is a **chain of separate scripts**; each one
reads files the previous step wrote and writes files for the next. **`data/` is the shared
memory** between steps, and each `npm run <script>` in `package.json` is one step.

Why it's built this way:
- steps are slow / cost money / depend on a live server — a crash in one step doesn't force
  redoing the earlier ones
- every intermediate file can be opened and inspected (great for QA)
- steps can be swapped: the browser runner and the WebSocket runner write the **same output
  format**, so capture / export / dashboard work with either

The **dashboard** (`npm run ui`) is a remote control on top: every button spawns the same
`npm run ...` command you could type in a terminal.

## 3. Tech stack

| Tech | Used for |
|---|---|
| TypeScript on Node.js, run by **`tsx`** | most of the code; `tsx` runs `.ts` directly, no build step (`tsc` is only a type checker here) |
| Python | `.docx` parsing (`python-docx`), evaluation (`deepeval`), tests (pytest-style) |
| `dotenv` | loads `.env` into `process.env` — almost every script calls `dotenv.config()` first |
| `ws` | WebSocket client for the direct/relay runner |
| Playwright | browser automation — CallRunner (real calls), `get-token.ts`, `--auto-token` |
| edge-tts (Python) | text-to-speech for browser-mode audio (`ar-EG-SalmaNeural`, `en-US-JennyNeural`) |
| `node:http` (no framework) | the dashboard server; the frontend is one plain `index.html` |

TypeScript and Python never import each other — they only share JSON files.

External services (configured in `.env`): Zilla staging web app (`APP_URL`), its REST API
(`VITE_API_BASE_URL`), its WebSocket endpoints (`WS_URL`, `RELAY_URL`); LLMs for question
generation (Gemini/OpenAI) and judging (Groq / OpenAI-compatible / Ollama / Gemini).

## 4. Project structure

### Root
| Item | Purpose |
|---|---|
| `package.json` | **list of commands** — start here when lost |
| `.env.example` → `.env` | config template / your real config (git-ignored: holds secrets) |
| `*_qa_testset.json`, `customer_qa_dataset*.json`, `consistency_retest*.json`, … | ready-made question datasets to import |
| `skills/kb-question-generator/SKILL.md` | instructions Claude uses to generate datasets |
| `callrunner/` | vendored browser-call tool (see below) |
| `_probe_*.ts`, `tmp/`, `*.log` | scratch/diagnostic files (git-ignored) |

### `src/` — one folder per pipeline step
```
src/
├── question-generator/   classic path: .docx → chunks → questions (not used in current workflow)
├── kb_flows/             flow path: how-to articles → Claude prompts → flows → question files
├── tts/                  generate_audio.ts: questions → wav/<id>.wav (browser mode only)
├── session-runner/
│   ├── build_sessions.ts          ACTIVE builder (npm run build-sessions)
│   ├── build_multiflow_sessions.ts chain several flows into one call
│   ├── run_sessions.ts            browser mode (spawns callrunner)
│   ├── run_sessions_ws.ts         direct + relay modes (same script)
│   ├── interactive_ws.ts          LLM plays the customer
│   └── get-token.ts               headless login → WS_TOKEN in .env
├── session-builder/      LEGACY builder (not wired to npm) — ignore
├── capture/              capture_answers.ts: run results → captured-answers
├── lib/                  transcript-pairing.ts (shared answer↔question matching)
├── evaluator/            evaluate.py: deflection gate + DeepEval judge + --export
├── agents/, clean.ts     helpers (agent name→id, delete generated outputs)
└── ui/                   server.ts (~18 /api routes) + index.html
```
(`src/src/tts/generate_audio.ts` is a stray old duplicate.)

### `callrunner/` — a project inside the project
CallRunner is an **older, standalone tool** (an E2E smoke test that places a real call through
the Zilla web frontend; it originally lived next to the `zilla-frontend` repo). Making a real
browser call is hard — login, faking the microphone, detecting replies, fetching the saved
transcript — and CallRunner already did it reliably, so it was **vendored** (folder copied in)
instead of rewritten. That's why it has its own `package.json`, `tsconfig.json`, `.gitignore`,
`requirements.txt`, `.env.example`.

`lib/mic-inject.ts` replaces the browser's microphone with the `.wav` clips; `lib/call.ts`
drives the call UI; `e2e.ts` is the entry point.

**Why it runs as a separate process, not an import** (`run_sessions.ts:217`):
1. *Different module systems* — root is ESM (`"type": "module"`), CallRunner is CommonJS and
   uses `__dirname`, which doesn't exist in ESM.
2. *Global config* — `callrunner/lib/config.ts` reads env once at load into module-level
   constants (`CFG`, `ASSETS_DIR`, `OUT_DIR`). Concurrent calls each need different clips,
   output folder, and agent → one process per session = one config per call.
3. *Crash isolation* — each process owns its own Chromium; one hung call fails only its session.

Think of it as a contractor: per session it receives a job sheet (env vars), places one call,
and returns a report (`summary-*.json` + `e2e.log` in `data/runs/<session>/`).

**How config reaches it — the root `.env` is the only one that matters.**
`config.ts:48` does `process.env[key] ??= value`: CallRunner's own `.env` only fills keys that
are *not already set*. The parent passes its whole environment (root `.env`) plus
`ASSETS_DIR`, `OUT_DIR`, `APP_URL`, `ZILLA_EMAIL`, `ZILLA_PASSWORD`, `VITE_API_BASE_URL`,
`ZILLA_AGENT_ID` (AR/EN by session language), `TRACE_FAILED_CALLS=1`, and `--no-interruption`
(`run_sessions.ts:404-415`). In this project `callrunner/.env` doesn't even exist.

Consequence: any CallRunner tunable from `callrunner/.env.example` (`TURN_TIMEOUT_MS`,
`SETTLE_MS`, `CALL_START_MS`, `ARTIFACT_WAIT_MS`, …) can be set in the **root** `.env` to tune
**browser mode**. ⚠ `SETTLE_MS` (CallRunner, browser) ≠ `WS_SETTLE_MS` (WS runner, direct/relay).

**It's a partial copy:** `package.json` scripts reference `prep.ts` / `tts.ts`, which aren't
present (the tool has its own TTS); no `assets/` and no own `node_modules` (packages resolve
from the root `node_modules`); the interruption classifier (`classify_interruptions.py`) is
never used because the runner always passes `--no-interruption`.

### `data/` — the pipeline's shared memory
```
data/
├── questions/manifest.json            index of topics/sub-topics with AR/EN counts
├── questions/<topic>/<sub>.json       imported questions (+ <sub>.chunks.json)
├── sessions/<topic>/<sub>.json        built sessions
├── runs/<session_id>/summary-*.json   one per run of that session
├── runs/run-results-<stamp>.json      aggregate report for one run
├── captured-answers-<stamp>.json      capture output
└── claude-export-<stamp>.json         --export output (what you send to Claude)
```
- Timestamps in names mean **nothing is overwritten** — and "newest file" is the default input
  of the next step.
- A session id like `CarLoan-ar-003` = sub-topic, language, number. Its `runs/` folder keeps
  every run of that session, so the same conversation can be compared across days.
- `.gitignore` quirk: `data/questions/` and `data/sessions/` are ignored, but older files were
  committed before the rule — new datasets won't appear in `git status`.

## 5. The everyday workflow, traced through the code

```
Claude → dataset.json
  ① Import (topic + sub_topic)     POST /api/import        (server does it itself)
  ② Build Sessions                 POST /api/build-sessions → npm run build-sessions
  (browser mode only) Generate Audio → wav/<id>.wav
  ③ Run Sessions (mode)            POST /api/run-sessions  → run-sessions / run-sessions-ws
  ④ Capture answers                auto after ③ only if exit 0 — otherwise run it yourself
  ⑤ Export                         npm run evaluate -- --export → claude-export-<stamp>.json
  ⑥ Claude judges the export
```

### The dashboard pattern (applies to every button)
1. browser `fetch("/api/...")` with form values
2. server converts them to CLI flags and calls `runPhase()` (`src/ui/server.ts:481`), which
   spawns `npm run <script> -- <flags>` (via `cmd.exe /c` on Windows)
3. the child's output is streamed back live; the browser reads it with `res.body.getReader()`

The first log line always shows the exact command (`> npm run ...`) — copy it to reproduce
any dashboard action in a terminal.

### ① Import — `src/ui/server.ts:588-647`
- File may be a plain array, or `{ "questions": [...], "chunks": [...] }`. Only the second
  form enables the broken-reference check.
- Every question must have: `id, pair_id, language, topic, sub_topic, question,
  expected_answer, source_chunks`.
- Rejected (nothing written) on: missing/empty fields, duplicate `id`, or a `chunk_ids` entry
  not found in `chunks`.
- Writes `data/questions/<topic>/<sub_topic>.json` (+ `.chunks.json`), then rebuilds
  `manifest.json` by rescanning every topic folder.
- ⚠ Re-importing the same topic + sub_topic **silently overwrites** the old file.
- `source_chunks` holds the **KB text itself** — that's what the judge sees. `chunk_ids` are
  just ids, validated against `.chunks.json` at import time.

### ② Build Sessions — `src/session-runner/build_sessions.ts:117-165`
Per sub-topic: split AR / EN → shuffle each → cut into groups of `size` → if the last group is
short, **pad it with repeats** of other same-language questions → name sessions
`<SubTopic>-<lang>-<NNN>` → each turn gets `audio_file = wav/<question_id>.wav`.

- "Number of AR/EN sessions" is a **cap** (0 = all); it never creates more sessions than the
  questions allow.
- **No seed = a different shuffle every build.** Use a seed (or `RANDOM_SEED`) to get the same
  sessions again.
- The session file is overwritten on every build.
- Example: `Car Loan.json` = 166 questions (83 AR + 83 EN), `--size 10` → 9 AR + 9 EN
  sessions; the 9th of each has 3 new questions + 7 repeats.

### ③ Run Sessions — the 3 modes (`src/ui/server.ts:727-772`)
| Mode | Script | Difference |
|---|---|---|
| browser (`ui`) | `run_sessions.ts` → `callrunner/e2e.ts` | real browser + real voice call; needs `.wav` files |
| direct (`ws`) | `run_sessions_ws.ts` | connects to `WS_URL` |
| relay | `run_sessions_ws.ts --url $RELAY_URL` | **same code**, different address |

Relay vs direct differ **only in the URL** — if one works and the other doesn't, suspect the
address or token, not the code.

Form fields map to flags: `--file`, `--total-ar/--total-en` (first N sessions per language),
`--concurrent-ar/-en`, `--repeat N` (each repeat gets a `#N` suffix), `--auto-token`.

**Token (direct/relay):** the handshake sends `{agentId, token}` where `token = WS_TOKEN`
(`run_sessions_ws.ts:194`). There is **no fallback** to the token inside the URL path, despite
the code comment. Set `WS_TOKEN` or use `--auto-token` / `AUTO_TOKEN=1`, which logs in and
refreshes it before connecting. `agentId` comes from `ZILLA_AGENT_ID_AR` / `_EN`.

**Concurrency:** a shared sliding pool — in-flight calls never exceed AR cap + EN cap; when
any call finishes, the next waiting session (either language) starts.

**Browser mode:** clips are copied to `data/runs/<id>/clips/` and CallRunner plays them into a
fake microphone. A missing `.wav` fails the session (`run_sessions.ts:335`).

**Output:** `data/runs/<id>/summary-<stamp>.json` per session + `run-results-<stamp>.json`; the
last printed line is `report: <path>`.

### ④ Capture
The dashboard auto-runs `capture-answers --report <that run's report>` **only if the run exits
with code 0**. The WS runner exits 1 if *any* session failed (`run_sessions_ws.ts:996`), so
after a partially failed run capture is skipped — run it manually with `--report`, otherwise
export would pick up an older capture.

### ⑤ Export — `src/evaluator/evaluate.py:614, 744`
`npm run evaluate -- --export` reads the newest (or `--report`) captured file, calls **no
LLM**, and writes `data/claude-export-<same stamp as the capture>.json`. Each record has
`question, expected_answer, zilla_answer, source_chunks, source_file_ids`, latencies,
`turn_type` (`ack` for short "نعم/كمّل" turns) and `deflection_detected` (free pattern check).
The judging instructions (format, PASS/FAIL rules, deflection → FAIL with 0 scores, judge
meaning not MSA-vs-dialect) are **embedded in the file**, so it can be handed to Claude as is.

## 6. WebSocket timing explained

### The problem
Zilla streams its answer **one sentence per frame** (`llm_message_sentence`) and **never sends
a "done" signal**. The runner must decide when an answer is finished — it does that by waiting
for **silence**. Guess too early and the tail of answer N gets glued to question N+1 (every
following answer shifts by one). Guess too late and runs are slow.

### The four settings
| Setting | Current value | Role |
|---|---|---|
| `WS_SETTLE_MS` | 6000 | "answer finished" = this long with **no new frame**. Restarts on **every** frame |
| `WS_CONFIRM_MS` | 500 | extra silence check after settle; if a late sentence arrives, settle again and re-check |
| `WS_TURN_TIMEOUT_MS` | 20000 | safety cap on one waiting phase — if nothing ever arrives, give up ("no reply") |
| `WS_INTER_TURN_MS` | 400 | pause before sending the next question |

### A turn on a timeline (with the values above)
```
t=0.0s   send {"text": question}
t=1.8s   sentence 1 arrives   → latency = 1800 ms; settle countdown starts (6 s)
t=3.0s   sentence 2 arrives   → countdown restarts (6 s from now)
t=4.1s   sentence 3 arrives   → countdown restarts
         ... silence ...
t=10.1s  6 s of silence       → settle done
t=10.6s  0.5 s more silence   → confirmed final; answer = sentences 1+2+3
t=11.0s  0.4 s pause          → send next question
```
The answer finished at 4.1 s but the next question goes out at 11.0 s — about **6.9 s of
waiting per turn** (≈70 s per 10-question session). That's the price of safety.

### What each value protects against
- `WS_SETTLE_MS` must be **longer than the longest pause Zilla takes between two sentences of
  the same answer** (e.g. while it retrieves or thinks mid-answer). A sentence that arrives
  after more than settle + confirm of silence lands in the **next** question's answer.
- Too short → answers cut off / shifted to the wrong question. Too long → slow runs, no
  accuracy gain.
- `WS_TURN_TIMEOUT_MS` is armed when waiting starts and is **not** reset by frames, so one
  waiting phase is capped at 20 s; very long answers are still captured because the confirm
  loop starts a new settle phase whenever more sentences arrive.
- **Latency** in the results = time to the **first** sentence, not to the end of the answer.

### Before the first question
`drainWelcome()` waits for Zilla's greeting to finish (6 s of silence) and discards it. If
Zilla sends no greeting, it waits the full 20 s timeout before question 1.

### Optimization idea (not implemented)
The waiting exists only because there's no end-of-answer signal. If Zilla's backend can confirm
an end-of-answer event, the runner could stop as soon as it arrives instead of waiting 6+ s.
This must be confirmed with the backend team — don't guess the protocol against the live
server.

## 7. Known gotchas (quick list)
- README is outdated (e.g. says the WebSocket runner isn't built) — trust the code.
- Re-import of an existing topic/sub_topic overwrites silently.
- No build seed → different sessions every build → runs aren't directly comparable.
- Run with any failed session → auto-capture skipped → capture manually before export.
- `WS_TOKEN` is required for direct/relay (no URL-token fallback).
- Browser mode needs Generate Audio first.
- `requirements.txt` lacks `edge-tts` (needed for audio).
- Regression tip: regenerating *all* questions after every KB change makes runs hard to
  compare. Keep a stable baseline set (same file + same seed) and add new questions only for
  changed KB content.

---

## Guide status
| # | Section | Status |
|---|---|---|
| 1 | Overview & tech stack | done (§1–3) |
| 2 | Project structure | done (§4) |
| 3 | Application flow (everyday workflow) | done (§5–6) |
| 4 | Code walkthrough (file by file) | to do |
| 5 | Frontend ↔ backend ↔ external services | to do |
| 6 | Core business logic (answer pairing, deflection, judging) | to do |
| 7 | Testing | to do |
| 8 | Running & debugging | to do |
| 9 | Dependencies & integrations | to do |
| 10 | Learning roadmap | to do |
