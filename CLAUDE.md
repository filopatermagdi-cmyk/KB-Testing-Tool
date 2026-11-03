# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Automated KB regression tester for Zilla (intella.me's Arabic/English bank voice agent). It plays known questions to live Zilla agents, records the answers, and prepares them for an LLM judge. **`README.md` is stale** (e.g. says the WebSocket runner isn't built) — trust the code. `TOOL-GUIDE.md` is the up-to-date explanation of how things work; `data/TOOL-GUIDE.html/.pdf` is an older version.

## Commands

No build step: TypeScript runs directly via `tsx` (`tsc` is only a type checker).

```bash
npm install && npx playwright install chromium     # Node deps + browser for browser mode
pip install -r requirements.txt edge-tts           # requirements.txt lacks edge-tts (needed for audio)

npx tsc --noEmit                                   # type check (src/ only; callrunner/ has its own tsconfig)
python -m pytest tests                             # all tests (only tests/test_deflection.py exists)
python -m pytest tests/test_deflection.py::TestIsDeflectionArabic::test_ma_andi_tafaseel   # one test

npm run ui                                         # dashboard at http://127.0.0.1:5173 (next free port if busy)
npm run build-sessions -- --topic Loan --subtopic "Car Loan" --size 10 --ar-sessions 3 --en-sessions 3 --seed 7
npm run generate-audio -- --only "Car Loan.json"   # wav/<question_id>.wav, needed only for browser mode
npm run run-sessions-ws -- --file "data/sessions/Loan/Car Loan.json" [--url $RELAY_URL] [--auto-token]
npm run run-sessions    -- --file "data/sessions/Loan/Car Loan.json" --headed      # browser mode
npm run capture-answers -- --report data/runs/run-results-<stamp>.json
npm run evaluate -- --export                       # writes data/claude-export-<stamp>.json, no LLM calls
npm run clean -- --dry --from 5                    # preview deleting generated outputs of phase 5+
```

## Architecture

**A pipeline of independent scripts that communicate only through files in `data/`.** Each `npm run` script is one step; TypeScript and Python never import each other. Timestamped outputs are never overwritten, and each step defaults to the *newest* output of the previous step (pass `--report` to pin one).

The primary workflow (the user's actual usage; `src/question-generator/` and `src/session-builder/` are the legacy path):

1. **Import** — `POST /api/import` in `src/ui/server.ts` (done inline, no script) validates required fields `id, pair_id, language, topic, sub_topic, question, expected_answer, source_chunks`, duplicate ids, and `chunk_ids` against optional `chunks`; writes `data/questions/<topic>/<sub_topic>.json` (+ `.chunks.json`) and rebuilds `data/questions/manifest.json`. Silently overwrites an existing sub_topic. `source_chunks` holds KB **text** (what the judge sees); `chunk_ids` are just ids.
2. **Build** — `src/session-runner/build_sessions.ts` (the active builder): per sub-topic, split AR/EN, shuffle (mulberry32 if seeded, else random), slice into `--size` groups, pad the short last group with repeats. `--ar-sessions/--en-sessions` are caps (0 = all). Session ids: `<SubTopicNoSpaces>-<lang>-<NNN>`.
3. **Run** — three dashboard modes in `server.ts` `/api/run-sessions`: `ui` → `run_sessions.ts` (browser), `ws` (direct) → `run_sessions_ws.ts`, `relay` → **the same `run_sessions_ws.ts` with `--url $RELAY_URL`**. Both runners write the same shape (`data/runs/<session_id>/summary-<stamp>.json` + `data/runs/run-results-<stamp>.json`, last stdout line `report: <path>`) so downstream steps don't care which ran.
4. **Capture** — `src/capture/capture_answers.ts` pairs questions with answers (via `src/lib/transcript-pairing.ts`, content-based alignment because STT splits/garbles utterances) and joins expected answers/source chunks from the question files.
5. **Export/evaluate** — `src/evaluator/evaluate.py`: a regex deflection gate (`is_deflection`, the subject of the tests) runs before any LLM; `--export` dumps judge payloads with embedded judging instructions for Claude to grade; otherwise DeepEval metrics via the `EVAL_LLM_PROVIDER` judge.

### Dashboard
`src/ui/server.ts` is plain `node:http` (no framework); `src/ui/index.html` is the entire frontend. Nearly every button calls `runPhase()`, which spawns `npm run <script> -- <flags>` (via `cmd.exe /c` on Windows) and streams stdout back. After a run it auto-chains `capture-answers --report <that run>` **only if the run exited 0** — the WS runner exits 1 if any session failed, so capture is then skipped.

### WebSocket runner (`run_sessions_ws.ts`)
Handshake `{agentId, token}` then `{type:"session", sessionId}`; each turn sends `{"text": question}`. `token` is **only** `WS_TOKEN` (no fallback to the token in the `WS_URL` path despite the comment); `--auto-token`/`AUTO_TOKEN=1` logs in via Playwright to refresh it. Zilla streams `llm_message_sentence` frames with **no end-of-answer signal**, so a turn ends after `WS_SETTLE_MS` of silence (timer reset on every frame), then a `WS_CONFIRM_MS` re-check loop prevents a late tail of answer N bleeding into N+1; `WS_TURN_TIMEOUT_MS` caps each wait. Latency = time to first frame. A welcome message is drained before turn 1. Sessions run in a sliding pool capped at concurrent-AR + concurrent-EN.

### CallRunner (`callrunner/`)
A vendored, partially copied standalone E2E tool (CommonJS, own `package.json`/`tsconfig.json`, no own `node_modules`). `run_sessions.ts` **spawns** `callrunner/e2e.ts` once per session (it can't be imported: CJS vs ESM, and `lib/config.ts` holds env-derived module-level globals) with `ASSETS_DIR=data/runs/<id>/clips`, `OUT_DIR=data/runs/<id>`, Zilla credentials, and `ZILLA_AGENT_ID`. `config.ts` uses `process.env[k] ??= v`, so the **root `.env` wins**; `callrunner/.env` is only a fallback. CallRunner tunables (`TURN_TIMEOUT_MS`, `SETTLE_MS`, `CALL_START_MS`, …) can be set in the root `.env` — not to be confused with the WS runner's `WS_*` settings. Browser mode fails a session if a turn's `wav/<id>.wav` is missing.

### Other entry points
- `src/kb_flows/` — alternative question source for step-by-step how-to articles: `.docx` → Claude prompts → `data/flows/KnowledgeHub/*.unified.json` → `data/questions/KnowledgeHub/<Title>-{Incremental,FullDump}_{AR,EN}.json`; `build_multiflow_sessions.ts` chains flows into one call.
- `src/session-runner/interactive_ws.ts` — an LLM (Ollama Qwen or Groq) plays the customer over the WS protocol.
- `src/agents/agents.ts` and `get-token.ts` **rewrite `.env`** (agent ids / `WS_TOKEN`).

## Gotchas

- Many env vars and CLI flags used in code aren't in `.env.example` (e.g. `WS_TOKEN`, `RELAY_URL`, `AUTO_TOKEN`, `MIN_FREE_RAM_GB`, `LAUNCH_STAGGER_MS`, `TTS_*`); grep `process.env` / `arg("` in the relevant file.
- `data/questions/`, `data/sessions/`, `data/runs/`, captures/exports, `wav/`, and `*.docx` are git-ignored (captures and KB docs are sensitive), but some older question/session files were committed before the rule.
- `src/src/tts/generate_audio.ts` is a stray duplicate; edit `src/tts/generate_audio.ts`.
- Don't probe the live Zilla WS/auth endpoints with guessed token/URL combinations — confirm the protocol with the backend team first.
