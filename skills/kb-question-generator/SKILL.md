---
name: kb-question-generator
description: Generate exhaustive, grounded QA test-sets from bank Knowledge Base documents. Use when the user provides KB content/chunks and wants every possible customer question with fully-grounded expected answers in strict JSON format.
---

# KB Question Generator

You generate exhaustive regression test-sets for a bank voice agent ("Zilla").
Input = knowledge base content (chunks with ids like `[chunk_001]`, or raw document text).
Output = ONE valid JSON array. No prose outside the JSON.

## Output format

Return ONE valid JSON array of questions. No prose outside the JSON.
Do NOT output the chunked document itself — only questions.

```json
[
  {
    "id": "SLUG-Q001",
    "pair_id": null,
    "language": "ar",
    "topic": "Loan",
    "sub_topic": "Car Loan",
    "question": "...",
    "expected_answer": "...",
    "source_chunks": ["<verbatim text quoted from the source>"],
    "chunk_ids": []
  }
]
```

- Internally split the source into logical units first, but keep that
  chunking to yourself — quote the supporting unit(s) verbatim inside
  each question's `source_chunks`.
- `chunk_ids`: leave an empty array unless the user explicitly asks for
  a chunk map (then output it as a SEPARATE follow-up response).
- `id`: prefix from sub-topic slug (e.g. `CARLOAN-Q001`), sequential.
- `language`: `"ar"` or `"en"` — write question AND expected_answer in this language.
- `pair_id`: always `null` unless the user asks for paired variants.
- `topic`: the KB top-level folder name IN ENGLISH (e.g. `"Loan"`, `"Cards"`).
- `sub_topic`: the document name IN ENGLISH without extension
  (e.g. `"Car Loan"`, not `"قروض السيارات"`, not `"عام"`).

## Generation rules

1. **Exhaustive coverage** — every factual element appears in at least one question
   (rates, limits, tenures, eligibility, documents, fees, commissions, app flows,
   campaigns, special cases, exceptions).
2. **Zero invention** — every fact in `expected_answer` MUST exist in the provided
   chunks. If the KB doesn't cover something, do not ask about it.
3. **Numbers are sacred** — copy every number, percentage, date exactly as written
   in the source. Never round, convert, or infer values.
4. **Lists must be complete** — when the source enumerates items (approved dealers,
   cities, branches, document types), either list ALL of them in the expected_answer,
   or create a dedicated question whose whole purpose is that complete enumeration.
   NEVER write hedges like "وغيرها كثير" / "among others" / "etc." instead of the items.
5. **One idea per question** — split multi-fact topics into narrow questions
   ("conditions for X", "documents for X", "fees for X") rather than mega-questions.
6. **No garbled compression** — each sentence in expected_answer must be grammatical
   and faithful. Prefer 2-3 short sentences over one dense sentence that merges
   unrelated rules.
7. **Concise but complete** — expected_answer is 1-4 sentences.
8. **Merge true duplicates** — don't ask the same thing twice with different wording.

## Known failure modes (avoid these real past mistakes)

BAD  (incomplete list):  "...الوكالات المعتمدة تشمل غرغور والمركزية وشاهين والعديد غيرهم"
GOOD (complete list):    separate question listing ALL agents found in the chunks,
                         e.g. غرغور (Skywell/XPeng)، الاتحاد لتزويد المعدات (Maxus)،
                         صقر صقر (IM Motors)، هارلم (Jetour)، المركزية (Chery)،
                         أكاماس (Hongqi)، شاهين (MG/HOGQI)، نهج المنار (GWM-HAVAL)،
                         العصرية (NETA/BESTUNE)، بسطامي وصاحب (BYD)، عليان (GAC)،
                         العبيدي وسيارات المستقبل (BYD)، الوصل (Geely)

BAD  (garbled):          "كما يمول التاجر الصيني بشرط زويد البنك بتقرير"
GOOD (faithful):         "يمكن تمويل السيارات ذات العلامة الصينية من أي معرض بشرط
                          وجود وكيل معتمد بالأردن وعداد صفر، مع تزويد البنك بتقرير
                          فحص وتخمين وتقرير CarSeer."

## Self-check before answering

- Does EVERY item of every list in the source appear in some expected_answer?
- Is every number traceable to the source text?
- Are all questions distinct?
- Are topic/sub_topic in English matching the KB folder taxonomy?
- Is every source_chunks entry a verbatim quote from the source?

Then output ONLY the questions JSON array.
