# Deployment

## Vercel

- **Repository:** `JaswantSiva2006/Taste_Probe`. The production branch is `main`.
- **Build settings:** framework Next.js, root directory `/`, install `npm ci`, build `npm run build` (declared in `vercel.json`). Node.js ≥ 22.12 (`engines`); keep the default Next.js output.
- **Required services:** Upstash Redis (REST), Qloo API key, Gemini API key. YouTube Data API keys are optional.
- **Health check:** `GET /api/health`. It reports `mode`, `readiness.configuration`, `readiness.sessionStore` and the published capabilities.
- **Variable changes:** set variables in Vercel → Settings → Environment Variables. Changes apply to the **next** deployment, so redeploy after changing them.

## Environment variables

All variables are server-side (there are no `NEXT_PUBLIC_` variables).

**Missing values never break the build.** In live production, a missing required value makes every API request return `CONFIG_ERROR`, including `/api/health`.

| Variable | Production | Default | Notes |
|---|---|---|---|
| `QLOO_MODE` | `live` | mock | |
| `QLOO_API_KEY` | **required** | — | |
| `QLOO_BASE_URL` | optional | `https://hackathon.api.qloo.com` | HTTPS only; exclusions and pagination are used only on this host |
| `LLM_PROVIDER` | `google` | google | `gemini` alias; `none` disables inference outside live production |
| `LLM_MODEL` | **required** | — | e.g. `gemini-3.5-flash-lite` |
| `GOOGLE_API_KEY` | **required** | — | Gemini key |
| `SESSION_SIGNING_SECRET` | **required** | — | ≥32 random characters |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **required** | — | production refuses memory sessions |
| `YOUTUBE_API_KEY`, `YOUTUBE_API_KEY_2`, `YOUTUBE_API_KEY_3` | recommended | — | each from a different Google Cloud project; failover in order |
| `YOUTUBE_SEARCHES_PER_EXPLORATION` | recommended `12` | 6 | max 30 |
| `YOUTUBE_DAILY_SEARCH_MAX` | about 90 × number of keys | 80 | max 300 |
| `ADAPTIVE_LISTENING_ENABLED` | `true` | true | reactions and listening time re-rank |
| `ADAPTIVE_POOL_ENABLED` | `true` | true | adaptive reservoir + taste walk |
| `MAX_QLOO_WALK_CALLS` | `15` | 15 | 0 disables the walk |
| `MAX_GEMINI_REQUESTS_PER_EXPLORATION` | `30` | 30 | |
| `MAX_RECOMMENDATION_CANDIDATES` | `50` | 50 | Qloo `take` |
| `MAX_QLOO_CALLS_PER_SESSION` | `6` | 6 | question-phase Qloo budget |
| `RATE_LIMIT_FEEDBACK_MAX` | `240` | 240 | listening actions per IP per window |
| `RATE_LIMIT_RESOLVE_MAX` / `_SEARCH_MAX` / `_START_MAX` / `_ANSWER_MAX` | defaults | 60 / 30 / 10 / 30 | per IP per `RATE_LIMIT_WINDOW_SECONDS` (600) |
| `ENABLE_EXPENSIVE_OPERATIONS` | `true` | true | kill switch for start/continue |
| `QUESTION_GENERATION_MODE` | optional | deterministic | `llm_grounded` for Gemini-proposed questions |
| `MUSIC_MOMENT_REVIEW`, `LEGACY_GENERIC_JOURNEYS`, `VERIFICATION_PAIRS` | **unset** | — | refused in production |

**Not used by the application:** `ENABLE_QLOO_CACHE`, `CACHE_TTL_SECONDS` and `SENTRY_DSN` are accepted for compatibility but have no effect.

## Release verification

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
npm run audit:release-secrets
npm run smoke:mock && npm run smoke:multi-round && npm run smoke:listening
npm run qa && npm run qa:passport
```

**After deploying:**
1. Open `/api/health`. Expect `mode: live`, `configuration: ready` and `sessionStore: redis`.
2. Run one real journey in a clean browser: search, start, listen, Love, Not for me, Save, reload the Passport, Finish.

## Paid live checks

These scripts call real providers and are **opt-in**:
- `smoke:qloo`, `smoke:gemini`, `smoke:live`, `smoke:questions-live`, `smoke:production`;
- `probe:*`;
- `qa:live`, `qa:adaptive-live`;
- `test:redis`.

`qa:listening` additionally needs a local, git-ignored ledger from an earlier campaign. None of these run in `npm test`.

## Rollback

- Stop walk spend: set `MAX_QLOO_WALK_CALLS=0`, or `ADAPTIVE_POOL_ENABLED=false`.
- Return to the earlier listening loop: set `ADAPTIVE_LISTENING_ENABLED=false`.
- Or promote the previous Vercel deployment. Sound Passport data is browser-local and unaffected.
