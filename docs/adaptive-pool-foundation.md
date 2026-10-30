# Adaptive candidate-pool foundation (S9.10)

S9.10 adds a dormant, server-authoritative reservoir contract. It does not add a Qloo call, change public recommendation behavior, or execute an adaptive query. `ADAPTIVE_POOL_ENABLED` defaults to `false`; when false, sessions retain the pre-S9.10 shape and behavior.

## Persistent state

When enabled, `SessionState.adaptivePool` is stored in the same memory/Redis record already protected by the signed `{sid, revision, expiry}` token. It contains at most 90 compact entries:

- verified candidate ID and target domain;
- tag IDs plus description/image availability;
- query family/hash, rank within origin, and provider request ID;
- displayed, previously presented, explicitly rejected, and pinned IDs;
- attempted query hashes and the last 20 decision transitions.

Only an explicit recommendation rejection enters `rejectedIds`. A disliked question target or tag remains preference evidence and is not promoted to an artist-level rejection. Rejected recommendations are excluded from local selection, while pinned entries are placed first and cannot be displaced.

The implementation stores references and compact metadata rather than duplicating candidate descriptions and images. A 90-entry representative serialized pool is asserted below 100 KB in offline tests. The complete verified candidates remain in the existing session candidate array.

## Pure adequacy policy

`evaluatePool` is deterministic and performs no I/O:

| Decision | Meaning in S9.10 |
|---|---|
| `KEEP` | The current slate has at least five eligible candidates and adequate verified metadata/diversity. No churn. |
| `LOCAL_REPLACE` | A displayed entry is no longer eligible and an already-verified reserve entry can replace it. |
| `FETCH_AND_MERGE` | Fewer than five eligible verified candidates remain. This is a proposal only. |
| `EXPAND` | Candidate count is sufficient but metadata coverage or tag diversity is weak. Proposal only. |
| `DEGRADED_KEEP` | No eligible verified candidate remains; preserve honest degraded state. |

`selectLocalReplacements` uses a stable union of pins, still-valid incumbents, then reservoir order. An adequate slate therefore does not change merely because the policy was evaluated.

## Query-plan contract

The typed families are `BASE`, `PROFILE_REFRESH`, `TAG_FOCUS`, `PAGINATE`, and `DIVERSIFY`. Plans accept only entity and tag IDs present in caller-supplied verified sets, deduplicate inputs, and receive a stable 24-character SHA-256-derived hash. Every S9.10 plan is explicitly `executable: false`. `PAGINATE` also requires a cursor, but pagination support has not been claimed or executed.

## Exact S9.11 integration contract

S9.11 may add execution behind a separately controlled feature only by:

1. evaluating the stored pool after a committed preference/feedback transition;
2. applying `LOCAL_REPLACE` without a provider call;
3. mapping `FETCH_AND_MERGE` or `EXPAND` to one validated, previously unattempted query plan;
4. executing through the existing bounded Qloo provider and cumulative session budget;
5. normalizing the response with the existing strict target-domain normalizer;
6. merging by candidate ID, preserving origin/rank history, rejection suppression, pins, and the 90-entry bound;
7. recording the attempted hash and decision transition atomically with the session revision;
8. leaving the current verified slate untouched on timeout, malformed data, empty results, quota refusal, or store failure.

S9.11 must first verify whether Qloo pagination is supported. Until that proof exists, a `PAGINATE` plan must remain non-executable. It must not broaden source/target capabilities, invent IDs/tags, place mutable state in the token, or couple YouTube resolution to candidate retrieval.

## Verification

Offline tests cover feature-off compatibility, signed-session persistence, the 90-entry bound and size, deterministic decisions, stable no-churn selection, pin protection, rejection suppression, tag-dislike separation, validated/deduplicated plans, and round 1–3 state retention. Ordinary tests make zero Qloo, Gemini, or YouTube calls.
