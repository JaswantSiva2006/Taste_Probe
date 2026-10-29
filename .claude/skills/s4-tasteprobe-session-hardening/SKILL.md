---
name: s4-tasteprobe-session-hardening
description: Secure TasteProbe discovery sessions against replay, concurrent updates, tampering, expiry violations, and API budget bypasses using atomic session state transitions.
---

# S4 — Session Security and State Hardening

## Product context

TasteProbe is a Next.js 16 application using Qloo
for recommendations and Gemini for bounded agent decisions.

S1 established signed anonymous discovery sessions.

S3 implemented live Qloo Search and Insights.

Current session state includes:
- Session ID.
- Revision.
- Expiration.
- Verified preference signals.
- Question history.
- Question count.
- Qloo call count.
- Current question ID.

The existing implementation signs session state,
but an old valid token can potentially be replayed.

This segment must close that vulnerability.

## Objective

Provide replay-safe, atomic, server-authoritative
discovery sessions.

Keep existing HTTP contracts and the frontend working.

Support local development without external storage.

Require a shared atomic session store for production.

## Files to inspect

Start with:

src/lib/session/
src/lib/discovery/service.ts
src/lib/contracts/
src/lib/config/env.ts
src/app/api/discovery/
tests/unit/session-config.test.ts
tests/integration/discovery-routes.test.ts

Also inspect relevant Qloo request-budget handling.

Do not read unrelated frontend or provider modules.

## Required architecture

Use a SessionStore interface.

Required conceptual operations:

create(session)
read(sessionId)
compareAndSwap(sessionId, expectedRevision, nextState)
expire(sessionId)

Adapt exact signatures to the existing codebase.

The store must be authoritative.

Do not trust mutable session fields solely because
they arrived inside a correctly signed token.

The token should identify the session and authenticate
the expected revision/expiry.

The server must validate that revision against
the current authoritative store state.

Preserve existing API response shapes where practical.

## Storage implementations

### Local

Provide an in-memory SessionStore for:
- Local development.
- Mock mode.
- Unit tests.

It must implement atomic transitions within one
Node.js process.

Do not claim this gives cross-instance guarantees.

### Production

Use Upstash Redis with @upstash/redis.

Environment variables:

UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN

Read them through central configuration.

Require both in production.

Never silently fall back to local memory in production.

Do not create a database account on the user's behalf.

Do not print credentials.

## Redis atomicity

Use an atomic Redis operation for state transitions.

Recommended approach:

- Store a versioned session record under a namespaced key.
- Give the record a TTL consistent with session expiry.
- Use a Lua EVAL script for atomic compare-and-set.
- Compare the expected revision with the stored revision.
- Reject mismatch.
- Replace state and increment revision atomically.
- Preserve session expiry limits.

Never implement CAS as separate GET and SET operations.

Do not assume an ordinary pipelined GET/SET is atomic.

Use the SDK's verified EVAL API.

No stale session token may overwrite newer state.

## Session invariants

The following conditions must always hold:

1. Session IDs are cryptographically unpredictable.
2. Tokens cannot be forged or modified.
3. Expired tokens are rejected.
4. Expired store records are rejected.
5. Revision strictly increases after successful mutations.
6. Old revisions cannot mutate current state.
7. Finished sessions cannot be reopened.
8. Answers must target the active question.
9. An answer cannot be applied twice.
10. Question count never exceeds MAX_QUESTIONS.
11. Usage budgets cannot be reset by replay.
12. Unknown/skip cannot create inferred preferences.
13. Invalid state transitions have no side effects.
14. Session storage failure must fail closed.
15. Sessions cannot access one another's state.

Treat these as hard requirements.

## Concurrency

Two requests using the same revision must not
both succeed.

Expected:

Request A: valid transition.
Request B: stale revision, HTTP 409.

Test concurrent submissions using Promise.all.

A stale request must not:
- Apply preference changes.
- Increment counters.
- Finish a session.
- Resurrect an old shortlist.

Where possible, reject stale actions before
performing expensive external calls.

Inspect the existing Qloo call path.

If budget reservation is required before external
requests, implement the smallest atomic mechanism.

Retries must not create additional untracked budget.

Do not weaken existing budget enforcement.

## Idempotency

At minimum, replayed operations must be safely rejected.

If existing API contracts support an idempotency key,
preserve successful idempotent retries.

Do not silently double-apply a repeated answer.

Document what happens when the client retries after
a lost network response.

Do not introduce a large general-purpose workflow engine.

## Signing

Use the existing SESSION_SIGNING_SECRET.

Use a cryptographically secure HMAC or the existing
verified signing method.

Reject altered tokens.

Use timing-safe signature comparison where applicable.

Preserve strict expiry handling.

Never introduce hardcoded signing secrets.

Non-production mock mode may retain the existing
ephemeral-secret behaviour.

Production must require explicit secure configuration.

## Error handling

Use stable error codes.

Expected categories include:

INVALID_SESSION
SESSION_EXPIRED
SESSION_REVISION_CONFLICT
SESSION_FINISHED
INVALID_QUESTION
QUESTION_LIMIT_EXCEEDED
SESSION_STORE_UNAVAILABLE

Preserve existing error codes where already established.

Use appropriate HTTP statuses.

Return 409 for conflicting state transitions.

Do not leak signing material, raw Redis errors,
session internals, or stack traces to users.

## API integration

Preserve:

POST /api/discovery/start
POST /api/discovery/answer
POST /api/discovery/finish

Also preserve existing search and health endpoints.

The existing browser should work without frontend changes.

If a small API response adjustment is unavoidable,
make the corresponding minimal frontend change
and document it.

Do not change Qloo response normalization.

Do not implement the Gemini agent.

Do not implement the question optimizer.

## Configuration

Use central configuration for:

SESSION_SIGNING_SECRET
SESSION_TTL_SECONDS
MAX_QUESTIONS
MAX_QLOO_CALLS_PER_SESSION
MAX_AGENT_TOOL_CALLS_PER_TURN
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN

Update .env.example with placeholders only.

Do not modify .env or .env.local.

Never print actual secrets.

Do not require Redis credentials for local mock tests.

## Unit tests

Add tests for:

- Session creation.
- Token verification.
- Tampered signature.
- Expired token.
- Expired store record.
- Monotonic revision.
- Stale revision rejection.
- Concurrent answer race.
- Concurrent finish/answer race.
- Finish replay rejection.
- Duplicate answer rejection.
- Question-budget preservation.
- Qloo-budget preservation.
- Unknown response handling.
- Independent session isolation.
- Store failure.
- Missing production Redis configuration.

Use deterministic clocks where appropriate.

## Atomic store tests

Test the SessionStore contract independently.

Test both successful and rejected CAS transitions.

Verify that stale requests cannot modify state.

For Redis-specific tests, use an appropriate isolated
test double or optional live test.

Do not claim actual distributed Redis atomicity
was network-tested unless it was.

Provide an optional Redis integration test command
when credentials are available.

Keep ordinary tests offline.

## Regression tests

Preserve S3's existing tests.

Ensure:

npm run smoke:mock

still works.

Ensure:

npm run smoke:qloo

still works when configured for live API verification.

Do not run repeated live Qloo tests unnecessarily.

## Security boundaries

Client input is untrusted.

Signed tokens authenticate claims but are not
independently authoritative session state.

Redis records are authoritative for session revision.

Qloo responses are third-party data.

LLM responses remain untrusted.

Do not expose Redis credentials to the client.

## Performance

Avoid unnecessary database round trips.

Keep session records small.

Use TTL-based cleanup.

Avoid storing large recommendation payloads if
stable references are sufficient.

Do not prematurely optimize.

Prioritize correctness.

## File ownership

Primary:

src/lib/session/
src/lib/config/
tests/unit/session-*.test.ts
tests/integration/discovery-routes.test.ts

Narrowly permitted:

src/lib/discovery/service.ts
src/lib/contracts/
src/app/api/discovery/
package.json
package-lock.json
.env.example
README.md

Do not modify unrelated Qloo integration modules.

Do not modify UI styling.

Do not implement S5/S6 functionality.

## Working rules

- Inspect actual interfaces before changing them.
- Preserve existing successful behaviour.
- Keep changes focused.
- Avoid speculative abstractions.
- Do not modify private environment files.
- Do not expose credentials.
- Do not weaken tests.
- Run narrow tests while iterating.
- Run full verification before committing.
- Document limitations honestly.

## Verification

Run:

npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:mock

Run the existing Qloo smoke only if necessary.

Add and execute a dedicated replay/concurrency
verification command or integration test.

Production configuration without Redis credentials
must fail closed.

## Completion criteria

S4 passes when:

- Sessions are server-authoritative.
- Replay attacks fail.
- Concurrent mutations are atomic.
- Revision checks are enforced.
- Question budgets cannot be bypassed by replay.
- Finished sessions remain finished.
- Production storage configuration is enforced.
- Mock mode works without Redis.
- Existing API contracts remain functional.
- Existing tests pass.
- New security tests pass.
- No secrets are exposed.
- Changes are committed.

If actual Upstash network verification was not
performed, report that limitation explicitly.

## Completion report

### COMPLETION REPORT
Status: DONE | PARTIAL | BLOCKED
Summary: <3 lines>
Files changed: <list>
Commands run and results: <commands>
Session replay protection: PASS | FAIL
Concurrent mutation test: PASS | FAIL
Production fail-closed configuration: PASS | FAIL
Redis integration: VERIFIED | IMPLEMENTED_UNTESTED | BLOCKED
Question-budget protection: PASS | FAIL
Mock regression: PASS | FAIL
Total tests passing: <number>
Deviations: <or none>
Open questions / risks: <or none>
Suggested next step: <one line>