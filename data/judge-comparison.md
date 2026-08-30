# Judge Model Comparison

_Generated 2026-08-22 02:30 | threshold 0.5 | cell = relevancy / faithfulness_

| Question | nvidia/nemotron-3-ultra-550b-a55b | openai/gpt-oss-120b | qwen2.5:7b |
|---|---|---|---|
| Q049 (ar) | 0.75 / 1.00 | 1.00 / 1.00 | ERR / ERR ⚠ |
| Q079 (ar) | 0.75 / 1.00 | 1.00 / 1.00 | 0.75 / 0.67 |
| Q013 (ar) | 0.67 / 0.50 | 1.00 / 1.00 | 0.50 / 0.00 |
| Q009 (ar) | 0.75 / 1.00 | 1.00 / 1.00 | 0.33 / 0.80 |
| Q005 (ar) | 0.67 / 1.00 | 1.00 / 1.00 | 0.50 / 1.00 |
| Q003 (?) | - | - | 1.00 / 0.50 |
| Q081 (?) | - | - | ERR / ERR ⚠ |
| Q039 (?) | - | - | 1.00 / 0.50 |
| Q021 (?) | - | - | 0.50 / 1.00 |
| Q025 (?) | - | - | 0.50 / 0.57 |
| Q074 (?) | - | - | 0.67 / 0.50 |
| Q002 (?) | - | - | 0.44 / 0.40 |
| Q050 (?) | - | - | 1.00 / 0.67 |
| Q070 (?) | - | - | 0.67 / 0.60 |
| Q028 (?) | - | - | 0.80 / 0.80 |
| Q064 (?) | - | - | 0.50 / 0.50 |
| Q046 (?) | - | - | ERR / ERR ⚠ |
| Q060 (?) | - | - | 0.33 / 0.33 |
| Q066 (?) | - | - | 0.67 / 0.67 |
| Q056 (?) | - | - | 1.00 / 0.50 |

| **Relevancy avg** | 0.718 | 1.000 | 0.624 |
| **Faithfulness avg** | 0.900 | 1.000 | 0.574 |
| Judge LLM calls | - | 35 | - |
| Prompt tokens | - | 19,044 | - |
| Completion tokens | - | 12,098 | - |
| Wall time | 10.1 min | 2.7 min | - |

## Negative Control (judge credibility check)

Poisoned answers were fed to gpt-oss-120b to verify it actually detects errors:

| Test | Poison | Relevancy | Faithfulness |
|---|---|---|---|
| NC1 wrong cities (Amman/Irbid instead of Saudi list) | factual corruption | 1.00 PASS | **0.00 FAIL - caught** |
| NC2 off-topic small talk | relevance corruption | **0.00 FAIL - caught** | 1.00 PASS* |
| NC3 fabricated numbers (all -> 999) | factual corruption | 1.00 PASS | **0.00 FAIL - caught** |
| NC4 positive control (untouched answer) | none | 1.00 PASS | 1.00 PASS |

*NC2 note: an off-topic reply makes no false factual claims, so faithfulness
correctly stays high - each metric guards its own dimension.

Result: the judge reliably separates correct from corrupted answers, and each
metric penalizes exactly its own failure mode.
