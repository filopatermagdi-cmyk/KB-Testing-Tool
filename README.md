# zilla-kb-tool

Automated regression testing for Zilla's Knowledge Base. Standalone project —
not a copy of CallRunner, but reuses one proven piece of its logic (KB
chunking) and follows the same `.env` conventions.

**Status: Phases 1–5 built and verified (KB parsing, question generation, TTS,
session builder, session runner, response capture); Phase 6 (DeepEval)
added.

## What Phase 1 does

```
spl_kb.docx
    |
    v
extract_chunks.py   ->  data/chunks.json   (paragraphs + table rows, with ids)
    |
    v
generate.ts          ->  data/questions.json (question + expected_answer + source_chunks)
```

1. **`extract_chunks.py`** reads the KB `.docx` and splits it into addressable
   chunks — one per paragraph, one per table row (deduplicated). This is the
   same approach CallRunner's `evaluate.py` already uses for its faithfulness
   check, extended with a stable `chunk_NNN` id, a detected language, and a
   `group` (which table a row came from — used below).

2. **`generate.ts`** reads those chunks and asks an LLM to write one realistic
   question + grounded answer per chunk (or, for **combined** questions, per
   pair of rows from the *same table* — the KB's own structure already marks
   those as topically related). When both `GENERATE_ENGLISH` and
   `GENERATE_ARABIC` are on (the default), **every selected chunk produces
   both an Arabic and an English version of the same question** — not
   different chunks split across languages — linked by a shared `pair_id`.
   Output is validated and written to `data/questions.json`.

## Setup

**Requirements:** Node.js 18+, Python 3.9+.

```bash
npm install
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` and set `GEMINI_API_KEY` (question generation needs an LLM to
turn KB facts into natural questions). By default this uses **Google Gemini's
free tier** — get a key at https://aistudio.google.com, no credit card
required. If you'd rather use OpenAI instead (same `OPENAI_API_KEY`
convention CallRunner's `evaluate.py` already uses, but paid), set
`LLM_PROVIDER=openai` in `.env`.

Place your KB file as `spl_kb.docx` in the project root (a copy is already
included from the reference repo for this first run).

## Run it

```bash
# Step 1: parse the KB into chunks (fast, offline, no API key needed)
npm run extract-chunks

# Step 2: generate a small sample of questions (needs OPENAI_API_KEY)
npm run generate-questions

# Step 3 (optional, generate-questions already runs this inline):
npm run validate-questions
```

## What you should see

**`npm run extract-chunks`** (verified working against the real KB — 202
chunks: 26 paragraphs + 176 table rows, mostly Arabic):
```
Extracted 202 chunk(s) -> data/chunks.json
  by language: {'ar': 201, 'en': 1}
  by type: paragraph=26, table_row=176
```

**`npm run generate-questions`** (needs your real `GEMINI_API_KEY` — this
part talks to Google's API, so I can't run it for you; run it locally and
share `data/questions.json` so we can check the actual output together):
```
Generating 3 question(s) x 2 language(s) = 6 total, from 202 chunk(s)...
  [1/6] standalone (ar) <- chunk_002 ... ok
  [2/6] standalone (en) <- chunk_002 ... ok
  [3/6] combined (ar) <- chunk_027, chunk_028 ... ok
  [4/6] combined (en) <- chunk_027, chunk_028 ... ok
  [5/6] standalone (ar) <- chunk_003 ... ok
  [6/6] standalone (en) <- chunk_003 ... ok

Validation OK.
Wrote 6 question(s) -> data/questions.json
```

Note `SAMPLE_SIZE` (default 5) counts **KB chunks selected**, not final
questions — with both languages on, `SAMPLE_SIZE=5` yields 10 questions
(5 bilingual pairs). Set `SAMPLE_SIZE=3` if you want a smaller first look.

## Generating from a whole (possibly large) KB

Don't try to guess a "right" number of questions up front. Set:

```
SAMPLE_SIZE=all
```

and it generates one question (per enabled language) for every usable chunk
in the KB — small KB or large, you don't need to pick a number. This is safe
to run on a big knowledge base because it's:

- **Resumable** — re-running with `SAMPLE_SIZE=all` skips any chunk+language
  combo already in `data/questions.json`, so a crash, an interrupted run, or
  hitting a rate limit partway through just means "run it again." Set
  `RESUME=false` to force a clean regeneration instead.
- **Paced** — `REQUEST_DELAY_MS` waits between calls so a large run doesn't
  blow through a free-tier rate limit. Gemini's free tier is roughly 15
  requests/minute for Flash — for a large KB, set `REQUEST_DELAY_MS=4000` to
  stay comfortably under that.
- **Retried** — a 429 (rate limited) response is retried with backoff
  automatically (`MAX_RETRIES`, default 5) instead of failing the whole run.
- **Saved incrementally** — `data/questions.json` is rewritten after every
  successful question, not just at the end, so an interruption doesn't lose
  what was already generated.

I verified all of this with a mocked LLM (no real API calls) against a small
fake chunk set: a fresh run with `SAMPLE_SIZE=all` generated everything; an
identical re-run correctly skipped all of it (0 calls); and enabling a
second language on a third run generated only the missing language for each
chunk, reusing the same `pair_id` to link back to the question already
generated. Output for a 3-chunk / 1-language test run:
```
4 chunk(s) selected (all) from 3 total. 4 question(s) to generate now.
  [1/4] standalone (en) <- chunk_001 ... ok
  [2/4] combined (en) <- chunk_002, chunk_003 ... ok
  [3/4] standalone (en) <- chunk_002 ... ok
  [4/4] standalone (en) <- chunk_003 ... ok
```
Re-running with the same config: `4 already fully generated — skipping. 0
question(s) to generate now.`

For your **next, larger KB**: same workflow — `SAMPLE_SIZE=all`, set
`REQUEST_DELAY_MS` based on whichever provider's rate limit applies, and let
it run. If it's big enough that a single terminal run would take a long
time, that's expected and fine — it saves progress as it goes, so you can
stop and resume anytime.

I dry-ran the full pipeline with a mocked LLM response (verified for both
Gemini's and OpenAI's response shapes) to confirm the wiring — chunk
selection, the standalone/combined mix, bilingual pairing (same chunk, both
languages, shared `pair_id`), id assignment, and schema validation — is
correct end-to-end. That produced exactly the shape shown above and passed
validation. The only part I couldn't run myself is the real LLM call, since
that needs your API key and network access I don't have here.

## Output shape (`data/questions.json`)

```json
[
  {
    "id": "Q001",
    "pair_id": "P001",
    "language": "ar",
    "question": "...",
    "expected_answer": "...",
    "source_chunks": ["chunk_002"]
  },
  {
    "id": "Q002",
    "pair_id": "P001",
    "language": "en",
    "question": "...",
    "expected_answer": "...",
    "source_chunks": ["chunk_002"]
  }
]
```

`Q001` and `Q002` above are the **same underlying question** — same
`pair_id`, same `source_chunks` — just in different languages. Use `pair_id`
whenever you want to look at, or later compare, the two language versions of
one question side by side.

`source_chunks` with more than one id marks a **combined** question — one
that needs multiple KB chunks to answer correctly. This is what later phases
use to check the answer against the right KB context.

## Config (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `gemini` | `gemini` (free) or `openai` (paid) |
| `GEMINI_API_KEY` | — | required if `LLM_PROVIDER=gemini` — free at aistudio.google.com |
| `GEMINI_MODEL` | `gemini-3.6-flash` | |
| `OPENAI_API_KEY` | — | required if `LLM_PROVIDER=openai` |
| `OPENAI_MODEL` | `gpt-4o-mini` | same model CallRunner's evaluator uses |
| `SAMPLE_SIZE` | `5` | how many KB chunks to select, or `all` (see above) |
| `GENERATE_ENGLISH` | `true` | include English questions |
| `GENERATE_ARABIC` | `true` | include Arabic questions |
| `RESUME` | `true` | skip chunk+language combos already generated |
| `REQUEST_DELAY_MS` | `0` | pause between LLM calls — raise for large runs |
| `MAX_RETRIES` | `5` | retries for a rate-limited (429) call |

Note: `RANDOM_SEED`, `TOTAL_SESSIONS`, `MESSAGES_PER_SESSION`, etc. are **not**
here on purpose — those belong to the session-builder phase, not this one.

## Project layout (Phase 1 only)

```
zilla-kb-tool/
├── src/question-generator/
│   ├── extract_chunks.py   # KB .docx -> data/chunks.json
│   ├── generate.ts         # data/chunks.json -> data/questions.json
│   └── validate.ts         # standalone schema check for questions.json
├── data/
│   ├── chunks.json         # intermediate: already generated from the real KB
│   └── questions.json      # generated by you (needs OPENAI_API_KEY)
├── spl_kb.docx
├── requirements.txt
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

No `tts/`, `sessions/`, `runners/`, `evaluator/`, or `dashboard/` yet —
those are later phases, not built until this one is verified.

## Phase 4A — Session runner (UI)

Runs each session in `data/sessions.json` as a real Zilla call through the
deployed frontend, by reusing CallRunner as a subprocess (the same reuse
pattern as `stress.ts`) — no framework duplication. See
`src/session-runner/run_sessions.ts`.

Scheduling is configured in `.env` (no flags needed):

```dotenv
CONCURRENCY=10            # total calls in flight (when per-language not set)
CONCURRENT_AR=4           # max Arabic calls at once
CONCURRENT_EN=6           # max English calls at once
```

Set `CONCURRENT_AR`/`CONCURRENT_EN` to keep an exact AR/EN mix in flight at all
times (example above = 10 calls at once = 4 ar + 6 en, refilling in waves until
all sessions are done). With only `CONCURRENCY` set, languages mix freely.

`RESHUFFLE=true` re-randomizes the question order inside every session on each
run (no rebuild); `RESHUFFLE=false` (default) plays sessions exactly as the
seeded builder produced them.

`SHUFFLE_SESSIONS=true` randomizes *which* sessions run and in what order each
run (so repeated runs exercise different sessions, not always 1,2,3...).
`SESSIONS_PER_RUN=N` runs only N sessions this run (a random pick when
`SHUFFLE_SESSIONS` is on); 0 = run all.

### Config glossary

| Setting | What it controls |
|---|---|
| `MESSAGES_PER_SESSION` | session size — how many questions per call |
| `TOTAL_SESSIONS_AR` / `TOTAL_SESSIONS_EN` | how many calls per agent (built into `sessions.json`) |
| `RANDOM_SEED` | build-time draw — which questions land in which session + their order (change + rebuild for new groupings) |
| `CONCURRENCY` | in-flight cap when per-language budgets aren't set |
| `CONCURRENT_AR` / `CONCURRENT_EN` | in-flight caps per language (keeps e.g. 4 ar + 6 en at once) |
| `SHUFFLE_SESSIONS` | randomize which sessions run and their run order |
| `SESSIONS_PER_RUN` | how many sessions this run (random pick when shuffled) |
| `RESHUFFLE` | randomize the question order *inside* each session each run |

```bash
npm run run-sessions                                  # all sessions, per .env config
npm run run-sessions -- --sessions S001_ar,S002_en    # only these sessions
npm run run-sessions -- --concurrency 2               # override concurrency for this run
npm run run-sessions -- --headed                      # show the browser
npm run clean -- --from 5                             # delete outputs of phases 5..8,
                                                      # keep questions + wav (restart from phase 5)
npm run clean -- --dry --from 5                       # preview what it would delete
```

Per session it stages the session's `.wav` clips into
`data/runs/<session_id>/clips/`, spawns CallRunner's `e2e.ts` with
`ASSETS_DIR`/`OUT_DIR`/`ZILLA_AGENT_ID` set, and collects the resulting
`summary-*.json` + `e2e.log`. An aggregate report is written to
`data/runs/run-results-<stamp>.json`.

CallRunner is **vendored** in `./callrunner` (its source was copied from the
reference repo, unchanged) — the tool is fully self-contained and needs no
external copy. It needs one install first:

```bash
npm install                    # installs playwright (and the rest)
npx playwright install chromium   # downloads the browser binary once
```

The runner picks the agent per session's language via `ZILLA_AGENT_ID_AR` /
`ZILLA_AGENT_ID_EN` (or each session's `agent_id`); if unset it warns and
CallRunner uses the account's first agent. Zilla connection settings
(`APP_URL`, `ZILLA_EMAIL`, `ZILLA_PASSWORD`, `VITE_API_BASE_URL`) are read
from this project's `.env` and forwarded to CallRunner.

## Phase 5 — Response capture

Turns the raw run artifacts into a clean per-question dataset ready for
evaluation (DeepEval in Phase 6):

```bash
npm run capture-answers                                # newest run report
npm run capture-answers -- --report data/runs/run-results-<stamp>.json
```

Output: `data/captured-answers-<stamp>.json` — one record per turn with:

| Field | DeepEval mapping |
|---|---|
| `question` | `input` |
| `zilla_answer` | `actual_output` (the agent's answer from the call transcript) |
| `expected_answer` | `expected_output` (the KB answer) |
| `source_chunks` | `retrieval_context` (KB chunks the question was generated from) |
| `latency_ms` | timing |

Each record also carries `session_id`, `language`, `agent_id`,
`conversation_id`, `call_url` for traceability.

## Phase 6 — Answer evaluation (DeepEval)

Scores every captured answer with an LLM judge against the KB. Requires
`pip install -r requirements.txt` (adds `deepeval` + `google-genai`).

```bash
npm run evaluate                                 # newest captured file, all metrics
npm run evaluate -- --sample 5                   # quick check on first 5 turns
npm run evaluate -- --metrics relevancy,faithfulness,correctness
npm run evaluate -- --no-llm                     # stats only (no judge calls)
```

Metrics (threshold 0.5, adjust with `--threshold`):

| Metric | What it checks |
|---|---|
| `relevancy` (AnswerRelevancy) | is the agent's answer on-topic for the question? |
| `faithfulness` (Faithfulness) | is the answer grounded in the KB `source_chunks`? |
| `correctness` (GEval) | does the answer match the expected KB answer? |

The judge is configured in `.env`:

```dotenv
EVAL_LLM_PROVIDER=openai      # or ollama (local/free) or gemini
EVAL_MODEL=qwen/qwen3.6-27b   # Groq model id (free) - or your Ollama model
EVAL_LLM_BASE_URL=https://api.groq.com/openai/v1   # Groq's free endpoint
```

`gemini` reuses `GEMINI_API_KEY`, `openai` uses `OPENAI_API_KEY` /
`GROQ_API_KEY` (with `EVAL_LLM_BASE_URL` pointing at Groq or any
OpenAI-compatible API), and `ollama` needs no key at all — it talks to your
local Ollama (`http://localhost:11434/v1`) after `ollama pull <model>`.
Note: Gemini's **free tier** is limited (roughly 20 requests/day/model), and
Groq's free tier rate-limits per-minute — both are fine for small samples;
the script retries transient 429s with backoff and keeps going per-record so
one failure doesn't kill the run.

Output: `data/eval-results-<stamp>.json` — per-record metric scores, pass/fail
and reasons, plus a summary broken down overall and by language.

## Agents — switch the Zilla agent by name, no code edits

The runner talks to the agents listed in `.env` (`ZILLA_AGENT_ID_AR` /
`ZILLA_AGENT_ID_EN`). Instead of editing code to switch agents, put the agent
**name** in `.env` and resolve it once:

```bash
npm run agents                              # list agents + resolve names
npm run agents -- --list                    # just list, don't touch .env
npm run agents -- --json                    # machine output (JSON on stdout)
```

It logs in to Zilla (same UI login CallRunner uses), fetches your agent list
via `GET /agent`, and if `ZILLA_AGENT_AR` / `ZILLA_AGENT_EN` (names) are set,
matches each against the list and rewrites `ZILLA_AGENT_ID_AR` / `_EN` to the
resolved ids automatically. Same workflow is available in the Dashboard's
**Agents** panel (load the list, pick from dropdowns, save).

## Dashboard (UI)

A local web dashboard that drives the whole pipeline by hand — configure every
`.env` value (with hover tooltips explaining each one), run any phase or a
sequence automatically, then watch every call play back (question → Zilla's
answer) with per-turn DeepEval metrics, the call link, and Zilla's latency.

```bash
npm run ui          # starts http://127.0.0.1:5173 and opens the browser
```

No extra install — pure Node stdlib, so anyone who clones the project just
needs the existing `npm install`. Custom port: `UI_PORT=8080 npm run ui`.

Sections:
- **Status** — counts (questions / audio / sessions) + last run / captured / eval.
- **Agents** — load the Zilla agent list, pick the Arabic/English agent, save
  to `.env` (or type names in `.env` and run `npm run agents`).
- **Phases** — run any phase alone (with optional extra args) or tick several
  and **Run selected in order** for an automated pass through the pipeline.
- **Calls** — the latest run, animated per session: each question bubble, a
  typing indicator, then Zilla's answer, then that turn's
  relevancy/faithfulness/correctness chips, latency, and the call link.
- **Config (.env)** — edit every key in the browser; `ℹ️` shows what it does.

## What's next (not built yet)

- **Phase 2** — TTS: turn each question into a reusable `.wav` file. **(built, verified)**
- **Phase 3** — Session builder: group questions into multi-turn sessions
  (configurable size, reproducible random ordering via `RANDOM_SEED`). **(built, verified)**
- **Phase 4** — Session runner (UI first, then direct WebSocket) — send each
  session's questions into one continuous Zilla call/session. **(4A: built, verified; 4B not built)**
- **Phase 5** — Response capture (text/transcript first). **(built — `npm run capture-answers`)**
- **Phase 6** — Answer evaluation (DeepEval, once capture is stable). **(built — `npm run evaluate`; needs a judge key with quota)**
- **Phase 7** — Scale to many sessions with controlled concurrency.
- **Phase 8** — Dashboard. **(built — `npm run ui`)**

Each phase starts only after the previous one is verified working.
