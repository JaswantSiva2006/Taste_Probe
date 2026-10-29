# Cross-domain discovery engine (S9.3)

Baseline `72b6d07` (S9.2) on `seg/S9-3-cross-domain-engine`. All live evidence below was gathered on 2026-10-29 in one bounded campaign. Nothing here is extrapolated.

## 1. Implementation summary

TasteProbe now has **one** discovery engine for any directed pair of six cultural domains. A request moves through the same orchestrator whatever the pair:

```
Search (registry source type) → explicit selection → typed re-resolution of the selected ID
→ registry pair gate → Insights (registry target filter.type) → normalize + reject wrong types
→ S5 questions (registry wording) → S6 bounded agent → answer → preference update
→ local rerank / Qloo reretrieval → finish → S9.2 Discovery Path
```

There are no per-pair controllers, handlers or runtime branches. Behaviour that differs by domain lives in four places:

1. **The registry** (`src/lib/contracts/capabilities.ts`): wire types, nouns, verbs, narrative flag, tag-question template, capability levels, pair evidence and enablement.
2. **One normalization rule** (`src/lib/discovery/normalize.ts`): a result is classified by an exact registry URN in `subtype`, then `type`, then `types[]`. Anything else is rejected, never coerced.
3. **Domain-aware wording** (`questions.ts`, `question-generation/renderer.ts`, and the proposer prompt): every phrase comes from the registry, and only narrative domains may be called "stories".
4. **Presentation copy**: the Discovery Path text uses `domainLabel(target)`.

What changed, and where:

- **`capabilities.ts`.** It now covers six domains, all 30 directed pairs, and separate capability levels for each. It adds `tagQuestionText`, a verification allow-list helper (`pairAccess`), and a startup integrity check.
- **`config/env.ts`.** `VERIFICATION_PAIRS` is an isolated, non-production allow-list (see §8).
- **`discovery/service.ts`.**
  - The pair gate now goes through `pairAccess`.
  - The selected source ID is re-resolved with a **typed** Search for the source domain.
  - There is a new `insufficient_question_evidence` finish reason.
  - Every turn and finish log carries pair-aware telemetry.
- **`discovery/live-turn.ts` and `normalize.ts`.** `normalizeTargetCandidates` rejects and counts wrong-type results, and the count goes to telemetry.
- **`qloo/live-provider.ts` and `raw-types.ts`.** Insights keeps the verbatim `type` and `types[]` alongside `subtype` for classification.
- **Wording files** (`questions.ts`, `renderer.ts`, `proposer.ts`, `question-quality.ts`). Wording is now driven by the registry; book and movie output is byte-identical to before.
- **`api.ts`.** The `insufficient_question_evidence` finish reason was added, an additive enum value.
- **Scripts.** `smoke-live.mjs` is parameterized by pair and checks the Discovery Path, replay and revisions. `probe-cross-domain.test.ts` is a bounded Qloo-only probe.
- **Tests.** `tests/integration/cross-domain-matrix.test.ts` is new, and the capabilities, routes and contracts tests were updated.

## 2. Domains, Qloo types and capability levels

The levels are kept separate: Search source, Insights target, session adapter, pair evidence, pair enabled.

| Domain | Qloo wire type | Search (source) | Insights (target) | Session adapter | Wording |
|---|---|---|---|---|---|
| `movie` | `urn:entity:movie` | **LIVE** (S2, S9.3) | documented only | yes | narrative, "watch" |
| `book` | `urn:entity:book` | documented only | **LIVE** (S2, S9.3) | yes | narrative, "read" |
| `music_artist` | `urn:entity:artist` | **LIVE** (S9.1, S9.3) | **LIVE** (S9.3) | yes | non-narrative, "listen to" |
| `tv_show` | `urn:entity:tv_show` | **LIVE** (S9.3 probe) | **LIVE** (S9.3 probe) | yes | narrative, "watch" |
| `video_game` | `urn:entity:videogame` | **LIVE** (S9.3 probe) | **LIVE** (S9.3 probe) | yes | non-narrative, "play" |
| `podcast` | `urn:entity:podcast` | **LIVE** (S9.3 probe) | **LIVE** (S9.3 probe) | yes | non-narrative, "listen to" |

Observed response shapes:

- Search returns the specific kind in `types[]`, for example `["urn:entity:videogame"]`.
- Insights returns it in `subtype`, while its `type` field is the generic `urn:entity`. That is why `subtype` is checked first and `urn:entity` never matches.
- Qloo spells two types differently from the product names: `artist` (not `music_artist`) and `videogame` (not `video_game`). Only the registry knows this.

## 3. Pair capability matrix

| Pair | Evidence | Enabled |
|---|---|---|
| movie → book | `FULL_E2E_VERIFIED` (S7/S9 reference; not rerun live in S9.3, see §6) | **yes** |
| music_artist → book | `FULL_E2E_VERIFIED` (S9.3 live session) | **yes** (new) |
| movie → music_artist | `FULL_E2E_VERIFIED` (S9.3 live session) | **yes** (new) |
| movie → tv_show | `FULL_E2E_VERIFIED` over HTTP in S9.5 (see `docs/live-browser-verification.md`); browser journey not yet run | no |
| movie → video_game, movie → podcast | `VERIFIED_INSIGHTS` (live Search + Insights, no session) | no |
| The other 24 directed pairs | `OFFLINE_MATRIX` (engine behaviour with fixtures only) | no |
| Same-domain pairs, unknown domains | unregistered | never |

`OFFLINE_MATRIX` is **not** live coverage. It proves that the engine handles the pair correctly given Qloo-shaped data. It says nothing about whether Qloo returns useful results for that pair.

## 4. Offline verification

`tests/integration/cross-domain-matrix.test.ts` has 53 tests. They run through the real live orchestrator: sessions, the S5 optimizer, the deterministic bounded agent (`LLM_PROVIDER=none`) and a Qloo-shaped fixture provider.

**All 30 directed pairs.** Each pair is run as Search → Start → Answer → Finish → Discovery Path and passes. Each run asserts:

- the source Search type and the target `filter.type` are the registry URNs;
- the seed is the selected verified ID;
- every result is of the target domain, keeps its fixture ID, has `qloo` provenance, and the wrong-type decoy is rejected;
- the question text equals the registry template with the verified label, and non-narrative targets contain no story or reading words;
- `like` produces a positive preference, `unknown` produces none, and revisions run 0 → 1 → (2) → finish;
- `discoveryPathProblems` is empty, START HERE is the top result, and the copy names the target domain with no "books" for non-book targets;
- no Qloo exclusions are ever sent, and the Qloo budget holds.

**Per target domain (6 each):**

- Sparse metadata (one untagged candidate with no description or image) gives a truthful early finish, `insufficient_question_evidence`, with no question and a START HERE-only path. Missing fields stay missing.
- Untagged candidates fall back to grounded A/B comparisons between returned entities, never to filler.
- Empty Insights, or Insights containing only the wrong type, give `NO_RECOMMENDATIONS`, never fabricated results.

**Safety:**

- Every disabled pair is rejected before any provider call.
- Ambiguous names need explicit selection.
- Arbitrary or cross-domain IDs are refused (`ENTITY_NOT_FOUND`, `ENTITY_TYPE_MISMATCH`).
- Negative answers stay local.
- A stale token causes no provider work.
- The classifier accepts only exact URNs; `urn:entity:music_artist` and `urn:entity` are rejected.

**Full suite:** 394 passed, 4 skipped. The 4 skips are the same pre-existing live-only tests; there are no new skips. Lint has 0 errors, and typecheck, build, `smoke:mock`, `evaluate:questions`, `evaluate:question-quality` and `evaluate:question-wording` all pass.

## 5. Live verification (bounded campaign, 2026-10-29)

| Run | Qloo | Gemini | Est. cost | Result |
|---|---:|---:|---:|---|
| music_artist → book, Coldplay (`smoke-live.mjs`, Redis) | 3 | 2 | $0.001213 | **PASS** |
| movie → music_artist, Interstellar (`smoke-live.mjs`, Redis) | 3 | 2 | $0.001223 | **PASS** |
| Capability probe (`probe:cross-domain`, no Gemini, no retries) | 6 | 0 | $0 | **PASS** |
| **Total** (limits 14 / 4 / $0.05) | **12** | **4** | **$0.002436** | 2 Qloo unspent |

Both sessions used `next dev` in live mode with real Qloo, the real Gemini agent (`gemini-3.5-flash-lite`, `LIVE_GEMINI` decisions) and the configured **Upstash Redis** store. Each pair was admitted only through `VERIFICATION_PAIRS`, and `/api/health` did not list either pair during its run.

**Music artist → books (Coldplay `B6FA456F-…`).**

- Search returned 8 artists with 1 exact match, and the selection was re-resolved by typed Search.
- Insights returned 8 books, with description 8/8, image 8/8 and tags on 5/8.
- Gemini asked the approved S5 question "Do you enjoy History books?" (`valid`).
- The answer `dislike` caused a `LOCAL_RERANK` with no Qloo call. The replayed revision-0 token got HTTP 409.
- Finish reached revision 2 with 5 grounded books. The path was START HERE #1 and EXPLORE NEXT #2 (both provenance-only) and ANOTHER DIRECTION #5, which contrasts on the tag “Biography Memoir”.
- Session usage was 1 of 6 Qloo budget calls and 2 Gemini calls.

**Movie → music artists (Interstellar `057DA9D9-…`).**

- Insights returned 8 artists (`subtype urn:entity:artist`, 0 rejected), all with descriptions, images and tags.
- Gemini asked "Do you enjoy music artists associated with Minimalist?", which is the new artist wording.
- The answer `dislike` caused a `LOCAL_RERANK`, and the replay got 409.
- Finish reached revision 2 with 5 artists (Jóhann Jóhannsson, Goldmund, Shawn Mendes, Max Richter, Ólafur Arnalds). The path was START HERE, EXPLORE NEXT (contrast on “New Age”) and ANOTHER DIRECTION (contrast on “Charismatic”).

**Probe.** Insights from Interstellar:

| Target | Returned | Correct subtype | Description | Image | Tagged | Sample question |
|---|---|---|---|---|---|---|
| TV shows | 10 | 10 | 10/10 | 10/10 | 10/10 | “Do you enjoy Adventure TV shows?” |
| Video games | 10 | 10 | 10/10 | **3/10** | 10/10 | “Do you enjoy Action video games?” |
| Podcasts | 10 | 10 | 10/10 | 10/10 | 10/10 | “Would you be interested in podcasts about After Shows?” |

Search found exact matches with the correct type: Breaking Bad (TV, 2008), Minecraft (`urn:entity:videogame`, 2011) and Serial (podcast, no year).

**Not exercised live in S9.3:**

- A *positive* answer that triggers Qloo reretrieval with artist-domain tag IDs. Both runs answered negatively to stay within 2 Gemini calls per session; the reretrieval code is shared with the verified movie → book flow.
- Book as a source, since book Search is still documented only.
- Any pair whose source is TV, a game or a podcast.
- A full session for the three `VERIFIED_INSIGHTS` pairs.

## 6. Movie → books regression

The only change on this path is that the selected ID is now re-resolved with `type=urn:entity:movie`. That typed Search was verified in S2 and again live in both S9.3 runs (Interstellar search, and Coldplay re-resolution). Book wording, ranking, normalization and the Discovery Path are byte-identical; all existing route, orchestration, smoke and evaluation tests pass. To respect the budget, a live movie → book session was **not** rerun. Its evidence is the S9 production smoke plus the offline gates.

## 7. Questions, early finish and runtime outcomes

- **Questions.** Tag questions use the registry template with the verified label inserted verbatim:

  | Target | Template |
  |---|---|
  | book | “Do you enjoy {label} books?” |
  | movie | “Do you enjoy {label} movies?” |
  | music artist | “Do you enjoy music artists associated with {label}?” |
  | TV show | “Do you enjoy {label} TV shows?” |
  | video game | “Do you enjoy {label} video games?” |
  | podcast | “Would you be interested in podcasts about {label}?” |

  - For non-narrative targets, the renderer's own deterministic fallback, its list of accepted LLM wordings, and the proposer prompt all exclude "stories", "storytelling" and reading verbs.
  - Entity comparisons use the target noun.
  - No mapping of tags across domains was added: preferences only touch candidates that carry the exact tag ID.
- **Early finish.** If the verified candidates support no grounded question (fewer than two candidates, or nothing left to ask), the session finishes immediately with `finishReason: "insufficient_question_evidence"` and still returns its grounded results and path.
- **Runtime outcomes**, mapped to the skill's categories through existing error conventions:

  | Skill category | What the API returns |
  |---|---|
  | UNSUPPORTED_PAIR | `400 UNSUPPORTED_DOMAIN` (also for a disabled source in typed Search) |
  | NO_SOURCE_MATCH | `404 ENTITY_NOT_FOUND`, `400 ENTITY_NOT_RESOLVED` (ambiguous or unselected), `400 ENTITY_TYPE_MISMATCH` |
  | NO_CANDIDATES | `422 NO_RECOMMENDATIONS`, including when every result was the wrong type (logged as `discovery.no_candidates` with `normalizationRejected`) |
  | INSUFFICIENT_QUESTION_EVIDENCE | a finished view with that `finishReason`, not an error |
  | UPSTREAM_FAILURE | the existing `QLOO_*` codes; a failed reretrieval mid-session keeps the verified list and marks the response `degraded` |

## 8. Session, security and budgets

- **Sessions.** `TasteSession` v1 and token v2 are unchanged. `sourceType` and `targetType` use the registry-derived `EntityTypeSchema`, and older movie/book sessions still parse. Redis CAS, leases, revisions, replay rejection and expiry are untouched, and replay was re-verified live with HTTP 409.
- **Pair gate.** It runs before any paid work. A browser cannot enable a pair:
  - the request schema is `.strict()`;
  - `VERIFICATION_PAIRS` is server configuration only, causes a `CONFIG_ERROR` in production, may list only registered *disabled* pairs, and never appears in `/api/health`;
  - unregistered pairs can never be admitted.
- **Arbitrary IDs.** An ID is accepted only after re-resolution through typed Search or `getEntity` and a type check.
- **Answers.** `unknown` creates no preference. Negative answers stay local penalties and are never sent as Qloo exclusions.
- **Budgets unchanged.** `MAX_QUESTIONS=3`, `MAX_QLOO_CALLS_PER_SESSION=6`, `MAX_AGENT_TOOL_CALLS_PER_TURN=3` and the rate limits (30/10/30 per 10 minutes) are as before. The question-generation mode was left at the configured `deterministic`.
- **Telemetry.** `discovery.turn` and `discovery.finish` now carry `sourceType`, `targetType`, `capability` (`enabled` or `verification`), `candidateCount`, `questionCount`, `finishReason`, `normalizationRejected` and, when finished, `recommendationCount` and `discoveryPathCount`. `discovery.pair_rejected` and `discovery.no_candidates` record refusals. Correlation IDs and redaction are unchanged, and no tokens, prompts or credentials are logged.

## 9. Known limitations

- The UI still offers only movie → books and hard-codes film/book copy. The engine and API support the three enabled pairs; S9.4 must expose them.
- Video game images are sparse (3/10 in the probe), so the UI needs a no-cover fallback that isn't book-specific.
- Podcast tags in the probe leaned toward format and genre (“After Shows”), and S5's tag filter was not tuned for podcasts or games.
- The live sessions answered negatively, so positive artist-tag reretrieval is verified offline only.
- `movie → book` was not rerun live in S9.3 (§6).
- The three `VERIFIED_INSIGHTS` pairs and all 24 `OFFLINE_MATRIX` pairs stay disabled.

## 10. S9.4 UI integration requirements

1. **Data source.**
   - Read `GET /api/health` → `data.capabilities.pairs`, which today lists movie→book, movie→music_artist and music_artist→book.
   - Build the target picker and source picker only from those pairs, using `sourceLabel` and `targetLabel`; never hard-code domains.
2. **Search and start.**
   - Search with `type=<source>`.
   - Make the user pick an exact result: duplicate names are common, e.g. 20 "Breaking Bad" results.
   - Send the start request with `sourceType`, `targetType` and `selectedEntityId`.
3. **Result display.**
   - Render results by `candidate.entityType` and treat every metadata field as optional; artists and games have no author, cover or year guarantees.
   - Copy (“shelf”, “screening”, “books”) must come from the labels.
4. **Finish and errors.**
   - Handle `finishReason: "insufficient_question_evidence"` as a valid result (“We went straight to your picks”).
   - Map `UNSUPPORTED_DOMAIN` and `NO_RECOMMENDATIONS` to distinct recoverable messages.
5. **Finale.** Use `discoveryPath` as specified in `docs/discovery-path-contract.md`, unchanged.

## 11. S9.5 verification priorities

1. Full live sessions (with a *positive* answer, so reretrieval is exercised) for `movie → tv_show`, `movie → video_game` and `movie → podcast`. Promote each with a one-row `PAIR_STATUS` change on PASS.
2. Run `smoke-live.mjs` with `SMOKE_SOURCE=music_artist` and a positive answer to cover artist-tag reretrieval.
3. A book-source Search probe, then `book → music_artist` and `book → movie`.
4. Non-movie sources (`tv_show`, `video_game`, `podcast`).
5. One live movie → book rerun against the production build (`smoke:production`) before deployment.

Each step is `SMOKE_SOURCE=… SMOKE_TARGET=… SMOKE_QUERY=… npm run smoke:live`, with the per-run caps `SMOKE_MAX_QLOO` and `SMOKE_MAX_GEMINI`.
