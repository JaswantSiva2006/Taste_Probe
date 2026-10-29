# TasteProbe

TasteProbe is an AI-assisted cultural discovery app (Qloo Agentic Hackathon). You give it a favourite
entity (for example the movie *Interstellar*) and a target domain (books). It retrieves
Qloo-grounded candidates, asks up to **3** adaptive preference questions, updates your preferences from
explicit answers, and returns at most **5** evidence-backed recommendations.

This branch is **segment S1, the walking skeleton**: the whole loop runs end to end, but on **mock data
only**. Qloo and Gemini are replaced by clearly labelled fixtures and a deterministic mock agent.

## Architecture

```
Browser UI (src/components)            -- calls only the app's own API routes
   │  fetch + Zod-validated responses (src/lib/api-client.ts)
   ▼
Route handlers (src/app/api/**)        -- G1: validation, request IDs, JSON envelope
   │  handleApi / parseJsonBody (src/lib/validation/http.ts)
   ▼
Discovery service (src/lib/discovery/service.ts)  -- G2 orchestration
   ├─ QlooProvider (src/lib/qloo)          T1 search, T2 insights   [mock | live placeholder]
   ├─ normalize.ts                         K1 raw payload → public contracts, provenance kept
   ├─ questions.ts                         K2 question builder + D1 selection boundary
   ├─ preferences.ts                       D2 explicit preference updates
   ├─ ranking.ts                           placeholder reranker (observable movement)
   ├─ stop.ts                              V2 stop controller
   ├─ DiscoveryAgent (src/lib/agent)       A1 deterministic mock agent + decision validator
   └─ session (src/lib/session)            HMAC-signed, expiring session state
Config (src/lib/config/env.ts)          -- the only module that reads process.env
```

Flow: search → select → start → retrieve → normalize → build questions → select question → agent
decision → answer → preference update → rerank → stop or ask again → finish.

The agent loop is bounded: on start the mock agent asks for a `retrieve` (one Qloo call), then
`ask`s the top question from the selector or `finish`es when the stop controller says so. Agent output is
validated against `AgentDecision`, may only select offered question IDs, and is capped by
`MAX_AGENT_TOOL_CALLS_PER_TURN` and `MAX_QLOO_CALLS_PER_SESSION`.

### Directory structure

```
src/app/                 page, layout, API route handlers
src/components/          DiscoveryApp (client state machine), RecommendationList
src/lib/contracts/       canonical Zod schemas + types (domain.ts, api.ts)
src/lib/config/          centralized environment config
src/lib/qloo/            provider interface, raw types, fixtures, mock + live-placeholder providers
src/lib/discovery/       normalizer, questions, preferences, ranking, stop, orchestration service
src/lib/agent/           DiscoveryAgent interface, deterministic mock agent, decision validator
src/lib/session/         token signing + session state service
src/lib/validation/      AppError + route-handler helpers
src/lib/telemetry/       structured logging
tests/unit/              schemas, provider, normalization, questions, preferences, ranking, stop, agent, session, config
tests/integration/       route handlers end to end (start / answer / finish + negative cases)
scripts/smoke-mock.mjs   HTTP smoke test against a real Next.js server
```

## Prerequisites

- Node.js 22 LTS (>= 22.12) and npm
- No API keys are needed for mock mode.

## Setup

```bash
npm install
```

Optional: copy `.env.example` to `.env.local` and fill it in. `.env`, `.env.local` and `.env.*.local`
are git-ignored; never commit credentials.

| Variable | Purpose |
| --- | --- |
| `QLOO_MODE` | `mock` (default) or `live`. Live returns `501 LIVE_PROVIDER_NOT_IMPLEMENTED` until a later segment. It never falls back to fixtures. |
| `SESSION_SIGNING_SECRET` | ≥ 32 chars. Required for `live` and for production. In non-production mock mode it may be omitted: an ephemeral random secret is generated per process, so sessions don't survive a restart. |
| `SESSION_TTL_SECONDS` | Session lifetime (default 1800). |
| `MAX_QUESTIONS` (≤ 3), `MAX_QLOO_CALLS_PER_SESSION`, `MAX_AGENT_TOOL_CALLS_PER_TURN`, `MAX_RECOMMENDATION_CANDIDATES`, `FINAL_RECOMMENDATION_COUNT` (≤ 5) | Budgets. |
| `QLOO_*`, `LLM_*`, `GOOGLE_API_KEY` | Parsed but unused in S1 and never required in mock mode. |
| `ENABLE_*`, `CACHE_TTL_SECONDS`, `SENTRY_DSN` | Parsed for later segments; not yet wired. |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server using your `.env.local` (may be live mode). |
| `npm run dev:mock` | Dev server forced to `QLOO_MODE=mock` (via `cross-env`, works on Windows). |
| `npm run lint` | ESLint (flat config, `eslint-config-next`). |
| `npm run typecheck` | `next typegen` + `tsc --noEmit` (strict). |
| `npm test` | Vitest unit + integration tests. |
| `npm run build` | Production build. |
| `npm run smoke:mock` | HTTP end-to-end smoke test (below). |

Open http://localhost:3000, search **Interstellar**, select it, start discovery, answer a question and
watch the ▲/▼ markers, then continue or press **Finish now**.

### How tests stay in mock mode

- **Vitest** never reads `.env.local`. Tests build config from explicit values and use a fresh random
  secret per test (`tests/helpers.ts`, `vi.stubEnv`).
- **`smoke:mock`** starts `next dev` on a free port and sets these on the child process: `QLOO_MODE=mock`,
  a random in-memory `SESSION_SIGNING_SECRET`, and empty `QLOO_API_KEY` / `GOOGLE_API_KEY`. Next.js
  gives values already in the process environment precedence over `.env*` files, so a live-mode `.env.local`
  cannot override them. The smoke checks `/api/health` and `meta.mode` on every response and aborts
  if the mode is not `mock`. On exit it kills the server's process tree (`taskkill /T` on Windows).
  It then runs search → select → start → invalid answer (400) → `like` answer (asserts the order
  changed) → finish (≤ 5 mock results) → answer after finish (409).
- To smoke an already-running mock server instead: `SMOKE_BASE_URL=http://localhost:3000 npm run smoke:mock`.
  A `next dev` instance already running in this folder will block the spawned one, so stop it first or use
  `SMOKE_BASE_URL`.

## HTTP API

Every response uses one envelope and carries an `x-request-id` header:

```jsonc
{ "ok": true,  "data": { ... },                          "meta": { "requestId": "uuid", "mode": "mock" } }
{ "ok": false, "error": { "code": "...", "message": "..." }, "meta": { "requestId": "uuid", "mode": "mock" } }
```

| Route | Request | `data` |
| --- | --- | --- |
| `GET /api/health` | none | `{ status, mode, qloo: { mode, implemented }, agent }` |
| `GET /api/entities/search?q=&type=movie\|book` | query (`q` 1–200 chars) | `{ results: EntitySummary[] }` |
| `POST /api/discovery/start` | `{ entityQuery, sourceType, targetType, maxQuestions: 3, selectedEntityId? }` | `DiscoveryView` |
| `POST /api/discovery/answer` | `{ sessionToken, questionId, response }` | `DiscoveryView` |
| `POST /api/discovery/finish` | `{ sessionToken }` | `DiscoveryView` (top ≤ 5, idempotent) |

`DiscoveryView` (`src/lib/contracts/api.ts`) contains `sessionToken`, `sessionId`, `revision`,
`status` (`asking`/`finished`), `finishReason`, `seed`, `questionCount`/`maxQuestions`, `currentQuestion`
(with `allowedResponses`), `lastAnswer`, `preferences`, ranked `recommendations` (each with `position`,
`previousPosition`, `score`, matched tags and an `explanation`), `rankingChanged`, the agent decision and
usage counters. The session token is transported in the JSON body, never in a cookie or URL.

The server builds the `PreferenceAnswer` itself (targets come from the active question, not the client).
Main error codes: `VALIDATION_ERROR`/`INVALID_JSON` (400), `ENTITY_NOT_FOUND` (404),
`ENTITY_TYPE_MISMATCH`/`ENTITY_NOT_RESOLVED` (400), `INVALID_QUESTION`/`INVALID_ANSWER` (400),
`QUESTION_MISMATCH`/`SESSION_FINISHED`/`QUESTION_BUDGET_EXHAUSTED`/`SESSION_MODE_MISMATCH` (409),
`INVALID_SESSION_TOKEN`/`SESSION_EXPIRED` (401), `LIVE_PROVIDER_NOT_IMPLEMENTED` (501).

## Mock-mode limitations

- All entities, books, tags and scores are **synthetic fixtures** (`mock:` IDs, `evidence.source = "mock"`,
  `syntheticScore` instead of `affinity`). They are not Qloo data and make no claim about real works.
- Only *Interstellar* (and a synthetic sibling) have recommendations, and only for books.
- The question selector is a **placeholder balance heuristic**, not the information-theoretic optimizer.
- The reranker is a **placeholder additive adjustment**, not the production scoring equation.
- The agent is a **deterministic mock**; no Gemini calls are made.
- Only tag like/dislike/skip questions are generated; the contracts already allow pair (`prefer_a`/`prefer_b`/
  `both`/`neither`) and entity questions.

### Session limitations (for S4)

Session state is a stateless HMAC-SHA256 token carried by the client. It gives integrity and expiry but
**no replay protection**: an older, still-valid token can be resubmitted (for example to answer the same
question twice and fork the session) until it expires. `revision` is recorded but not enforced against a
server store. Cross-request concurrency, idempotency keys and a server-side revision store belong to S4.
The token payload is signed, not encrypted (it holds no secrets or personal data). With no
`SESSION_SIGNING_SECRET` in mock dev, the ephemeral secret is per process.

## Future integration boundaries

| Replace | Where | Contract to keep |
| --- | --- | --- |
| Live Qloo | `createLiveQlooProvider` in `src/lib/qloo/index.ts` | `QlooProvider` + raw types → `normalize.ts` yields `QlooRecommendationCandidate` (`evidence.source = "qloo"`) |
| Gemini agent | `createDiscoveryDeps` in `src/lib/discovery/deps.ts` | `DiscoveryAgent.decide` → `AgentDecision`, still passed through `validateAgentDecision` |
| Question optimizer (S5) | `QuestionSelector` in `src/lib/discovery/questions.ts` | ordered `Question[]` |
| Scoring | `rankCandidates` in `src/lib/discovery/ranking.ts` | `RankedRecommendation[]` |
| Session hardening (S4) | `src/lib/session/*` | `encodeSessionState` / `decodeSessionState`, canonical `TasteSession` fields |
| UI | `src/components/*` | HTTP API above |
