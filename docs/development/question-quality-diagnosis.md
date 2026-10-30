# S8.6 question-quality diagnosis

Baseline: commit `892ce49` on `seg/S8-5-llm-question-quality`. Measurements below were taken before S8.6 code changes with `npm run evaluate:questions`, `npm run evaluate:question-quality`, and the question-generation/optimizer unit tests.

## Baseline evidence

- The fixture-backed S5 run had 6 candidates, 7 eligible questions, and selected `tag:mock:tag:hard-science-fiction` with J=0.672483. Its interpretability was the hard-coded 0.90 and ambiguity the near-constant 0.05.
- The 20-case S8.5 comparison reported deterministic mean top J=0.667945 and grounded mean top J=0.667945. Half of generated proposals passed; 12 unsupported proposals and 4 duplicates were rejected. The benchmark reused one six-book pool and five proposal patterns, so it did not establish semantic quality.
- `buildQuestionEvidence` can pass 30 ranked candidates, 8 useful tags per candidate, and 180 description characters. The S6 context is separately limited to 8 candidates, but that does not constrain the question proposer.
- The live retrieval requests `MAX_RECOMMENDATION_CANDIDATES` (default 30), normalization applies the same cap, and then target type/provenance filters can reduce the actual pool. Therefore `take=30` is only a request ceiling, not proof that 30 items reach Gemini.

## Hypothesis findings

| Hypothesis | Evidence and finding | Impact | Intervention and test |
|---|---|---|---|
| H1: validator destroys nuance | **Confirmed.** `canonicalTagQuestion` and `canonicalEntityQuestion` ignore `proposal.questionText` and always rebuild `Do you enjoy … books?` or `Which book sounds more appealing …?`. Unit tests explicitly expect this replacement. | Very high: valid natural wording cannot survive validation, making many LLM/baseline pairs identical. | Add a narrowly constrained renderer that preserves only wording whose intent, exact verified targets, and answer semantics can be proven; fall back to canonical wording. Test malicious/unsupported wording and valid variants separately. |
| H2: evidence rules favour simple questions | **Confirmed.** Schema supports only one-tag or two-entity mappings. `preferenceDimension` must equal one tag name for tag questions. No typed contrastive or compound intent exists, so all multi-attribute semantics are rejected or collapsed. | High, but loosening it now would be safety-sensitive. | Keep compound/contrastive support out of production until a typed mapping exists. Benchmark category-diverse single-tag and entity proposals first; record multi-attribute as an isolated rejected experiment. |
| H3: optimizer favours generic categories | **Confirmed.** J gives 40% to entropy; broad tags near a 50/50 carrier split maximize it. All tag questions receive interpretability=0.90 regardless of wording or label quality. The baseline winner had entropy=0.999957. | Very high: generic but balanced labels dominate. | Test semantic-quality adjustment and order-aware counterfactual distance without replacing hard grounding. Compare selection changes and discrimination, not J alone. |
| H4: insufficient input diversity | **Partly confirmed.** The proposer can see up to 30 candidates, but each candidate is truncated to its first 8 useful tags and 180 description characters; there is no tag-frequency summary or diversity-aware tag selection. Candidate order is purely ranking order. | Medium: available context can be repetitive even when the provider returns diverse metadata. | Compact descriptions, deduplicate/choose tags across the pool, expose carrier frequency, and request fewer category-balanced proposals. Measure prompt size and proposal diversity. |
| H5: poor prompt design | **Confirmed.** The prompt asks for 10–15 “diverse” proposals but defines no slots, stage policy, preference rationale, or natural wording rubric. It simultaneously requires exact tag-name dimensions, encouraging tag templates. | High. | Compare concise category-balanced prompts with 5 and 8 proposal caps against the 15-proposal baseline using identical offline inputs. |
| H6: weak semantic evaluation | **Confirmed.** Tag interpretability is constant 0.90; tag ambiguity is 0.05 unless text exceeds 100 characters. Neither detects mechanical wording, vague labels, or broad genre confirmation. The prior benchmark had no semantic scorer or human rating. | Very high: selection and evaluation cannot observe the stated objective. | Add an auditable deterministic 1–5 rubric for clarity, naturalness, answerability, relevance proxy, and preference usefulness. Keep it labeled heuristic; generate a blind sheet for optional human review. |
| H7: candidate-pool limitations | **Partly confirmed.** The configured retrieval/generation caps are 30, but actual normalized candidates may be fewer after provider response, duplicate removal, malformed-entry removal, type filtering, and provenance filtering. Existing sanitized Qloo fixture has only one usable unique book plus sparse/malformed entries; the mock benchmark has six. | Medium/high and currently under-measured. | Record requested, normalized, and evidence candidate counts. Exercise benchmark pools from 3 to 30. Report actual live counts rather than inferring them from `take`. |
| H8: selection bottleneck | **Confirmed.** The complete valid pool is optimized by J, but the trace records only the winner. S8.5’s equal top score and identical questions show generation did not change selection. For tag questions, constant semantic components make entropy/separation the effective selectors. | Very high. | Persist per-configuration pool metrics in the offline ledger, add quality-aware selection as an isolated variant, and inspect all held-out winners and rejected proposals.

## Root-cause priority

1. Canonical rendering erases valid wording (H1).
2. The objective cannot distinguish semantic quality and rewards balanced broad tags (H3/H6/H8).
3. The prompt requests unstructured quantity rather than evidence-supported diversity (H5).
4. Context and actual candidate counts are bounded but not diversity-aware or adequately measured (H4/H7).
5. Richer compound questions need a new answer contract and are not safe to rush (H2).

## Baseline decision

The S8.5 feature remains non-default. Hard grounding and deterministic fallback are retained. S8.6 experiments will change one component at a time on development scenarios, then evaluate only the retained combination on the held-out set. No LLM-judge result will be represented as a human rating; the initial campaign uses deterministic heuristics plus a blind human-rating artifact.
