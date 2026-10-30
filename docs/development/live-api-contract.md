# Live API contract (S2 verification)

Evidence from one run of `npm run probe:live` on **2026-10-29**: 6 Qloo requests and 2 Gemini requests,
all real and authenticated. Observations below come from that run. Inferences and recommendations are
labelled as such. Raw responses were not saved. Entity and tag IDs are public catalog identifiers
(no secrets). The sanitized machine summary goes to `.probe/latest-summary.json`, which is git-ignored.

## 1. Qloo

### 1.1 Endpoints and auth (observed)

| Item | Value |
| --- | --- |
| Base URL | `https://hackathon.api.qloo.com` |
| Auth header | `X-Api-Key: <QLOO_API_KEY>` (plus `accept: application/json`) |
| Search | `GET /search` |
| Insights | `GET /v2/insights` |
| Errors seen | none (all 6 requests returned HTTP 200) |

### 1.2 Search

Request: `GET /search?query=Interstellar&type=urn:entity:movie`

- `type=urn:entity:movie` **filters**: all 6 results had `urn:entity:movie` in `types[]`. `types` was not needed and was not tested.
- Result list: `results[]` (top level).
- Selected entity: `057DA9D9-399B-437E-8BCA-A80E499125EF`, name `Interstellar`. Its type was verified from `results[].types[]`.
- Verified field paths, each `results[]…`:
  `entity_id` (string, upper-case UUID), `name`, `types[]` (string URNs), `disambiguation`, `popularity` (number),
  `tags[].tag_id`, `tags[].name`, `tags[].type`,
  `properties.release_year` (number), `properties.release_date`, `properties.description`, `properties.image.url`,
  `properties.short_descriptions[].{language,value}`, `properties.akas[].{language,value}`, `properties.content_rating`,
  `properties.external.{imdb,metacritic,rottentomatoes,wikidata,…}`.
- Latency: 1,814 ms. This was the first call of the run.

### 1.3 Insights (movie → books)

Baseline request:
`GET /v2/insights?filter.type=urn:entity:book&signal.interests.entities=057DA9D9-399B-437E-8BCA-A80E499125EF&take=10`

- Top-level keys: `success` (boolean), `results` (object). Entity list: `results.entities[]`.
- **No request ID in the body.** Response headers were not inspected, so a provider request ID is UNVERIFIED.
- Verified field paths, each `results.entities[]…`:

| Field | Path | Coverage (n=10) |
| --- | --- | --- |
| ID | `entity_id` (upper-case UUID) | 10/10, all unique |
| Name | `name` (often includes the series, e.g. "… (Series, #1)") | 10/10 |
| Type | `subtype` = `urn:entity:book`. A separate `type` string also exists. | 10/10 book |
| Affinity | `query.affinity` (number) | 10/10 |
| Popularity | `popularity` (number) | 10/10 |
| Description | `properties.description`; also `properties.short_description`, `properties.short_descriptions[]` | 10/10 |
| Image | `properties.image.url` | 10/10 |
| Tags | `tags[].id`, `tags[].name`, `tags[].type` (**`id`, not `tag_id`**) | 8/10 have tags (2 have none) |
| Explainability | `query.explainability` (only with `feature.explainability=true`) | 0/10 without, 10/10 with |
| Book extras | `properties.{title,publication_year,publication_date,publisher,page_count,isbn10,isbn13,language,format,series_name}`, `external.goodreads[]`, `external.wikidata[]` | present (per-field coverage not measured) |

- Ordering: results came back in provider order. That order is consistent with descending `query.affinity` (inference: affinity order was not asserted).
- The baseline top 10 mixed sci-fi (Ender's Game, Ready Player One) with many epic-fantasy titles (A Song of Ice and Fire, Kingkiller, Mistborn, Warbreaker, Norse Mythology).
- Latency: 773–837 ms for plain variants; 1,472 ms for `filter.exclude.tags`.

### 1.4 Tag statistics (baseline, 10 books)

- 238 distinct tags, and every one appears on fewer than 10 books, so all of them "split" the shortlist. The top tags appear on 8/10.
- Distinct tags by type: `keyword:qloo` 56, `critical_descriptor:qloo` 28, `motif:qloo` 26, `theme:qloo` 23, `style:qloo` 23,
  `character:qloo` 20, `genre:media` 19, `viewer_characteristic:qloo` 13, `subgenre:qloo` 10, `age_ranges:qloo` 5,
  `book_format:qloo` 4, `media_type:qloo` 3, `narrative:qloo` 3, `genre:qloo` 2, `setting:qloo` 2, `time_period:qloo` 1.
- Most frequent (8/10): `urn:tag:genre:media:adventure`, `…:fantasy`, `…:fiction`, `…:science_fiction_fantasy`. Formats like
  `urn:tag:book_format:qloo:hardcover` and `urn:tag:media_type:qloo:print` also reach 7/10.
- Conclusion: tags are **plentiful but noisy**. Format, media-type and age-range tags are not useful preference questions,
  and 2/10 books have no tags at all.

### 1.5 Signals and exclusions

| Feature | Parameter tested | Verdict | Evidence |
| --- | --- | --- | --- |
| Positive tag signal | `signal.interests.tags=urn:tag:genre:qloo:fantasy` | **SUPPORTED** | HTTP 200. 8 of 10 results replaced (Jaccard 0.111) and 2 reordered. Books carrying the tag rose from 5/10 to 9/10. |
| Entity exclusion | `filter.exclude.entities=4B74CED1-CFA5-4682-B4FB-882B51593459` (baseline #1) | **SUPPORTED** | HTTP 200. The excluded ID was absent; the other 9 stayed in the same relative order and 1 new book filled the slot. |
| Tag exclusion | `filter.exclude.tags=urn:tag:genre:qloo:fantasy` | **SUPPORTED** | HTTP 200. Books carrying the tag went from 5/10 to 0/10; 5 replaced. |
| Explainability | `feature.explainability=true` | **SUPPORTED** | Ranking was identical to the baseline. Per entity: `query.explainability.signal.interests.entities[].{entity_id,score}`. Response level: `query.explainability.signal.interests.entities.effect_on_{top3,top5,top10,all}_recs[].{entity_id,avg_score}`. |
| Signal weights, negative signals | not tested | UNVERIFIED | Weights are documented for POST bodies only. |

Not tested (no budget spent): `types` on search, POST insights, pagination, `take` > 10, 4xx error shapes.

## 2. Gemini

| Item | Observed |
| --- | --- |
| Interface | REST `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| Auth header | `x-goog-api-key: <GOOGLE_API_KEY>` |
| Model | `gemini-3.5-flash-lite` (configured `LLM_MODEL`, echoed back as `modelVersion`) |
| Thinking | No `thinkingConfig` sent; `thoughtsTokenCount` was absent or 0 on both calls |
| Tools | Only the declared functions. No search grounding, no image generation. |

### 2.1 Structured output: PASS

- `generationConfig.responseMimeType = "application/json"` plus `responseSchema`, an OpenAPI-subset mirror of
  `AgentDecision` built by `agentDecisionResponseSchema()`. Also `maxOutputTokens: 1024` and the configured temperature.
- Text from `candidates[0].content.parts[].text` parsed as JSON and passed local `AgentDecisionSchema` validation.
  It chose `action:"ask"` with an offered question ID copied exactly, `reasonCode:"informative_question"`, `done:false`.
- `finishReason: STOP`. Latency 2,246 ms. Tokens: 176 in, 68 out.

### 2.2 Function calling: PASS

- `tools[].functionDeclarations` declared `ask_question(questionId: enum, reasonCode)` and `finish_discovery(reasonCode)`.
  `toolConfig.functionCallingConfig = { mode: "ANY", allowedFunctionNames: [...] }`.
- The response contained a real `candidates[0].content.parts[].functionCall`, not text describing one:
  `ask_question({ questionId: <offered ID>, reasonCode: "informative_question" })`. The args validated.
- `finishReason: STOP`. Latency 1,298 ms. Tokens: 358 in, 40 out.

### 2.3 Usage and cost

| Calls | Tokens (in / out / thought) | Estimated cost |
| --- | --- | --- |
| 2 | 534 / 108 / 0 (642 total) | **$0.00043** |

Pricing basis: $0.30 per 1M input tokens and $2.50 per 1M output tokens (thinking counts as output), from Google's
pricing page for `gemini-3.5-flash-lite`, standard paid tier, checked 2026-10-29. Inference: one agent decision costs
about $0.0002, so the $7 budget is about 30,000 decisions.

## 3. Mismatches with the S1 code (for S3)

1. **Insights tags use `tags[].id`, Search uses `tags[].tag_id`.** `RawTag` in `src/lib/qloo/raw-types.ts` and
   `normalizeCandidate` assume `tag_id`. S3 must accept both, or use separate raw types per endpoint.
2. Search results give types in `types[]`. Insights entities give `subtype` (plus a separate `type` string). S1's
   `normalizeEntity` (`types`) and `normalizeCandidate` (`subtype`) already match this.
3. `RecommendationCandidate.evidence.requestId` is required, but Qloo returns no request ID in the body. S3 should use
   our own per-call request ID (or a response header, if one is verified).
4. Qloo IDs are upper-case UUIDs without a namespace. The S1 schemas accept any non-empty string. Mock IDs stay `mock:`-prefixed.
5. Explainability maps to `evidence.explainability` from `query.explainability`. It only appears with `feature.explainability=true`.
6. S1's `buildQuestionCandidates` would turn all 238 real tags into questions. S5 needs a tag-type allowlist and a cap.
7. `.env.example` previously used a placeholder `QLOO_BASE_URL`. It now holds the verified base URL; that value is not secret.

## 4. Implementation instructions

### S3: live Qloo provider (`createLiveQlooProvider`)

- `searchEntities(q, type)` → `GET /search?query=<q>&type=urn:entity:<movie|book>`. Read `results[]`.
- `getEntity(id)`: **not verified**. Either search and match on `entity_id`, or verify an entities lookup endpoint first.
- `getRecommendations({ seedEntityIds, targetType, take })` → `GET /v2/insights?filter.type=urn:entity:<type>&signal.interests.entities=<comma-separated IDs>&take=<n ≤ 50>&feature.explainability=true`.
  Read `results.entities[]`. Map `query.affinity` to `affinity`, `properties.description` to `description`,
  `properties.image.url` to `imageUrl`, `tags[].{id|tag_id,name,type}` to `tags`, and `query.explainability` to `evidence.explainability`.
- Send the `X-Api-Key` header. Enforce `QLOO_TIMEOUT_MS` with `AbortSignal.timeout`. Do not retry 401/403/402/429; map them to typed `AppError`s.
- Count each HTTP call against `qlooCallCount`. Never fall back to fixtures.
- Inference: since rejected tags work as `filter.exclude.tags`, a re-retrieval after "dislike" answers can exclude them server-side
  instead of only reranking locally. Each re-retrieval costs one Qloo call.

### S5: questions (inference from the tag data)

- Build questions from content tag types: `genre:media`, `subgenre:qloo`, `theme:qloo`, `setting:qloo`, `style:qloo`,
  `motif:qloo`, `time_period:qloo`. Exclude `book_format`, `media_type`, `age_ranges`, `viewer_characteristic`, and probably most of `keyword`.
- 2/10 books have no tags, so keep **grounded entity-comparison questions** (`prefer_a`/`prefer_b` between two real candidates)
  as a fallback. Tag-only questions can never move untagged books.

### S6: Gemini agent

- Use the same REST call and headers. Use `responseSchema` for `AgentDecision`, or function declarations with
  `mode: "ANY"` restricted to the allowed actions. Both passed here.
- Always pass the output through `validateAgentDecision`. Restrict `questionId` with an `enum` of offered IDs, as in the probe.
- Set `maxOutputTokens` (1024 was ample) and enforce `LLM_TIMEOUT_MS`. Log `usageMetadata` for cost accounting.

## 5. Reproducing

See "Live API probe" in the README. The run used `QLOO_MODE=live` and `QLOO_BASE_URL=https://hackathon.api.qloo.com`
set in the process environment, because the local env file holds `QLOO_MODE=mock` and a placeholder base URL.
