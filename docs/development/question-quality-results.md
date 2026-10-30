# S8.6 question-quality results

## Selected configuration

The selected experimental configuration keeps the hard evidence validator and executable single-tag/two-entity answer mappings, requests at most eight category-diverse proposals, preserves only narrowly validated natural tag wording, and applies `quality_v1` selection (60% legacy S5 objective, 25% deterministic semantic-quality proxy, 15% order-aware counterfactual distance). Deterministic mode remains unchanged and default.

## Held-out comparison

Scores marked “heuristic” are deterministic proxies, not human judgments. The 10 held-out scenarios were not used to choose weights.

| Metric | Deterministic S5 | Original S8.5 | Optimized S8.6 |
|---|---:|---:|---:|
| Grounding pass rate | 100% | 100% | 100% |
| Unsupported accepted claims | 0 | 0 | 0 |
| Duplicate rate | 0% | 0% | 0% |
| Selected-question diversity | 10/10 | 10/10 | 10/10 |
| Clarity (heuristic 1–5) | 5.00 | 5.00 | 5.00 |
| Naturalness (heuristic 1–5) | 3.50 | 3.50 | 5.00 |
| Answerability (heuristic 1–5) | 5.00 | 5.00 | 5.00 |
| Relevance (heuristic 1–5) | 3.75 | 3.75 | 4.00 |
| Preference usefulness (heuristic 1–5) | 4.80 | 4.80 | 5.00 |
| Mean semantic quality (heuristic) | 4.41 | 4.41 | 4.80 |
| Mean mathematical objective | 0.660798 | 0.660798 | 0.705699 (different composite; not directly equivalent) |
| Mean top-K ranking separation | 0.300 | 0.300 | 0.300 |
| Order-aware ranking changes | Measured inside S8.6 composite | Measured inside S8.6 composite | Measured inside S8.6 composite |
| Fallback rate | 0% | 0% | 0% |
| Per-configuration latency | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Gemini cost | $0.00 | $0.00 | $0.00 |

Mean heuristic quality improved by 0.39 points (8.84% relative), with no loss in top-K separation and zero unsupported acceptances. This establishes an improvement only under the stated deterministic rubric. Human evaluation was **NOT PERFORMED**, so no human-quality win is claimed.

## Held-out examples (unfiltered)

| Scenario | Original S8.5 | Optimized S8.6 |
|---|---|---|
| moral ambiguity | Do you enjoy moral ambiguity books? | Would you enjoy moral ambiguity? |
| found family | Do you enjoy found family books? | Would you enjoy found family? |
| slow-burn tension | Do you enjoy slow-burn tension books? | Would you enjoy slow-burn tension? |
| unreliable narrators | Do you enjoy unreliable narrators books? | Would you enjoy unreliable narrators? |
| political intrigue | Do you enjoy political intrigue books? | Would you enjoy political intrigue? |
| scientific rigor | Do you enjoy Science Fiction books? | Would you enjoy scientific rigor? |
| intimate character study | Do you enjoy intimate character study books? | Would you enjoy intimate character study? |
| mythic atmosphere | Do you enjoy mythic atmosphere books? | Would you enjoy mythic atmosphere? |
| social satire | Do you enjoy social satire books? | Would you enjoy social satire? |
| nonlinear storytelling | Do you enjoy nonlinear storytelling books? | Would you enjoy nonlinear storytelling? |

The scientific-rigor case is the clearest selection improvement: the legacy entropy-heavy objective selected the broad genre; the quality-aware profile selected the supported specific dimension. Difficult cases remain: “Would you enjoy nonlinear storytelling?” is concise but still assumes the user understands the term, and deterministic heuristics cannot measure that reliably.

## Validator rejections

| Rejection | Example | Reason |
|---|---|---|
| `unknown_entity` | evidence cites an absent book ID | Cannot prove the evidence carrier |
| `unknown_tag` | target uses an absent tag ID | Cannot execute a supported preference update |
| `incorrect_association` | real tag cited on a book that lacks it | Association is unsupported |
| `unsupported_semantics` | “emotionally immersive cosmic journeys” for a `Space opera` tag | Meaning exceeds verified label |
| `unsupported_mapping` | tag question omits `dislike` | Answer cannot map to the existing contract |
| `duplicate` | same target/dimension twice | Redundant pool entry |
| `previously_asked` | session already contains question ID | Repeat preference elicitation |
| canonical fallback | unrestricted paraphrase | Intent-preserving wording cannot be proven |

## Operational result and limitations

Offline API usage was 0 Qloo requests, 0 Gemini requests, and $0.00. Three bounded live trials used 9 Qloo requests and 8 Gemini requests in total, with cumulative estimated Gemini cost $0.0257032. The final full-loop trial exposed 30 real candidates, generated/accepted 8/8 grounded proposals, selected “Do you enjoy Dragons books?”, and verified that a `like` answer changed the complete top-five ordering. Start+answer route latency was 10,310 ms and estimated cost $0.0122967. Earlier start-only trials took 7,102 ms and 5,736 ms; this is an improvement over the prior >10s start observation but not a controlled latency benchmark.

The live wording is still templated and only moderately insightful. The benchmark is synthetic, the rubric is hand-authored, seed relevance is only approximated, and no independent LLM or human ratings exist. Accordingly, optimized generation remains behind `QUESTION_GENERATION_MODE=llm_grounded`; deterministic mode remains the default.
