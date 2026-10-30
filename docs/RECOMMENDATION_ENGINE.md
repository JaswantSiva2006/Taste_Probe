# Recommendation engine

This document describes the code at the current release. Weights and thresholds are hand-set heuristics, not trained or calibrated values.

## 1. Candidate supply (Qloo)

1. **Starting point.** Qloo `GET /search` with the chosen domain type. The UI shows the top 3 matches.
2. **Base artists.** Qloo `GET /v2/insights` with `filter.type=urn:entity:artist` and `signal.interests.entities=<starting point>`, `take` ≤ 50 (`src/lib/discovery/live-turn.ts`, `src/lib/qloo/live-provider.ts`). Results are normalized with provenance (`src/lib/discovery/normalize.ts`).
3. **Question-driven refresh.** Confirmed answers can trigger PROFILE_REFRESH (entity signals) or TAG_FOCUS (tag signals) plans. These are de-duplicated by query hash, within `MAX_QLOO_CALLS_PER_SESSION` (`src/lib/discovery/adaptive-pool.ts`).
4. **Supply expansion.** When the playable runway is low, the app uses exclusion refresh and pages 2–6. These run only on the verified hackathon host and stop after two plans that add nothing.
5. **Taste walk.** See §4.

The reservoir holds at most 90 artists. Each entry remembers every query that returned it, with its rank.

## 2. Recording verification (YouTube)

Recordings come from a reviewed registry (`src/lib/music/mappings.ts`) or the YouTube Data API (`src/lib/music/youtube-data.ts`).

**How searches run:**
- **Batch query:** one OR-query covers ≤6 artist names and requests 50 results. The same results are also matched against every other reservoir artist ("harvest", positive matches only).
- **Focused search:** artists crowded out of a shared query get their own single-artist search later. Loved artists get one deeper, merged search.

**Identity tiers,** strongest first:

| Tier | Evidence |
|---|---|
| `topic` | the artist's "– Topic" channel |
| `vevo` | exact-name VEVO channel, and the title names the artist |
| `artist_channel` | a channel named for the artist (± "official" or "music") |
| `credited_title` | the title credits the full name as a whole segment |
| `credited_description` | a description credit line names the artist |

**Requirements below VEVO:** Music category, public and embeddable, the search's channel ID matches, 60–900 s long, and the title is not a cover, karaoke, reaction, slowed/8D/sped-up edit, jukebox, status clip, trailer or similar.

**Name matching:**
- Names are normalized, and initials are joined ("A.R." = "AR").
- The name must equal a whole credit segment; a prefix of a longer name doesn't count.
- Names shorter than 4 characters are never credited from text.
- Hashtags and @mentions are ignored.

**Namesakes.** Two "Topic" or two own-name channels mean two different artists share the name. The app then keeps only recordings that also credit someone from the artist's Qloo context (the starting point or reservoir artists). Otherwise the outcome is "ambiguous", never a guess.

**Quota and caching:**
- Each artist's result is cached: 24 h when found, 6 h when not.
- Searches are counted per exploration and per day, before the call.
- Keys fail over `YOUTUBE_API_KEY` → `_2` → `_3` on quota or key errors.

## 3. Ranking (`src/lib/music/adaptive-listening.ts` → `rankRecordings`)

Each verified, unseen recording of an eligible artist is scored:

```
base    = (0.5 − fw/2)·relevance + 0.35·answer + fw·transfer + 0.18·novelty
        + 0.16·affinity + 0.25·model + explore            (+ 0.20·musical, always 0 today)
penalty = 0.24·share(last 8) + 0.20·min(1, consecutive/2) + 0.12·plays(last 4)
        + 0.18·negativePressure + 0.06·recentTagSimilarity
score   = base − penalty
```

| Term | Meaning |
|---|---|
| relevance | taste-weighted fusion over every Qloo query (§4) |
| answer | overlap with confirmed or rejected question tags, plus confirmed entities |
| transfer | tag overlap with liked minus disliked artists, weighted by signal strength |
| novelty | `1 / (1 + times the artist was presented)` |
| affinity | same-artist evidence. Love ±1, Save +1, "More like this artist" +3, listening time −0.5…+0.6; shrunk as `Σw / (n + 2)` |
| model | Gemini affinity. A favoured artist at position i scores `1 − i/10`; a disfavoured one scores −0.8 |
| explore | Thompson sample of the artist's bucket: `0.12·(2θ − 1)`, from a deterministic per-turn PRNG; inactive until the first reaction |
| fw | `min(0.3, 0.05 · total signal weight)` |

**Hard filters:** rejected artists ("Not this artist"), already-presented recordings (a lifetime list of up to 600 IDs; the app exhausts rather than repeats), and disliked recordings.

**Implicit listening time** (Next, Another song, Different artist only):

| Listening | Weight |
|---|---|
| 0 s | no evidence |
| < 12 s | −0.5 |
| < 25 % | −0.25 |
| ≥ 50 % | +0.3 |
| ≥ 80 % | +0.6 |

In preview mode the percentages are measured against the preview's length. An explicit reaction always overrides implicit evidence for the same recording.

**Supply control** (`src/lib/music/supply.ts`):
- **Runway target:** `min(6, max(2, ⌈√artists⌉))` unseen recordings across enough distinct artists.
- **Proactive lookup:** when listener evidence or a model favourite says an unresolved artist outranks the best playable one, it is looked up once per turn.

## 4. Taste-graph walk (`src/lib/music/taste-walk.ts`, `walkStep` in `src/lib/discovery/service.ts`)

The walk is enabled by `ADAPTIVE_POOL_ENABLED` and bounded by `MAX_QLOO_WALK_CALLS`.

**Seeds and queries:**
- An artist becomes a seed once its same-artist evidence reaches 0.3: one Love, two long listens, or an explicit artist like.
- **EXPAND:** Qloo Insights with that seed **alone**. Already-heard and rejected artists are excluded. Results carry `seedEntityIds = [seed]`.
- **BLEND:** 2–3 expanded seeds from different buckets queried together. Each blend must include a newly expanded seed, with at most 3 per exploration.

**Relevance and eviction:**
- **Seed weights:** the starting point fades from 1.0 toward 0.45 as other seeds earn trust; a seed's weight is `0.5 + 0.7·evidence`; a rejected seed's weight is 0.
- **Relevance:** each origin contributes `w(seeds) / (1 + (rank − 1)/5)`, and contributions combine as a noisy-OR. Artists several trusted seeds agree on rise.
- **Eviction:** the 90-artist reservoir keeps the most relevant entries plus protected ones (current, saved, seeds).

**Saturation and validation:**
- A neighbourhood whose expansion added fewer than 3 new artists is saturated; seeds in it are not expanded again.
- Every plan, model or deterministic, must pass `walkPlanAllowed`: no repeated seed set, no saturated or already-expanded seed.

**Budget:** at most 1 Insights request and 2 scout searches per turn.

**Offline benchmark** (`npm run evaluate:taste-walk`): a synthetic graph whose favourite cluster is mostly outside the starting point's list, with a simulated listener.

| | Walk off | Walk on (3 Qloo calls) |
|---|---|---|
| Recommendations in the listener's cluster | 42% | 75% |
| Second half of the session | 33% | 100% |
| Core artists reached | 0 | 10 |

This measures mechanics, not human satisfaction.

## 5. Gemini's role

| Mode | Trigger | Output (server-validated) | Fallback |
|---|---|---|---|
| Discovery agent | live question turns | a tool call among offered questions or actions (≤2 requests incl. one repair) | deterministic agent |
| Question proposer | `QUESTION_GENERATION_MODE=llm_grounded` | grounded question proposals | deterministic questions |
| Song choice | ≥2 eligible recordings for one artist, with explicit evidence | a recording ID from an enum | deterministic |
| Cross-artist comparison | new preference event, no affinity ranking yet | a recording ID within score bounds (−0.15 score, −0.05 answer, +0.06 penalty of the top) | deterministic top |
| Artist affinity | at the start, then on a new positive signal or ≥3 new signals | ≤8 favoured / ≤8 disfavoured candidate IDs | deterministic ranking |
| Walk planner / scout | a new seed or blend is available | EXPAND / BLEND / SCOUT / HOLD with seed IDs; ≤3 artist names | deterministic plan; redundant plans rejected; names kept only on an exact Qloo match |
| Preview choice | ≥2 human-approved annotated segments (none exist today) | a segment ID | deterministic Quick preview |

**Common rules for every mode:**
- Function calling with `mode: ANY` and enum-constrained IDs.
- Each mode makes one request and never retries.
- Every request is charged against `MAX_GEMINI_REQUESTS_PER_EXPLORATION` before the call, failures included.
- The model is told it has not heard any audio; inputs are names, titles, Qloo tags and reactions.
