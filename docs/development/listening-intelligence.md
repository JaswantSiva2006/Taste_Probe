# S9.17 — Verified supply and adaptive listening intelligence

Branch `seg/S9-16R-discovery-intelligence`, after `115c5fc`.

## Problem

A user who starts from an artist often could not reach closely related artists, for example A.R. Rahman → Anirudh Ravichander. Many sessions ended with "no verified recording". The cause was the YouTube identity policy, not Qloo:

- **Strict channel rule.** S9.9–S9.16R accepted a recording only from the artist's auto-generated "Artist - Topic" channel or an exact-name VEVO channel. Much of the world's catalogue is published elsewhere: by the artist's own channel, or by record labels (film-music labels, independent labels, regional majors).
- **Two searches per exploration.** Each search was a shared OR-query for six names, so niche artists were crowded out by popular ones.
- **Supply-only lookups.** Lookups ran only when the playable runway was low. A likely favourite therefore stayed unresolved while weaker supply was still available.
- **Feedback had little to work with.** Feedback only moved Qloo-tag overlap. When Qloo returned no tags, a Love had almost no effect beyond novelty. Listening time was ignored.

## What changed

### 1. Identity tiers (generic; no artist, language or genre names in code)

Tiers, from strongest to weakest:

| Tier | Evidence | `channelKind` |
|---|---|---|
| topic | "Artist - Topic" channel | `topic` |
| vevo | exact-name VEVO channel + title names the artist | `vevo` |
| artist_channel | channel name is the artist's own name (± "official"/"music") | `artist_self_described` |
| credited_title | any channel; title credits the full artist name as a whole segment | `credited_upload` |
| credited_description | any channel; description has an explicit credit line ("Music: X", "Singer: X") | `credited_upload` |

Rules for every tier below VEVO:
- The video must be in the Music category, public and embeddable, and the search must have returned it with the same channel ID.
- It must last between 60 seconds and 15 minutes.
- The title must not mark a cover, karaoke, reaction, slowed/8D/sped-up edit, jukebox, status clip, trailer or similar.

Name matching works as follows:
- Names are normalized (accents and punctuation removed), and initials are joined, so "A.R. X" = "AR X".
- The full name must equal a whole credit segment. A shorter name never matches the start of a longer one ("Pritam" ≠ "Pritam Bhartwan").
- Names shorter than 4 characters are never credited from text alone.
- Hashtags and @mentions are ignored.

When two "Topic" channels share a name, the result is still ambiguous. Two Qloo IDs with the same name are still never both assigned. The cache policy version moved to `v3-credited`, so negative results cached under the stricter policy are not reused.

### 2. More supply per search

- One search now returns up to 50 results, and every returned ID is checked with a single `videos.list` call (general quota bucket, 1 unit).
- **Harvesting:** the same results are also matched against every other authorized reservoir artist. Positive matches only; an artist who doesn't appear is never treated as unavailable.
- An artist crowded out of a shared query (DEFERRED) gets a focused single-artist search on a later turn.
- Defaults are now `YOUTUBE_SEARCHES_PER_EXPLORATION=6` (was 2) and `YOUTUBE_DAILY_SEARCH_MAX=80` (was 40). Both are still hard-capped by the env schema (10 / 100), counted before each call, and fail closed.

### 3. Priority-driven resolution

Unresolved artists are looked up in priority order: model affinity (0.5), the listener's own artist signal (0.3), then Qloo's order (0.4).

A lookup runs when the runway is low, as before. It also runs (once per turn) when the highest-priority unresolved artist outranks the best artist that is already playable. A likely favourite is no longer left unreachable just because other supply exists.

### 4. Learning from every choice

- **Listen time.** The listening stage measures how long the official player reported PLAYING and sends it with the next action (`listenedSeconds`, `playbackMode`). The server caps it at one full play.
  - A skip within 12 seconds counts −0.5.
  - Listening to under a quarter counts −0.25.
  - At least half counts +0.3; at least 80% counts +0.6.
  - In preview mode, these are measured against the preview's length.
  - Never pressing play counts as no evidence.
- **Explicit signals.** Love / Not for me count ±1; Save counts +1. Explicit always wins over implicit for the same recording. "More like this artist" counts strongly.
- **Same-artist affinity.** A per-artist score from these signals is shrunk toward zero when there is little evidence. It enters ranking directly (weight 0.16), so reactions matter even when Qloo returns no tags. Tag transfer and redundancy penalties now use the same weighted signals.
- **Widening the reservoir.** The first loved recording of an artist asks Qloo for that artist's neighbourhood through the existing adaptive planner. Plans are deduplicated and stay within the cumulative Qloo allowance; this needs `ADAPTIVE_POOL_ENABLED`. It does not record an artist preference. Artists Qloo did not return for the starting point can then be reached.
- **Deepening a loved artist.** Loving a recording of an artist with fewer than three unseen recordings triggers one deliberate, deeper search for that artist. It runs once per exploration, and the results are merged with the cache rather than replacing it.

### 5. Gemini artist affinity (same agent, model, key and budget)

A new `rank_candidate_artists` mode of the existing song selector:
- **Inputs:**
  - the starting point;
  - liked and disliked artists, each with strength (strong = explicit, weak = listening time) and recording titles;
  - confirmed question answers;
  - up to 40 authorized Qloo candidate artists, with their tags.
- **Output:** up to 8 favoured and 8 disfavoured IDs, taken from an enum of authorized candidates. Lists are de-duplicated and disjoint, and the reason code comes from a fixed set. Anything else is rejected.
- **When it runs:**
  - once at the start (starting point only);
  - again when the evidence gains a new positive signal (love, save, long listen, "more like this artist");
  - otherwise only after three new signals of any kind.
- **Budget:** each request is charged to the existing per-exploration Gemini allowance before the call, and needs at least 2 requests remaining. While a model ranking exists, the older title-only cross-artist song comparison is skipped. A turn never spends two requests.
- **Observed live:** about 1.3–2.0 s and about $0.0025–0.0033 per request (gemini-3.5-flash-lite).
- **Effect:** a soft ranking term (weight 0.25) plus the resolution priority above. Explicit answers, rejections, seen-video and redundancy rules still apply.
- **What it does not do:** the model uses general knowledge of artists. It is told it has heard no audio, and no claim about audio is made.

## Verification

**Offline:** 606 tests passed, 4 skipped. This includes new resolver-tier, harvest, deepen-merge, engagement, priority, deferral, affinity-validation and budget tests. Lint (0 errors), typecheck, build, smoke:listening, smoke:adaptive-listening, smoke:discovery-supply and all evaluate suites pass.

**Live YouTube yield probe** (`PROBE_YOUTUBE=1`, `scripts/probe-credited-yield.test.ts`): 2 searches and 2 `videos.list` calls; 0 Qloo, 0 Gemini. Twelve artist names in two unrelated groups:

| Policy | Artists with playable recordings | Recordings |
|---|---:|---:|
| S9.16R (Topic/VEVO only) | 3 / 12 | 13 |
| S9.17 tiers | 10 / 12 | 76 |

**Live browser journey** (A.R. Rahman, Qloo live, real YouTube and Gemini):
- Qloo returned 50 artists for A.R. Rahman. Anirudh Ravichander was not among them, so that gap starts upstream.
- **Playable supply:** 32–34 of 50 artists and 138 verified recordings. The S9.16R report measured 9 of 50 and 40 recordings for its Dua Lipa sample.
- **Ten consecutive recordings:** nine different artists, with no repeats and no dead ends. They included Pritam via a Sony Music India credited upload; the strict policy had found nothing for Pritam.
- **One Love:** one Qloo call, and the reservoir grew from 50 to 62 artists.

The two artists missing from the second probe group were crowded out of the OR-query. The focused follow-up search (section 2) exists for exactly this case. The trace is in `.artifacts/s9-17/credited-yield.json` (ignored).

## Limits and rollback

- **Some false attributions are possible.** A credited upload is attributed from metadata, so a mislabelled third-party upload can occasionally pass. Covers, edits, shorts and non-song clips are filtered, and Topic/VEVO/own-channel recordings always rank first.
- **Same-name artists.** An artist whose name is also a common credit word, or who shares a name with someone else, can still be mismatched. Very short names are never credited from text alone.
- **No audio claims.** The weights are heuristics, not calibrated probabilities, and nothing claims to have heard the audio.
- **Rollback:** set `ADAPTIVE_LISTENING_ENABLED=false` (now true by default), or lower `YOUTUBE_SEARCHES_PER_EXPLORATION`. Passport data is unchanged.
