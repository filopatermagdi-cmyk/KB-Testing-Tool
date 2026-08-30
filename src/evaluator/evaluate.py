#!/usr/bin/env python3
"""
evaluate.py - Phase 6: Answer evaluation with DeepEval.

Consumes data/captured-answers-<stamp>.json (Phase 5 output) and scores every
answered turn with DeepEval LLM-judge metrics:

  - Deflection gate   catches hedges / non-answers BEFORE scoring (zero LLM cost)
  - AnswerRelevancy    is the answer on-topic for the question?
  - Faithfulness       is the answer grounded in the KB source chunks?
  - Correctness (GEval) does the answer match the expected KB answer?

LLM judge config (.env):
  EVAL_LLM_PROVIDER=gemini|openai|ollama  (default: gemini)
    - gemini: reuses GEMINI_API_KEY
    - openai: uses OPENAI_API_KEY (optional EVAL_LLM_BASE_URL for custom endpoints)
    - ollama: LOCAL + FREE, no API key. Needs EVAL_LLM_BASE_URL (default
      http://localhost:11434/v1) and a pulled model in EVAL_MODEL, e.g.
      qwen2.5:7b  ->  `ollama pull qwen2.5:7b`
  EVAL_MODEL=...                    (default: gemini-3.6-flash / gpt-4o-mini / qwen2.5:7b)

Usage:
  npm run evaluate                                # newest captured file
  npm run evaluate -- --report data/captured-answers-<stamp>.json
  npm run evaluate -- --metrics relevancy,faithfulness,correctness
  npm run evaluate -- --sample 5                  # first 5 records only (quick check)
  npm run evaluate -- --no-llm                    # stats only, no LLM judge calls
  npm run evaluate -- --no-resume                 # ignore any partial eval-results, start clean

Large runs (hundreds/thousands of records) are resumable: the output file is
named from the SOURCE captured-answers file's own stamp (not a new timestamp
per run), progress is saved after every record, and re-running the same
command skips records already scored - so a crash or interruption part-way
through a long local-judge run only costs the time since the last save.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

import dotenv

dotenv.load_dotenv()

# Windows consoles default to cp1252 and crash on Arabic judge output.
# Force UTF-8 (with safe fallback) no matter how this script is launched.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# Module-level deepeval imports so editors (Pylance/IDE) can resolve them.
# `--no-llm` (stats only) still works even if deepeval is missing.
try:
    from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric, GEval
    from deepeval.metrics.answer_relevancy import AnswerRelevancyTemplate
    from deepeval.metrics.faithfulness import FaithfulnessTemplate
    from deepeval.models import DeepEvalBaseLLM, GeminiModel
    from deepeval.test_case import LLMTestCase

    try:
        from deepeval.test_case import SingleTurnParams as _P
    except ImportError:
        from deepeval.test_case import LLMTestCaseParams as _P

    # Zilla answers by voice in colloquial Jordanian/Levantine Arabic, while the
    # KB and generated expected_answers are Modern Standard Arabic (MSA). Without
    # this note, a judge can misread dialectal phrasing as unsupported/off-topic
    # even when the meaning is correct. Each override below only replaces ONE
    # prompt (the extraction or verdict step) and delegates back to DeepEval's own
    # default template for everything else - the claim/statement extraction
    # algorithm, JSON schema, and scoring all stay exactly as DeepEval ships them.
    DIALECT_NOTE = (
        "Note: the actual output may be phrased in colloquial Jordanian/Levantine "
        "Arabic dialect rather than Modern Standard Arabic (MSA) - Zilla is a voice "
        "agent that answers this way by design. Judge meaning and factual content "
        "only. Do NOT penalize dialectal wording, phrasing, or register differences "
        "from MSA."
    )
    ENGLISH_REASON_NOTE = (
        "Write every 'reason' field in your JSON output in English only - "
        "never mix other languages into the JSON structure."
    )
    RELATED_CONTEXT_NOTE = (
        "When deciding 'yes' vs 'no': mark 'yes' for statements that directly "
        "answer the input AND for additional details closely related to the "
        "input's topic (eligibility conditions, exceptions, availability, "
        "restrictions, next steps). Reserve 'no' for clearly off-topic content "
        "and generic conversational closings unrelated to the input."
    )
    GROUNDING_NOTE = (
        "Claims may be English translations or paraphrases of Arabic source "
        "text. Different English renderings of the SAME Arabic term refer to "
        "the same entity (e.g. 'panels', 'plates', 'signs', or compound forms "
        "like 'mail plates' can all translate \u0644\u0648\u062d\u0627\u062a). Judge semantic equivalence "
        "of meaning and facts between the claim and the retrieval context - do "
        "NOT reject a claim merely because its wording differs. Reject only if "
        "the claim's actual factual content contradicts or is genuinely absent "
        "from the context."
    )

    COMPLETE_CLAIMS_NOTE = (
        "Copy each claim VERBATIM from the output - never truncate, shorten or "
        "paraphrase. If a sentence contains a long enumeration (cities, options, "
        "steps), SPLIT it into SEVERAL claims of at most 5 items each, keeping "
        "every item exactly once and in order - never drop, merge or invent items. "
        "Do not emit duplicate claims where one is contained within another."
    )
    ONLY_SCOPE_NOTE = (
        "The word \u0641\u0642\u0637 ('only') appearing before a list means nothing OUTSIDE "
        "the list applies - it does NOT restrict items within the list. A claim "
        "listing several cities after '\u0641\u0642\u0637 \u0645\u062a\u0627\u062d\u0629 \u0641\u064a \u0627\u0644\u0645\u062f\u0646' is fully "
        "consistent with that context; it is NOT a contradiction."
    )

    class DialectAwareFaithfulnessTemplate(FaithfulnessTemplate):
        @staticmethod
        def generate_claims(actual_output):
            # multimodal_instruction is interpolated unconditionally by the base
            # template (not just inside an {% if multimodal %} block), so it must
            # be supplied explicitly - "" matches DeepEval's own non-multimodal default.
            return (
                f"{DIALECT_NOTE}\n{ENGLISH_REASON_NOTE}\n{_source_lang_note()}\n"
                f"{COMPLETE_CLAIMS_NOTE}\n\n"
                + FaithfulnessTemplate.generate_claims(
                    actual_output=actual_output, multimodal_instruction=""
                )
            )

        @staticmethod
        def generate_verdicts(claims, retrieval_context):
            return (
                f"{DIALECT_NOTE}\n{ENGLISH_REASON_NOTE}\n{_source_lang_note()}\n"
                f"{ONLY_SCOPE_NOTE}\n\n"
                + FaithfulnessTemplate.generate_verdicts(
                    claims=claims, retrieval_context=retrieval_context
                )
            )

    CLOSINGS_NOTE = (
        "Conversational closings and follow-up offers (e.g. '\u0623\u064a \u062e\u062f\u0645\u0629 "
        "\u0623\u062e\u0631\u0649\u061f', '\u0625\u0630\u0627 \u0627\u062d\u062a\u062c\u062a\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u0623\u0643\u062b\u0631' / 'Any other service?', "
        "'Would you like more details?') are STANDARD parts of any voice or chat "
        "assistant's reply - every support service ends turns this way, so they "
        "are normal and expected. Treat them as relevant ('yes') unless they "
        "REPLACE the actual answer entirely."
    )

    class DialectAwareAnswerRelevancyTemplate(AnswerRelevancyTemplate):
        @staticmethod
        def generate_statements(actual_output):
            return (
                f"{DIALECT_NOTE}\n{ENGLISH_REASON_NOTE}\n{_source_lang_note()}\n\n"
                + AnswerRelevancyTemplate.generate_statements(
                    actual_output=actual_output
                )
            )

        @staticmethod
        def generate_verdicts(input, statements):
            return (
                f"{DIALECT_NOTE}\n{ENGLISH_REASON_NOTE}\n{RELATED_CONTEXT_NOTE}\n"
                f"{CLOSINGS_NOTE}\n{_source_lang_note()}\n\n"
                + AnswerRelevancyTemplate.generate_verdicts(input=input, statements=statements)
            )

    HAS_DEEPEVAL = True
except Exception:  # noqa: BLE001 - deepeval optional for --no-llm
    HAS_DEEPEVAL = False

ROOT = os.getcwd()
DATA_DIR = os.path.join(ROOT, "data")
DEFAULT_METRICS = ["relevancy", "faithfulness"]

# ---------------------------------------------------------------------------
# Deflection detection — hard gate that fires BEFORE relevancy / faithfulness.
# A "deflection" is a response that dodges the question instead of answering it:
# hedges, handoffs to human agents, "I don't have that info" replies, etc.
# Patterns are kept here (not buried in logic) so the team can expand them as
# new transcript patterns are discovered. Two flavour groups per language:
#
#   * NO-INFO  — "ما عندي / ما بتحدد / I don't have ... regarding ...".
#                Matched ANYWHERE in the reply (position-independent): even if
#                the agent adds "however, I can tell you..." afterwards, the
#                core ask was refused, so it's still a deflection.
#   * HANDOFF  — "أوصلك على موظف / connect you with an agent / beyond my
#                scope". These legitimately FOLLOW a real answer ("answers then
#                offers follow-up"), so they keep the prefix-substance gate:
#                only deflect when the text BEFORE the match is not a
#                substantive answer.
# ---------------------------------------------------------------------------
DEFLECTION_NOINFO_AR = [
    # Opener-free skeleton: apology/hedge opener + "don't have" clause + noun.
    # "بعتذر منك، ما قدرت ألاقي معلومات عن ..." | "ما عندي معلومة بخصوص ..."
    r"(ما عندي|معنديش|ما عنديش|ما قدرت (ألاقي|القى|لاقي)|ما لقيت|"
    r"مش (متوفر|متوفرة)( (عندي|هاي))?|ما بتحدد|ما بتوضح|ما بتشرح|ما بتحدّد)"
    r".{0,40}(معلوم|تفصيل|تفاصيل|بيانات|قائمة)",
    # Reversed order: "المعلومات المتوفرة عندي ما بتحدد/بتوضح/بتشرح ..."
    r"(معلوم|تفصيل|تفاصيل|بيانات|قائمة).{0,40}"
    r"(ما بتحدد|ما بتوضح|ما بتشرح|ما بتحدّد|ما عندي)",
    # "للأسف ... ما عندي / ما بتحدد ..."
    r"للأسف.{0,60}(ما عندي|ما بتحدد|ما بتوضح|ما بتشرح|مش متوفر)",
]

DEFLECTION_HANDOFF_AR = [
    r"أوصلك (على|ب)?\s*موظف",
    r"موظف مختص",
    r"تحويلك ل(موظف|فرع|قسم)",
    r"الجواب الأكيد",
    r"بقدر أساعدك بالمعلومات اللي عندي",
]

# Convenience: full editable list per language (tests + any caller).
DEFLECTION_PATTERNS_AR = DEFLECTION_NOINFO_AR + DEFLECTION_HANDOFF_AR

DEFLECTION_NOINFO_EN = [
    # "I'm sorry, but I don't have specific information regarding ..."
    r"(i'?m sorry|i apologize)?,?\s*(but\s+)?"
    r"(i (don'?t|do not) have|i couldn'?t find)\s+"
    r"(a|an|any)?\s*(specific|particular|exact|complete)?\s*"
    r"(information|info|details?|list)\s+(in my records\s*)?"
    r"(regarding|about|on|of)",
]

DEFLECTION_HANDOFF_EN = [
    r"connect you (with|to) (an?|a) (agent|specialist|representative|human)",
    r"transfer you\s+to\s+(a|an)\s+(agent|representative|specialist)",
    r"reach out to\s+(our|a)\s+(support|specialist)\s+team",
    r"speak\s+(with|to)\s+a\s+(representative|specialist|human)",
    r"that(?:'s| is)\s+beyond\s+(my|the)\s+(scope|knowledge|capability)",
    r"i'?m\s+unable\s+to\s+answer",
    r"i\s+cannot\s+(provide|answer|help\s+with)\s+that",
]

DEFLECTION_PATTERNS_EN = DEFLECTION_NOINFO_EN + DEFLECTION_HANDOFF_EN

# How much real content must precede a HANDOFF pattern before we trust it as a
# genuine answer (vs the handoff being the whole substance of the reply).
MIN_SUBSTANCE_CHARS = 40


def is_deflection(response_text: str, language: str = "ar") -> bool:
    """Return True if *response_text* is a deflection / non-answer.

    A deflection is a reply that dodges the question instead of answering it:
    hedges, handoffs to human agents, "I don't have that info" replies, etc.

    IMPORTANT: a response that ANSWERS the question and THEN offers to
    connect to a specialist (e.g. "Documents needed are X, Y. Would you
    like me to connect you to a specialist?") is NOT a deflection - the
    follow-up offer is standard conversational behavior.  Only responses
    where the deflection/hedge is the ENTIRE substance are flagged.

    Two gates, applied in order:
      1. NO-INFO patterns match anywhere in the reply -> deflection.
      2. HANDOFF patterns only deflect when the text BEFORE the match is
         itself refusal/hedge language, absent, or a short opener - a long
         substantive prefix means the response answered and merely appended
         a follow-up.
    """
    if language == "ar":
        noinfo, handoff = DEFLECTION_NOINFO_AR, DEFLECTION_HANDOFF_AR
    else:
        noinfo, handoff = DEFLECTION_NOINFO_EN, DEFLECTION_HANDOFF_EN
    return _scan_deflection(response_text.strip(), noinfo, handoff, language)


def _scan_deflection(
    text: str, noinfo, handoff, language: str, _log: bool = True
) -> bool:
    for p in noinfo:
        if re.search(p, text, flags=re.IGNORECASE | re.DOTALL):
            if _log:
                _log_deflection_match(language, p, text)
            return True
    for p in handoff:
        m = re.search(p, text, flags=re.IGNORECASE | re.DOTALL)
        if not m:
            continue
        prefix = text[: m.start()].strip()
        if not prefix:
            if _log:
                _log_deflection_match(language, p, text)
            return True
        if len(prefix) < MIN_SUBSTANCE_CHARS:
            if _log:
                _log_deflection_match(language, p, text)
            return True
        # Long prefix: it must itself be deflection/hedge language, otherwise
        # the response contains a real answer and just ends with a follow-up.
        if _scan_deflection(prefix, noinfo, handoff, language, _log=False):
            if _log:
                _log_deflection_match(language, p, text)
            return True
    return False


def _log_deflection_match(language: str, pattern: str, text: str) -> None:
    """Which pattern fired (for tuning the lists against new transcripts)."""
    system: str = "ar" if language == "ar" else "en"
    sys.stderr.write(
        f"[deflection] {system} pattern {pattern!r} matched in: {text[:70]!r}\n"
    )

# Language of the record currently being judged - updated per record in
# run_one(). Template overrides read it so Arabic records are judged over
# untranslated Arabic text (claim<->context comparison never crosses languages).
JUDGE_LANG = {"current": "en"}

# Live token/call accounting for the judge LLM. Updated by the adapter on
# every completion (retries included) and written into each results file so
# judge cost can be compared across models.
JUDGE_USAGE = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}


def _source_lang_note():
    if JUDGE_LANG["current"] == "ar":
        return (
            "LANGUAGE RULE: work in the source language. Extract statements/"
            "claims VERBATIM in their original Arabic - do NOT translate them "
            "into English. Compare Arabic claims against the Arabic retrieval "
            "context directly. Keep 'verdict' values as yes/no/idk and write "
            "'reason' fields in English."
        )
    return ""


def newest_captured():
    files = [
        f for f in os.listdir(DATA_DIR)
        if f.startswith("captured-answers-") and f.endswith(".json")
    ]
    files.sort()
    return os.path.join(DATA_DIR, files[-1]) if files else None


def _extract_json(text):
    """Pull the first complete JSON object out of model output (it often
    wraps the JSON in extra commentary)."""
    import json

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        if start == -1:
            raise ValueError(f"no JSON object in model output: {text[:200]}")
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        return json.loads(text[start : i + 1])
        raise ValueError(f"unbalanced JSON in model output: {text[:200]}")


def build_compat_model(model_name, base_url, api_key, label):
    """Generic adapter for ANY OpenAI-compatible chat endpoint (Ollama, Groq, ...).
    deepeval's built-in OpenAIModel uses an OpenAI-only code path (beta.parse)
    that breaks against Groq - this adapter uses the plain chat.completions
    endpoint that every OpenAI-compatible API supports.
    """
    from openai import OpenAI

    print(f"[judge] {label} {model_name} @ {base_url or 'default'} (key: {'set' if api_key else 'MISSING'})")
    client = OpenAI(base_url=base_url, api_key=api_key or "dummy")

    class OpenAICompatModel(DeepEvalBaseLLM):
        def load_model(self):
            return client

        def _call(self, prompt, schema):
            # NOTE: no response_format=json_object here on purpose - Groq's JSON
            # mode requires the literal word "json" in the prompt and deepEval's
            # prompt only says "JSON" (uppercase), so it 400s. The prompt already
            # demands a JSON reply and the models comply - we parse it below.
            call = {"temperature": 0.0}
            resp = client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                **call,
            )
            content = resp.choices[0].message.content or ""
            usage = getattr(resp, "usage", None)
            if usage is not None:
                JUDGE_USAGE["calls"] += 1
                JUDGE_USAGE["prompt_tokens"] += getattr(usage, "prompt_tokens", 0) or 0
                JUDGE_USAGE["completion_tokens"] += getattr(usage, "completion_tokens", 0) or 0
            stripped = content.strip()
            if not stripped or stripped.lower() in {"null", "none"}:
                # Reasoning models occasionally emit an empty/null completion.
                # Surface it as a JSONDecodeError so the caller's retry loop
                # treats it as transient instead of crashing deepEval's verdict
                # parser with 'NoneType' object is not subscriptable.
                raise json.JSONDecodeError("empty or null completion", content, 0)
            if schema is not None:
                data = _extract_json(content)
                return schema.model_validate(data), 0.0
            return content, 0.0

        def generate(self, prompt, schema=None, **kwargs):
            out, _ = self._call(prompt, schema)
            return out

        async def a_generate(self, prompt, schema=None, **kwargs):
            import asyncio
            return await asyncio.to_thread(self.generate, prompt, schema)

        def get_model_name(self):
            return model_name

    return OpenAICompatModel()


def build_model(provider):
    if provider == "gemini":
        key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        model_name = os.environ.get("EVAL_MODEL", "gemini-3.6-flash")
        print(f"[judge] Gemini {model_name} (key: {'set' if key else 'MISSING'})")
        return GeminiModel(model=model_name, api_key=key)
    if provider == "openai":
        model_name = os.environ.get("EVAL_MODEL", os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))
        base_url = os.environ.get("EVAL_LLM_BASE_URL") or None
        # Route credentials by endpoint: a Groq base URL must use the Groq key,
        # anything else (OpenRouter, OpenAI) uses OPENAI_API_KEY.
        if base_url and "groq.com" in base_url:
            key = os.environ.get("GROQ_API_KEY")
        else:
            key = os.environ.get("OPENAI_API_KEY") or os.environ.get("GROQ_API_KEY")
        return build_compat_model(model_name, base_url, key, "OpenAI-compatible")
    if provider == "ollama":
        model_name = os.environ.get("EVAL_MODEL", "qwen2.5:7b")
        base_url = os.environ.get("EVAL_LLM_BASE_URL") or "http://localhost:11434/v1"
        return build_compat_model(model_name, base_url, "ollama", "Ollama")
    print(f"[error] unknown EVAL_LLM_PROVIDER={provider!r} (use gemini|openai|ollama)")
    sys.exit(1)


def build_metrics(model, names, threshold):
    metrics = {}
    if "relevancy" in names:
        metrics["relevancy"] = AnswerRelevancyMetric(
            threshold=threshold, model=model, async_mode=False,
            evaluation_template=DialectAwareAnswerRelevancyTemplate,
        )
    if "faithfulness" in names:
        metrics["faithfulness"] = FaithfulnessMetric(
            threshold=threshold, model=model, async_mode=False,
            evaluation_template=DialectAwareFaithfulnessTemplate,
        )
    if "correctness" in names:
        metrics["correctness"] = GEval(
            name="Correctness",
            evaluation_params=[_P.INPUT, _P.ACTUAL_OUTPUT, _P.EXPECTED_OUTPUT],
            criteria=(
                "Determine whether the actual output correctly answers the input "
                "question based on the expected output. The actual output must "
                "include the key facts from the expected output. Penalize answers "
                "that are off-topic, contradict the expected output, or omit "
                "required details. " + DIALECT_NOTE + " " + ENGLISH_REASON_NOTE
            ),
            threshold=threshold,
            model=model,
            async_mode=False,
        )
    return metrics


def _verdict_reason(name, metric):
    """LLM-written 'reason' summaries often contradict the actual per-statement
    verdicts (e.g. claiming the output 'did not provide information' while the
    verdicts accepted it). Rebuild a factual summary from the raw verdict data;
    fall back to the LLM text when the metric exposes no verdicts (GEval)."""
    try:
        verdicts = list(getattr(metric, "verdicts") or [])
        if not verdicts:
            return getattr(metric, "reason", "") or ""
        noun = "statement" if name == "relevancy" else "claim"
        items = list(getattr(metric, "statements") or []) if name == "relevancy" \
            else list(getattr(metric, "claims") or [])
        total = len(verdicts)
        accepted = 0
        rejected = []
        ambiguous = 0
        for i, v in enumerate(verdicts):
            vd = (getattr(v, "verdict", "") or "").strip().lower()
            if vd == "idk":
                ambiguous += 1
            if vd != "no":
                accepted += 1
                continue
            why = (getattr(v, "reason", "") or "").strip() or "no explanation given"
            txt = f'"{items[i][:70]}" ' if i < len(items) else ""
            rejected.append(f"{txt}- {why}")
        head = f"{name}: {accepted}/{total} {noun}s accepted"
        if rejected:
            head += ". Rejected: " + " | ".join(rejected)
        if ambiguous:
            head += f". ({ambiguous} ambiguous)"
        return head
    except Exception:  # noqa: BLE001 - reason is cosmetic; never fail scoring
        return getattr(metric, "reason", "") or ""


def run_one(record, metrics, threshold, max_retries=3):
    import time

    tc = LLMTestCase(
        input=record.get("question") or "",
        actual_output=record.get("zilla_answer") or "",
        expected_output=record.get("expected_answer") or "",
        retrieval_context=record.get("source_chunks") or [],
    )
    result = {"metrics": {}, "error": None, "judge_latency_ms": None}
    lang = (record.get("language") or "en").lower()
    JUDGE_LANG["current"] = lang

    # ---- Deflection gate (runs BEFORE any LLM judge calls) ----
    if is_deflection(record.get("zilla_answer") or "", language=lang):
        result["error"] = "deflection_detected"
        result["judge_latency_ms"] = 0
        return result

    t0 = time.perf_counter()
    for name, metric in metrics.items():
        attempt = 0
        while True:
            try:
                metric.measure(tc)
                result["metrics"][name] = {
                    "score": metric.score,
                    "pass": bool(metric.is_successful()),
                    "reason": _verdict_reason(name, metric) if name in ("relevancy", "faithfulness")
                    else getattr(metric, "reason", "") or "",
                }
                break
            except Exception as e:  # noqa: BLE001 - per-record isolation
                err = f"{name}: {type(e).__name__}: {e}"
                low = str(e).lower()
                is_quota = (
                    "429" in str(e)
                    or "resource_exhausted" in low
                    or "ratelimit" in low.replace("_", "")
                    or "rate_limit" in low
                    or "retryerror" in low
                )
                # Small local judges occasionally emit malformed JSON (truncated
                # output, language slips mid-structure). These are transient -
                # a fresh call usually parses fine - so retry them like quota.
                is_json_err = (
                    "json" in type(e).__name__.lower()
                    or "json" in low
                    or "validationerror" in type(e).__name__.lower()
                )
                attempt += 1
                if (is_quota or is_json_err) and attempt <= max_retries:
                    wait = 10 * attempt if is_quota else 2 * attempt
                    why = "quota hit" if is_quota else f"{name} output parse error"
                    print(f"    {why} on {name}, retrying in {wait}s ({attempt}/{max_retries})...")
                    time.sleep(wait)
                    continue
                result["error"] = err
                break
    result["judge_latency_ms"] = round((time.perf_counter() - t0) * 1000)
    return result


def stats_only(records):
    answered = [r for r in records if r.get("zilla_answer")]
    total = len(records)
    lat = [r.get("latency_ms") for r in answered if r.get("latency_ms") is not None]
    avg_lat = round(sum(lat) / len(lat)) if lat else None

    # Count deflections in --no-llm mode (pattern check only, no LLM calls).
    deflections = sum(1 for r in answered if is_deflection(r.get("zilla_answer") or "", language=(r.get("language") or "ar").lower()))

    return {
        "total_turns": total,
        "answered": len(answered),
        "unanswered": total - len(answered),
        "deflections": deflections,
        "answer_rate": round(100 * len(answered) / total, 1) if total else None,
        "avg_latency_ms": avg_lat,
    }


def export_for_claude(records, report_path, out_path):
    """Write every record exactly as run_one() would feed it to the LLM judge,
    WITHOUT calling any model. Fields mirror the LLMTestCase build in run_one():
    question -> input, zilla_answer -> actual_output, expected_answer ->
    expected_output, source_chunks -> retrieval_context. Also flags which
    responses the deflection gate would short-circuit, so the batch judge
    (e.g. Claude) doesn't waste effort on them."""
    payloads = []
    for rec in records:
        lang = (rec.get("language") or "en").lower()
        payloads.append(
            {
                "session_id": rec.get("session_id"),
                "question_id": rec.get("question_id"),
                "language": lang,
                "turn": rec.get("turn"),
                "conversation_id": rec.get("conversation_id"),
                "latency_ms": rec.get("latency_ms"),
                "question": rec.get("question"),
                "expected_answer": rec.get("expected_answer"),
                "zilla_answer": rec.get("zilla_answer"),
                "source_chunks": rec.get("source_chunks") or [],
                "deflection_detected": is_deflection(
                    rec.get("zilla_answer") or "", language=lang
                ),
            }
        )
    payload = {
        "source": os.path.basename(report_path),
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "metrics_targets": list(DEFAULT_METRICS),
        "instructions": (
            "Judge each record like the Groq judge (openai/gpt-oss-120b) would: "
            "score `relevancy` (is the Zilla answer on-topic for the question) "
            "and `faithfulness` (are its claims supported by `source_chunks`). "
            "Follow our dialect rules: Zilla speaks colloquial Jordanian/Levantine "
            "Arabic; judge meaning, not MSA-vs-dialect wording. If "
            "`deflection_detected` is true, the response dodged the question "
            "(hedge/handoff) - verdict FAIL, scores 0. A response that ANSWERS "
            "then offers follow-up is NOT a deflection. Output one result object "
            "per record with: question_id, verdict (PASS/FAIL), relevancy, "
            "faithfulness."
        ),
        "records": payloads,
    }
    json.dump(
        payload,
        open(out_path, "w", encoding="utf-8"),
        indent=2,
        ensure_ascii=False,
    )
    return payload


def main():
    parser = argparse.ArgumentParser(description="DeepEval evaluation of captured Zilla answers")
    parser.add_argument("--report", help="path to a captured-answers-*.json file")
    parser.add_argument("--metrics", default=",".join(DEFAULT_METRICS))
    parser.add_argument("--sample", type=int, default=0, help="only evaluate the first N records")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--no-llm", action="store_true", help="stats only (no LLM judge calls)")
    parser.add_argument(
        "--no-resume", action="store_true",
        help="ignore any partial eval-results for this source and start clean",
    )
    parser.add_argument(
        "--export", action="store_true",
        help="do NOT call the LLM judge; write every judge payload (question, "
        "expected_answer, zilla_answer, source_chunks) to a Claude-ready JSON "
        "file and exit. Use this to batch-judge with a different model than Groq.",
    )
    args = parser.parse_args()

    report_path = args.report or newest_captured()
    if not report_path or not os.path.exists(report_path):
        print("[error] no captured answers found - run Phase 5 first (npm run capture-answers)")
        sys.exit(1)

    data = json.load(open(report_path, encoding="utf-8"))
    records = data.get("records", data if isinstance(data, list) else [])
    if args.sample and args.sample > 0:
        records = records[: args.sample]

    # Output is named from the SOURCE file's stamp PLUS the judge model so
    # re-running the same captured-answers file with the same judge targets
    # the same eval-results file and can resume it, while switching judges
    # never clobbers another judge's scores.
    m = re.search(r"captured-answers-(.+)\.json$", os.path.basename(report_path))
    source_stamp = m.group(1) if m else os.path.splitext(os.path.basename(report_path))[0]
    model_slug = re.sub(
        r"[^A-Za-z0-9._-]+", "_",
        os.environ.get("EVAL_MODEL", "judge").replace(":free", ""),
    )
    out_path = os.path.join(DATA_DIR, f"eval-results-{source_stamp}-{model_slug}.json")

    print(f"Evaluating {len(records)} record(s) from {os.path.basename(report_path)}")

    if args.export:
        exp_path = os.path.join(DATA_DIR, f"claude-export-{source_stamp}.json")
        export_for_claude(records, report_path, exp_path)
        print(f"export: {os.path.relpath(exp_path, ROOT)}")
        n_deflect = sum(
            1
            for rec in records
            if is_deflection(rec.get("zilla_answer") or "", language=(rec.get("language") or "ar").lower())
        )
        print(f"records: {len(records)}  | deflection-gated (no judge needed): {n_deflect}")
        return

    if args.no_llm:
        s = stats_only(records)
        print(json.dumps(s, indent=2))
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-") + datetime.now().strftime("%f")[:3] + "Z"
        out = os.path.join(DATA_DIR, f"eval-stats-{stamp}.json")
        json.dump({"source": os.path.basename(report_path), "stats": s}, open(out, "w", encoding="utf-8"), indent=2)
        print(f"stats: {out}")
        return

    provider = os.environ.get("EVAL_LLM_PROVIDER", "gemini").lower()
    if not HAS_DEEPEVAL:
        print("[error] deepeval is not installed - run: pip install -r requirements.txt")
        sys.exit(1)
    if provider not in ("gemini", "openai", "ollama"):
        print("[error] EVAL_LLM_PROVIDER must be one of: gemini | openai | ollama")
        sys.exit(1)
    if provider == "openai" and not (os.environ.get("OPENAI_API_KEY") or os.environ.get("GROQ_API_KEY")):
        print("[error] EVAL_LLM_PROVIDER=openai but OPENAI_API_KEY / GROQ_API_KEY is not set in .env")
        sys.exit(1)

    model = build_model(provider)
    metric_names = [mn.strip() for mn in args.metrics.split(",") if mn.strip()]
    metrics = build_metrics(model, metric_names, args.threshold)
    print(f"[metrics] {', '.join(metrics.keys())}  (threshold {args.threshold})\n")

    # Resume: an existing eval-results file for this exact source is loaded and
    # any (session_id, question_id) already scored in it is skipped, so a long
    # local-judge run can be safely re-run after a crash/interruption.
    done_by_key = {}
    if not args.no_resume and os.path.exists(out_path):
        try:
            prior = json.load(open(out_path, encoding="utf-8"))
            for r in prior.get("records", []):
                done_by_key[(r.get("session_id"), r.get("question_id"))] = r
        except Exception as e:  # noqa: BLE001 - a corrupt/partial file just means start clean
            print(f"[warn] could not read existing {out_path} ({e}) - starting clean")
    if done_by_key:
        print(f"resuming: {len(done_by_key)} record(s) already scored in {os.path.basename(out_path)} - skipping those\n")

    def summarize(subset):
        if not subset:
            return {}
        out = {
            "records": len(subset),
            "errors": sum(1 for x in subset if x["error"] and x["error"] != "deflection_detected"),
            "deflections": sum(1 for x in subset if x["error"] == "deflection_detected"),
        }
        for name in metrics:
            vals = [x["metrics"][name]["score"] for x in subset if name in x.get("metrics", {})]
            passed = [x["metrics"][name]["pass"] for x in subset if name in x.get("metrics", {})]
            if vals:
                out[name] = {
                    "avg": round(sum(vals) / len(vals), 3),
                    "pass_rate": round(100 * sum(passed) / len(passed), 1),
                }
        return out

    def save(results_so_far, done):
        summary = {
            "overall": summarize(results_so_far),
            "by_language": {lang: summarize([x for x in results_so_far if x["record"].get("language") == lang])
                            for lang in sorted({x["record"].get("language") for x in results_so_far})},
        }
        json.dump(
            {
                "source": os.path.basename(report_path),
                "provider": provider,
                "model": os.environ.get("EVAL_MODEL", "default"),
                "metrics": list(metrics.keys()),
                "threshold": args.threshold,
                "done": done,
                "total": len(records),
                "judge_usage": dict(JUDGE_USAGE),
                "judge_wall_seconds": round(time.time() - _run_t0),
                "summary": summary,
                "records": [
                    {
                        "session_id": r["record"].get("session_id"),
                        "question_id": r["record"].get("question_id"),
                        "language": r["record"].get("language"),
                        "question": r["record"].get("question"),
                        "expected_answer": r["record"].get("expected_answer"),
                        "zilla_answer": r["record"].get("zilla_answer"),
                        "source_chunks": r["record"].get("source_chunks"),
                        "conversation_id": r["record"].get("conversation_id"),
                        "call_url": r["record"].get("call_url"),
                        "latency_ms": r["record"].get("latency_ms"),
                        "metrics": r["metrics"],
                        "error": r["error"],
                    }
                    for r in results_so_far
                ],
            },
            open(out_path, "w", encoding="utf-8"),
            indent=2,
            ensure_ascii=False,
        )
        return summary

    results = []
    import time

    _run_t0 = time.time()
    for i, rec in enumerate(records, 1):
        key = (rec.get("session_id"), rec.get("question_id"))
        prior = done_by_key.get(key)
        if prior is not None:
            results.append({"record": rec, "metrics": prior.get("metrics", {}), "error": prior.get("error")})
            print(f"  [{i}/{len(records)}] {rec.get('question_id', '?')}  (resumed from prior run)")
            continue
        if not rec.get("zilla_answer"):
            results.append({"record": rec, "metrics": {}, "error": "unanswered"})
            print(f"  [{i}/{len(records)}] {rec.get('question_id', '?')}  UNANSWERED - skipped")
        else:
            try:
                r = run_one(rec, metrics, args.threshold)
            except Exception as e:  # noqa: BLE001
                r = {"metrics": {}, "error": f"{type(e).__name__}: {e}"}
            results.append({"record": rec, "metrics": r["metrics"], "error": r["error"]})
            if r["error"] == "deflection_detected":
                status = "DEFLECTION - FAIL (gate)"
            else:
                status = r["error"] or ", ".join(
                    f"{k}={v['score']:.2f}{'P' if v['pass'] else 'F'}" for k, v in r["metrics"].items()
                )
            print(f"  [{i}/{len(records)}] {rec.get('question_id', '?')}  {status}")
        # Saved after every record (not just at the end) so a crash or
        # interruption mid-run only costs the time since the last save.
        save(results, i)

    summary = save(results, len(records))
    print("\n===== EVALUATION SUMMARY =====")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\neval: {os.path.relpath(out_path, ROOT)}")


if __name__ == "__main__":
    main()