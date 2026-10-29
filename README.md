# TasteProbe

TasteProbe is an AI-assisted cultural discovery app (Qloo Agentic Hackathon). You give it a favourite
entity (for example the movie *Interstellar*) and a target domain (books). It retrieves
Qloo-grounded candidates, asks up to **3** adaptive preference questions, updates your preferences from
explicit answers, and returns at most **5** evidence-backed recommendations.

This branch is **segment S3**. The default mock pipeline remains fully offline, while live mode uses
authenticated Qloo Search and Insights. Gemini is still replaced by a truthfully labelled deterministic mock agent.

## Architecture

```
Browser UI (src/components)            -- calls only the app's own API routes
   │  fetch + Zod-validated responses (src/lib/api-client.ts)
   ▼
Route handlers (src/app/api/**)        -- G1: validation, request IDs, JSON envelope
   │  handleApi / parseJsonBody (src/lib/validation/http.ts)
   ▼
Discovery service (src/lib/discovery/service.ts)  -- G2 orchestration
   ├─ QlooProvider (src/lib/qloo)          T1 search, T2 insights   [mock | live Qloo]
   ├─ normalize.ts                         K1 raw payload → public contracts, provenance kept
   ├─ questions.ts                         K2 question builder + D1 selection boundary
   ├─ preferences.ts                       D2 explicit preference updates
   ├─ ranking.ts                           bounded deterministic preference reranker
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
src/lib/qloo/            provider interface, raw types, fixtures, mock + authenticated live providers
src/lib/discovery/       normalizer, questions, preferences, ranking, stop, orchestration service
src/lib/agent/           DiscoveryAgent interface, deterministic mock agent, decision validator
src/lib/session/         token signing + session state service
src/lib/validation/      AppError + route-handler helpers
src/lib/telemetry/       structured logging
tests/unit/              schemas, provider, normalization, questions, preferences, ranking, stop, agent, session, config
tests/integration/       route handlers end to end (start / answer / finish + negative cases)
scripts/smoke-mock.mjs   HTTP smoke test against a real Next.js server
scripts/probe-live.mjs   S2 live Qloo/Gemini contract probe (helpers in scripts/lib/)
scripts/smoke-qloo.mjs   bounded real-Qloo HTTP route smoke (no Gemini calls)
docs/                    live-api-contract.md (verified provider contracts)
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
| `QLOO_MODE` | `mock` (default) or `live`. Live uses authenticated Qloo and never falls back to fixtures. |
| `SESSION_SIGNING_SECRET` | ≥ 32 chars. Required for `live` and for production. In non-production mock mode it may be omitted: an ephemeral random secret is generated per process, so sessions don't survive a restart. |
| `SESSION_TTL_SECONDS` | Session lifetime (default 1800). |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Shared session store. **Required in production**, where the app fails closed (`CONFIG_ERROR`) without them. Not needed for dev, mock or tests. |
| `SESSION_STORE` | Optional `memory` or `redis`. Defaults to `memory` outside production. Production always uses `redis`, and `memory` is rejected there. |
| `MAX_QUESTIONS` (≤ 3), `MAX_QLOO_CALLS_PER_SESSION`, `MAX_AGENT_TOOL_CALLS_PER_TURN`, `MAX_RECOMMENDATION_CANDIDATES`, `FINAL_RECOMMENDATION_COUNT` (≤ 5) | Budgets. |
| `QLOO_API_KEY`, `QLOO_BASE_URL`, `QLOO_TIMEOUT_MS` | Live Qloo credentials, validated HTTPS endpoint, and timeout. Never required in mock mode. |
| `LLM_PROVIDER`, `LLM_MODEL`, `GOOGLE_API_KEY`, `LLM_TEMPERATURE`, `LLM_TIMEOUT_MS` | Gemini agent, used in live mode. Canonical: `LLM_PROVIDER=google`, `LLM_MODEL=gemini-3.5-flash-lite`. `gemini` is accepted as a legacy alias. `none` explicitly disables inference (decisions are then labelled `DETERMINISTIC_FALLBACK`/`llm_disabled`). Missing Gemini config in live mode is a `CONFIG_ERROR`, never a silent fallback to the mock agent. The key stays server-side. |
| `QUESTION_GENERATION_MODE` | `deterministic` (default) preserves S5 generation; `llm_grounded` enables one bounded Gemini proposal call per leased turn followed by deterministic evidence validation and S5 scoring. |
| `MAX_AGENT_TOOL_CALLS_PER_TURN`, `ENABLE_AGENT_TRACING` | Per-turn cap on model function calls (enforced in code), and structured `agent.decision` traces. |
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
| `npm test` | Vitest unit + integration tests (offline; the live Redis test is skipped). |
| `npm run test:session` | Session replay, concurrency, store-contract and fail-closed config suites only. |
| `npm run test:redis` | Optional: runs the store contract against a real Upstash database (needs `UPSTASH_*`). |
| `npm run build` | Production build. |
| `npm run smoke:mock` (alias `npm run smoke`) | HTTP end-to-end smoke test (below). |
| `npm run qa:ui -- --url http://127.0.0.1:3000` | Browser QA against a running `dev:mock` server. Drives the full UI flow at 320/375/768/1024/1440, checks keyboard, overflow, broken images and console errors, and saves screenshots to `.artifacts/ui/`. Needs `npx playwright install chromium` once. |
| `npm run smoke:qloo` | Real Qloo-only HTTP smoke: Search, selection validation, Insights, and provenance (3 requests, 0 Gemini calls). |
| `npm run smoke:live` | **Live HTTP E2E** through the real app: search → start → answer → finish with real Qloo and real Gemini (≤ 5 Qloo, ≤ 3 Gemini requests, < $0.05). It fails rather than raising a limit. |
| `npm run smoke:gemini` | Live Gemini agent smoke: one real function-calling decision (≤ 2 requests, < $0.01, 0 Qloo/Redis calls). |
| `npm run evaluate:questions` | Offline fixture-backed S5 evaluation with eligible/rejected counts, H/D/I/R/U scores, counterfactual top-five rankings, and runtime. |
| `npm run evaluate:question-quality` | Offline 20-scenario comparison of deterministic S5 and controlled grounded proposal fixtures; prints safety/proxy metrics and blind human-rating material. |
| `npm run smoke:questions-live` | Bounded route-level live S8.5 smoke using real Qloo and Gemini; reports validation, S5 scores, counterfactuals, tokens, cost, and latency. |

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

## Interface (S8)

The "Intertitle" direction treats a screening room as the stage:
- An original SVG projector throws its beam onto a bookshelf.
- Each adaptive question appears as a silent-film intertitle.
- The finale is a printed programme.

Design rationale, tokens, the asset register, the QA log and the scorecard are in
[docs/ui-design-brief.md](docs/ui-design-brief.md). The UI uses only the existing API client and response fields.
Labels are truthful: Qloo reretrieval vs local reranking, Gemini vs deterministic fallback, and synthetic vs Qloo data.
Components live in `src/components/`, and pure presentation helpers in `src/lib/ui/` (unit-tested).

## Live API probe (S2)

`npm run probe:live` makes **real, authenticated** calls to Qloo and Gemini to verify their contracts. The results
are documented in [docs/live-api-contract.md](docs/live-api-contract.md). The probe is not part of `npm test` or
`smoke:mock`; use `smoke:qloo` for the S3 live provider without invoking Gemini.

### Live Qloo provider (S3)

Live mode sends `X-Api-Key` only from the server, validates configured HTTPS base URLs, and applies bounded
timeouts. Search uses `GET /search`; recommendations use `GET /v2/insights` with verified positive entity/tag
signals and entity/tag exclusions. Transient 5xx responses receive at most one retry when the session request
budget allows it; authentication, permission, billing/quota, rate-limit, and bad-request responses are not retried.
Every live result has `evidence.source = "qloo"`. Its `evidence.requestId` is an application-generated correlation
UUID because the observed Qloo bodies did not provide a request ID. Missing metadata stays missing, and malformed
entities are discarded rather than replaced with fixtures.

- **Credentials:** read from `.env.local` / `.env` via Next's env loader. Values in the process environment win.
  Needs `QLOO_MODE=live`, `QLOO_API_KEY`, `LLM_PROVIDER=gemini`, `LLM_MODEL`, `GOOGLE_API_KEY`. Optional:
  `QLOO_BASE_URL` (default `https://hackathon.api.qloo.com`), `QLOO_TIMEOUT_MS`, `LLM_TIMEOUT_MS`, `LLM_TEMPERATURE`.
  Missing variables are reported by name only. Key values are never printed; every output line is redacted.
- **Hard limits:** at most **8 Qloo** requests (6 in practice) and **2 Gemini** requests per run. No retries, no
  concurrency, no search grounding or image generation. The run stops on 401/403 (auth) and 402/429 (billing/quota).
  A run costs about $0.0005 of Gemini usage with `gemini-3.5-flash-lite`.
- **Output:** a sanitized summary on stdout and in `.probe/latest-summary.json` (git-ignored). Raw responses are never saved.
- Requires Node's TypeScript type stripping (`--experimental-strip-types`, Node ≥ 22.6) so it can reuse the
  canonical `AgentDecisionSchema` and the helpers in `scripts/lib/probe-helpers.ts`. The helpers are unit-tested offline.

If your env file keeps `QLOO_MODE=mock`, override it for a single run (PowerShell):

```powershell
$env:QLOO_MODE='live'; npm run probe:live; Remove-Item Env:QLOO_MODE
```

## Live discovery orchestration (S7)

### LLM-grounded question proposals (S8.5)

The opt-in `llm_grounded` path runs before the existing S6 decision agent. It sends a compact bundle of at most
30 normalized candidates to a separate schema-constrained Gemini call, validates every cited entity/tag and
association, rejects unsuitable metadata and unsupported answer mappings, canonicalizes wording from verified
labels/titles, and passes only valid server-constructed questions to S5. S5 still selects by H/D/I/R/U; Gemini
cannot override grounding or optimizer order. The S6 agent receives only the highest-scoring approved question.

The proposal call is cached once per replay-safe leased turn. Timeout, quota, malformed JSON, empty output, or
complete validation rejection uses the original deterministic S5 pool and records the fallback in the turn trace.
The default remains `deterministic`. The offline 20-scenario fixture comparison is a safety/proxy evaluation, not
evidence of human-quality improvement; blind rating material is emitted, but no human ratings have been collected.

Measured S8.5 evaluation (2026-10-29): the controlled 20-scenario fixtures generated 32 proposals, accepted 16,
rejected 16 (including 12 unsupported and 4 duplicates), covered tag and entity questions, and produced the same
mean top S5 score as the deterministic baseline (`0.667945`). This is no objective-score improvement. The bounded
route-level live smoke requested up to 30 Qloo candidates, generated and accepted 10/10 grounded proposals, selected
“Do you enjoy Dystopia books?” with `J=0.853076`, used 3 Qloo and 2 Gemini requests, cost an estimated `$0.0096544`,
and took 8,833 ms in the start route. Human quality evaluation remains not performed.

With `QLOO_MODE=live`, `createDiscoveryDeps` adds the S6 bounded agent, and the discovery service runs the
live loop in `src/lib/discovery/live-turn.ts`. With `QLOO_MODE=mock`, nothing changes: fixtures, the
deterministic mock agent, no network calls.

**Start:** the client-selected ID is re-verified through Qloo Search. Qloo Insights retrieves the books;
this is application-driven, and no session exists yet. Candidates are normalized; only `evidence.source = "qloo"`
books of the target type are kept. Then:
1. S5 scores the questions.
2. The S6 context gets the top 3 in deterministic mode, or only the top validated proposal in `llm_grounded` mode.
3. Gemini makes one bounded decision.
4. The session is created atomically.

Zero Qloo results returns `NO_RECOMMENDATIONS`; a Qloo failure is reported as an error. Nothing is substituted.

**Answer**, with the S4 order kept:
1. Load and check the revision.
2. Validate the active question and response.
3. Take the lease. A stale or concurrent request gets 409 here, before any Qloo or Gemini call.
4. Record the explicit preference (S5 logic; `unknown` infers nothing).
5. Ask Gemini for a decision. `request_retrieval` is granted only if this answer added a confirmed **positive**
   signal and Qloo budget remains. Negative preferences are local penalties, never hard Qloo exclusions.
6. An authorized retrieval runs through the S3 provider, using only confirmed signals. The agent then gets
   exactly **one** follow-up decision, with retrieval withdrawn: no recursive loops.
7. Commit revision+1. On failure the lease is released and the usage consumed so far stays charged.

**Actions:** `ask` uses only S5-approved IDs and wording. `retrieve` runs an authorized Qloo Insights request.
`finish` returns the grounded shortlist (≤ 5). `enrich` is never granted, because the S3 provider has no enrichment
capability; an `enrich` decision becomes a labelled fallback. When Qloo fails, the verified shortlist is kept and the
response carries `degraded: { reason }`.

**Truthful metadata** (new optional response fields; the frontend is unchanged):
- `agent.mode`: `LIVE_GEMINI`, `MOCK_AGENT` or `DETERMINISTIC_FALLBACK`, with `fallbackReason`.
- `recommendationUpdate.mechanism`: `INITIAL_RETRIEVAL`, `QLOO_RERETRIEVAL` (only if an Insights request ran),
  `LOCAL_RERANK` or `UNCHANGED`. It also carries top-5 before/after, the responsible preference IDs and the
  *internal* correlation IDs (application-generated, not Qloo IDs).
- `trace`: Qloo and Gemini requests in this HTTP request, tokens, estimated cost, latency, every decision, and the
  session-store kind.
- `usage.geminiRequestCount`: cumulative per session.

A `discovery.turn` log line records the same data, never prompts, tokens or secrets.

**Budgets** are enforced in code: ≤ 3 questions, `MAX_QLOO_CALLS_PER_SESSION` (failures are charged at the 2-attempt
cap), and `MAX_AGENT_TOOL_CALLS_PER_TURN`. The S4 lease is extended to cover a live turn's worst case.
The in-memory store used in development gives no cross-instance guarantee. Production requires Redis
(`npm run test:redis` is still a deployment gate).

## Gemini discovery agent (S6)

`src/lib/agent/` provides a bounded agent: `decide(AgentDecisionContext) → AgentResult`.
`createBoundedAgent(config)` selects the deterministic mock agent in mock mode and Gemini in live mode.
In live mode it drives the discovery routes (S7, below). Mock mode keeps the original deterministic path.

- **Context** (`context.ts`) is built only from verified data: the top 3 S5-eligible questions (IDs, approved
  wording, H/D/I/R/U scores), up to 8 sanitized and truncated candidate summaries, explicit preferences, and
  budgets. It never includes tokens, secrets or raw provider payloads. The session is referenced by a hash.
- **Real function calling** over the S2-verified REST API (`generateContent`, `x-goog-api-key`,
  `toolConfig.mode = ANY`). The four tools `ask_question`, `request_retrieval`, `request_enrichment` and
  `finish_discovery` are declared per turn only when permitted, with `enum`s of server-approved IDs.
- **Authorization** (`tools.ts`): every returned call is re-validated with strict Zod schemas. Question IDs
  must be in the S5 shortlist, entity IDs must be in the context, and retrieval signals must be confirmed
  preferences. Unknown tools or fields are rejected. Calls become a canonical `AgentDecision` plus an optional
  retrieval or enrichment *intent*. Nothing is executed: S7 runs intents through the Qloo provider and the S4 budgets.
- **Grounded wording:** the displayed question text always comes from the approved S5 candidate. The model
  cannot supply text.
- **Hard stops in code** (finished or expired session, 3 questions asked, no permitted action, tool budget
  used up) never call Gemini.
- **Bounded failure handling:** at most 2 inference requests per decision, shared by one retry for
  5xx/timeout/network errors and one schema repair. 400/401/403/429 are never retried. Every failure ends in an
  explicitly labelled `DETERMINISTIC_FALLBACK` (the top S5 question, or finish). Modes are `LIVE_GEMINI`,
  `MOCK_AGENT` and `DETERMINISTIC_FALLBACK`.
- **Prompt-injection resistance:** trusted rules sit in the system instruction. Qloo text sits in a labelled,
  untrusted `CATALOG_DATA` block. Outputs are validated independently of the prompt.
- **Tracing and cost:** each decision logs request ID, model, mode, action, question ID, candidate count,
  allowed and attempted tools, validation, fallback reason, latency, tokens (in/out/thinking) and estimated cost
  (`$0.30` / `$2.50` per 1M tokens for `gemini-3.5-flash-lite`). Prompts and secrets are never logged.

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
`INVALID_SESSION_TOKEN`/`SESSION_EXPIRED` (401), `SESSION_REVISION_CONFLICT` (409, stale or concurrent
request), `SESSION_STORE_UNAVAILABLE` (503), and sanitized `QLOO_*` upstream errors in live mode.

## Mock-mode limitations

- All entities, books, tags and scores are **synthetic fixtures** (`mock:` IDs, `evidence.source = "mock"`,
  `syntheticScore` instead of `affinity`). They are not Qloo data and make no claim about real works.
- Only *Interstellar* (and a synthetic sibling) have recommendations, and only for books.
- The S5 question optimizer is a deterministic engineering heuristic, not calibrated information gain or a
  measured model of user satisfaction. It scores weighted partition entropy (H), executable counterfactual top-K
  separation (D), interpretability (I), redundancy (R), and ambiguity (U) as
  `J = 0.40H + 0.25D + 0.25I - 0.05R - 0.05U` with rank-weight temperature `tau = 3`.
- Content-tag questions use a conservative verified type/label filter. When no useful tag splits the shortlist,
  the optimizer asks about pairs of returned entities without inventing semantic contrasts. Counterfactuals use
  the same bounded additive reranker as the application; its weights remain initial engineering choices.
- The agent is a **deterministic mock**; no Gemini calls are made.
- Only tag like/dislike/skip questions are generated; the contracts already allow pair (`prefer_a`/`prefer_b`/
  `both`/`neither`) and entity questions.

## Sessions (S4: server-authoritative, replay-safe)

- **The store is the source of truth.** The full session state lives in a `SessionStore`
  (`src/lib/session/`), keyed `tasteprobe:session:<uuid>` with a TTL equal to the session expiry. The
  HMAC-SHA256 token (`SESSION_SIGNING_SECRET`, timing-safe compare) now only authenticates
  `{sid, rev, exp}`. Tampering with any field gives `INVALID_SESSION_TOKEN`.
- **Every transition is checked against the store revision.** A token whose `rev` is not the stored
  revision is rejected with `409 SESSION_REVISION_CONFLICT` before any work, so replayed tokens cannot apply
  answers, finish or reopen sessions, reset usage counters, or trigger Qloo calls.
- **Atomic compare-and-swap.** Redis runs one Lua `EVAL` per write that checks `rev` (and the lease owner)
  and writes in the same step; there is never a separate GET and SET. The memory store does the same within
  one Node.js process.
- **Answer = lease, then commit.** An answer first takes a short lease (60 s, via CAS) on the current
  revision, so a concurrent request for that revision gets 409 before it reaches the agent or Qloo. The
  answer then commits as revision+1. If the turn fails, the lease is released with the revision unchanged,
  but Qloo usage consumed so far is kept. A failed upstream call is charged at its attempt cap, so retries
  cannot create untracked budget. Finish is a single lock-free CAS. Repeating finish with the current
  token is read-only.
- **Lost responses.** If the client retries after a successful answer whose response was lost, the retry
  gets 409, never a double-applied answer. The client must start a new discovery: there is no
  idempotency-key replay of the original response.
- **Stores.** Memory is the default outside production (dev, mock, tests) and is not shared across instances.
  Production (`NODE_ENV=production`) requires Upstash Redis and fails closed: missing credentials →
  `CONFIG_ERROR`, store errors → `503 SESSION_STORE_UNAVAILABLE`. It never falls back to memory.
- **Verification.** The Redis adapter's Lua scripts are executed offline in a Lua VM (`fengari`,
  `tests/support/lua-redis.ts`). That verifies script logic, not Upstash network behaviour. `npm run test:redis`
  runs the same contract against a real database when `UPSTASH_*` is set.
- The token is signed, not encrypted (it holds no personal data). With no `SESSION_SIGNING_SECRET` in mock
  dev, the ephemeral secret is per process.

## Future integration boundaries

| Replace | Where | Contract to keep |
| --- | --- | --- |
| Live Qloo | Implemented in `src/lib/qloo/live-provider.ts` | `QlooProvider` + raw types → `normalize.ts` yields `QlooRecommendationCandidate` (`evidence.source = "qloo"`) |
| Gemini agent → orchestrator (S7) | `createBoundedAgent` in `src/lib/agent/factory.ts`, wired into `src/lib/discovery/service.ts` | `BoundedAgent.decide(AgentDecisionContext)` → `AgentResult` (decision + intent + mode + usage) |
| Question optimizer (S5) | Implemented in `src/lib/discovery/question-optimizer.ts` | ordered grounded `Question[]` plus structured H/D/I/R/U traces |
| Scoring | `rankCandidates` in `src/lib/discovery/ranking.ts` | `RankedRecommendation[]` |
| Session store | `getSessionStore` in `src/lib/session/index.ts` | `SessionStore` (create / read / compareAndSwap / expire), canonical `TasteSession` fields |
| UI | `src/components/*` | HTTP API above |
