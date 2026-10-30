# Tested release preparation

Base commit: `233b989`. This is a bounded deployment-preparation pass; it does not publish or deploy anything. No new Qloo requests are permitted from the exhausted S9.14 campaign.

## Pritam diagnosis

There is no reviewed Pritam mapping in `src/lib/music/mappings.ts`. A read-only Redis inspection found no surviving Pritam session/cached entry, so the exact historical response behind the screenshot cannot be recovered. The current name-only YouTube diagnostic reproduced `ambiguous / no_topic_channel_match`: the resolver maps that to `NEEDS_REVIEW`, `video: null`, and normally `dynamicLookup: USED` (or `CACHED` for a saved negative result).

The diagnostic used one YouTube `search.list` request (HTTP 200), zero `videos.list`, zero Qloo, and zero Gemini. Returned channels were Nagpuri Collection, Ninesh Music Nagpuri, Sony Music India, Pritam Bhartwan Official Channel, and T-Series. The latter two label identities do not satisfy the automatic exact Pritam Topic/VEVO rule; unrelated same-name channels are not safe matches. The internal reason name `no_topic_channel_match` predates VEVO support and now means neither supported channel class matched.

This is an identity-verification limitation, not evidence that Pritam has no playable recordings. [YouTube’s official recording metadata for Kesariya](https://www.youtube.com/watch?v=N4_4A2nA4fM) credits Pritam and Sony Music. An independent official oEmbed request returned HTTP 200, exact title `Kesariya`, author `Pritam - Topic`, channel `https://www.youtube.com/channel/UCCTN01plFzn4npREHKT2_9Q`. Thus a legitimate Topic recording exists but was absent from the current five-result broad search window. This keyless metadata/embedding check used no YouTube Data API quota; playback of this particular candidate was not tested.

No retained, independently verified **Qloo artist ID** for Pritam was available locally, and no fresh Qloo request was authorized. No guessed mapping was added. To add one later, retain Pritam’s Qloo ID/name from an authorized exploration and verify that exact pair against this candidate, then add a reviewed entry with the check date and evidence. Label uploads can also be approved individually in that registry; automatic label-channel matching has not been broadened. The dynamic search window has not been expanded, avoiding an unreviewed increase in provider spending during this bounded release pass.

Resolution order and safeguards:

1. Signed-session artist authorization precedes resolution/cache access.
2. A fresh reviewed mapping resolves without lookup. Name mismatch, held review, invalid video ID, or metadata older than 30 days produces a review fallback.
3. Without `YOUTUBE_API_KEY`, dynamic lookup is disabled: `UNAVAILABLE / no_reviewed_mapping / DISABLED_NO_KEY`.
4. Dynamic results are cached by Qloo artist ID and `v2-topic-vevo` policy. Success lasts 24 hours; ambiguous/no-match outcomes last six hours. Failures and quota refusals are not cached. Name mismatch invalidates a hit.
5. Cache hits precede quota charging. Default app caps are 40 searches per UTC day/deployment and two per exploration, counted through the shared limiter (Redis in production). These are application caps, not a statement about Google’s account quota.
6. Quota refusal maps to `RATE_LIMITED / youtube_quota_exhausted`; network/quota-store failures map to `UPSTREAM_FAILURE`. A Redis quota outage prevents a new YouTube request.
7. Automatic acceptance requires one exact artist Topic/VEVO channel and a public, embeddable video. VEVO additionally needs artist-correlated title metadata and excludes impersonation/cover markers. Label and self-described channels require separate reviewed evidence.

The fallback now explains that music may exist and offers both “Try the next artist” and “Find their music on YouTube”.

The listening path is `songOptions` → `resolveArtistVideo` → `optionsFrom`. Any non-resolved result becomes an empty authorized option set, then listening status `no_verified_song`; the UI previously rendered the same “No verified recording” heading for all such outcomes. That heading alone cannot distinguish ambiguity, disabled lookup, cached negative, quota refusal or upstream failure. No surviving response/cache record was available to retrospectively disambiguate the original screen; the fresh diagnostic above is explicit about what it reproduced.

## Exact Vercel environment variable names

All credentials below are **server-side**. Never paste their values into documentation, Git, screenshots, or client-prefixed variables.

### Required for the intended live deployment

| Name | Requirement |
|---|---|
| `QLOO_MODE` | Set to `live`; default is mock and is unsuitable for the live release. |
| `QLOO_API_KEY` | Valid key for the configured hackathon provider. |
| `LLM_MODEL` | Configured, available Gemini model ID. |
| `GOOGLE_API_KEY` | Gemini API credential. |
| `SESSION_SIGNING_SECRET` | At least 32 random characters; stable across deployment instances. |
| `UPSTASH_REDIS_REST_URL` | HTTPS Upstash REST endpoint. |
| `UPSTASH_REDIS_REST_TOKEN` | Matching Upstash REST credential. |
| `NODE_ENV` | Must be `production` at runtime; Vercel supplies this, so do not override it manually. |

### Optional names (validated defaults exist)

Provider/runtime: `QLOO_BASE_URL`, `QLOO_TIMEOUT_MS`, `LLM_PROVIDER`, `LLM_TEMPERATURE`, `LLM_TIMEOUT_MS`, `QUESTION_GENERATION_MODE`, `SESSION_STORE`, `SESSION_TTL_SECONDS`.

YouTube: `YOUTUBE_API_KEY`, `YOUTUBE_TIMEOUT_MS`, `YOUTUBE_DAILY_SEARCH_MAX`, `YOUTUBE_SEARCHES_PER_EXPLORATION`.

Rate limits: `RATE_LIMIT_ENABLED`, `RATE_LIMIT_SEARCH_MAX`, `RATE_LIMIT_START_MAX`, `RATE_LIMIT_ANSWER_MAX`, `RATE_LIMIT_RESOLVE_MAX`, `RATE_LIMIT_WINDOW_SECONDS`, `TRUSTED_PROXY_IP_HEADER`.

Budgets: `MAX_QUESTIONS`, `MAX_QLOO_CALLS_PER_SESSION`, `MAX_AGENT_TOOL_CALLS_PER_TURN`, `MAX_GEMINI_REQUESTS_PER_EXPLORATION`, `MAX_RECOMMENDATION_CANDIDATES`, `FINAL_RECOMMENDATION_COUNT`.

Features/observability: `ADAPTIVE_POOL_ENABLED`, `ENABLE_ADAPTIVE_QUESTIONING`, `ENABLE_EARLY_STOPPING`, `ENABLE_QLOO_CACHE`, `CACHE_TTL_SECONDS`, `ENABLE_EVALUATION_LOGGING`, `ENABLE_AGENT_TRACING`, `ENABLE_EXPENSIVE_OPERATIONS`, `SENTRY_DSN`.

Recommended explicit settings: `SESSION_STORE=redis`, `LLM_PROVIDER=google`, `QLOO_BASE_URL=https://hackathon.api.qloo.com`, `RATE_LIMIT_ENABLED=true`. Leave budget defaults unchanged. `ADAPTIVE_POOL_ENABLED` defaults to `false`: explicitly choose `true` only if deploying the adaptive controller with accepted quota/testing scope. Its enabled path can spend Qloo calls, including artist-level feedback. Do not turn it on merely to obtain a green demo.

`YOUTUBE_API_KEY` is optional: without it only reviewed recordings resolve. Use a dedicated YouTube Data API credential, never the Gemini key. Configure restrictions for this server-side API usage in the provider console; a browser-referrer-only key is inappropriate for backend requests. This pass did not inspect account-console restrictions.

### Forbidden/restricted production configurations

| Name | Prohibited configuration |
|---|---|
| `VERIFICATION_PAIRS` | Nonempty verification allowlist; omit entirely. Runtime rejects it. |
| `LEGACY_GENERIC_JOURNEYS` | `true`; runtime rejects it. Production is music-only. |
| `MUSIC_MOMENT_REVIEW` | `true`; runtime rejects unreviewed-moment mode. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0`; runtime rejects disabled TLS verification. Omit it. |
| `SESSION_STORE` | `memory`; runtime rejects it in production. |
| `LLM_PROVIDER` | `none` or any unsupported provider in live production; runtime rejects it. |
| `NODE_ENV` | `development` or `test` for a production deployment. |
| `RATE_LIMIT_ENABLED` | Do not use `false` on the public release, although the schema permits it. |
| `QLOO_MODE` | Do not use `mock` for a deployment advertised as live, although the schema permits it. |

Forbidden secret-bearing client names include `NEXT_PUBLIC_QLOO_API_KEY`, `NEXT_PUBLIC_GOOGLE_API_KEY`, `NEXT_PUBLIC_YOUTUBE_API_KEY`, `NEXT_PUBLIC_SESSION_SIGNING_SECRET`, and `NEXT_PUBLIC_UPSTASH_REDIS_REST_TOKEN`. None is needed by this app. `MUSIC_MOMENT_REVIEW=false` and `LEGACY_GENERIC_JOURNEYS=false` need not be set because they default to false.

## Deployment compatibility and publication steps

1. Review the tested commit and unrelated local files separately. Run `npm ci`, the regression gates, production build, then `npm run audit:release-secrets` on the final checkout. The audit checks configured secrets against reachable Git blobs and client-build files; it cannot prove absence of unknown/rotated credentials. A broader historical scan is advisable before publication. Never remove history or rotate accounts without reviewing a real finding.
2. Approve a project license and copyright holder, then add its actual LICENSE text before claiming the repository is open source. No license has yet been approved/added. Third-party videos, metadata, thumbnails and trademarks are not relicensed by a project license.
3. Create the intended GitHub repository manually after reviewing visibility. Add its remote, push only the reviewed release branch/commit, and confirm `.env*`, private keys, `.vercel`, QA artifacts and local agent settings are absent from tracked release content. Existing tracked files are not untracked merely by adding ignore rules. Do not stage unrelated changes with `git add .`.
4. Import that repository into Vercel. Use its Next.js framework preset, repository root, `npm ci`, `npm run build`, and a Node runtime satisfying `>=22.12.0`. Keep the default Next.js output directory; do not configure a static export. `vercel.json` already declares the build/install framework settings.
5. Enter the required names above through Vercel’s protected environment settings for the intended Preview/Production environments, then deploy manually. Preview also runs with production validation and needs Redis. Use separate preview credentials/database when available.
6. Test the actual HTTPS URL in a clean browser: source selection/search, start, verified recording, user Play/Pause, reactions, another song/artist, save, finish and Passport reload/removal. Do not describe deterministic/single-option selection as a Gemini song call. A new paid-provider smoke requires a separately authorized Qloo allowance; the existing campaign is exhausted.
7. Check `/api/health`, HTTPS security headers and player behavior. `YouTubePlayer` supplies `origin: window.location.origin` and cues without autoplay. No localhost/public-origin environment variable is required. CSP permits the official YouTube script/frame hosts; `Referrer-Policy` is `strict-origin-when-cross-origin`. Native controls and branding remain visible. Verify these headers and playback on the actual deployed origin; local success is not public-origin proof.

There is currently no Git remote, public repository URL, or verified deployment URL. No publication/deployment is performed by this preparation pass. Account authentication, license approval, actual public-origin checks and the previously incomplete live acceptance remain release blockers.

Platform reference: [Vercel environment scopes](https://vercel.com/docs/environment-variables) distinguish Preview and Production settings. Keep the variables in this document server-side; Next.js documents [`NEXT_PUBLIC_` build-time inlining](https://nextjs.org/docs/pages/guides/environment-variables). The rate limiter uses Vercel’s platform-supplied `VERCEL` indicator and `x-vercel-forwarded-for` header automatically; do not invent a client-controlled proxy header override. Existing Redis storage uses REST HTTPS with atomic Lua CAS, fixed expiry, and no production memory fallback. Qloo/Gemini configuration is composed only on the server and misconfigured live Gemini fails closed.

## Verification of this preparation pass

- 553 tests passed, four existing live-only tests skipped.
- Lint passed with one unrelated pre-existing local-skill warning; typecheck, production build, mock/multi-round/listening smoke, standard/adaptive/song/wording evaluations passed.
- Generic browser QA: 18/18; multi-round browser QA: 14/14; Passport browser QA: 59/59, including the clearer unavailable-recording copy, preview controls, persistence, and narrow layouts.
- Reviewed recording audit: 25/25 videos reached PLAYING with matching identity. This does not upgrade entries held for human review.
- Existing release-secret audit passed before changes: 1,016 Git objects and 27 client files, zero configured-secret matches, no tracked environment files. It is rerun on the final build/commit.
- Git filename-history review found only `.env.example` among environment/private-key paths. Ignore checks covered preview env files, `.vercel` state, local agent settings and private keys. Existing unrelated tracked edits were preserved.
- Additional provider use: zero Qloo, zero Gemini, one quota-guarded YouTube search, zero videos.list; one keyless oEmbed check. Ordinary regression tests remained offline apart from explicitly run official-player audits.
