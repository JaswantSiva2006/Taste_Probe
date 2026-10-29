---
name: s1-tasteprobe-walking-skeleton
description: Use when creating the initial TasteProbe Next.js repository and implementing a runnable, mocked end-to-end discovery pipeline with stable contracts, verified mock provenance, API routes, and automated smoke tests.
---

# S1 — TasteProbe Walking Skeleton

## 1. Product context

TasteProbe is an AI-powered cultural discovery application for the Qloo Agentic Hackathon.

The user provides a favourite cultural entity and a discovery objective.

The application retrieves Qloo-grounded recommendations, generates adaptive preference questions, updates preferences from user answers, and returns evidence-backed recommendations.

Primary demonstration:
- Source: movie.
- Target: books.
- Example seed: Interstellar.
- Maximum questions: 3.
- Final recommendations: at most 5.

The full product uses:
- Next.js + TypeScript.
- Qloo Search and Insights APIs.
- Google Gemini as a bounded AI agent.
- A deterministic question optimizer.
- Signed anonymous sessions.
- Vercel deployment.

This segment establishes a minimal runnable path through the entire architecture.

It does NOT implement live Qloo or Gemini calls.

All external data and decisions in S1 must be explicitly identified as MOCK.

Future segments will replace individual mock implementations without breaking the application.

## 2. S1 objective

Produce a complete walking skeleton:

User enters entity query
    ↓
Mock entity search
    ↓
User selects an entity
    ↓
Create discovery session
    ↓
Mock Qloo Insights response
    ↓
Normalize recommendation candidates
    ↓
Build question candidates
    ↓
Select a question deterministically
    ↓
Mock agent decision
    ↓
Display question
    ↓
Receive explicit user response
    ↓
Update preference state
    ↓
Rerank verified mock candidates
    ↓
Stop or ask another question
    ↓
Show final recommendations

Every arrow must represent working application code.

Do not replace the workflow with a hardcoded static webpage.

The frontend must call the application's API routes.

## 3. Technology and repository conventions

Use:
- Node.js 22 LTS.
- Next.js App Router.
- TypeScript with strict mode.
- React.
- Tailwind CSS.
- Zod for runtime schema validation.
- Vitest for unit/integration tests.
- npm.

Use supported, mutually compatible stable package versions.

Verify installed library APIs rather than assuming older examples remain valid.

Initialize a standard Next.js project in the current repository.

Use the src/ directory convention.

Prefer:
- Named TypeScript exports.
- Explicit return types for public interfaces.
- Small focused modules.
- Server-only service modules.
- Centralized configuration.
- Explicit typed errors.
- Structured request identifiers.

Avoid:
- Unnecessary dependencies.
- Database setup.
- Microservices.
- Authentication systems.
- Large abstraction frameworks.
- Complex agent frameworks.
- Premature performance optimization.

Keep business logic separate from Next.js route handlers.

## 4. Canonical architecture

The eventual application contains:

C1/C2/C3 — User interface and decisions.
G1/G2 — API gateway and session controller.
A1 — Bounded Gemini agent.
T1 — Qloo entity search.
T2 — Qloo recommendation insights.
T3 — Optional Qloo tag enrichment.
K1 — Recommendation normalizer.
K2 — Question candidate builder.
D1 — Deterministic question optimizer.
D2 — Preference state updater.
V1 — Output and grounding validator.
V2 — Stop controller.
F1 — Failure handling.
DB1 — Optional cache.
O1/O2 — Offline evaluation.
L1 — Structured telemetry.

S1 must provide a thin implementation boundary for the main runtime components.

The offline evaluation component only needs a basic smoke-test foundation.

Optional cache and enrichment need interfaces/placeholders only if they are necessary for the skeleton.

Do not introduce unused abstractions merely to represent every architecture diagram box.

## 5. Shared contracts

Place canonical public types and Zod schemas under:

src/lib/contracts/

Use these contracts consistently across API routes, frontend, and application services.

### DiscoveryInput

type DiscoveryInput = {
  entityQuery: string;
  sourceType: 'movie' | 'book';
  targetType: 'movie' | 'book';
  maxQuestions: 3;
};

The UI must resolve an entity via search before starting discovery.

A start request may additionally contain the selected entity ID.

The server must validate the selected ID against the mock provider's known entities.

### RecommendationCandidate

type RecommendationCandidate = {
  entityId: string;
  name: string;
  entityType: string;
  rank: number;
  affinity?: number;
  description?: string;
  imageUrl?: string;
  tags: {
    id: string;
    name: string;
    type: string;
  }[];
  evidence: {
    source: 'qloo';
    requestId: string;
    seedEntityIds: string[];
    explainability?: unknown;
  };
};

IMPORTANT MOCK RULE:

The above is the future real-Qloo contract.

Do not fabricate real Qloo provenance for fixture responses.

Represent mock provenance explicitly, for example through a separate MockRecommendationCandidate variant with evidence.source = 'mock'.

The shared runtime representation may use a discriminated union.

A mock response must never claim to be a live Qloo response.

Every UI screen showing mocked recommendations must clearly display that status.

### PreferenceAnswer

type PreferenceAnswer = {
  questionId: string;
  targetType: 'tag' | 'entity';
  targetIds: string[];
  response:
    | 'like'
    | 'dislike'
    | 'prefer_a'
    | 'prefer_b'
    | 'both'
    | 'neither'
    | 'unknown';
  timestamp: number;
};

Responses must be validated against the active question and its allowed answers.

Unknown/skip must not generate an inferred positive or negative preference.

### TasteSession

type TasteSession = {
  version: 1;
  sessionId: string;
  revision: number;
  anchorIds: string[];
  sourceType: 'movie' | 'book';
  targetType: 'movie' | 'book';
  positiveTagIds: string[];
  rejectedTagIds: string[];
  positiveEntityIds: string[];
  rejectedEntityIds: string[];
  answers: PreferenceAnswer[];
  askedQuestionIds: string[];
  currentQuestionId?: string;
  questionCount: number;
  maxQuestions: number;
  qlooCallCount: number;
  createdAt: number;
  expiresAt: number;
};

Additional internal fields may be introduced if needed.

Preserve the canonical field names.

The eventual production system requires signed, expiring session state and replay-safe updates.

S1 must establish this boundary and prevent obvious invalid transitions.

S4 will harden cross-request concurrency, idempotency, and replay protection.

Do not claim S1 provides cross-instance replay safety unless it actually does.

### AgentDecision

type AgentDecision = {
  action: 'retrieve' | 'enrich' | 'ask' | 'finish';
  selectedQuestionId?: string;
  questionText?: string;
  reasonCode:
    | 'insufficient_candidates'
    | 'insufficient_metadata'
    | 'informative_question'
    | 'stable_recommendations'
    | 'question_budget_exhausted';
  done: boolean;
};

The real Gemini implementation will arrive later.

S1 must use an explicitly named deterministic mock agent.

Its decisions must still conform to AgentDecision validation.

The mock agent may select only known question IDs.

## 6. API contracts

Create these Next.js Route Handlers:

GET /api/health

GET /api/entities/search

POST /api/discovery/start

POST /api/discovery/answer

POST /api/discovery/finish

All request bodies and query parameters must be validated with Zod.

All responses must use a consistent JSON envelope.

Recommended response shape:

{
  "ok": true,
  "data": {},
  "meta": {
    "requestId": "...",
    "mode": "mock"
  }
}

For errors:

{
  "ok": false,
  "error": {
    "code": "...",
    "message": "..."
  },
  "meta": {
    "requestId": "...",
    "mode": "mock"
  }
}

Use suitable HTTP status codes.

The frontend must not bypass these routes.

Do not return sensitive environment variables.

Design session token transport consistently across start, answer, and finish.

Keep the wire format documented and schema-validated.

## 7. Mock provider architecture

Create a narrow provider interface supporting:

- Entity search.
- Recommendation retrieval.

Implement one fixture-backed provider for S1.

The fixture provider should return deterministic results for:

Interstellar → books.

Provide several recommendations with deliberately different verified fixture tags.

Fixture IDs must be clearly distinguishable from actual Qloo IDs.

Example namespace:

mock:movie:interstellar
mock:book:alpha
mock:book:beta

Fixture scores and associations are synthetic.

Do not represent them as measured Qloo affinities.

The data must support at least one question whose positive and negative answers generate different candidate rankings.

The implementation should not depend on specific fixture titles outside the fixtures and tests.

### Live integration boundary

QLOO_MODE determines the provider mode.

When QLOO_MODE=mock:
- Use the fixture provider.
- Never call Qloo.
- Never call Gemini.
- Do not require paid API keys.

When QLOO_MODE=live:
- Do not silently use fixture data.
- Until real integration exists, return an explicit unsupported/not-implemented error.
- Do not produce a successful fake live response.

Later segments will implement the live provider behind the same boundary.

## 8. Minimal question engine

S1 only needs enough deterministic logic to prove the loop.

Build question candidates from fixture-backed tags or entity contrasts.

Select an unasked valid question.

Ensure:
- Known question IDs.
- Known target IDs.
- No repeated questions.
- At most 3 questions.
- Explicit answer updates.
- Different rankings when meaningful preferences change.
- Unknown answers do not change confirmed preferences.
- Early finish is supported.

The later optimizer will implement the full objective:

J(q) =
  0.40 * H(q)
+ 0.25 * D(q)
+ 0.25 * I(q)
- 0.05 * R(q)
- 0.05 * U(q)

where:
H = candidate partition entropy.
D = expected rank separation.
I = interpretability.
R = redundancy.
U = ambiguity risk.

Do NOT implement the complete optimizer in S1.

Expose a clean selection boundary so S5 can replace the initial heuristic.

Never present the placeholder heuristic as a validated information-gain model.

## 9. Session and security basics

Use a central session service.

S1 should support:
- Session creation.
- Session restoration.
- Session expiration.
- Signed-state integrity validation.
- Revision fields.
- Valid question-answer transitions.
- Maximum question count.
- Maximum Qloo call count.
- Maximum agent tool calls per turn, where applicable.

Do not hardcode a signing secret.

Read SESSION_SIGNING_SECRET through the central configuration module.

Use cryptographically secure randomness.

In automated tests, inject an isolated test secret or generate one at runtime.

Never commit real credentials.

Do not assume stateless token signing alone prevents replay.

Report any remaining replay/concurrency limitations explicitly for S4.

## 10. Environment configuration

Support the existing environment contract.

Core variables:

QLOO_API_KEY
QLOO_BASE_URL
QLOO_TIMEOUT_MS

LLM_PROVIDER
LLM_MODEL
GOOGLE_API_KEY
LLM_TEMPERATURE
LLM_TIMEOUT_MS

SESSION_SIGNING_SECRET
SESSION_TTL_SECONDS

MAX_QUESTIONS
MAX_QLOO_CALLS_PER_SESSION
MAX_AGENT_TOOL_CALLS_PER_TURN
MAX_RECOMMENDATION_CANDIDATES
FINAL_RECOMMENDATION_COUNT

ENABLE_ADAPTIVE_QUESTIONING
ENABLE_EARLY_STOPPING

ENABLE_QLOO_CACHE
CACHE_TTL_SECONDS

ENABLE_EVALUATION_LOGGING
ENABLE_AGENT_TRACING

QLOO_MODE
SENTRY_DSN

Use one centralized configuration module.

S1 only needs to validate variables required by active code paths.

Do not require QLOO_API_KEY or GOOGLE_API_KEY in mock mode.

Keep production/live validation strict when the actual integrations are implemented.

Never scatter process.env reads throughout application services.

Create .env.example containing placeholder values.

Preserve an existing .env.local without modification.

Ensure .env, .env.local, and .env.*.local are gitignored.

Never commit credentials.

## 11. Frontend requirements

Build a clean, responsive MVP interface.

Required states:

1. Search screen.
2. Entity selection.
3. Initial recommendations.
4. Current question.
5. Answer submission.
6. Updated recommendations.
7. Finished results.
8. Visible error state.

Include:
- Loading indicators corresponding to actual operations.
- Disabled controls while requests are pending.
- Clear mocked-data indicator.
- Question progress.
- Explicit finish button.
- Short explanations of preference-based ranking changes.

A basic design is sufficient.

Do not spend time on decorative animation.

Avoid third-party images or unverified recommendation metadata.

## 12. Reliability requirements

Use:
- Strict input validation.
- Explicit error responses.
- Server-side request IDs.
- Safe exception handling.
- Deterministic mock fixtures.
- Clear boundaries for external services.

Use in-memory state only where safe for this mock skeleton.

Do not rely on module-global state for a production session guarantee.

Do not swallow errors or fabricate successful results.

## 13. Testing strategy

Use Vitest.

Create unit tests for:
- Core schema validation.
- Mock entity resolution.
- Mock recommendation normalization.
- Question selection.
- Explicit preference updates.
- Ranking changes.
- Stop conditions.
- Session signature validation.
- Session expiration.

Create integration tests for:
- Start discovery.
- Answer current question.
- Finish discovery.
- Invalid entity selection.
- Invalid question ID.
- Invalid or tampered token.
- Attempts to exceed question limits.

Create one executable HTTP smoke test covering:

Search
  → select
  → start
  → answer
  → verify ranking change
  → finish
  → verify final recommendations.

The smoke must invoke actual Next.js HTTP routes.

It must launch or connect to a local mock-mode server in a documented, reproducible way.

Avoid depending on third-party services or real credentials.

Use a dedicated test port or automatically allocated free port.

Ensure any test-launched server is cleaned up after execution.

## 14. Required npm scripts

Provide functional scripts named:

npm run dev
npm run dev:mock
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:mock

dev:mock must work on Windows.

Use a cross-platform environment-setting method.

smoke:mock must test the HTTP application, not merely invoke internal functions.

It must run without paid credentials.

Document any required local signing-secret setup.

The smoke command may generate an ephemeral test-only secret in memory.

## 15. File ownership

This segment owns initial scaffolding and may create:

src/app/
src/components/
src/lib/contracts/
src/lib/config/
src/lib/qloo/
src/lib/agent/
src/lib/discovery/
src/lib/session/
src/lib/validation/
src/lib/telemetry/

tests/
scripts/

README.md
package.json
.env.example
.gitignore

Do not add:
- Databases.
- Authentication providers.
- Payment services.
- Python microservices.
- Production Qloo SDK integration.
- Production Gemini SDK integration.
- Deployment infrastructure beyond basic readiness.

## 16. Common pitfalls

### Pitfall 1 — Static demo instead of pipeline

Avoid hardcoding all recommendations directly into the page.

The frontend must use backend routes and actual state transitions.

### Pitfall 2 — Fake Qloo provenance

Mock data must use explicit mock labels and mock IDs.

Never claim fixture output was returned by Qloo.

### Pitfall 3 — Contracts designed only for fixtures

Do not create interfaces that assume one specific movie or book list.

The future live adapter must fit the same public contracts.

### Pitfall 4 — Question answers not affecting results

At least one positive/negative answer must visibly change ranking.

### Pitfall 5 — Client-side trust

Validate selected IDs, question IDs, session state, and answer values on the server.

### Pitfall 6 — Hidden live-mode fallback

Live mode must fail explicitly until implemented.

It cannot silently return mock recommendations.

### Pitfall 7 — Excessive first-segment scope

Keep the optimizer and agent deliberately minimal.

Their real implementations belong to later segments.

### Pitfall 8 — Next.js configuration mismatch

Ensure npm scripts actually work under the installed Next.js version.

Do not assume outdated configuration or lint commands still work.

## 17. Working rules

- Inspect existing files before modifying anything.
- Do not read unrelated directories.
- Prefer targeted search over dumping the whole repository.
- Make the smallest coherent implementation.
- Keep business logic out of route handlers.
- Do not modify .env.local.
- Do not expose or print secrets.
- Do not introduce unnecessary dependencies.
- Use local fixtures for all S1 testing.
- Add tests while implementing.
- Never remove or weaken tests to achieve passing status.
- Never silently replace failed integrations with fake success.
- Run focused tests during development.
- Run the complete verification suite at the end.
- Keep terminal output concise.
- Report all unresolved security or architecture limitations.

If blocked by a genuine contradiction or missing credential, complete unblocked work and report the issue.

## 18. Verification

The following must pass:

npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:mock

Additionally verify:

- A browser can complete the flow.
- The final recommendations remain mock-labelled.
- The API rejects invalid identifiers.
- The ranking can change after an answer.
- No more than 3 questions can be asked.
- Early finish works.
- Mock mode makes zero external API calls.
- No credential is committed.
- Live mode cannot silently return fixtures.

## 19. Definition of done

S1 is complete only when:

1. A functioning Next.js application exists.
2. The application implements the complete mock discovery loop.
3. API and domain contracts are centralized.
4. Mock providers are cleanly replaceable.
5. The app supports question/answer/rerank/finish.
6. Mock provenance is unmistakable.
7. Environment configuration is centralized.
8. Automated tests pass.
9. HTTP smoke passes.
10. Production build passes.
11. README documents setup and execution.
12. Changes are committed on seg/S1-walking-skeleton.

## 20. Completion report

End the implementation response with exactly:

### COMPLETION REPORT
Status: DONE | PARTIAL | BLOCKED
Summary: <3 lines max>
Files changed: <list>
Commands run and results: <command -> pass/fail, key lines only>
Deviations from the task (and why): <or "none">
Open questions / risks: <or "none">
Suggested next step: <one line>