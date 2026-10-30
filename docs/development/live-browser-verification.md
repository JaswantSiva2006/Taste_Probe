# Live browser verification (S9.5)

Baseline: S9.4 commit `c2fcd83`. Branch: `seg/S9-5-live-verification`. Date: 2026-10-29.

This document records only what actually executed. No credentials, signed tokens or raw provider payloads appear here or in the evidence files.

## 1. Environment

| Item | Value (verified at runtime) |
|---|---|
| Server | `next start` on the production build (`npm run build`), `NODE_ENV=production` |
| Providers | `QLOO_MODE=live`, `/api/health` → `mode: live` |
| Session store | **Upstash Redis**: `/api/health` → `readiness.sessionStore: redis`, and `trace.sessionStore: redis` on every turn |
| Agent | `gemini-agent (gemini-3.5-flash-lite)`, `LLM_PROVIDER=gemini` (the accepted alias of `google`) |
| Rate limiting | production limiter on (`RATE_LIMIT_ENABLED=true`), Redis-backed |
| Question generation mode | **`deterministic`**, the effective configured value; it was not changed |
| Browser | Playwright 1.64.1 Chromium, driving the real UI |
| Command | `npm run qa:live -- --confirm-live` (`scripts/qa-live.mjs`) |

**Question generation.** `llm_grounded` was **not** exercised in S9.5; it is not configured and is not intended for the public demo. Every Gemini call in S9.5 was the bounded S6 *decision* agent choosing among questions the S5 optimizer had approved.

## 2. The live browser harness

`scripts/qa-live.mjs` reuses the S9.4 Playwright steps, now shared in `scripts/lib/ui-flow.mjs`.

**Safety:**
- It refuses to run without `--confirm-live`.
- It charges every request to a persistent campaign ledger (`.artifacts/live/ledger.json`, git-ignored), capped at 18 Qloo calls, 10 Gemini calls and $0.05, across runs and failures. A journey starts only if the remaining allowance covers it.

**Free rehearsal.** `--rehearse` runs the identical script against a mock server; it was run first and passed all three journeys with zero spend.

**What it checks, per journey:**
- The destination placards match `/api/health` capabilities.
- The user explicitly selects a real Qloo result: no `mock:` IDs, `qloo` provenance, and the correct source type.
- Start uses Redis at revision 0. Every candidate is a Qloo entity of the target type.
- Gemini executed (`LIVE_GEMINI` decision, `geminiRequests > 0`).
- The question's targets exist among the verified candidates' tags or IDs, and the UI shows the approved wording verbatim.
- The answer is applied once at revision 1, and the right preference bucket is updated.
- The recommendation-update mechanism matches the actual Qloo calls and the ordering.
- Finish happens at revision 2.
- The Discovery Path covers exactly the final candidates with no duplicates. START HERE is the top eligible candidate and matches the UI.
- Explanation evidence has `qloo` provenance and the selected seed, and contains no unsupported-claim words.
- "Why this starting point?" shows the backend text verbatim.
- For non-book targets there is no book copy, and artwork uses the square frame.
- Restart works.
- No credential appears in any API response or the DOM.
- There are no console or page errors.
- axe-core runs on the finale.
- Each state is screenshotted at 1440, then the same session is resized to 375, with no extra paid calls.
- Server telemetry turns are captured and sanitized.

## 3. Results: the three enabled journeys

| | Movie → Books | Music artist → Books | Movie → Music artists |
|---|---|---|---|
| **Result** | **PASS** | **PASS** | **PASS** |
| Source (explicit selection) | Interstellar (2014), `057DA9D9-…`, 6 results, 1 exact | Coldplay, `B6FA456F-…`, 8 results (incl. "Coldplayers", "Coldplay & Jay-Z"), 1 exact | Interstellar, `057DA9D9-…` |
| Initial candidates | 8 Qloo books (8 images, 8 descriptions, 6 tagged) | 8 Qloo books (8/8/5) | 8 Qloo artists (8/8/8) |
| Start decision | `LIVE_GEMINI` ask (1 Gemini call) | `LIVE_GEMINI` ask (1) | `LIVE_GEMINI` ask (1) |
| Question (tag, grounded) | "Do you enjoy Immersive books?" | "Do you enjoy History books?" | "Do you enjoy music artists associated with Minimalist?" |
| Answer | **like** (positive) | dislike | **like** (positive) |
| Mechanism | `LOCAL_RERANK`, no Qloo call; order changed, members unchanged; UI said "Your picks were reordered" | `LOCAL_RERANK`, same | `LOCAL_RERANK`, same |
| Next decision | `LIVE_GEMINI` ask | `LIVE_GEMINI` ask | `LIVE_GEMINI` ask |
| Revisions (Redis) | 0 → 1 → 2 | 0 → 1 → 2 | 0 → 1 → 2 |
| Final | 5 books; START HERE / EXPLORE NEXT / ANOTHER DIRECTION; 5 real covers | 5 books, 3 roles, 5 real covers | 5 artists, 3 roles, 5 real portraits |
| START HERE | *Ready Player One*, `preference_match`: "You said yes to “Immersive”, and it carries that tag. Qloo returned this among its books for fans of “Interstellar”, and it is the highest-ranked result." | *And Then It Fell Apart*, `source_grounded` | *Max Richter*, `preference_match` ("Minimalist") |
| Usage | 3 Qloo, 2 Gemini, $0.0012794 (3,648/74 tokens) | 3 Qloo, 2 Gemini, $0.0012129 | 3 Qloo, 2 Gemini, $0.0012552 |
| Latency (search / start / answer / finish) | 2,223 / 2,862 / 2,099 / 411 ms | 1,708 / 3,122 / 1,323 / 236 ms | 1,897 / 5,404 / 1,625 / 215 ms |
| Browser errors / layout defects / secrets | 0 / 0 / none | 0 / 0 / none | 0 / 0 / none |
| axe-core on the live finale (WCAG A/AA tags) | 0 violations | 0 | 0 |

Each journey's server telemetry (`discovery.turn` and `discovery.finish`) recorded:
- the pair, `capability: enabled` and `sessionStore: redis`;
- the start: `qlooRequests: 2` (seed re-resolution plus Insights) and `geminiRequests: 1`;
- the answer: `qlooRequests: 0` and `geminiRequests: 1`;
- the finish: `recommendationCount: 5`, `discoveryPathCount: 3`.

No upstream Qloo failures or retries were logged.

### Positive-answer verification

Two journeys answered positively, and both produced **local reranking, not Qloo reretrieval**. In each case Gemini's follow-up decision was to ask another approved question rather than request retrieval, so no Qloo call ran. The response, the telemetry and the UI all say so: "Your picks were reordered", never "Fresh picks from Qloo". The preference was applied exactly once (revision 1), and no unsupported Qloo signal was sent.

The order changed in both cases but no member changed, and nothing claims an improvement beyond that. Qloo reretrieval itself remains verified offline and in earlier movie → book runs, not in S9.5.

## 4. Optional coverage: movie → TV shows

All three required journeys passed, so one bounded full lifecycle was run on **movie → tv_show**. It used `smoke:live` in dev mode, because a disabled pair can only be admitted through the non-production `VERIFICATION_PAIRS` allow-list. It used real Qloo, Gemini and Upstash Redis. It was an **API-level** HTTP lifecycle, not a browser journey.

**Result: PASS.**
- **Search and start:** Interstellar was selected; Qloo returned 8 TV shows (8 descriptions, 8 images, 8 tagged).
- **Question:** `LIVE_GEMINI` asked "Do you enjoy Psychological thriller TV shows?" (TV wording).
- **Answer:** **like** gave `LOCAL_RERANK` with no Qloo call. Membership changed this time: *3 Body Problem* and *The Signal* entered the top 5 from the existing candidate pool.
- **Session:** the replay got HTTP 409; revisions ran 0 → 1 → 2 on Redis.
- **Finish:** 5 shows, 3 roles, `preference_match` explanations.
- **Usage:** 3 Qloo, 2 Gemini, $0.001316.

The registry now records `movie->tv_show` as `FULL_E2E_VERIFIED` but **keeps it disabled**. Its browser journey has not run, and S9.5's own bar for public pairs is browser proof. Video games, podcasts and book-source pairs were not attempted.

## 5. Campaign totals

| | Qloo HTTP | Gemini HTTP | Est. Gemini cost |
|---|---:|---:|---:|
| Live browser journeys (3) | 9 | 6 | $0.0037475 |
| movie → tv_show lifecycle | 3 | 2 | $0.001316 |
| **S9.5 total** (cap 18 / 10 / $0.05) | **12** | **8** | **$0.0050635** |

Retries and failed requests were counted, and there were none. The free rehearsal and `npm run qa` used 0 paid calls.

## 6. Defect found and fixed

**Empty cover frames while live image hosts load.**
- **Symptom.** In the live discovery screenshots (1440 and 375), book covers rendered as blank dark rectangles. They loaded later; the finale shows the real *Ready Player One* cover.
- **Cause.** The S8 artwork component showed an empty frame until the remote image arrived, and nothing while a slow host was serving. This also explains the S8 note "live 375 covers captured blank", which is now confirmed and fixed.
- **Fix** (`EntityArt.tsx`, CSS).
  - While loading, the typeset title board sits under the image *without* the "No cover from Qloo" caption, which would be false at that point.
  - The image fades in on load.
  - The captioned fallback appears only on error or when there is no URL.
- **Proof.** It was tested offline in `npm run qa` with a deliberately delayed and a deliberately broken cover at 375 and 1440. The loading state shows the title with no caption, the broken image shows the captioned fallback, and the delayed cover appears once released.
- **Not re-run live.** This is a rendering-only change, so the paid journeys were not repeated.

Other real-data observations needed no change:
- Long names (up to 76 characters) wrapped cleanly.
- Goodreads series titles split correctly.
- Real portraits suit the square artist frame.
- Coldplay's 8 near-duplicate results confirm the need for explicit selection.

## 7. Offline regression (after the fix)

| Gate | Result |
|---|---|
| `npm run lint` | 0 errors (1 pre-existing warning in the untracked `web-design-atelier` skill) |
| `npm run typecheck` | pass |
| `npm test` | 409 passed, 4 skipped (the same pre-existing live-only skips) |
| `npm run build` | pass |
| `npm run smoke` | pass |
| `npm run qa` (new, free, self-starting mock browser QA) | **17/17** journey checks, 0 hygiene problems, **0 axe violations** (landing, question, finale at 375 and 1440) |
| `npm run evaluate` (new alias: questions + quality + wording) | 6/6 |
| `npm run evaluate:question-wording` (S8.7) | 4/4 |

**Accessibility tools that actually ran:** axe-core 4.14.0 (now a pinned dev dependency), plus the Playwright keyboard and focus checks. No Lighthouse run and no screen-reader session were done, so no WCAG compliance is claimed.

## 8. Screenshots

- **Live browser runs.** In `.artifacts/live/` (git-ignored; regenerate with `npm run qa:live -- --confirm-live`), for each of `movie-book`, `artist-book` and `movie-artist`:
  - `{1440,375}-01-choice`, `-02-results`, `-03-question`, `-04-after-answer`, `-05-way-in`
  - `1440-06-why` (the expanded explanation)
- **Mock.** In `.artifacts/ui/`, including `{375,1440}-15-cover-loading`.

## 9. Remaining risks

- Qloo reretrieval was not triggered live in S9.5. Gemini chose to keep asking, which is valid behaviour. If it is demoed, it may or may not occur.
- Live latency for start is 2.9–5.4 s; the UI shows a real loading label. Cover images from external hosts can take longer, and are now handled.
- `llm_grounded` question generation is not verified through the new UI. Keep it off for the public demo unless one bounded run is done first.
- `movie → tv_show` is verified end to end over HTTP but is disabled pending a browser run. Other optional pairs are unverified.
- Local runs share one anonymous rate-limit bucket. On Vercel the platform header is used (see `release-readiness.md`).
- Production smoke used a local `next start`, not the Vercel deployment; S10 must repeat one run on the deployed URL.

## 10. Readiness

All three publicly enabled journeys passed complete live browser verification on the production build with real Qloo, Gemini and Redis. **Ready for S10 deployment**, with the risks above.
