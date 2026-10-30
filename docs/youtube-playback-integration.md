# YouTube resolution and listening player (S9.9)

**Branch and inputs:**
- Branch `seg/S9-9-youtube-playback`, from `2b91df3` (S9.8).
- Specification: `.agents/skills/s9-9-youtube-playback/SKILL.md`.
- Context: `docs/sound-passport-feasibility.md`, `docs/multi-round-discovery.md`, `docs/live-browser-verification.md`, and the vision document (local copy without the `(1)` suffix).

**S9.10 note:** the adaptive-pool foundation is documented separately; listening feedback and Passport collection remain out of scope.

**Rule:** Qloo recommends **artists**; YouTube supplies **videos**. TasteProbe never says Qloo chose a song. Four provenances are kept separate:
- the Qloo artist;
- the YouTube video;
- the reviewed artist/video match;
- any featured moment.

## 1. Resolution architecture

```
Programme (music_artist journey)
 └─ ListeningRoom ──POST /api/music/resolve {sessionToken, artistId}──▶ route (rate limit "resolve")
        │                                                               └─ resolveMusic()
        │                                                                   ├─ loadAuthorizedArtist(): signed token + revision check,
        │                                                                   │   artist ∈ exploration candidates, not set aside, target = music_artist
        │                                                                   └─ resolveArtistVideo()
        │                                                                        Tier A reviewed registry (default, no network)
        │                                                                        Tier B YouTube Data API (only with YOUTUBE_API_KEY; disabled now)
        │                                                                        Tier C honest fallback (search link, artist kept)
        └─ YouTubePlayer (official IFrame API; one player; user-started)
```

| File | Role |
|---|---|
| `src/lib/music/types.ts` | ID shapes, `watchUrl` and `searchUrl` (the only external URLs), moment bounds |
| `src/lib/music/mappings.ts` | Reviewed registry (Tier A) |
| `src/lib/music/resolver.ts` | Tier logic and moment selection; pure |
| `src/lib/music/youtube-data.ts` | Optional Data API lookup and quota guard (Tier B) |
| `src/lib/music/service.ts` | Authorization, Tier B wiring, in-flight dedup, telemetry |
| `src/app/api/music/resolve/route.ts` | Route |
| `src/lib/contracts/music.ts` | Request and response schemas |
| `src/components/music/YouTubePlayer.tsx` | Player |
| `src/components/music/ListeningRoom.tsx` | Per-artist resolution and fallbacks |
| `src/components/Programme.tsx` | Listening room plus a **Listen** action on every music pick |

**Small, documented changes to existing files:**
- `discovery/service.ts`: new read-only `loadAuthorizedArtist`; no discovery logic changed.
- `config/env.ts`: new `music` block and `RATE_LIMIT_RESOLVE_MAX`.
- `rate-limit.ts`: `resolve` bucket; the limiter store is exported for quota counters.
- `contracts/api.ts`: `ARTIST_NOT_IN_EXPLORATION`.
- `next.config.ts`: security headers.
- `scripts/ui-qa.mjs`: the "no external links" invariant now allows YouTube-only links inside the listening room.

## 2. Reviewed mapping registry

The registry has **15 artists: 14 RESOLVED and 1 NEEDS_REVIEW**, with 25 videos (14 primary, 11 alternates).
- **Source of the artists:** every Qloo ID and name was returned by Qloo for *Interstellar → artists* in the S9.8 live probe. No ID was invented.
- **Live journey coverage:** the S9.9 live journey's five shown picks (Jóhannsson, Richter, Goldmund, Arnalds, Chauveau) are all mapped.

| Qloo artist | Qloo ID | Primary video | Channel (kind) | Alternates |
|---|---|---|---|---|
| Jóhann Jóhannsson | 5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC | `aXlx-YnvgKU` "Jóhannsson: Flight from the City" (391 s) | Jóhann Jóhannsson - Topic (topic) | `mPvqle7mF-U` (Topic), `dCWbVxfkoKg` (Deutsche Grammophon - DG) |
| Max Richter | 0704ADB9-6270-4D71-B252-A42D8A4EAA47 | `InyT9Gyoz_o` "Max Richter - On The Nature Of Daylight (Official Video)" (396 s) | MaxRichterVEVO (vevo) | `b_YHE4Sx-08` (VEVO, 2018 version) |
| Ólafur Arnalds | 02940707-9635-45DA-B290-243F84C6B910 | `xpZgtFhDbss` "Ólafur Arnalds - saman (Sunrise Session II / Performance Video)" (155 s) | OlafurArnaldsVEVO (vevo) | `XmHs_sMDueA` (Topic) |
| Goldmund | D7918037-2D25-4990-BC34-4502B136E5AE | `Yyl5X7HqYAA` "Threnody" (281 s) | Goldmund - Topic | `wkIIZLDX25w` |
| Sylvain Chauveau | 5AC77C2A-0A4F-4A6B-B2EE-D915F0E92549 | `pR3CEtnEo_k` "Pauvre Simon" (111 s) | Sylvain Chauveau - Topic | — (a 27 s FatCat teaser was rejected) |
| Peter Broderick | 70BE1CE0-6D03-4125-BF8F-F538A9449F86 | `Qkc42ah4nnM` "Eyes Closed and Traveling" (212 s) | Peter Broderick - Topic | `R5ZPMcL9xF8` |
| Eluvium | 08ADBAF0-7267-4239-BCF8-DAD243B09BFC | `xuZnS2cNJhc` "Prelude For Time Feelers" (349 s) | Eluvium - Topic | — |
| Greg Haines | 41B1FF16-564C-4BC1-82F9-1FC443AC3D6D | `bZFkBajkgMM` "183 Times" (548 s) | Greg Haines - Topic (channel UCCT4p4…) | `d_qoJ-jaHGI` |
| Hildur Guðnadóttir | 24259855-E26C-43A3-93E5-5BB4E09ABBBF | `LNYCuj4ur-U` "Bathroom Dance" (128 s) | Hildur Guðnadóttir - Topic | — |
| Nils Frahm | 0D8EAFA4-CEEA-44D5-8E1F-26A8A9F49A77 | `luXZuPTJ3f8` "Says" (498 s) | Nils Frahm - Topic | `hs1yXpaDgiE` (Erased Tapes) |
| Hauschka | 34F09ED4-6170-4DF9-AB79-8348D2465EC5 | `Lsg9ZZF-240` "Hauschka - Elizabeth Bay (Official Video)" (356 s) | Temporary Residence Ltd (label) | — |
| A Winged Victory for the Sullen | 37EA7EEF-A51E-4D54-9728-5BCFEB9B3E85 | `SwmRJQAx8eA` "Requiem for the Static King, Pt. 1" (166 s) | …For The Sullen - Topic | `-TOGFiiidAs` |
| Philip Glass | 4358B267-4DF8-49FF-A4A2-5C84586EA882 | `8l9Lr9loHG4` "Metamorphosis: One" (340 s) | Philip Glass - Topic | — |
| Library Tapes | 76FD7956-0732-4F83-A6F0-DE21C07CE293 | `R850HNDA-yY` "Library Tapes: Fall" (124 s) | Library Tapes - Topic | `uja-wLfRyUg` |
| Poppy Ackroyd | 75AE7DFF-0996-4522-BAEE-064A5CB73FD0 | **NEEDS_REVIEW**: `vWW9knyjU7U` exists and plays, but only on a self-described channel ("Poppy Ackroyd Music"), so it is never played | — | — |

## 3. Identity checks actually performed (2026‑10‑30)

1. **Qloo identity.** The ID and name come from the S9.8 live Qloo response. At request time, the resolver also requires the session candidate's Qloo **name** to equal the registry name; if it doesn't, the result is NEEDS_REVIEW `artist_name_mismatch`.
2. **YouTube oEmbed** (official, keyless). All 27 candidate videos returned HTTP 200, which means they exist and allow embedding. The exact title, `author_name` and `author_url` were recorded. Candidates were found by a research pass, then re-verified independently.
3. **Channel authority.**
   - Accepted: the artist's auto-generated **Topic** channel, the artist's **VEVO** channel, or a **named label** channel (DG, Erased Tapes, Temporary Residence).
   - Never accepted on its own: a title containing "Official".
   - Two "Greg Haines - Topic" channels exist; only one is used.
   - Rejected: fan uploads, covers, live re-uploads, a FatCat "catalogue" channel, and embedding-disabled (403) videos.
4. **Real player audit** (`npm run verify:mappings`). Every registry video, including Poppy Ackroyd's, was played in the official IFrame player from a localhost origin on Edge. **26 of 26** reached PLAYING with time advancing, and YouTube's reported `video_id` and channel equalled the registry. Durations come from the player.

Each registry entry carries `verifiedAt` and `evidence: ["oembed_200","iframe_playing"]`. Tests enforce the shape of every ID, uniqueness, YouTube-only URLs, and that no RESOLVED mapping rests on a self-described channel.

## 4. Resolver endpoint contract

`POST /api/music/resolve` (JSON body; the token is never in a URL), with body `{ "sessionToken": "<signed token>", "artistId": "<Qloo artist ID>" }`.

**Authorization.** The same token verification and revision check as every discovery transition, plus:
- the exploration's target is `music_artist`;
- the artist is in this exploration's verified candidate pool;
- the artist has not been set aside with "Not for me".

**Read-only.** The session revision does not change, so resolving never invalidates the UI's token. This is tested.

**Rate limit.** Its own `resolve` bucket (`RATE_LIMIT_RESOLVE_MAX`, default 60 per window), on the shared Redis limiter.

**Response `MusicResolution`:**

```ts
{
  status: "RESOLVED" | "NEEDS_REVIEW" | "UNAVAILABLE" | "RATE_LIMITED" | "UPSTREAM_FAILURE",
  provider: "youtube",
  artist: { entityId, name, provenance: "qloo" | "mock" },   // always the Qloo artist, unchanged
  video: { videoId, title, channelTitle, watchUrl, provenance: "reviewed_mapping" | "youtube_data_api",
           channelKind, verifiedAt, durationSeconds? } | null,
  alternates: ResolvedVideo[],                                 // reviewed, same artist, tried in order
  featuredMoment: { videoId, startSeconds, endSeconds, status: "APPROVED" | "PENDING_REVIEW",
                    provenance: "human_curated", reviewedAt? } | null,
  fallback: { label, url: "https://www.youtube.com/results?search_query=…" },
  reason: string | null,          // e.g. no_reviewed_mapping, mapping_stale, synthetic_artist, artist_name_mismatch
  dynamicLookup: "DISABLED_NO_KEY" | "NOT_NEEDED" | "USED" | "CACHED" | "QUOTA_EXHAUSTED" | "FAILED",
  checkedAt: ISO
}
```

**Errors** use the standard envelope:

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed body |
| 400 | `UNSUPPORTED_DOMAIN` | Not a music exploration |
| 401 | `INVALID_SESSION_TOKEN` / `SESSION_EXPIRED` | Bad or expired token |
| 403 | `ARTIST_NOT_IN_EXPLORATION` | Artist not authorized for this exploration |
| 409 | `SESSION_REVISION_CONFLICT` | Stale token |
| 429 | `RATE_LIMITED` | Rate limit hit |

## 5. Dynamic lookup availability, key and quota

**Status: ENABLED whenever `YOUTUBE_API_KEY` is set.** The owner added a free-tier key to `.env`, which is git-ignored, after the first S9.9 commit; only its presence was checked, and the value was never printed. `GOOGLE_API_KEY` belongs to Gemini and is never reused. With no key, Tier B is never constructed and makes no network calls (tested with a fetch spy).

**Live verification with the key** (`npm run probe:youtube`; YouTube only, no Qloo or Gemini). All four test artists are Qloo artists with no reviewed mapping.

| Artist | Outcome |
|---|---|
| Danny Norbury | **RESOLVED** `bQY0q6mLyng` "Speak, Memory" (Danny Norbury - Topic, 337 s) |
| Deaf Center | **RESOLVED** `i61WLyM3pZ0` "Open Upon" (Deaf Center - Topic, 394 s) |
| Julia Kent | NEEDS_REVIEW: her uploads are on a channel named "Julia Kent", not a Topic channel |
| Shawn Mendes | Historical S9.9 result: NEEDS_REVIEW because the old dynamic policy excluded VEVO |

Both resolved videos reached PLAYING in the official player, with the reported ID and channel matching.

The server path (`PROBE_PART=service npm run probe:youtube`) runs `resolveMusic` with the real config wiring and a fake Qloo exploration:
- **First lookup:** USED.
- **Repeat for the same artist:** **CACHED**, same video, 0 requests.
- **Two concurrent requests:** shared one lookup.
- **Third artist:** RATE_LIMITED at the per-exploration cap (set to 2 for the probe), with no request sent.

Total YouTube usage for these checks: 8 `search.list` and 6 `videos.list` (8 of the 100/day search bucket).

**Per-artist cache** (`src/lib/music/cache.ts`). Search results are not stable: Deaf Center returned "Open Upon" once and `U00ks17rrCs` on a later call. Tier B outcomes are cached by **policy version plus Qloo artist ID**. S9.10 uses `v2-topic-vevo`, so a negative entry written by the narrower S9.9 Topic-only policy cannot suppress a newly valid VEVO match:

| Outcome | Cached for |
|---|---|
| Resolved | 24 h |
| NEEDS_REVIEW or none | 6 h |
| Quota refusals, failures | Never |

**How the cache behaves:**
- **Order:** the cache is checked **before** the quota guard, so a hit costs nothing. The order is cache → in-flight dedup → quota guard → Data API.
- **Visibility:** a hit is reported as `dynamicLookup: "CACHED"`.
- **Stability:** the same artist keeps the same video across explorations, which S9.12 feedback validation relies on.
- **Storage:** Redis in production (same instance as sessions), memory otherwise. A Redis outage degrades to a cache miss.
- **Name check:** an entry whose stored artist name no longer matches the Qloo name is ignored.

**Current Google quota** (Data API docs and Quota Calculator, checked 2026‑10‑30). The old "100 units per search" figure is outdated.
- `search.list` costs **1 unit** in its own **Search Queries bucket, 100 calls/day** by default.
- `videos.list` costs **1 unit** from the general **10,000 units/day**.
- Quotas reset at midnight Pacific time.

**Our caps** apply if a key is added later. They are server-side, in Redis, and counted before each call, failures included:

| Cap | Default |
|---|---|
| `YOUTUBE_DAILY_SEARCH_MAX` (per deployment) | 40 |
| `YOUTUBE_SEARCHES_PER_EXPLORATION` | 2 |
| Retries | None |
| Timeout (`YOUTUBE_TIMEOUT_MS`) | 5 s |

Concurrent lookups for the same artist share one request.

**S9.10 Tier B identity rule.** A result is accepted only when all of these hold:
- the video sits on exactly one canonical channel matching the Qloo name: `<Artist> - Topic` or exact-name `<Artist>VEVO` (spacing, punctuation, case, and diacritics are normalized; extra words are not accepted);
- it was found with `type=video&videoEmbeddable=true&videoCategoryId=10`;
- `videos.list` reports it as `embeddable` and `public`.
- for VEVO, the video title independently starts with the normalized artist name and contains no cover, tribute, karaoke, reaction, parody, fan-made, or impersonation marker.

Topic behavior remains supported. A self-operated artist channel still requires independently reviewed evidence in the static registry; a name match alone never authorizes dynamic playback. Ambiguous identity remains **NEEDS_REVIEW**. Quota exhaustion (403/429) returns **RATE_LIMITED**, and network, timeout, or shared quota-store failures return **UPSTREAM_FAILURE**. A quota-store failure occurs before any YouTube request. The key travels in the `x-goog-api-key` header, never in a URL. Tests use a fake fetch only.

**Enabling Tier B later:**
1. Create a key in a Google Cloud project with the YouTube Data API v3 enabled. The default free quota needs no billing; do not enable billing.
2. Restrict the key to that API.
3. Set `YOUTUBE_API_KEY` server-side.

## 6. Player lifecycle (`YouTubePlayer`)

**Lifecycle:**
- The official `https://www.youtube.com/iframe_api` is loaded once per page.
- **Mount:** one `YT.Player` is created per artist; the parent keys the component by artist ID.
  - It uses `controls:1`, `playsinline:1`, `rel:0` and `origin` set to the page origin.
  - The video is **cued** only, so nothing autoplays.
- **Unmount:** `destroy()`, so a previous artist's video cannot keep playing. This was verified as one iframe after switching, and zero after leaving the programme.

**App controls**, all **outside** the embed:
- Play (from the start), Pause/Resume, Replay (repeats the last mode), and **Open on YouTube**.
- "Play featured moment" appears only with an APPROVED moment.
- In review mode only, it reads "Preview unreviewed moment", with a visible review note.

**Native YouTube controls, branding and ads are untouched**, and the embed is never overlaid.

**State reported to the page:**
- Exposed as `data-player-phase` (`loading` / `ready` / `buffering` / `playing` / `paused` / `ended` / `failed`), `data-video-id`, `data-reported-video-id`, `data-reported-title` and `data-reported-channel` (from `getVideoData()`), and `data-current-time` while playing.
- A polite live region announces the state.

**Geometry:** 16:9 with `min-height: 200px`. Measured at 728×410 on desktop and 295×200 at 375 px, with no horizontal overflow. There are no animations, so reduced motion needs no change.

## 7. Featured-moment provenance

**Current status: no moment is human-curated.** The S9.8 30–45 s segment was a fixture and is not used.

**Contract:** a moment holds `{videoId, startSeconds, endSeconds, status, provenance:"human_curated", reviewedBy, reviewedAt}`. It is offered only when all of these hold:
- the status is **APPROVED** and has a reviewer and date;
- `0 ≤ start < end ≤ duration`, checked against the audited duration on the server and against `getDuration()` in the player;
- it belongs to the video being played.

Otherwise playback starts from the beginning.

**Candidates awaiting review.** Three PENDING_REVIEW placeholder windows sit inside the verified durations:

| Video | Window |
|---|---|
| Jóhannsson `aXlx-YnvgKU` | 1:00–1:30 |
| Richter `InyT9Gyoz_o` | 1:00–1:30 |
| Arnalds `xpZgtFhDbss` | 0:30–1:00 |

These are **unlistened placeholders with no musical claim**. A reviewer must listen and then approve or replace them. They are visible only with `MUSIC_MOMENT_REVIEW=true`, which is refused in production, and are labelled "unreviewed" there.

**How to approve a moment:**
1. Run `next dev` with `MUSIC_MOMENT_REVIEW=true`.
2. Listen, and adjust the bounds in `mappings.ts`.
3. Set `status:"APPROVED"`, `reviewedBy` and `reviewedAt`.

## 8. Error handling and fallbacks

| Failure | Behaviour (tested) |
|---|---|
| Malformed video ID in the registry | Resolver returns NEEDS_REVIEW `invalid_video_id` (unit) |
| Wrong artist/video association (name drift) | NEEDS_REVIEW `artist_name_mismatch` (unit) |
| Self-described or unverified channel | NEEDS_REVIEW, never played (unit: Poppy Ackroyd) |
| Stale metadata (more than 30 days) | NEEDS_REVIEW `mapping_stale` (unit) |
| Unknown artist, no key | UNAVAILABLE plus a YouTube search link; artist kept (unit and route) |
| Synthetic (mock) artist | UNAVAILABLE, with no search link for an invented name (route and mock QA) |
| Player error 2/5/100/101/150 (unembeddable, removed, region-blocked, HTML5) | The player stops, then the next **reviewed alternate for the same artist** is cued, and the user presses Play (**live, induced**). With no alternate left, a role=alert fallback offers "Open on YouTube" and a search link, with nothing playing (**live, induced**). The artist is never replaced. |
| A late state event after a terminal error | Ignored; this bug was found in QA and fixed (§10) |
| Stale response after switching artist | Dropped by request key (**live, induced** 3 s delay) |
| Network failure or 429 on resolve | Message plus manual **Try again**; no retry loop |
| IFrame API blocked (network or content blocker) | "The YouTube player could not load…" plus YouTube links |
| Data API quota exhausted or failing | RATE_LIMITED or UPSTREAM_FAILURE, then the fallback (unit) |
| Autoplay blocked | Not applicable: playback always starts from a user click |

## 9. Privacy, CSP and Referer

**Security headers** (all routes, `next.config.ts`):

| Header | Value |
|---|---|
| CSP `script-src` | `'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com`, plus `'unsafe-eval'` only in development, per Next's CSP guide |
| CSP `frame-src` / `child-src` | `https://www.youtube.com` |
| CSP others | `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Content-Type-Options` | `nosniff` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

**CSP scope and known limits:**
- Before S9.9 there was **no** CSP; this tightens scripts and frames.
- `img-src` and `connect-src` are deliberately not restricted, because Qloo artwork hosts vary.
- `'unsafe-inline'` remains because Next without nonces needs it. A nonce-based CSP is a later hardening step.

**Live verification:**
- No CSP violations in the console.
- The embed Referer was origin-only (`http://localhost:<port>/`) on all 10 embed requests.

**Privacy and data handling:**
- Session tokens travel only in POST bodies.
- External URLs are built only by `watchUrl` and `searchUrl` (`https://www.youtube.com/…`) and validated by the response schema.
- The resolver fetches no client-supplied URL, so there is no SSRF or open redirect.
- Metadata is rendered as React text, never as HTML.
- YouTube's own ad and conversion requests appear as CORS console noise. That is YouTube's traffic, not the app's.

**Metadata retention:**
- The registry stores **stable references** (video ID, channel URL) alongside **check-time metadata** (title, channel, duration), with `verifiedAt`.
- Entries older than **30 days** stop playing and fall back to NEEDS_REVIEW until they are re-checked with `npm run verify:mappings` (free).
- Tier B results are kept only in the expiring per-artist cache (24 h for resolved, 6 h for negative outcomes), and `verifiedAt` records when YouTube was asked. Nothing API-derived is stored permanently.
- The future Passport (S9.13) must store only `videoId`, the Qloo artist ID and name, and its own saved-at time. Title and channel should be re-read from the player or registry when shown, not kept indefinitely.

## 10. Browser tests and outcomes

**Mock QA (`npm run qa`, free): 17/17 and 16/16, 0 problems.** The music journeys now render the listening room; with synthetic artists it shows the honest fallback. axe found no serious or critical issues.

**Live QA (`npm run qa:music -- --confirm-live`, paid, Edge, production build, real Qloo, Gemini, Upstash and YouTube): 25/25.**
- **Usage:** 3 Qloo and 1 Gemini per run. Two runs in total, so 6 Qloo and 2 Gemini (ledger 6/6 Qloo, 2/8 Gemini). 0 YouTube Data API calls: the key was added later, and the journey's picks all have reviewed mappings, so they never need Tier B.
- **The three artists:** Jóhannsson, Richter and Arnalds each had no autoplay (cued), one iframe, and user-triggered PLAYING with time advancing (about 2.5 s → 4.5 s). The reported ID and channel equalled the registry for each.
- **Controls:** pause, resume, and replay from the start all worked.
- **Switching:** switching artist while one was playing left one iframe, with the new video cued and not playing.
- **Moment (induced):** the PENDING_REVIEW moment was labelled unreviewed; it started at 61.5 s and ENDED at 71.99 s (bounds 60–72).
- **Failure paths (induced):**
  - Broken primary: the alternate `mPvqle7mF-U` played, with the switch notice shown.
  - No playable video: the fallback alert appeared, with YouTube-only links and the artist name kept.
  - Stale response: ignored.
- **Accessibility:** axe at 1440 and 375 found no serious or critical issues.
- **Mobile 375:** the player is 295×200, plays on tap, with no overflow.
- **Headers and teardown:** security headers present; Referer origin-only; leaving the programme leaves zero iframes.

**Bug found and fixed.** The first live run scored 23/25. A terminal player error was overwritten by a later `stopVideo()` state event, so the fallback never showed; that also cascaded into the next check, because the run left its interception active. The fix: a terminal failure now ignores later events, and the harness always removes interceptions.

**Screenshots** (`.artifacts/music-qa/`, git-ignored) were inspected: the playing state for each artist at 1440, the 375 playing state, failover and fallback.

**What is not claimed:** "Playing" means YouTube reported PLAYING and time advanced. **No one listened**, so audible playback is not claimed. Bundled Chromium showed an intermittent YouTube error 5 in S9.8, so the live QA ran on branded Edge.

## 11. S9.12 listening-feedback integration (requirements)

**Feedback request:**
- Add `POST /api/discovery/feedback {sessionToken, artistId, videoId, action}`.
- Authorize with `loadAuthorizedArtist`.
- Then require `videoId` to be the **server-resolved** video for that artist: `resolveArtistVideo(...).video.videoId` or one of its `alternates`. Never trust a client pairing.

**Semantics:**
- **Love:** adds the artist as a positive signal.
- **Not for me (track):** must **not** call `/api/discovery/reject`.
- **Next:** neutral.
- **Save:** records the exact `videoId` that played, taken from `data-reported-video-id` or the current alternate.

**Player hooks:**
- Hook up phase changes from `YouTubePlayer`, for example an `onPhase` prop added beside the existing data attributes, to know what was heard.
- Feedback buttons must sit outside the embed, like the existing controls.

**Session handling:** feedback mutates the session, so it takes the lease/CAS path and returns a new token. The ListeningRoom must then switch to the new token; it already reads the latest token through a ref.

**Constraints:** keep `resolve` read-only. Do not reuse its rate-limit bucket for feedback.

## 12. S9.13 Sound Passport UI integration (requirements)

**Reuse:** `ListeningRoom` and `YouTubePlayer` as they are. Keep one player per page, keyed by artist, and keep app controls outside the embed and the player at least 200×200.

**Saved items:** each Passport entry stores `{ videoId, qlooArtistId, artistName, savedAt }` (§9 retention). Its link must be `watchUrl(videoId)`.

**Featured moments:** show "Featured moment" only for `status === "APPROVED"`. Never show it for PENDING_REVIEW outside review mode, which the server already enforces.

**Copy:** keep "Qloo recommended the artist… Qloo didn't choose the song" wherever a video is shown.

**Before release (S9.14/S10):**
- Re-run `npm run verify:mappings` within 30 days of the demo.
- Approve at least a handful of real moments by listening.
- Run `qa:music` against the deployed URL in a private window.
