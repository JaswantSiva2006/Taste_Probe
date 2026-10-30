# S9.14 handoff — not yet ready for S10

Use branch `seg/S9-14-six-domain-release-verification`. This checkpoint deliberately keeps new source pairs disabled pending end-to-end acceptance. See `final-release-verification.md` and `six-domain-music-capability-matrix.md` before making demo claims.

Build and test: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Run `smoke:mock`, `smoke:multi-round`, `smoke:listening`, `qa`, `qa:passport`, `evaluate`, `evaluate:adaptive`, `evaluate:songs`, and `evaluate:question-wording` through npm.

Production needs Node >=22.12, a supported Next.js host, HTTPS origin, Upstash Redis, `QLOO_MODE=live`, `QLOO_API_KEY`, `QLOO_BASE_URL=https://hackathon.api.qloo.com`, `LLM_PROVIDER=google` (or supported alias), `LLM_MODEL`, `GOOGLE_API_KEY`, `SESSION_SIGNING_SECRET`, `SESSION_STORE=redis`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN`. A dedicated restricted `YOUTUBE_API_KEY` is optional for dynamic lookup. Never expose these values through client-prefixed variables. Preserve security headers and official player origin/referrer behavior.

No remote, hosting project, verified public URL, or preview deployment was found. No infrastructure or billing was created. A host must support server-side route handlers and outbound provider/Redis HTTPS. Keep the 30-minute signed-session lifetime; Passport is local browser data and survives it. Do not introduce global TLS verification bypasses in production.

For real-provider checks, retain `.artifacts/s9-14/ledger.json`; the campaign has used 12/18 Qloo calls. Do not reset it or spend from historical campaign ledgers. Current S9.14 Gemini/YouTube usage is zero. The six-domain probe can be run with `npx vitest run --config scripts/vitest.pivot.config.mts scripts/probe-six-domain.test.ts`; existing recorded domains are skipped.

Honest demo scope: existing movie-to-music listening experience and generic enabled journeys; five source query paths have provider evidence, but complete six-domain discovery is not verified or enabled. No Devpost submission or S10 work has been started.
