# Adaptive Qloo retrieval and merging (S9.11)

S9.11 connects the dormant S9.10 candidate reservoir to TasteProbe's real answer transaction. The feature remains opt-in with `ADAPTIVE_POOL_ENABLED=true`; its default is still `false`.

## Root cause and integration point

Before S9.11, session start retrieved one candidate window, positive answers could retrieve only when Gemini chose the retrieval tool, and that retrieval replaced the old candidates. The answer route already had the correct security boundary: validate the signed revision, acquire the session lease, apply the preference, perform bounded work, and commit once through Redis CAS.

The adaptive controller now runs inside that boundary after `applyAnswer` and before the next agent decision:

1. validate the active question and answer;
2. acquire the existing lease;
3. apply explicit preference evidence;
4. make a deterministic pool decision;
5. validate and deduplicate a query plan;
6. execute at most one Insights request;
7. normalize and merge verified candidates;
8. rank and rebuild grounded questions from the merged universe;
9. commit preference, pool, provenance, budgets, question, and transition together.

When the flag is on, Gemini cannot request a second retrieval for the same answer. When off, the original Gemini-driven behavior and response shape remain unchanged.

## Validated query families

Only two S9.8-verified families are executable:

- `PROFILE_REFRESH`: original verified anchor plus a newly and explicitly preferred candidate entity.
- `TAG_FOCUS`: original verified anchor plus a newly confirmed tag carried by verified Qloo candidates, when local coverage is below the deterministic adequacy threshold.

`BASE` remains start-only. `PAGINATE` and `DIVERSIFY` remain non-executable. No public-documentation assumption is treated as hackathon-provider proof.

Every plan canonicalizes order-insensitive arrays and hashes the endpoint, family, source anchors, destination type, positive entity/tag IDs, exclusions, result limit, explainability flag, and cursor when applicable. Credentials are never included. Attempted hashes live in the Redis session and suppress replay.

## Reservoir merge and scoring

Insights responses pass through the existing strict normalizer. The merge then:

- accepts only the session target type and structurally valid Qloo IDs;
- deduplicates by canonical entity ID;
- retains existing descriptions/images when a later response is sparse;
- unions verified tags without inventing metadata;
- preserves up to eight query origins per candidate, including family, hash, within-query rank, and request ID;
- preserves rejected and pinned history and caps the reservoir at 90;
- evicts lowest fused, unprotected entries deterministically if the cap is reached.

Raw affinities from different queries are not averaged. Cross-query base order uses reciprocal-rank fusion (`1 / (60 + rank)` per verified origin), followed by the existing bounded explicit preference adjustments. Absence from one result window is not treated as negative evidence. Direct recommendation rejection remains a hard display exclusion.

The displayed top five can change by zero to five identities. There is no replacement quota. Existing identities win ties through deterministic origin rank and ID ordering; a newly retrieved candidate enters only when the fused evidence plus confirmed preference is strong enough. The live S9.11 query added three reservoir IDs but promoted no new ID into its top five; an offline running-service scenario proves a justified new ID can enter the top five.

## Question refresh and rounds

After merging, the existing question builder, S5 optimizer, S8.7 renderer, and semantic-dimension filter all read the merged `state.candidates`. Prior answers, asked IDs/dimensions, round number, three-question-per-round cap, presented IDs, rejections, query hashes, origins, and cumulative budgets stay in the same session record. `continue` still spends no Qloo call because it supplies no new positive evidence.

## Failure, concurrency, and budget safety

- Maximum adaptive Insights requests per answer: one, with `maxAttempts: 1`.
- `MAX_QLOO_CALLS_PER_SESSION` remains cumulative and unchanged.
- A spent failed attempt is charged and not automatically retried.
- 400/429/5xx/timeout outcomes preserve the explicit preference and the last verified pool, recording `DEGRADED_KEEP`.
- Budget exhaustion and duplicate query hashes spend zero calls.
- The lease is acquired before planning or network work. Duplicate/stale and concurrent answers cannot produce a second request or commit.
- Production Redis failure prevents lease acquisition and therefore prevents provider spending.

The additive `recommendationUpdate.poolTransition` reports the actual decision, reasons, old/new displayed IDs, new reservoir IDs, displayed additions/removals, Qloo calls, family, outcome, and committed revision.

## Offline comparison

Matched synthetic fixtures measure mechanics only, not user satisfaction:

| Baseline | New IDs | Qloo calls | Unnecessary calls | Duplicate-query rate | Display turnover | Invalid/rejected recurrence |
|---|---:|---:|---:|---:|---:|---:|
| B0 fixed pool | 0 | 0 | 0 | 0 | 0 | 0 |
| B1 fetch after every meaningful answer | 3 | 2 | 1 | 0.5 | 3 | 0 |
| B2 adequacy-gated adaptive | 3 | 1 | 0 | 0 | measured from actual ranker (0–5) | 0 |

The demonstrated improvement is call efficiency and duplicate suppression on this fixture. No preference-quality or satisfaction gain is claimed.

## Bounded live evidence — 2026-10-30

Production `next start`, real Qloo, Upstash Redis, Gemini decision agent, and the real browser UI:

- source: Interstellar, `057DA9D9-399B-437E-8BCA-A80E499125EF`;
- target: `music_artist` (`urn:entity:artist` on the Qloo wire);
- initial verified artists: 8;
- answer: a grounded positive tag answer;
- decision/family: `FETCH_AND_MERGE` / `TAG_FOCUS`;
- follow-up verified universe: 11 IDs;
- new IDs: `2D6B98A8-DCF2-420C-866F-E818BE53F90C`, `EAD9F030-8192-41C1-8EB3-6D8F15254F23`, `73F02D66-E8AF-46CA-8A11-A20DF3B312FB`;
- all 8 initial IDs retained;
- new IDs promoted into this run's top five: 0; one previously hidden verified initial candidate entered;
- revisions: 0 → 1; replay: HTTP 409;
- latency: search 1,481 ms, start 2,356 ms, answer 9,351 ms;
- campaign: 4 Qloo HTTP requests, 2 Gemini requests, estimated Gemini cost $0.0012242 (caps 5 / 2 / $0.01);
- browser result: PASS; screenshot and redacted evidence are in `.artifacts/s9-11-live/`.

A separate offline service scenario demonstrates justified `KEEP` with zero answer-time Qloo calls. The campaign was not repeated merely to obtain a no-change screenshot.

## Feature rollback and limitations

Setting `ADAPTIVE_POOL_ENABLED=false` restores the original path without deleting or corrupting an optional stored pool. Existing sessions without `adaptivePool` continue to parse.

Known limitations:

- pagination and speculative diversification remain disabled;
- the adequacy threshold and rank-fusion smoothing constant are transparent heuristics, not calibrated preference probabilities;
- the live query added reservoir novelty but did not promote a newly retrieved ID into that run's top five;
- no Sound Passport collection, listening feedback, or song choice is implemented here.

## Exact S9.12 integration contract

S9.12 may select a song only after an artist is already authorized by the committed exploration. It must resolve a bounded set of verified YouTube videos belonging to that artist, keep artist and video provenance separate, allow Gemini only to choose among those verified video IDs, validate the selection server-side, preserve the existing resolver/cache/quota rules, and store listening feedback separately from artist-level rejection. It must not reinterpret a track skip as rejecting the artist, mutate the S9.11 query profile without an explicit artist-level action, or allow a generated title/channel/ID to enter playback.
