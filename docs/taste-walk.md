# S9.18 — Taste-graph walk over Qloo

Branch `seg/S9-16R-discovery-intelligence`, after S9.17 (`33d8775`).

## The idea

Qloo's insights API is a graph. Every artist has its own neighbourhood. Until S9.17, every query stayed anchored to the starting point: the first artist list for, say, A.R. Rahman decided what the listener could ever hear. Liked artists were only added *next to* the anchor, so the walk never truly moved.

If Anirudh Ravichander is not in Rahman's top 50 but is in Harris Jayaraj's, then a listener who responds to Harris should be able to get there. S9.18 makes the listener's reactions move the seed.

## Algorithms

All of these live in `src/lib/music/taste-walk.ts` (pure functions) and the `walkStep` in `src/lib/discovery/service.ts`. No artist, language or genre names appear in production code.

1. **Seeds earned by evidence.** An artist becomes a seed once same-artist evidence reaches 0.3. That takes one Love, two long listens, a Save plus a listen, or an explicit "More like this artist". Rejected artists never seed.

2. **Neighbourhood expansion (EXPAND).**
   - Qloo is queried with the seed **alone** (`signal.interests.entities = [seed]`, `take=50`).
   - Already-heard and rejected artists are excluded through the host-verified `filter.exclude.entities`.
   - Results keep truthful provenance: `evidence.seedEntityIds = [seed]`.

3. **Blend (taste centroid).**
   - Two or three expanded seeds from *different* neighbourhoods are queried together.
   - Each blend must include a seed not in any earlier blend, with at most 3 per exploration, so a blend is new evidence rather than a reshuffle.

4. **Taste-weighted fusion (relevance).**
   - Every pool entry remembers each query (origin) that returned it, with its rank.
   - Seed weights follow the listener:
     - the starting point fades from 1.0 toward 0.45 as other seeds earn trust;
     - a seed's weight is 0.5 + 0.7 × its own evidence (0.7 base for scouted artists);
     - a rejected seed's weight is 0.
   - Each origin contributes w(seeds) / (1 + (rank − 1)/5), and contributions combine as a **noisy-OR**. Artists that several trusted seeds agree on therefore rise, and raw affinities from different queries are still never compared.
   - This relevance replaces the static "rank under the starting point" term in recording ranking. It also drives which artists get YouTube resolution first.

5. **Relevance-based eviction.** The reservoir stays capped at 90. When a walk query merges, entries are retained by relevance to the *current* taste: protected IDs (current artist, saved, seeds) first. The reservoir therefore drifts toward the listener's bucket instead of keeping the starting point's list forever.

6. **Bucket bandit (Thompson sampling).**
   - A candidate's *bucket* is the seed set that best explains it.
   - Each bucket gets Beta(1 + positive evidence, 1 + negative evidence) from the listener's own reactions and listening time.
   - A per-turn deterministic sample (seeded PRNG) adds ±0.12 to ranking.
   - Effect: neighbourhoods that keep pleasing get exploited, and untried ones keep being explored. It stays silent until the listener has reacted at all.

7. **Yield-aware saturation.**
   - A neighbourhood whose expansion returned fewer than 3 new artists is *saturated*. Seeds in the same bucket share most of their Qloo neighbourhood, so they are not expanded again.
   - Every proposer, model or deterministic, passes `walkPlanAllowed`: never the same seed set twice, never an expanded or saturated seed, and blends only as above.

8. **Gemini walk planner + scout** (`plan_walk_step`, same agent, model, key and allowance).
   - **Inputs:**
     - the starting point;
     - seeds with strength and whether each is expanded;
     - disliked names;
     - names already in the reservoir;
     - the remaining Qloo allowance.
   - **Choices:** EXPAND, BLEND, SCOUT or HOLD, with seed IDs taken from an enum.
   - **Scout names:** it can also name up to 3 artists who are missing from the reservoir. Names are only text. One is added only when **Qloo's own search** returns exactly that name as a music artist. It then enters with an `AGENT_SCOUT` origin, weighted by the seeds that motivated it.
   - **Safeguards:** a redundant model plan falls back to the deterministic one (`model_plan_redundant`), and the deterministic policy also covers failures.

9. **Identity corroboration (YouTube).** Qloo places each artist in a context: the starting point and the reservoir.
   - A recording that also credits someone from that context is *corroborated*.
   - For namesakes (two Topic channels, or two own-name channels), only corroborated recordings are kept.
   - Otherwise corroborated recordings rank first, and a corroborated credit outranks an uncorroborated own-name channel.
   - Example: live, "Vijay Prakash" resolved only to recordings co-credited with A.R. Rahman/Shweta Mohan, never a Kumaoni namesake's. Previously the result was simply "ambiguous".

10. **Visible path.**
    - The listening view carries `path` (NEIGHBOURHOOD / BLEND / SCOUT, plus the seeds it came through) and the `trail` of explored seeds.
    - The stage shows a "Through …" step in the journey, an explanation such as "You responded to X, so TasteProbe asked Qloo for X's own neighbourhood", and the taste trail.

## Budgets

| Allowance | Default | Notes |
|---|---:|---|
| `MAX_QLOO_WALK_CALLS` | 15 per exploration | Insights + scout searches. Separate from the question-phase `MAX_QLOO_CALLS_PER_SESSION`; 0 disables the walk. At most 1 insights + 2 searches per turn. |
| `MAX_GEMINI_REQUESTS_PER_EXPLORATION` | 30 (was 20) | Shared by questions, affinity and the walk planner. A walk-planner call is about $0.0005; an affinity call about $0.003. |

Both are charged before the request, failures included. Turning on the walk also needs `ADAPTIVE_POOL_ENABLED=true`.

## Evidence

**Offline benchmark** (`npm run evaluate:taste-walk`, mechanics only, not human satisfaction).

The setup is a synthetic graph:
- The starting point's top 50 contains 40 "popular" artists, 5 edge artists of a cluster H at ranks 21–25, and 5 others.
- H's 30 core artists are reachable only through H's own neighbourhood.

A simulated listener loves H and passes on everything else. Results over 24 recordings:

| | Walk off | Walk on |
|---|---:|---:|
| Share of recommendations in the listener's cluster | 42% | **75%** |
| Share in the second half | 33% | **100%** |
| Core artists reached (absent from the starting list) | 0 | **10** (first at turn 8) |
| Qloo walk calls | 0 | **3** (was 15 before saturation) |

**Live** (A.R. Rahman, real Qloo/YouTube/Gemini; one session):
- After a single Love, Gemini chose EXPAND Vijay Prakash. Qloo added 34 artists from his own neighbourhood, and the UI showed artists "Through Vijay Prakash".
- **Defect 1, now fixed:** the planner then proposed redundant BLENDs that each added nothing and used up the 15-call allowance. `walkPlanAllowed` and the seed-set duplicate check now apply to model plans; there is a regression test.
- **Defect 2, now fixed:** a loved artist repeated three times in a row. The consecutive-artist penalty was raised (0.08 × min(1, n/3) → 0.2 × min(1, n/2)).
- The fixes were verified offline; no second paid live run was made.

**Tests:** 618 passed, 4 skipped. New coverage includes walk provenance, budget, failure tolerance, scouting (exact match only), rejected seeds, redundancy regression, noisy-OR, bandit determinism, plan validation and namesake corroboration.

## Limits

- Walk quality depends on Qloo's neighbourhoods. Saturation and the budget bound the cost, not the outcome.
- Scouted names rely on the model's general knowledge; only exact Qloo matches are used.
- Corroboration needs at least one co-credit from the context. A namesake with no co-credited upload stays unresolved rather than guessed.
- The bandit and weights are heuristics, not calibrated probabilities. The benchmark measures mechanics, not human preference.
