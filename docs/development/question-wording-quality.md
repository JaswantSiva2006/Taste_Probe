# S8.7 grounded question wording quality

## Root cause

S8.6 kept the verified tag ID, exact tag label, evidence associations, and answer mapping, but its renderer only accepted a small set of label-insertion patterns. Safe Gemini wording outside those patterns was discarded, and fallback text was another metadata template such as “Would you enjoy moral ambiguity?” The result was grounded yet conversationally weak. The optimizer could prefer these questions, but it could not turn a metadata label into a grammatical relationship with stories.

## Approaches evaluated

The offline `s8.7-wording-v1` benchmark contains 35 distinct synthetic preference dimensions: 20 development and 15 held-out. It includes genres, subgenres, themes, styles, descriptors, atmosphere, relationships, pacing, settings, periods, motifs, philosophical themes, sparse descriptions, ambiguous labels, previously asked markers, and a separate entity-comparison mapping check. Solarpunk and Afrofuturism are held-out unfamiliar valid labels. Fixtures are synthetic and are not represented as Qloo observations.

| Strategy | Development naturalness (heuristic 1–5) | Semantic fidelity | Answer mapping | Extra inference |
|---|---:|---:|---:|---:|
| Existing S8.6 label template | 3.500 | 100% | 100% | 0 |
| Deterministic category-aware | 5.000 | 100% | 100% | 0 |
| Preserve validated Gemini wording | 4.775 | 100% | 100% | 0 |
| Hybrid | 5.000 | 100% | 100% | 0 |

The preserved-only strategy fell back to S8.6 wording when the proposal introduced an unsupported expansion. Deterministic and hybrid tied on the heuristic; hybrid was selected because it retains already-generated natural wording when the exact verified label appears inside a constrained positive, single-dimension intent, while retaining deterministic safety fallback.

## Selected implementation

`renderer.ts` separates display rendering from the authoritative target. It never changes `questionId`, `targetIds`, evidence, polarity, or allowed responses.

- Generated text is preserved only when it matches a bounded positive-intent grammar and contains the exact verified tag label.
- Negation, alternatives, contrasts, and unrelated semantic additions fail validation.
- Unsafe or awkward generated text falls back according to verified tag type: genre, theme, style/descriptor, setting/period, or motif.
- Entity comparisons retain their exact two entity IDs and the existing `prefer_a`, `prefer_b`, `both`, `neither`, `unknown` mapping.
- No second Gemini request is added.

Lexical similarity is never treated as semantic proof. In the explicit regression, a `Science fiction` tag paired with “scientifically rigorous storytelling” renders conservatively as “Would you like to read more Science fiction?” The unsupported meaning does not survive.

## Held-out evaluation

On 15 untouched dimensions, S8.6 mean naturalness was 3.500 and hybrid was 5.000 under the deterministic heuristic (+1.500, +42.86%). Semantic-fidelity and answer-mapping rates were 100% for both. Final warm-process rendering took 0.32 ms for all 15 hybrid cases; repeated cold-process observations ranged into the tens of milliseconds, so this microbenchmark is reported only as negligible relative to network inference and is not a production latency claim. Grounding validity remained 100%, unsupported accepted claims were 0, and additional inference cost was $0.00.

Human evaluation was **NOT PERFORMED**. The scores above are deterministic heuristic scores. Blind samples are in `tests/fixtures/question-wording-blind-rating.json`.

## Representative before/after examples

These are the complete held-out set, not cherry-picked successes.

| Dimension | S8.6 | Hybrid |
|---|---|---|
| grief | Would you enjoy grief? | Do you like stories that explore the theme of grief? |
| memory | Would you enjoy memory? | Do you like stories that explore the theme of memory? |
| class conflict | Would you enjoy class conflict? | Do you like stories that explore the theme of class conflict? |
| environmentalism | Would you enjoy environmentalism? | Do you like stories that explore the theme of environmentalism? |
| coming of age | Would you enjoy coming of age? | Do you like stories that explore the theme of coming of age? |
| rural isolation | Would you enjoy rural isolation? | Do you enjoy stories set in rural isolation? |
| Victorian era | Would you enjoy Victorian era? | Do you enjoy stories set in the Victorian era? |
| near future | Would you enjoy near future? | Do you enjoy stories set in near future? |
| journey motif | Would you enjoy journey motif? | Do you like stories featuring journey motif? |
| forbidden knowledge | Would you enjoy forbidden knowledge? | Do you like stories featuring forbidden knowledge? |
| double identity | Would you enjoy double identity? | Do you like stories featuring double identity? |
| epistolary | Would you enjoy epistolary? | Do you enjoy epistolary storytelling? |
| absurdist | Would you enjoy absurdist? | Do you enjoy absurdist storytelling? |
| solarpunk | Would you enjoy solarpunk? | Would you like to read more solarpunk? |
| Afrofuturism | Would you enjoy Afrofuturism? | Would you like to read more Afrofuturism? |

Development examples include the five reported failures:

- moral ambiguity → “Do you like stories that explore the theme of moral ambiguity?”
- found family → “Do you like stories that explore the theme of found family?”
- slow-burn tension → “Do you enjoy slow-burn tension storytelling?”
- social satire → “Do you like stories that explore the theme of social satire?”
- immersive → “Do you enjoy immersive storytelling?”

## Remaining limitations and failures

The renderer deliberately does not explain or reinterpret unfamiliar labels. “Do you enjoy epistolary storytelling?” may still be obscure. “Do you like stories featuring journey motif?” is grammatical but metadata-like because the preserved Gemini wording itself is merely adequate. “Do you enjoy stories set in near future?” would be smoother with an article, but automatically inserting articles for every unfamiliar place/period label can be wrong. Found-family wording remains less explanatory than a human paraphrase because expanding it to “family-like bonds” cannot be proven from the label alone.

These limitations are preferable to semantic invention. Human ratings or an independently curated semantic paraphrase dictionary would be needed to claim expert-level conversational quality across arbitrary Qloo labels.
