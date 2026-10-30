# Multi-round discovery (S9.6)

Baseline `5a3ec11`, on the branch `seg/S9-6-multi-round-discovery`. This document is the state model and API contract that the S9.7 UI builds on. All S9.6 testing ran offline: **0 Qloo calls and 0 Gemini calls**.

## 1. Design choice: one session record is one exploration

The S4 store already gives each session one Redis record, transitions by compare-and-swap (CAS) on the revision, leases for paid work, a signed `{sid, rev, exp}` token, replay rejection and expiry. S9.6 **extends that record additively** instead of adding a parent exploration record with linked round sessions. A parent record would need atomic updates across two records, which the store does not provide.

As a result, every multi-round transition is still a single CAS on a single key, and all existing guarantees apply unchanged. `explorationId` equals `sessionId`. There is no second session or token system, and no format change: token claims stay v2 and `TasteSession` stays v1. The new fields are optional, so sessions stored before S9.6 read as round 1.

New optional `TasteSession` fields:

| Field | Meaning |
|---|---|
| `round` | Current round (absent means 1). `questionCount`/`maxQuestions` are now **per round**; everything else is cumulative. |
| `askedDimensions` | The semantic dimension of every question asked, in any round (see §5). |
| `presentedEntityIds` | Final recommendations presented in **earlier** rounds. |
| `recommendationFeedback` | An append-only log of `{action: reject\|accept\|continue, entityId?, round, revision, at, correction?}`. |
| `acceptedEntityId` | The chosen recommendation (terminal). |
| `status` | Now `active` (asking), `finished` (presenting this round's results, continuable) or `accepted` (terminal). |

Already stored and simply carried forward:
- the verified seed and the source and target domains;
- every answer, now tagged `round` from round 2 on;
- `askedQuestionIds`;
- confirmed positive and negative tag and entity preferences;
- candidates with their Qloo provenance;
- Qloo, agent-tool and Gemini usage counters;
- `createdAt` and `expiresAt`.

## 2. Lifecycle

```
start ──► ASKING (round n) ──answer──► ASKING … ──finish / no useful question──► PRESENTING (round n)
                                                                                  │  reject ─► PRESENTING (same round, item withdrawn)
                                                                                  │  continue ─► ASKING (round n+1)   [new questions, same context]
                                                                                  └─ accept ─► ACCEPTED (terminal)
```

Exploration status (`view.exploration.status`) is `asking`, `presenting` or `accepted`. The legacy `view.status` stays `asking` or `finished`; `accepted` explorations report `finished`, so old clients keep working.

**Status rules:**
- Answering a non-asking round still returns 409 (`SESSION_FINISHED` or `QUESTION_BUDGET_EXHAUSTED`), exactly as in S4.
- `finish` on a presenting or accepted exploration is idempotent and makes no write.
- Feedback or `continue` while asking returns `409 ROUND_IN_PROGRESS`.
- Anything after an accept returns `409 EXPLORATION_CLOSED`.

## 3. API

All endpoints are `POST`, use JSON bodies and return the usual `{ ok, data: DiscoveryView, meta }` envelope. Requests are `.strict()`, so extra fields are rejected with `VALIDATION_ERROR`. **No client-supplied history is ever accepted.**

| Route | Body | Effect | Paid work | Rate-limit bucket |
|---|---|---|---|---|
| `/api/discovery/start` | unchanged | Round 1 | Qloo, Gemini | `start` |
| `/api/discovery/answer` | unchanged | Next question or result | Gemini (+ optional justified Qloo) | `answer` |
| `/api/discovery/finish` | unchanged | Round → presenting | none | — |
| **`/api/discovery/reject`** | `{ sessionToken, entityId }` | Withdraws one shown recommendation | none | `answer` |
| **`/api/discovery/accept`** | `{ sessionToken, entityId }` | Records the intention to try it; terminal | none | `answer` |
| **`/api/discovery/continue`** | `{ sessionToken }` | Opens round n+1 from stored context | Gemini (one decision); **never Qloo** | `continue` (own bucket, `RATE_LIMIT_START_MAX`) |

- **`entityId` validation.** It must be one of the current round's **shown** final recommendations, computed server-side. Invented IDs, real candidates that aren't shown, and unshown IDs all return `400 INVALID_RECOMMENDATION`.
- **Tokens.** Every successful transition returns a new `sessionToken` at `revision + 1`. The previous token immediately returns `409 SESSION_REVISION_CONFLICT`, so a continue, reject or accept cannot be replayed.
- **Concurrency.** `continue` takes the S4 lease before any paid call, so two simultaneous continues produce exactly one round; the other gets 409. `reject` and `accept` are lock-free CAS commits, so concurrent feedback lets exactly one win.

### `view.exploration` (additive)

```ts
exploration: {
  explorationId: string;          // = sessionId
  round: number;                  // 1, 2, 3 … monotonic
  status: "asking" | "presenting" | "accepted";
  acceptedEntityId: string | null;
  rejectedRecommendationIds: string[];
  totalQuestionsAsked: number;    // across rounds
  previouslyPresentedIds: string[];
  unseenCandidateCount: number;   // eligible verified candidates never presented
  canContinue: boolean;
  continueBlockedReason: null | "round_in_progress" | "accepted" | "candidates_exhausted" | "budget_exhausted";
  budget: { qlooUsed, qlooMax, geminiUsed, geminiMax };
  expiresAt: number;              // epoch ms; the exploration expires as a whole
}
```

New error codes: `ROUND_IN_PROGRESS` (409), `EXPLORATION_CLOSED` (409), `EXPLORATION_EXHAUSTED` (409), `EXPLORATION_BUDGET_EXHAUSTED` (429), `INVALID_RECOMMENDATION` (400).

## 4. Preferences and rejections

- Answers from every round accumulate in the same authoritative sets.
  - `like`, `both` and `prefer_*` produce positive preferences; `dislike` and `neither` produce negative ones.
  - `unknown` adds nothing, in any round (tested).
- **Reject is entity-level only.**
  - The candidate goes into `rejectedEntityIds` and the feedback log, and is **withdrawn from all later result lists and featured slots**.
  - **Its tags are never touched.** Rejecting one science-fiction book does not dislike science fiction (tested).
  - It is never sent to Qloo as an exclusion; S7's local-only negative rule is unchanged.
- **Explicit correction.** If the user earlier preferred that title (`prefer_a`), the reject removes the positive entity preference and records `correction: "reversed_positive"` (tested). Accepting a shown item never infers anything beyond the accept.
- `continue` without a reject marks nothing as disliked (tested).

## 5. Question deduplication across rounds

- `askedQuestionIds` blocks the same ID.
- `askedDimensions` blocks the same **semantic dimension** under another ID or wording:
  - a tag question's dimension is its **verified tag label**, normalized, so "Fantasy" as a genre tag and as a subgenre tag is one dimension;
  - an entity comparison's dimension is its **unordered pair**, so `A|B` equals `B|A`.
- The filter sits in the existing `availableQuestions` gate. That gate feeds the S5 optimizer, the S6 agent's approved list and the S8.5 LLM proposer path alike, so no route around it exists.
- Targets with a confirmed preference stay excluded, as before.
- A round asks **up to three** questions and may ask fewer. If no grounded question is left, the round finishes immediately with `finishReason: "insufficient_question_evidence"`. Questions are never invented.

## 6. Recommendation refresh

- **Round 1 is unchanged:** the top N in rank order.
- **Later rounds** present verified candidates not yet presented first (in unchanged rank order), then fill with earlier ones. Positions stay the real rank.
- **The Discovery Path** puts unseen candidates in featured slots first. When START HERE is an item shown before, its text says so: "You were shown it in an earlier round; it now ranks highest among the picks you haven't turned down." It never presents an old pick as new. The grounding validator was updated and still passes for every round.
- **`continue` never calls Qloo**, because there is no new signal to justify it. New Qloo results can arrive only through the existing answer-time reretrieval (positive signal, agent request, budget remaining), labelled `QLOO_RERETRIEVAL`. Otherwise changes are labelled `LOCAL_RERANK` or `UNCHANGED`.
- **Exhaustion.** `continue` is refused with `409 EXPLORATION_EXHAUSTED` when no non-rejected candidate remains, or when there is neither an unseen candidate nor an unasked grounded question. The message advises trying another anchor or destination. Context is kept.

## 7. Budgets and abuse protection

- **Qloo.** `MAX_QLOO_CALLS_PER_SESSION` (default 6) is **cumulative per exploration**, because rounds share the record and `continue` never resets it.
- **Gemini.** The new `MAX_GEMINI_REQUESTS_PER_EXPLORATION` (default 20) covers all rounds.
  - `continue` is refused with `429 EXPLORATION_BUDGET_EXHAUSTED` when the remaining allowance cannot cover one decision plus its repair (2). The refusal makes no provider call.
  - Inside a round, an exhausted allowance makes the decision deterministic and labels it as such (`DETERMINISTIC_FALLBACK`, `exploration_gemini_budget_exhausted`) instead of calling Gemini. The optional question proposer is skipped the same way.
- **Per turn.** The agent-tool budget (`MAX_AGENT_TOOL_CALLS_PER_TURN`, 3) and `MAX_QUESTIONS = 3` per round are unchanged.
- **Rate limits.** The Redis rate limiter still applies; `continue` has its own bucket at the start limit.
- **Round count.** There is no arbitrary round cap. The combination of exhaustion, the cumulative budgets, the session TTL and rate limits keeps total usage bounded; unlimited calls or recommendations are never promised.

## 8. Expiry and recovery

- **Expiry.** The exploration expires `SESSION_TTL_SECONDS` (default 30 min) after `start`. `continue` does **not** extend it. After expiry every route returns `401 SESSION_EXPIRED` and a new exploration is needed.
- **Store failure.** Every new transition fails closed with `SESSION_STORE_UNAVAILABLE` before any provider call (tested). Production never falls back to memory.
- **Instance independence.** State lives only in the store, so a fresh app instance (a restart, or another serverless instance) continues the exploration with the same token (tested).

## 9. Verification (offline)

- **`tests/integration/multi-round.test.ts`: 18 tests.**
  - Route level: Movie → Books for three rounds, rejecting in rounds 1 and 2 and accepting in round 3. It asserts:
    - one exploration ID;
    - +1 revisions;
    - cumulative preferences;
    - distinct question IDs and dimensions;
    - rejected items never featured;
    - valid Discovery Paths for every round;
    - the accepted state;
    - replays rejected;
    - closed-exploration rules;
    - Qloo within budget.
  - Other route-level cases:
    - continue without reject;
    - accept in round 1;
    - skips stay unknown;
    - fabricated, unshown and mid-round feedback refused;
    - concurrent continue (one wins);
    - concurrent accept/reject;
    - typed exhaustion with context kept;
    - expiry;
    - the legacy one-round client;
    - cross-domain continuation for music_artist → book and movie → music_artist.
  - Service level:
    - the Gemini allowance across rounds (refusal with zero provider calls);
    - in-round deterministic fallback;
    - correction of an earlier positive;
    - persistence across instances;
    - store failure;
    - the cumulative Qloo budget.
- **`npm run smoke:multi-round`.** A real HTTP run on mock `next dev`:
  - start, round 1, reject, continue, a replayed continue (409), round 2, reject, continue, round 3, accept;
  - a replayed accept (409) and continue after accept (409 `EXPLORATION_CLOSED`);
  - 7 distinct questions and 1/6 Qloo calls. **PASS.**
- **Full suite:** 427 passed, 4 skipped (the pre-existing live-only skips). Lint, typecheck, build, smoke, `qa` (17/17, 0 axe problems), `evaluate` and wording all pass.

## 10. S9.7 UI integration contract

1. **Results screen** (`view.status === "finished"`):
   - Render from `discoveryPath` as today.
   - Show three actions:
     - **"I'll try this"** → `accept(entityId)`;
     - **"Not this one"** on START HERE (or any shown card) → `reject(entityId)`;
     - **"Keep exploring"** → `continue()`.
   - Enable "Keep exploring" only when `exploration.canContinue`. Otherwise explain `continueBlockedReason`:
     - `candidates_exhausted`: "try another anchor or destination";
     - `budget_exhausted`: "start a new exploration";
     - `accepted`: show the accepted state.
2. **After `reject`.** The response is still presenting, with the item gone and a new START HERE. Animate only on a real change, and offer continue or accept again.
3. **After `continue`.** The response is a new **asking** round. Show "Round {exploration.round}" and keep the taste notes, which are cumulative. The question counter is per round (`questionCount`/`maxQuestions`). A round may end with fewer than three questions, or none (`insufficient_question_evidence`).
4. **Accepted.** Show the chosen item from `exploration.acceptedEntityId` with intent-only copy: "On your list to try", never "you read or watched it". Offer only "Explore another world".
5. **Tokens and errors.**
   - Always replace the stored token with the newest response's token.
   - Never retry `continue`, `reject` or `accept` automatically.
   - Error mapping:
     - 409 `SESSION_REVISION_CONFLICT` → reload or "Start again";
     - 409 `EXPLORATION_CLOSED` → show the final state;
     - 409 `EXPLORATION_EXHAUSTED` and 429 `EXPLORATION_BUDGET_EXHAUSTED` → keep the results and show the reason;
     - 400 `INVALID_RECOMMENDATION` → refresh the view;
     - 401 `SESSION_EXPIRED` → start over.
6. **Copy.** "Previously shown" items keep the backend's wording. Don't label locally reordered items as new; use `recommendationUpdate.mechanism` and `previouslyPresentedIds`.
7. **Wiring.** Client methods already exist: `api.reject`, `api.accept`, `api.continue` in `src/lib/api-client.ts`.

## 11. Remaining live verification

No live Qloo, Gemini or Redis run of the new routes was done in S9.6, as instructed. Before release:

- run one bounded live multi-round session on the production build with real Redis, which needs a `qa:live` extension in S9.7;
- confirm the Redis CAS and lease behaviour of `continue` against Upstash.

The CAS primitives themselves are unchanged and were verified live in S9.5.
