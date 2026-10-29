# S8.6 experiment ledger

Dataset `s8.6-v1` contains 20 development and 10 held-out synthetic scenarios. They vary seed identity, candidate count (5–10), question stage (1–3), prior positive/rejected preferences, sparse descriptions, noisy age metadata, carrier balance, and specific preference dimensions. Synthetic evidence is explicitly namespaced and is not represented as Qloo observation. Randomness: none.

All quality values are deterministic heuristic 1–5 scores, not human or LLM-judge ratings. All experiments used zero external requests and $0.00 API cost.

The subsequent live-validation campaign used 9 Qloo and 8 Gemini requests across three bounded trials. Estimated Gemini costs were $0.0075419, $0.0058646, and $0.0122967 (cumulative $0.0257032). The first two start-only trials exposed generic “Magic” and “Dystopia” selections and motivated the broad-label penalty; the final start+answer trial selected “Dragons”, proved the answer mapping changed ranking, and also showed that wording quality still needs human review.

| ID | Single change / hypothesis | Prompt | Development result (quality / discrimination / objective) | Failure cases | Decision |
|---|---|---|---|---|---|
| A | Original deterministic S5 baseline | none | 4.32 / 0.260 / 0.651258 | Mechanical wording; broad genre occasionally selected | baseline |
| B | Original S8.5 canonical validation | S8.5, up to 15 | 4.32 / 0.260 / 0.651258 | Generated wording erased; identical to A | retain only as comparison |
| C | Concise, category-diverse prompt and safe natural renderer; cap 8 | S8.6-v1 | 4.62 / 0.260 / 0.651258 | S5 still selects broad labels; quality invisible to objective | retain wording/prompt |
| D | Add deterministic semantic-quality gate and order-aware distance | S8.6-v1 | 4.80 / 0.260 / 0.693923 | Heuristic rubric is not a human judgment | retain experimentally |
| E | Reduce proposal cap from 8 to 5 | S8.6-v1-cap5 | 4.80 / 0.260 / 0.693923 | No measured quality gain; may reduce coverage with real sparse metadata | inconclusive; do not retain |
| F | Combine retained prompt/renderer with quality-aware selection and cap 8 | S8.6-v1 | 4.80 / 0.260 / 0.693923 | Same development plateau as D; compound/contrastive questions still unsupported | selected |

Latency was measured at benchmark-command level rather than attributed per configuration because the operations complete within one Vitest process; per-configuration latency is `NOT_MEASURED`. The full command completed in roughly 0.5 seconds on the development machine.

## Rejected or deferred experiments

- Grounded multi-attribute questions: **rejected for production**. The current `Question`/answer contract cannot express whether a “like” applies jointly or independently to constituent tags. Adding them would violate deterministic answer mapping.
- Contrastive attribute questions: **deferred**. The contract supports entity A/B comparisons, not tag-direction A/B mappings. No safe change was established within this campaign.
- Stage-aware selection: investigated through scenario stages, but no independent benefit could be attributed without a richer typed question pool. No fixed stage sequence was added.
- Five-proposal cap: no development advantage over eight; retained cap is eight to preserve evidence coverage.
- LLM judge: not run. A separately configured model was not necessary to select the safety-preserving offline variant, and avoiding it kept experimental cost at zero.

## Rejected proposal classes

The evidence validator continues to reject malformed schemas, unknown entities, unknown tags, incorrect entity/tag associations, unsupported semantics, unsupported answer mappings, duplicates, and previously asked questions. Age/demographic and format tags remain filtered by tag type. Safe rendering falls back to canonical wording when generated text is outside the explicitly accepted intent-preserving patterns.

## Reproduction

Run `npm run optimize:question-quality`. The benchmark has no network transport and cannot incur paid API usage.
