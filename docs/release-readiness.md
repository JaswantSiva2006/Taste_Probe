# TasteProbe release readiness

## Production environment

Required for `NODE_ENV=production` and `QLOO_MODE=live`:

- `SESSION_SIGNING_SECRET` (at least 32 characters)
- `UPSTASH_REDIS_REST_URL` (HTTPS) and `UPSTASH_REDIS_REST_TOKEN`
- `QLOO_API_KEY`; optional `QLOO_BASE_URL`; bounded `QLOO_TIMEOUT_MS`
- `LLM_PROVIDER=google`, `LLM_MODEL`, `GOOGLE_API_KEY`, and bounded `LLM_TIMEOUT_MS`

Production configuration fails closed if Redis or paid-provider requirements are absent. Production never falls back to memory. `/api/health` validates configuration and reports only provider mode, implementation status, agent label, configured dependency readiness, and session-store kind; it never probes paid APIs or exposes credentials.

## Abuse and cost protection

Production enables an atomic Redis-backed anonymous limiter by default:

| Action | Default limit | Window |
|---|---:|---:|
| Search | 30 | 10 minutes |
| Discovery start | 10 | 10 minutes |
| Discovery answer | 30 | 10 minutes |

Configure with `RATE_LIMIT_ENABLED`, `RATE_LIMIT_SEARCH_MAX`, `RATE_LIMIT_START_MAX`, `RATE_LIMIT_ANSWER_MAX`, and `RATE_LIMIT_WINDOW_SECONDS`. Rejections occur before provider construction, return HTTP 429, and include `Retry-After`. `ENABLE_EXPENSIVE_OPERATIONS=false` pauses new discovery starts without taking down the landing page or existing-session completion.

On Vercel, the limiter uses the platform-controlled `x-vercel-forwarded-for` value only when `VERCEL=1`. Other deployments share one anonymous bucket unless the operator explicitly configures `TRUSTED_PROXY_IP_HEADER` and guarantees that the trusted edge overwrites that header. Raw addresses are HMAC-hashed and are never logged or stored in keys.

## Redis and sessions

Sessions use Upstash Redis Lua CAS operations with expiry. Revision changes, concurrent mutation exclusion, leases, stale-token rejection, expiry, and transport failure are covered offline and by the existing live Redis tests. Redis transport failures become sanitized `SESSION_STORE_UNAVAILABLE` responses. The application does not switch to client or process memory in production.

## External dependencies and fallback

- Qloo: finite abort timeout, at most two attempts, retries only transient 5xx, explicit 429/auth/bad-request/timeout/invalid-response classes, and actual attempt accounting. Existing verified candidates may survive a failed optional reretrieval; initial failure never fabricates recommendations.
- Gemini: finite abort timeout and bounded agent repair/retry. Authentication, rate-limit, and bad-request failures are not retried. Decision failure uses the established deterministic grounded fallback. Question-proposer failure uses deterministic grounded questions.
- Replay/stale answer validation and session lease acquisition happen before paid answer work.

## Observability and privacy

Structured JSON events cover every API request and discovery start/answer/finish. They include request ID, route/action, safe revision, store kind, Qloo attempts, Gemini attempts, proposer-versus-decision breakdown, tokens, estimated cost, selected question, fallback/degradation reason, update mechanism, and latency where applicable.

The logger recursively redacts credential-like field names and signed session-token patterns. Never add raw prompts, complete upstream responses, authorization/cookie headers, user session tokens, API keys, Redis URLs/tokens, or signing secrets to telemetry.

## User recovery

The existing Intertitle UI provides retry, restart, or edit actions for network failures, expired/conflicting sessions, Qloo failures, Redis failures, and invalid selections. S9 adds explicit messages for public rate limits and the emergency new-session pause. No fake progress percentages or unsupported fallback claims are shown.

## Production smoke

After `npm run build`, run once:

```text
npm run smoke:production
```

It launches `next start` with production configuration and exercises real HTTP health → search → start → answer → stale-token rejection → finish. It fails if the session store is not Redis, results are not Qloo-grounded, revisions are not 0→1→2, or usage exceeds five Qloo requests, three Gemini requests, or $0.05 estimated Gemini cost. Output and captured server logs are sanitized.

## Release checklist

- Configure all required variables in the deployment platform; never commit `.env*`.
- Confirm the trusted proxy/header policy or accept the conservative shared bucket.
- Run lint, typecheck, tests, build, mock smoke, evaluations, and one production smoke.
- Confirm Redis, Qloo, and Gemini dashboards/quotas independently; application estimates are not billing controls.
- Verify the emergency switch and rate limits suit the expected judge traffic.

## Remaining risks

- Anonymous IP limiting is imperfect on shared networks and depends on correct trusted-edge configuration.
- Health reports dependency configuration, not live Qloo/Gemini availability, to avoid paid monitoring traffic.
- Provider billing enforcement remains external.
- The experimental `llm_grounded` question mode remains opt-in; S9 does not change its default.

## Release status (S9.5)

The earlier blocker (a missing local `SESSION_SIGNING_SECRET`) no longer applies.

S9.5 ran the **complete browser experience** on the production build (`next start`, `NODE_ENV=production`, `QLOO_MODE=live`) with real Qloo, real Gemini and real Upstash Redis. All three enabled journeys (movie → book, music_artist → book, movie → music_artist) passed:
- search, explicit selection, start, grounded question, answer, finish, START HERE, "Why this starting point?" and restart;
- Redis revisions 0→1→2;
- no browser errors and no credential exposure.

The campaign used 12 Qloo calls, 8 Gemini calls and about $0.0051 in total. Details are in `docs/live-browser-verification.md`.

There is no remaining blocker for S10. Before announcing, repeat one bounded `npm run qa:live -- --confirm-live --journeys movie-book` (or `npm run smoke:production`) against the deployed environment.

Regression commands:
- `npm run qa` is free mock browser QA.
- `npm run qa:live -- --confirm-live` is the paid, budgeted live browser QA, with a persistent ledger and a free `--rehearse` mode.
