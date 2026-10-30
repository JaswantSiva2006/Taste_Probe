# S9.16R completion report — discovery supply intelligence

**Status: DONE for the bounded supply/repetition repair. Recommendation: READY FOR CONTROLLED DEPLOYMENT.** No deployment, merge or push was performed. This does not upgrade S9.16's unverified audio-understanding or human-preference claims.

Starting commit: `024d3054c4f60f04d985288424ee02efea670f37`.

Branch: `seg/S9-16R-discovery-intelligence`.

Final commit: the commit containing this report, titled `S9.16R: fix adaptive discovery supply and artist repetition loops` (`git log -1` on this branch). The final response supplies its exact SHA.

## Actual diagnosis and baseline

The reported source was Dua Lipa. No unexpired original session remained in Redis and no retained local artifact contained that journey. Its original returned/stored/playable ID counts therefore cannot be reconstructed honestly. The user's observation is not treated as evidence that Qloo returned only two artists.

Verified local configuration at the start:

| Setting | Observed |
|---|---|
| `MAX_RECOMMENDATION_CANDIDATES` | **8**, explicitly overriding the former default 30 |
| `ADAPTIVE_LISTENING_ENABLED` | true |
| `ADAPTIVE_POOL_ENABLED` | true |
| `MAX_QLOO_CALLS_PER_SESSION` | 6, unchanged |
| `YOUTUBE_SEARCHES_PER_EXPLORATION` | 2, unchanged |
| `YOUTUBE_DAILY_SEARCH_MAX` | 40, unchanged |
| Gemini allowance | Existing cumulative 20/exploration, unchanged |

Public GitHub main was independently read at `e9167c4b2579abb9ffb76073d970d2790e84690f`, while local HEAD contained S9.16. Public Vercel health reported live mode, configured Redis and `gemini-3.5-flash-lite`; it did not expose deployed SHA or feature flags. The exact deployed commit/flag values remain unverified. No production configuration was changed.

The code audit identified these concrete bottlenecks:

1. **Eight acquired artists locally.** The provider accepted a larger `take`; the local override constrained recall before any song ranking.
2. **One artist per dynamic search.** With two allowed searches, an unmapped cultural neighborhood could become a two-playable-artist neighborhood. A large artist reservoir could not repair this by itself.
3. **Eager spending.** The S9.16 inventory loop could spend its two searches even when reviewed playable options were already sufficient.
4. **Late replenishment.** Qloo supply work ran only at complete recording exhaustion and skipped Love/Up Next shortage. It did not have an explicit playable-runway controller.
5. **Misleading catalog coverage.** `TAG_FOCUS` adequacy counted artist entries rather than artists with unseen playable recordings, allowing an unplayable catalog to suppress useful retrieval.
6. **Permanent session suppression and lost reasons.** Resolutions collapsed to empty arrays and generic unavailable IDs, losing cache/quota/temporary-failure distinctions and retry timing.
7. **Inventory clipping.** A 180-option inventory could discard recordings from a legitimate 90-artist, six-options-per-artist reservoir.
8. **Weak recent concentration control.** Lifetime novelty did not separately represent recent artist share, consecutive exposure and artist-specific negative pressure.
9. **History compaction.** Track-to-artist inference depended on the last 100 encounters; long-lived explicit reactions needed their own artist references and bounded retention.

The automatic selector already considered hidden candidates; no hidden top-five restriction was found in the main listening path. The visible top five is a presentation limit. Old flag-off listening behavior can still be narrower by design. No production frontend stale-subset bug was established.

Before editing ranking, an offline service reproduction using genuine retained Interstellar identities and controlled resolver availability stored **14 artists**, but only **two artists/five videos** were playable. It served those five and exhausted honestly. This reproduced the supply bottleneck, not the unavailable historical Dua Lipa session.

## Live candidate acquisition: six separately authorized requests

The user explicitly authorized a **new six-HTTP-request Qloo allowance**. The previous S9.14 ledger remains untouched at **18/18**. Reservations were persisted before requests, with no date reset, and all six returned HTTP 200.

Verified source: Dua Lipa, `1D792A35-7D72-4D57-88D0-C3A4F3E73EF6`.

| Request | Returned artist IDs | New versus base | Additional checks |
|---|---:|---:|---|
| Search: exact artist identity | one selected verified identity | — | Explicit artist domain |
| BASE, `take=50` | **50** | 50 | 50 normalized/unique; no source echo |
| PROFILE_REFRESH | 50 | **10** | Original anchor + verified artist; zero wrong types/source echoes |
| TAG_FOCUS | 50 | **0** | Actual returned Qloo tag; zero wrong types/source echoes |
| Exclude first ten base IDs | 50 | **10** | **Zero excluded IDs returned** |
| `page=2`, `take=50` | 50 | **50** | Disjoint from base; zero wrong types/source echoes |

The reported neighbors were genuine members of the fresh base response: Harry Styles (`5D28EDAC-F84F-42EB-8DB3-28EC65330287`, rank 2) and Camila Cabello (`AE8A7A8E-A9C6-42E4-9204-A3D15E933D63`, rank 6). They were not the whole returned universe.

The [official Qloo reference](https://github.com/qloo/docs-public/blob/main/reference/insights-api-deep-dive.md) documents `take` up to 50, `page`, and entity exclusions. These parameters were enabled only after the active hackathon endpoint verified them. Geographic `diversify.by` remains disabled; it is not musical diversity. The active-host gate does not assume a custom Qloo endpoint has the same verified supply capabilities.

The default and `.env.example` candidate limit are now **50**. The local ignored `.env` override was changed from 8 to 50; no secret value or provider-call allowance was changed. Production must explicitly review its own setting during promotion.

## Three inventories and the supply controller

`src/lib/music/supply.ts` separates:

- Verified artist catalog/reservoir.
- Currently verified playable artist–video pairs.
- Unseen, eligible recording runway.

`SessionState.acquisition` records returned/normalized counts and per-ID normalization losses. `listening.supply` records bounded resolution outcomes, exact reasons, lookup provenance, check/retry times, counts, selection IDs and per-artist exclusions. Codes distinguish wrong type, source exclusion, explicit artist rejection, presented video, negative cache, cache miss, deferred batch coverage, temporary failure, quota exhaustion and never-resolved candidates. Scores are never shown as confidence probabilities.

The pure controller chooses `KEEP_SUPPLY`, `LOCAL_RESOLVE`, `FETCH_ARTISTS`, `DEGRADED_KEEP` or `EXHAUSTED`; local promotion and multi-video expansion are effects of verified local resolution rather than artificial mandatory transitions. The contract also reserves `LOCAL_REPLACE` and `EXPAND_VERIFIED_VIDEO_OPTIONS` for explicit diagnostic use.

The recording runway target scales with eligible artist count: `min(6, max(2, ceil(sqrt(n))))`. Breadth also requires unseen artists up to `min(recordingTarget, max(1, ceil(log2(n+1))))`; many songs from two weakly fitting artists cannot masquerade as broad runway. Adequate local runway, or an available strong local score (at least 0.35), takes the fast path. These thresholds are heuristics, not calibrated taste probabilities. All known verified pairs are ranked; no artist turnover or provider call is forced.

Free reviewed inventory is inspected first. Cache-only peeks inspect at most six unresolved artists per turn, in parallel; they spend no YouTube quota. Cache misses are distinct from negative results and are not repeatedly peeked for 60 seconds. If local supply needs resolution, at most two bounded batch lookups run, still subject to the shared quota guard. Definite negative outcomes retain cooldowns, temporary failures may retry after 30 seconds, and quota refusals suppress further lookup attempts for the exploration. No uncontrolled background work or automatic retry loop is added.

When useful supply is low and no preferable local/lookup path remains, the existing adaptive controller considers confirmed PROFILE_REFRESH/TAG_FOCUS signals using **playable coverage**. It can then use the newly verified source-preserving exclusion refresh or page continuation. Retrieval exclusions mean unavailable/exhausted supply, never an inferred artist dislike. Plans remain canonical, deduplicated and bounded by the existing cumulative Qloo allowance. Two zero-yield supply queries stop further blind expansion. One supply retrieval attempt is allowed per listening turn, including recursive inventory refresh.

Both adaptive flags are required for listening-driven Qloo refresh. Listening ranking works with `ADAPTIVE_LISTENING_ENABLED=true` alone; missing old-session pool state is initialized lazily when the pool flag is enabled. Turning both flags on indiscriminately is unnecessary.

## Multi-artist YouTube resolution

The [official search API](https://developers.google.com/youtube/data/reference/rest/v3/search/list) supports Boolean OR queries. The new optional `lookupBatch` queries up to **six authorized Qloo artist names**, requests at most 30 music/embeddable results, and verifies the resulting videos in one video-list batch.

Every accepted video still requires:

- Exactly attributable canonical Topic/VEVO channel for that artist.
- Unambiguous Qloo artist name within the batch.
- A video ID actually returned by that search.
- Matching search/video channel ID.
- Public and embeddable video status.
- Existing independent title corroboration and impersonation rejection for VEVO.

A self-described channel or unreviewed label channel is not accepted. Reviewed artist/label mappings are unchanged. No popular-artist mappings or names were added to production code. No recording ID was invented.

Up to six options per verified artist are retained. Positive batch outcomes use the existing 24-hour per-artist cache. An artist missing from an OR query is **deferred**, not declared unavailable and not inserted into the six-hour negative cache. Existing single-artist lookup and negative-cache policy remain available. Expired cache entries cannot suppress or authorize a new recording.

This improves search yield without increasing the two-search exploration limit or forty-search UTC-day cap. It does not guarantee coverage for every artist/channel/script or a minimum catalog size.

## Global ranking, learning and no-repeat behavior

S9.16's anchor relevance, confirmed question fit, supported track-feature seam, tentative artist-tag transfer and lifetime novelty remain. Raw affinities from different requests are not compared.

The additional MMR-style soft redundancy penalty is:

```
0.24 * recentArtistShare
+ 0.08 * min(1, consecutiveArtistCount / 3)
+ 0.18 * (artistTrackDislikes / (1 + artistTrackReactions))
+ 0.06 * recentVerifiedArtistTagOverlap
```

Recent context covers eight encounters. Shared tags cause only a bounded soft penalty, never exclusion or invented audio similarity. The original score can outweigh the penalty; a strongly preferred artist can remain appropriate. No random choice, fixed artist rotation, or Dua Lipa-specific rule exists.

Artist exposures are stored independently from the short UI history. Exact track reactions retain their own artist IDs and latest state for up to 600 encountered recordings. Canonical seen video IDs survive round changes, merges and encounter-log compaction. At the lifetime bound, automatic discovery exhausts rather than forgetting IDs and replaying them. Explicit authorized replay remains available.

Love updates taste and prepares Up Next while retaining the current recording; it does not save or endorse the artist. Not for me updates exact-track evidence and automatically selects the next verified pair. Next remains neutral. Artist rejection remains explicit. Gemini's existing top-six comparison is retained; its selection must satisfy verified-ID/evidence checks, score/explicit-answer guards, and the additional diversity-penalty guard. No audio facts are inferred from titles.

No new multimodal enrichment, musical annotation or semantic taste-reasoner claim is made in this repair.

## Live playable-supply and browser evidence

The retained, newly verified 50-artist Dua Lipa response was placed in an isolated real Redis session, with real quota-protected YouTube resolution and Gemini disabled. No additional Qloo request was permitted during this test.

| Metric | Observed |
|---|---:|
| Qloo artists returned / normalized / stored | **50 / 50 / 50** |
| Playable artists discovered | **9** |
| Verified unique video IDs | **40** |
| Dynamic search requests | **2** |
| Video-validation requests | **2** |
| Playable artist yield per search | **4.5**, across this two-request sample |
| Verified-video yield per search | **20**, across this sample |
| Direct service trajectory | 20 distinct encountered IDs across 6 artists; more supply remained |
| Retained-provider browser trajectory | **21 distinct presented IDs across 9 artists** for initial listen + 20 dislikes |
| Automatic repeated video IDs | **0** |
| Actual model requests in S9.16R | **0** |

The retained browser used the actual frontend, real Redis, cached verified provider metadata and the official visible YouTube player. Its Qloo HTTP boundary replayed the recorded authoritative response: it was **not a fresh paid Qloo browser journey**. Its YouTube search caps were set to zero in that test child, ensuring cache-only resolution and no extra Data API requests. Playback, Love without interruption, automatic transitions without autoplay, exact Save, Finish and Passport persistence passed **47/47 checks**. It exercised more than the originally reported two artists without adding recordings by hand.

A separate browser run using reviewed genuine identities and a local provider fixture passed **47/47**, presenting 21 distinct IDs across 14 artists. Neither run is human listening or a taste-satisfaction study. The official player reported PLAYING; no human audio assessment is claimed.

## Quantitative comparison and generalization

The matched ranking benchmark holds 30 fixture artists, 20 playable artists and 60 eligible fixture recordings constant across a 20-dislike trajectory:

| Policy | Unique video IDs | Unique artists | Maximum artist share | Automatic repeat rate |
|---|---:|---:|---:|---:|
| B0 S9.16 base utility | 20 | **12** | 15% | 0 |
| B1 with contextual redundancy | 20 | **17** | 15% | 0 |

This demonstrates wider artist coverage on matched evidence, not improved human relevance or lower maximum artist share. Pure-ranker sample mean latency was about 0.4–1.5 ms locally; it excludes network, browser and Redis overhead.

The real transaction comparison with the same adequate inventory produced:

| Variant | Unique IDs / artists | Qloo requests | Comparator requests |
|---|---|---:|---:|
| B1 global selection, no replenishment | 20 / 17 | 0 | 0 |
| B2 supply controller enabled | 20 / 17 | 0 | 0 |
| B3 constrained comparator, mocked responses | 20 / 17 | 0 | 20 **mocked**, zero paid |

Equivalent B1/B2 output is expected while local supply is adequate. In a separate low-runway transaction, B2 acquired and retained a fresh fixture artist/video with one provider request, where the unrefreshed inventory had no next video. Confirmed tags on seven unplayable artists did not suppress this refresh. Source, feedback, usage and new identities committed together. Duplicate batches stopped after two zero-yield plans; hashes differed, and identical plans were not rerun.

The B3 row verifies integration/cost/selection guards and does not measure a real model quality advantage. Existing Gemini validation remains covered; S9.16's prior live comparison is documented separately. No new paid model experiment was needed for this supplier repair.

Generalization tests cover 30 artists/20 playable, 30/two playable, eight/all playable, eight/none playable, full 90-artist capacity, one/multiple videos, duplicate/new provider results, exhausted budgets, invalid identities, stale cache, unreviewed labels, duplicate/concurrent feedback, expired sessions and unavailable storage. HTTP tests cover movie, mainstream artist (Dua Lipa), less mainstream artist (Nils Frahm), TV, game and podcast source identities. Backend production rules contain none of their names.

Required trajectories pass: NOT_FOR_ME ×10, NEXT ×15, LOVE ×5 (with neutral advancement between retained loves), and mixed ×20. Love legitimately reused one liked artist across distinct recordings; tests do not impose forced artist turnover. A longer mixed HTTP sequence exhausted its ten available reviewed videos exactly once instead of pretending to offer twenty. Two-playable-artist and zero-playable-artist cases report honest exhaustion.

## State, security and failures

The reservoir remains capped at **90 artists**. The video inventory is capped at **540** (90 × six) instead of discarding options at 180. Current and saved artist references receive eviction protection without being converted into preference pins; explicit rejects and origin/query history remain protected. Acquisition reports only new IDs actually retained after compaction.

Representative measured serialized sizes:

- Full 90-artist/540-video fixture: **243,328 bytes** after initial presentation.
- 90-artist/90-video fixture at exhaustion: **144,028 bytes**.
- Actual retained-provider browser Redis session: **396,186 bytes**, 50 artists, 40 videos, 21 encounters.

These are measured examples, not a promise that arbitrary provider metadata has the same size. Histories remain bounded, and no second database was added.

Signed authorization and current-video checks precede mutation. Redis CAS/leases serialize feedback, protect revisions and reject stale/duplicate/concurrent actions. The lease bound now covers bounded supply lookup plus model work, including configurations without a bounded agent. Cache reads run concurrently to avoid serial timeout multiplication. Fixed session expiry is unchanged.

Feedback survives resolver, model and supply-query failure; invalid candidates never become playable. Known request counts are charged once even if subsequent normalization fails. No provider limit is reset, no background retry worker is introduced and no token/credential is logged. Existing-session optional fields migrate lazily. Passport stays device-local and survives session expiry and rollback.

At real exhaustion the UI offers Passport, a different starting point, explicit replay of an earlier authorized recording, and the existing YouTube path. It never claims the artist has no music.

## Provider spending and regression gates

- S9.16R Qloo: **6/6 authorized HTTP requests**, all counted in `.artifacts/s9-16r/qloo-ledger.json`; no more requests authorized in this campaign.
- Historical S9.14 Qloo: **18/18**, unchanged.
- YouTube: **two searches + two video-list requests**, within existing shared daily/exploration guards; no quota/billing increase.
- Gemini: **zero new paid calls / ₹0 new model testing cost**. The prior S9.16 ledger and its ₹0.52743 conservative estimate remain untouched.
- Redis: existing configured service only; no new billing arrangements. Provider invoices were not accessed, so no total monetary invoice claim is made for Qloo/Redis.

Completed gates: lint (zero errors; one pre-existing local-skill warning), typecheck, production build, complete tests, smoke:mock, smoke:multi-round, smoke:listening, smoke:adaptive-listening, smoke:discovery-supply, evaluate, evaluate:adaptive, evaluate:songs, evaluate:adaptive-listening and evaluate:discovery-supply. The full suite includes preview, wording, security, quota, session and failure tests. Ordinary tests are offline.

Final automated count: **594 passed, four skipped**, 38 passing files and two opt-in live files skipped. Browser checks: **18** generic journeys, **14** multi-round, **59** legacy Passport, **47** supply, **47** retained-provider supply. The release-secret audit is also run on the final commit; its current-value scope is not a guarantee about unknown historical credentials.

Artifacts and complete per-candidate resolution/funnel traces are retained under `.artifacts/s9-16r/` (ignored, not published). The prior unrelated S2 skill edit is preserved.

## Rollback, promotion and remaining limits

No public deployment was changed. Recommended next step is an explicitly approved preview promotion of this branch, with `MAX_RECOMMENDATION_CANDIDATES=50`, existing protected credentials/Redis configuration, and independently chosen `ADAPTIVE_LISTENING_ENABLED=true` / `ADAPTIVE_POOL_ENABLED=true`. These flags still default to false. The pool flag permits bounded Qloo expansion; it is not needed for global listening over a committed reservoir.

Verify the preview SHA in hosting metadata, run `qa:discovery-supply`, then inspect a genuine clean-browser source journey and budgets before approving production promotion. Do not rerun the exhausted six-request probe without a new allowance. No automatic submission or deployment is authorized.

Rollback by setting `ADAPTIVE_LISTENING_ENABLED=false` (and, if desired, `ADAPTIVE_POOL_ENABLED=false`), or reverting the commit. Existing Passport data remains valid. Restore the prior candidate count explicitly if an exact previous retrieval-size configuration is required; its earlier local value was eight.

Limits remain finite: not every Qloo artist has a verifiable recording; batch omissions are unresolved, not proof of absence; some channels/scripts/regions may need independent review; duplicate audio under different video IDs is not fingerprint-deduplicated without verified equivalence evidence. Further pages beyond the live-tested page 2 use the same verified parameter with a bounded 2–6 range and normal failure handling. Live breadth was measured for this newly verified source; broader source generalization is covered offline/HTTP and does not establish a human preference win. Musical sound profiles and multimodal analysis remain outside this repair's verified scope.
