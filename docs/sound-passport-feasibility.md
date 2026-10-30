# Sound Passport — feasibility and integration audit (S9.8)

Branch `seg/S9-8-sound-passport-feasibility`, created from `efe6fa6` (S9.7). This is a feasibility stage. **No Sound Passport product code was added to `src/`.** The playback prototype is isolated in `prototypes/youtube-player/`. Paid usage in S9.8: **3 Qloo HTTP requests (cap 4), 0 Gemini, 0 YouTube Data API calls.**

Inputs read:
- `.agents/skills/s9-8-sound-passport-feasibility/SKILL.md`.
- The two product documents. They exist locally **without** the `(1)` suffix the skill uses: `Downloads/TasteProbe_Final_Product_Vision_Sound_Passport.md` and `Downloads/TasteProbe_Adaptive_Candidate_Pool_Upgrade_Plan.md`.
- The other three referenced documents (`TasteProbe_Pipeline_Architecture.md`, `TasteProbe_Environment_Setup.md`, `Builder_skill_prompt.md`) are present in `Downloads/`. They were not needed for these findings and are not quoted here.

---

## 1. Actual repository baseline and S9.7 status

| Item | Finding |
|---|---|
| Starting branch / commit | `seg/S9-7-continuous-exploration-ui` @ `efe6fa6` "S9.7: implement continuous exploration interface" |
| S9.7 status | Committed and complete. Gates at start: 431 tests passed and 4 skipped; qa 17/17 and 16/16 |
| Unrelated work preserved | ` M .claude/skills/s2-…/SKILL.md`, `?? .agents/`, `?? .claude/launch.json`, `?? .claude/skills/web-design-atelier/`. None of it is staged or committed |
| Remote / deployment | No git remote is configured, and there is no `.vercel/` link or CI workflow. **No production deployment exists.** Upstash Redis was used only from local live runs (S9.5) |
| Budgets (`src/lib/config/env.ts`) | `MAX_QLOO_CALLS_PER_SESSION=6`, cumulative per exploration. `MAX_GEMINI_REQUESTS_PER_EXPLORATION=20`. `MAX_QUESTIONS=3` per round. `MAX_RECOMMENDATION_CANDIDATES=30`. `MAX_AGENT_TOOL_CALLS_PER_TURN=3`. `SESSION_TTL_SECONDS=1800`, fixed at start and not extended by `continue` |

## 2. Existing system architecture

**Request flow:**
1. `app/api/discovery/{start,answer,finish,reject,accept,continue}` calls `src/lib/discovery/service.ts`.
2. The service loads a CAS-revisioned session through `src/lib/session/*`. Storage is Redis or memory; the token is `{v:2,sid,rev,exp}` and every transition takes a lease.
3. The live path calls `live-turn.ts` → `decideAndExecute()`. That function asks the bounded Gemini agent (`src/lib/agent/*`) for one of `ask | retrieve | finish`.
4. Retrieval goes through the Qloo provider (`src/lib/qloo/live-provider.ts`), then `normalizeTargetCandidates`, then `rankCandidates`, then `discovery/path.ts` (START_HERE, EXPLORE_NEXT, …).

**Recorded state:**
- One session record is one exploration.
- S9.6 added rounds, `askedDimensions`, `presentedEntityIds`, `recommendationFeedback` and `acceptedEntityId`.
- S9.7 added the UI for reject, continue and accept.

**Fixed-pool root cause (traced, confirmed):**

1. **The candidate pool is set at `start`.** `startLive` performs one Insights request and stores `state.candidates` (`service.ts:243`). Its decision runs with `{allowRetrieval:false}` (`service.ts:566`).
2. **Answers retrieve only if Gemini chooses to.** `answerLive` passes `allowRetrieval: delta.positive.length > 0` (`service.ts:702`). A new Qloo call then happens only if the Gemini agent picks `request_retrieval` (`agent/context.ts:134`, `gemini-agent.ts:43`). The deterministic and fallback paths never retrieve. In S9.5 the live positive answers produced LOCAL_RERANK only.
3. **`continue` never retrieves.** `continueLive` hard-codes `{allowRetrieval:false}` (`service.ts:931`), with the comment "no new signal could justify a Qloo retrieval".
4. **A retrieval replaces the pool instead of merging.** `retrieve()` returns `{ ...state, candidates }` (`live-turn.ts:165-171`), discarding the previous pool. There is no reservoir and no query-hash memory. Negative signals are never sent to Qloo (`live-turn.ts:154`).
5. **The cache is not the cause.** `ENABLE_QLOO_CACHE` defaults to false.

The upshot: the identity set is fixed after `start` unless an LLM decision happens to trigger a replacement.

## 3. Relevant source files and extension points

| Concern | File:line | Extension |
|---|---|---|
| Insights URL | `src/lib/qloo/live-provider.ts:124` `buildInsightsUrl` | It already supports `signal.interests.entities`, `signal.interests.tags`, `filter.exclude.entities`, `filter.exclude.tags` and `take` ≤ 50. It does not yet support `page`/offset, which S9.11 would add only if it is verified |
| Retrieval | `src/lib/discovery/live-turn.ts:136` `retrieve` | Change "replace" to "merge into reservoir" behind a flag (S9.11) |
| Decision loop | `live-turn.ts:288` `decideAndExecute` | The deterministic adequacy controller runs **before** the agent (S9.10/S9.11) |
| Answer / continue | `service.ts:702`, `service.ts:931` | Insert `evaluatePool()` (S9.10) |
| Normalization | `src/lib/discovery/normalize.ts:118` | Reused unchanged: type checks, anchor removal, provenance |
| Ranking | `src/lib/discovery/ranking.ts:51` | Gains RRF over source lists plus feedback penalties (S9.11) |
| Session schema | `src/lib/session/state.ts:20` | Gains `reservoir` and `poolTransitions`, both optional so old records still parse (S9.10) |
| Questions | `src/lib/discovery/questions.ts:96` `availableQuestions` | Already per round; listening is not question-limited (S9.12) |
| Contracts | `src/lib/contracts/{api,domain,capabilities}.ts` | New `ResolvedMusicVideo`, `ListeningFeedback` and `listening` view block (S9.9/S9.12) |
| Probe tooling | `scripts/probe-adaptive-retrieval.test.ts` (new) | `npm run probe:adaptive`, hard cap of 4 Qloo requests |

## 4. Three verified artist/video mappings

Qloo IDs come from the S9.8 live baseline (§8). Video identity was checked through YouTube's **oEmbed** endpoint, which is official, needs no key and charges no quota. It was then checked a second time by the IFrame player's own `getVideoData()` during real playback (§5). There was no scraping or downloading.

| Qloo artist (ID) | YouTube video | Title (YouTube) | Channel (YouTube) | Embeddable | Evidence |
|---|---|---|---|---|---|
| Jóhann Jóhannsson `5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC` | `aXlx-YnvgKU` | "Jóhannsson: Flight from the City" | "Jóhann Jóhannsson - Topic" (auto-generated label art track; length 6:31 shown by player) | Yes: oEmbed 200, played in browser | oEmbed and player |
| Max Richter `0704ADB9-6270-4D71-B252-A42D8A4EAA47` | `InyT9Gyoz_o` | "Max Richter - On The Nature Of Daylight (Official Video)" | "MaxRichterVEVO" | Yes: oEmbed 200, played in browser | oEmbed and player |
| Ólafur Arnalds `02940707-9635-45DA-B290-243F84C6B910` | `xpZgtFhDbss` | "Ólafur Arnalds - saman (Sunrise Session II / Performance Video)" | "OlafurArnaldsVEVO" | Yes: oEmbed 200, played in browser | oEmbed and player |

**Rejected or secondary candidates seen:**
- `OtfmorEK50Y`: Jóhannsson, channel "KlassikAkzente". It is a label-affiliated channel but not the artist's own, so the Topic channel was preferred.
- `XmHs_sMDueA`: "saman" on "Ólafur Arnalds - Topic". It is valid and is an alternative mapping.
- A malformed ID returned oEmbed 400.

**Mapping rule for S9.9:** the channel must be the artist's own VEVO, Topic or official channel, or a named label channel, and the title must contain the artist name or a known work. Anything else is `needs_review`. The metadata check date is 2026‑10‑30, and the mappings must be revalidated before submission.

## 5. Actual IFrame playback experiment

Files:
- `prototypes/youtube-player/index.html`: the official `https://www.youtube.com/iframe_api`, one `YT.Player`, `controls:1`, `playsinline:1`, and `origin` set to the page origin.
- `serve.mjs`: a real HTTP origin on `localhost`, never `file://`.
- `verify.mjs`: Playwright.

The prototype does not import from `src/` and is not routed by Next.

| Check | 1440×900 | 375×812 (mobile emulation) |
|---|---|---|
| Player ready (`onReady`) | PASS | PASS |
| Visible size | 728×410 (≥ 480×270) | 343×200 (≥ 200×200; `min-height:200px` required, because 16:9 at 343 wide is only 193 tall) |
| No autoplay on load (state 5 CUED, no PLAYING event) | PASS | PASS |
| User-triggered play: PLAYING with time advancing (30.04 → 32.51 s), `isMuted()=false`, volume 100 | PASS | PASS |
| Replay restarts the moment (30.09 s) | PASS | — |
| Switching track: the previous video is replaced in the **single** iframe, the new track is cued (not playing) until Play, then plays | PASS (Richter, then Ólafur) | PASS (Richter) |
| Invalid video: `onError` 150 → visible fallback, `stopVideo()`, nothing advancing | PASS | PASS |
| No horizontal overflow | PASS | PASS |
| Referer on `youtube.com/embed/` request | `http://localhost:<port>/` (origin only) | same |

**Runs:**
- **Installed Edge** (`PW_CHANNEL=msedge`): 27/27 and 27/27.
- **Playwright's bundled Chromium** after the fixes: 27/27, 26/27, 26/27, 27/27. The two failures were intermittent: one stall, and one YouTube **error 5** (HTML5 player error) on the Richter VEVO video. In both cases the fallback rendered correctly. Bundled Chromium is not a consumer browser, so S9.14 must use branded browsers.
- Evidence: `.artifacts/s9-8/youtube-verify.json` and screenshots `yt-{1440,375}-{cued,playing,fallback}.png` (git-ignored).

**Limits of the evidence:**
- **Audibility:** "Playing" means the player reported PLAYING, time advanced, and the player was not muted. No one listened, so audible output is **not** claimed.
- **Referer:** a page-level `Referrer-Policy: no-referrer` did **not** strip the Referer from the embed. The IFrame API sets `referrerpolicy="strict-origin-when-cross-origin"` on its own iframe. The product must keep the default policy and must not hand-roll iframes with `no-referrer`. That hand-rolled case was not tested.
- **Third-party requests:** YouTube's own ad and conversion requests, such as `googleads.g.doubleclick.net`, appear in the page console as CORS failures in headless runs. They are not app errors. The production CSP must allow YouTube's frame and script origins and must not block player requests.

## 6. Featured moment validation

- **Mechanism verified on real videos.** With object-syntax `loadVideoById({videoId, startSeconds:30, endSeconds:45})`, playback started at 30.04 s and stopped (ENDED) at 45.00 s. Richter started at 60.18 s and Ólafur at 20.25 s.
- **Content provenance.** These timestamps are **labelled test fixtures** (`provenance:"prototype_fixture"`). They exist to exercise start/end playback and are **not** claimed highlights. No listening review was performed, so no musically curated moment exists yet.
- **Product rule (vision §8):** a `featuredMoment` is shown only with `provenance: "human_curated" | "explicit_metadata"`, and only after `0 ≤ start < end ≤ duration − margin` is checked against the player's `getDuration()`. Otherwise the video plays from its normal start. An arbitrary 30‑second range is never presented as selected for the user.

## 7. Unavailable-video fallback

- **Trigger:** `onError` (codes 2, 5, 100, 101, 150).
- **Response:** `stopVideo()`, then a role=alert panel: "This video can't be played here. The artist recommendation still stands. Look for {artist} on YouTube."
- **What stays usable:** the artist card and actions remain. The fallback link is a YouTube search URL built only from the artist's name, never an unverified video.
- **Verified:** error 150 on both viewports, and a real intermittent error 5 also produced the fallback.
- **Product addition (S9.9):** try the next reviewed same-artist mapping once; then use Tier C, which is "Open on YouTube" plus "Try another artist".

## 8. Qloo baseline artist IDs

**Query:** `GET /v2/insights` with `filter.type=urn:entity:artist`, `signal.interests.entities=057DA9D9-399B-437E-8BCA-A80E499125EF` (Interstellar), `take=30`, `feature.explainability=true`. Query hash: `278bdd32e869`, the sha256 of the sorted params with the key excluded.

**Result:**
- 30 returned, 30 unique, 0 duplicates, 0 wrong-type.
- The anchor did not echo back.
- 30 normalized, 0 rejected.
- Latency 1710 ms, 1 attempt.

Names are listed only where the probe printed them. No names were inferred.

1. `5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC` Jóhann Jóhannsson · 2. `0704ADB9-6270-4D71-B252-A42D8A4EAA47` Max Richter · 3. `D7918037-2D25-4990-BC34-4502B136E5AE` Goldmund · 4. `02940707-9635-45DA-B290-243F84C6B910` Ólafur Arnalds · 5. `5AC77C2A-0A4F-4A6B-B2EE-D915F0E92549` Sylvain Chauveau · 6. `70BE1CE0-6D03-4125-BF8F-F538A9449F86` Peter Broderick · 7. `08ADBAF0-7267-4239-BCF8-DAD243B09BFC` Eluvium · 8. `A017F475-9F52-4884-AD5C-FDD7912A2A71` Shawn Mendes · 9. `C9FB5AB7-7509-41C5-B7DD-1309C9C6CFB1` · 10. `82DC448E-0865-4229-9846-A6F865C20FCF` · 11. `BA8DF7E5-8892-4244-A58F-39280CBE1784` · 12. `EEE15A04-1AB1-43EA-945E-B93EA6DD920A` · 13. `41B1FF16-564C-4BC1-82F9-1FC443AC3D6D` Greg Haines · 14. `6062A977-79F7-48F9-917E-0B57D77474AD` · 15. `5DACAF9A-F9E0-440E-82BE-94989866A0AF` · 16. `15B5AC9B-A21B-47CA-AD58-E2B8F1976EBD` · 17. `058B79A3-49F5-4927-9AB6-DE713C706796` · 18. `24259855-E26C-43A3-93E5-5BB4E09ABBBF` Hildur Guðnadóttir · 19. `2D6B98A8-DCF2-420C-866F-E818BE53F90C` · 20. `73F02D66-E8AF-46CA-8A11-A20DF3B312FB` · 21. `B2FC66F4-A9E3-47DA-AAA3-9D0F7134C53E` · 22. `E5144F88-EC15-4860-A494-01CB25ECAD12` · 23. `41990D6F-471D-4A11-AE51-A83F12D6E37A` · 24. `C684E3C1-A737-4878-B722-76B84A2091A2` · 25. `DC0C153F-EC04-4575-A20D-9B52614D1FC9` · 26. `7F659D95-A531-426C-81B5-FD95756F07F3` · 27. `AE8A7A8E-A9C6-42E4-9204-A3D15E933D63` · 28. `D4F4C8C8-430D-445C-BDCC-4C715C1A37B6` · 29. `C875D5A7-D161-4315-8109-EBF921866D54` · 30. `338EE3D7-168A-4C65-B4A9-FF109C63B178`

**Quality note:** the baseline includes a mainstream outlier, Shawn Mendes, at rank 8.

## 9. Qloo modified-query artist IDs

Both changed queries were built only from signals that Qloo itself returned in the baseline. No IDs were invented.

**A. TAG_FOCUS** (positive tag answer): baseline plus `signal.interests.tags=urn:tag:instrument:qloo:piano`.
- "Piano" was carried by 24 of the 30 baseline artists, and was the most common tag that did not cover all of them.
- Hash `8e0a10e97ddd`; latency 1496 ms; 30 returned, 30 unique, 0 duplicates, 0 wrong-type, 0 rejected.
- **New IDs (9):** Library Tapes `76FD7956-0732-4F83-A6F0-DE21C07CE293`, Loren Allred, Nils Frahm `0D8EAFA4-CEEA-44D5-8E1F-26A8A9F49A77`, Taylor Swift, A Winged Victory for the Sullen `37EA7EEF-A51E-4D54-9728-5BCFEB9B3E85`, Hauschka `34F09ED4-6170-4DF9-AB79-8348D2465EC5`, Clem Leek `9E315DCE-05A8-4336-84FA-18923A1B6B9B`, Poppy Ackroyd `75AE7DFF-0996-4522-BAEE-064A5CB73FD0`, Sophie Hutchings `EAD9F030-8192-41C1-8EB3-6D8F15254F23`.
- The top‑5 order was unchanged.

**B. PROFILE_REFRESH** (Love on a Qloo-returned artist): `signal.interests.entities=Interstellar,Jóhann Jóhannsson (5AD69C26…)`.
- Hash `644d4ab9c64c`; latency 360 ms; 30 returned, 30 unique, 0 duplicates, 0 wrong-type, 0 rejected.
- **New IDs (14):** Library Tapes, Nils Frahm, A Winged Victory for the Sullen, Hauschka, Julia Kent `326A36B8-4B9C-434B-87AA-2D9E6CF86369`, Poppy Ackroyd, Danny Norbury `00600DB7-30AC-44DE-BB01-30D088C0E4AF`, Philip Glass `4358B267-4DF8-49FF-A4A2-5C84586EA882`, Moon Ate the Dark `3DDEF18F-446A-4F68-A3D2-26230DCD7277`, Valgeir Sigurðsson `EA93C2A7-22C5-4CA2-A51D-95A2E16BB551`, Sophie Hutchings, Deaf Center `2BE4ECFD-05BF-40CB-92CA-D4514F083CD0`, Slow Meadow `D52533AA-E274-469D-9FDE-7B34F00C0533`, Brian McBride `302F4FCB-7335-4B87-AE34-3AAA923E6144`.
- The top‑5 order changed.

The full IDs for Loren Allred and Taylor Swift are in `.artifacts/s9-8/adaptive-probe.json` (git-ignored; IDs and names only, no raw body).

## 10. Exact new-ID overlap results

| Query | Unique | Overlap with baseline | Previously unseen | Wrong type | Duplicates |
|---|---|---|---|---|---|
| BASE | 30 | — | — | 0 | 0 |
| TAG_FOCUS (piano) | 30 | 21 | **9** | 0 | 0 |
| PROFILE_REFRESH (+Jóhannsson) | 30 | 16 | **14** | 0 | 0 |

- **Overall:** 17 distinct new IDs across both variants (6 shared), giving a union of 47 verified artists from 3 requests.
- **Requests:** 3 HTTP requests, 0 failures, 0 retries (`maxAttempts:1`), 0 Gemini.
- **Popularity drift:** the tag query brought in Taylor Swift and Loren Allred, mainstream artists who also carry the piano tag. Tag-only refreshes therefore need the seed entity kept in the signal, which it was, plus local relevance scoring.

## 11. Verified retrieval mechanisms

| Mechanism | Status |
|---|---|
| `signal.interests.entities` with an added loved artist (PROFILE_REFRESH) | **VERIFIED**: 14/30 new, correct type |
| `signal.interests.tags` with a Qloo-returned tag (TAG_FOCUS) | **VERIFIED**: 9/30 new, correct type |
| `take` up to 50 | Code-capped at 50; 30 used |
| `filter.exclude.entities` / `filter.exclude.tags` | In the URL builder; **not exercised in S9.8**, so unverified for novelty |
| `page`/offset pagination (PAGINATE) | **Unverified**: not built and not called. S9.11 may probe it with ≤1 request |
| Re-ranking the existing pool | Is **not** retrieval and must be labelled LOCAL_RERANK |

## 12. Candidate-reservoir design

This design is behind `ADAPTIVE_POOL_ENABLED` (default `false`). With the flag false, the code paths are exactly today's.

```ts
type ReservoirEntry = {
  candidate: RecommendationCandidate;      // normalized, provenance "qloo"
  sources: Array<{ queryHash: string; family: QueryFamily; rank: number }>;
  firstSeenRound: number;
  status: "available" | "presented" | "loved" | "saved" | "skipped_track" | "rejected_artist";
};
type QueryFamily = "BASE" | "PROFILE_REFRESH" | "TAG_FOCUS" | "PAGINATE" | "DIVERSIFY";
type AdaptivePoolState = {
  version: 1;
  entries: Record<string, ReservoirEntry>;  // key = Qloo entity ID (dedup)
  executedQueryHashes: string[];             // never re-issue an identical query
  transitions: PoolTransition[];             // newest 20
};
type PoolTransition = {
  at: number; round: number;
  action: "KEEP" | "LOCAL_REPLACE" | "FETCH_AND_MERGE" | "EXPAND" | "DEGRADED_KEEP";
  reason: string; queryHash?: string; family?: QueryFamily;
  added: string[]; qlooCalls: number;
};
```

- **Shortlist vs reservoir:** `state.candidates` stays the presented shortlist, at most 30. The reservoir holds every verified ID seen, capped at **90 entries**, oldest unpresented evicted first; loved, saved and rejected entries are never evicted.
- **Storage:** the reservoir is stored in the same Redis record, updated atomically under the existing lease/CAS.
- **Size:** about 90 normalized candidates with tags. This must be measured in S9.10 against the Upstash request limit. If it is too large, store tags by ID only.

## 13. Deterministic retrieval policy

`evaluatePool(state, event)` is pure and deterministic, with no LLM. It runs after each meaningful event (an answer, a Love, a Save, Not-for-me on an artist, or `continue`).

1. **Adequacy:** `available` = reservoir entries not presented and not rejected, with a relevance score at or above the floor. If `available ≥ 5`, the result is **KEEP**, or **LOCAL_REPLACE** when the top changed through feedback.
2. **Fetch:** if `available < 5` and a *new* positive signal exists (a loved or saved artist, or a liked tag) and `hash(query) ∉ executedQueryHashes` and the Qloo budget remaining is ≥ 1, the result is **FETCH_AND_MERGE**. The family is PROFILE_REFRESH (loved artist, verified best: 14/30 new); otherwise TAG_FOCUS.
3. **Expand:** if there is no new positive signal and the pool is exhausted, the result is **EXPAND** with `filter.exclude.entities` set to the presented IDs (to be verified first in S9.11), or with PAGINATE if verified.
4. **Degrade:** if the budget is spent, the query is a duplicate, Qloo errors, or there are no novel IDs, the result is **DEGRADED_KEEP** with an honest reason. The existing shortlist is never cleared and nothing is fabricated.

**Limits:** at most 1 Qloo call per event, and the existing per-exploration cap of 6, which S9.11 may raise to 8 by configuration only. `maxAttempts:1` on adaptive fetches, and no retries. Gemini is never needed for this decision.

## 14. Merge, rank and selection design

- **Merge:** union by entity ID, appending `sources`. Normalization, type checks and anchor exclusion are reused unchanged.
- **Rank:** `RRF(id) = Σ_sources 1/(60 + rank)` plus the existing `rankCandidates` tag-match terms, minus penalties:
  - `rejected_artist` is excluded;
  - `skipped_track` (Next) has **no** penalty;
  - `not_for_me` on a track gives a mild artist penalty of −0.1 and only demotes.
- **Select:** fill the next listening slot from the highest-ranked `available` entry that has a resolvable video. Keep at least 1 slot in 5 for an entry first seen in the newest query, to make discovery visible. Record "New from Qloo after you loved X" as an explanation grounded in `sources`.
- **Labelling:** `RecommendationUpdate.mechanism` takes the values `QLOO_FETCH_MERGE` or `LOCAL_RERANK`. Reranking is never called fresh retrieval.

## 15. Track-vs-artist feedback semantics

| Action | Scope | Effect | Must not |
|---|---|---|---|
| **Love** | artist (positive) and track | `positiveEntityIds += artistId`; reservoir status `loved`; may trigger FETCH_AND_MERGE | — |
| **Not for me** | **track** | Status `skipped_track` plus a mild artist demotion; the next track plays | Must **not** call `/api/discovery/reject` or add the artist to `rejectedEntityIds` |
| **Not this artist** (explicit, secondary) | artist | Existing reject semantics | — |
| **Next** | none | Neutral: advances the queue and records `next` for analytics only | Must not change preferences or ranking |
| **Save** | track | Stores the exact `{videoId, title, channel, artistId}` in the Passport (§17) | Must not substitute another video |
| **Finish** | session | Shows the Passport; valid with 0 saves | Must not require a save |

Listening is **not** limited by `MAX_QUESTIONS`. Feedback events are not questions and have their own rate limit.

## 16. Required listening-session API contracts

All new routes use the existing token, lease, CAS and revision handling.

- `GET /api/music/resolve?artistId=<qloo id>` (S9.9) returns `ResolvedMusicVideo`:
  ```ts
  { artistId, matchStatus: "verified" | "needs_review" | "unavailable",
    video?: { videoId, title, channelTitle, channelId?, embeddable: true },
    featuredMoment?: { startSeconds, endSeconds, provenance: "human_curated" | "explicit_metadata" },
    source: "reviewed_mapping" | "data_api", checkedAt }
  ```
  - The resolver is server-side.
  - Tier A uses the reviewed mapping file `src/lib/music/mappings.ts`.
  - Tier B uses the Data API only if `YOUTUBE_API_KEY` is configured.
  - Tier C returns `unavailable`.
  - It is rate-limited and never takes a free-text query from the client.
- `POST /api/discovery/feedback` (S9.12): body `{ sessionToken, artistId, videoId, action: "love" | "not_for_me" | "next" | "save" }`.
  - Validation: `artistId` must be a presented candidate, and `videoId` must equal the server-resolved video for that artist.
  - Returns the new `DiscoveryView` with `listening: { current, queue, poolTransition, counts }`.
  - It may perform ≤1 Qloo fetch per call, according to §13.
  - Errors: 409 `SESSION_REVISION_CONFLICT`, 400 `INVALID_FEEDBACK`, 429 budget.
- `POST /api/discovery/finish`: unchanged; it can be called with 0 saves.

## 17. Browser-local Passport contract

```ts
type SavedDiscovery = {
  v: 1; savedAt: string;
  artist: { qlooId: string; name: string };
  video: { videoId: string; title: string; channelTitle: string };
  featuredMoment?: { startSeconds: number; endSeconds: number; provenance: string };
  anchor: { qlooId: string; name: string; domain: string };
};
```

- **Storage:** `localStorage["tasteprobe.passport.v1"]`, holding at most 100 items, deduplicated by `videoId`. Every read and write is wrapped in try/catch, and the UI works when storage is unavailable, showing the session-only list.
- **What it holds:** no tokens, no session IDs, no PII. It contains public identifiers only.
- **Out of scope:** no account, no database and no playlist writes.
- **Removal:** a clear "Remove" action and "Clear Passport".
- **Video links:** links use `https://www.youtube.com/watch?v=<videoId>`, and the stored `videoId` is exactly the one played.

## 18. Provider budget and quota findings

| Provider | Configured? | S9.8 usage | Findings |
|---|---|---|---|
| Qloo hackathon API | Yes, `QLOO_API_KEY` is required for the probe and was present. The value was not printed | **3** requests (cap 4), 0 failures | Latency 360–1710 ms. The pricing and quota of the hackathon key are not documented in the repo, so they are **unknown** |
| Gemini (`LLM_PROVIDER`/`LLM_MODEL`) | Unchanged | **0** | The adaptive policy needs no Gemini |
| YouTube Data API v3 | **NO.** The app's config schema (`env.ts`, `.env.example`) has no YouTube variable. `.env.local` was not opened (standing rule), and `GOOGLE_API_KEY` belongs to Gemini and was not repurposed | 0 `search.list`, 0 `videos.list` | Tier B would need a new key with the Data API enabled. Default quota is 10,000 units/day, `search.list`=100 units and `videos.list`=1 unit (published defaults; not verified for this account). Billing was not enabled |
| YouTube IFrame player / oEmbed | Keyless | 6 oEmbed lookups, plus player loads | No quota for the IFrame API. oEmbed is a public endpoint and was used only for verification |
| Upstash Redis | Locally live in S9.5 | 0 | There is no production instance or deployment yet (S10) |

## 19. Security and YouTube policy considerations

- **Official player:**
  - Use the official IFrame player only: visible, at least 200×200 (480×270+ on desktop), with native controls, branding and ads intact.
  - No overlays on the player, and no autoplay on load. Playback starts from a user action.
  - No `<audio>` extraction, downloading or scraping.
- **Referrer and CSP:** keep the default referrer behaviour, since the API sets `strict-origin-when-cross-origin` itself. Do not set `Referrer-Policy: no-referrer` site-wide. The CSP needs `frame-src https://www.youtube.com` and `script-src https://www.youtube.com https://s.ytimg.com`.
- **Client inputs:** the client never chooses a video ID. The server resolves and validates it (§16), which prevents playing arbitrary content under TasteProbe's name.
- **Retention:** `checkedAt` is recorded on cached Data API results, and they are refreshed within YouTube's retention rules. Reviewed mappings are revalidated before submission.
- **Keys:** a Data API key would be server-only, never `NEXT_PUBLIC_*`, and never logged.
- **Attribution:** show the YouTube title and channel under the player, plus a "Data from Qloo" note.

## 20. Exact file-level implementation plan

**S9.9: YouTube Resolver and Player**
- **Add:**
  - `src/lib/music/types.ts`, for `ResolvedMusicVideo`.
  - `src/lib/music/mappings.ts` (Tier A, reviewed, with `checkedAt`).
  - `src/lib/music/resolver.ts` (Tier A, then optional Tier B behind `YOUTUBE_API_KEY`, then Tier C).
  - `app/api/music/resolve/route.ts`.
  - `src/components/music/YouTubePlayer.tsx`: one player instance, `loadVideoById` on user action, `onError` triggering fallback, and `stopVideo` on switch.
- **Edit:** `src/lib/config/env.ts` (optional `YOUTUBE_API_KEY`, `YOUTUBE_MAX_CALLS_PER_DAY`), plus the CSP headers in `next.config`.
- **Tests:** resolver unit tests (verified, needs_review, unavailable, timestamp bounds); route tests; Playwright based on `prototypes/youtube-player/verify.mjs` run against Edge or Chrome.
- **Exit criteria:** ≥12 reviewed mappings for demo journeys, and playback plus fallback on 375 and 1440.

**S9.10: Candidate Reservoir and Adequacy Policy**
- **Add:** `src/lib/discovery/pool/{types,reservoir,adequacy}.ts`.
- **Edit:** `src/lib/session/state.ts` (optional `adaptivePool`) and `env.ts` (`ADAPTIVE_POOL_ENABLED=false`, `ADAPTIVE_POOL_MAX_ENTRIES=90`, `ADAPTIVE_MIN_AVAILABLE=5`).
- **Tests:** pure policy table tests for all 5 actions, old-session compatibility, and a session size measurement.

**S9.11: Adaptive Qloo Retrieval and Merge**
- **Edit:** `live-turn.ts` `retrieve()` merges when the flag is on; `service.ts` answer and continue call `evaluatePool`; `ranking.ts` adds RRF and feedback penalties.
- **Add:** `RecommendationUpdate.mechanism: "QLOO_FETCH_MERGE"`.
- **Optional probe:** at most 2 Qloo requests to verify `filter.exclude.entities` and `page`.
- **Tests:** mock-provider merge and dedup, query-hash refusal, budget degrade, flag off equals S9.7 behaviour.

**S9.12: Listening Feedback and Session Integration**
- **Add:** `app/api/discovery/feedback/route.ts`, `src/lib/discovery/listening.ts`, and contracts `ListeningFeedback` plus the `listening` view block.
- **Rules:** track-level `not_for_me` never calls reject; Next is neutral; finish works with 0 saves; feedback has its own rate-limit bucket.
- **Tests:** route, CAS replay and semantics.

**S9.13: Premium Sound Passport UI and Collection**
- **Add:** `src/components/music/{ListeningRoom,FeedbackBar,PassportShelf}.tsx` and `src/lib/ui/passport-store.ts` (localStorage per §17).
- **Edit:** `DiscoveryApp.tsx` routes `movie→music_artist` into the listening mode.
- **Tests:** axe, keyboard-only flow, 320, 375 and 1440 widths.

**S9.14: Complete Live E2E and Compliance Verification**
- **Edit:** `scripts/ui-qa-live.mjs` adds a bounded listening journey with real Qloo, YouTube and Redis.
- **Run:** branded Chrome and Edge, plus a policy checklist (player size, no overlay, no autoplay, Referer, attribution).

**S10: Public Deployment and Submission**
- Vercel project, production Upstash, env var setup (by the owner), CSP, a private-window test on the deployed URL, revalidation of mappings, and the submission video.

## 21. Risk and fallback matrix

| Risk | Likelihood | Fallback |
|---|---|---|
| Mapped video becomes unavailable or region-blocked | Medium | `onError` → next reviewed mapping → Tier C link. Revalidate before submission |
| Intermittent player error 5 or stall (seen in bundled Chromium) | Low–medium | Same fallback, plus manual "Try again". Verify on branded browsers |
| No Data API key, so no Tier B | **Current state** | Tier A covers demo journeys; other artists get Tier C |
| Popularity drift in tag-only refresh (Taylor Swift via "piano") | Seen | Keep the anchor in every signal, apply local relevance floor, prefer PROFILE_REFRESH |
| Qloo budget (6/exploration) spent by listening | Medium | ≤1 fetch per event, query-hash dedup, then DEGRADED_KEEP with an honest message |
| Session record growth (reservoir) | Medium | Cap 90 entries; store tag IDs only if needed; measure in S9.10 |
| Fixed 30‑minute exploration expiry cuts long listening | Medium | Show the expiry (existing); extending TTL on activity is a backend decision for S9.12 |
| Uncurated featured moments | Certain without review | Normal start playback; label moments only when `human_curated` |
| Qloo key quota or pricing unknown | Unknown | Bounded probes; owner confirms before S10 |
| Ads or interstitials delay PLAYING | Possible | Never assert playback timing in UI; native controls stay usable |

## 22. Acceptance checklist covering every MUST

These are the MUSTs from vision §4, plus the featured-moment MUSTs in §8.

| MUST (vision §4/§8) | Evidence now (S9.8) | Owning stage |
|---|---|---|
| Existing end-to-end Qloo discovery remains functional | All gates green (§ results below) | every stage (regression) |
| Music target `artist` grounded in Qloo | 30 real IDs; 0 wrong type (§8) | done (S9.3/S9.5); reused |
| One familiar cultural anchor (search, disambiguate, confirm) | Existing S9.4 flow | done; reused |
| At least one verified non-music → music journey | movie→music_artist FULL_E2E (S9.5) and Interstellar probe | S9.14 re-verifies with listening |
| Correct artist → playable YouTube mapping, with embeddability, identity checks and fallback | 3/3 verified (§4), fallback (§7) | S9.9 |
| Large visible IFrame player with user-triggered clip controls; native controls, branding and ads preserved | Prototype PASS (§5) | S9.9 / S9.13 |
| `Love`, `Not for me`, `Next`, `Save` with distinct semantics and safe dedup | Contract (§15, §16) | S9.12 |
| Adaptive pool audit after meaningful answers (keep, replace, fetch/merge, expand or degrade) | Mechanism verified live (§10, §11); policy (§13) | S9.10 / S9.11 |
| Local saved collection (Sound Passport) | Contract (§17) | S9.13 |
| Explain why an artist appeared and what changed | `sources` and transitions (§12, §14) | S9.11 / S9.13 |
| Hard quotas, bounded retries, session and revision handling | Probe caps; policy limits (§13); existing CAS | S9.9–S9.12 |
| Complete empty, error and unavailable states | Player fallback (§7); DEGRADED_KEEP (§13) | S9.9 / S9.13 |
| Mobile, desktop and keyboard-accessible UI; no invisible player or forced playback | 375 and 1440 prototype; no autoplay (§5) | S9.13 (axe, keyboard) |
| Real end-to-end tests plus deployed private-window test | Not yet | S9.14 / S10 |
| Featured moment only when human-reviewed or checked metadata; otherwise normal start | Mechanism verified; fixtures labelled (§6) | S9.9 (curation of ≥ a handful) |

**Gate results (S9.8):**

| Gate | Result |
|---|---|
| `lint` | 0 errors (1 pre-existing warning in the untracked skill) |
| `typecheck` | pass |
| `test` | 431 passed, 4 skipped |
| `build` | pass |
| `smoke` | pass |
| `smoke:multi-round` | pass |
| `qa` | 17/17 + 16/16, 0 problems |
| `evaluate` | 6/6 |
| `evaluate:question-wording` | 4/4 |
| Prototype `verify.mjs` | 27/27 on Edge ×2. Bundled Chromium: 27/27 ×2 and 26/27 ×2 (intermittent YouTube error 5 or stall, handled by the fallback) |
