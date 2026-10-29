# Discovery Path & domain capability contract (S9.2)

Baseline: S9.1 `9dd3ffe` on `seg/S9-2-discovery-path`. S9.2 adds a server-owned registry of domain pairs and a pure, evidence-grounded presentation of the final shortlist. The recommendation engine, sessions, budgets and question pipeline are unchanged.

## 1. Registry (`src/lib/contracts/capabilities.ts`)

| Export | Purpose |
|---|---|
| `CulturalDomainSchema` | Product domains: `movie`, `book`, `music_artist`. |
| `QLOO_WIRE_TYPES`, `qlooTypeOf()` | The **only** product → Qloo type mapping. Both providers use it now; the old `` `urn:entity:${type}` `` string was removed from each. |
| `DOMAIN_PAIRS` | Frozen rows `{source, target, enabled, evidence}`. |
| `pairStatus()` / `isEnabledPair()` | `enabled`, `disabled` (registered but off) or `unregistered`. |
| `enabledSourceDomains()` | Sources of enabled pairs; these are the domains a user can search as an anchor. |
| `publicCapabilities()` + `PublicCapabilitiesSchema` | Safe projection: enabled pairs and labels only, with no wire types, evidence or disabled rows. |

| Pair | Qloo wire types | Status | Evidence |
|---|---|---|---|
| `movie → book` | `urn:entity:movie` → `urn:entity:book` | **enabled** | `FULL_E2E_VERIFIED` |
| `music_artist → book` | `urn:entity:artist` → `urn:entity:book` | disabled | `VERIFIED_INSIGHTS` (S9.1: Search and Insights only, no full session) |
| `movie → music_artist` | `urn:entity:movie` → `urn:entity:artist` | disabled | `INCONCLUSIVE` |

`urn:entity:music_artist` is not a Qloo type and appears nowhere in the code; a test asserts this.

The public projection is published additively as `data.capabilities` on `GET /api/health`, currently `{ pairs: [{ source: "movie", target: "book", sourceLabel: "film", targetLabel: "books" }] }`. There is no new endpoint.

## 2. Server-side validation

Each step runs before any provider is called:

1. **Request schema.** The schemas are unchanged. `sourceType` and `targetType` stay `EntityTypeSchema` (`movie | book`), and `StartRequestSchema` is `.strict()`.
   - `music_artist`, any unknown domain value, and extra fields (for example `enabled`, `capabilities` or `pairEnabled`) fail with `400 VALIDATION_ERROR`.
   - So a browser cannot express a disabled pair or a capability claim.
2. **Registry gate on Start.** `assertEnabledPair()` is the first statement of `startDiscovery`, in both the mock and live paths. A pair that is not enabled fails with `400 UNSUPPORTED_DOMAIN` before seed resolution, so it makes zero Search, Insights or Gemini calls (tested with spies).
3. **Registry gate on Search.** `searchAnchors()` handles `GET /api/entities/search`. A typed search must name an enabled source domain; for example `type=book` returns `400 UNSUPPORTED_DOMAIN` before Qloo is called. An untyped search is unchanged.

The route order stays: rate limit, then the service-disabled check, then body validation, then the registry gate, then paid work. `UNSUPPORTED_DOMAIN` is a new additive value of `ApiErrorCode`.

### Backward compatibility

- Every caller in the repository (UI, all smoke scripts, tests) sends `movie → book`. Those requests are unchanged and still pass.
- **Deliberate narrowing:** the old schema also accepted `book → movie`, `book → book` and `movie → movie`, which were never verified end to end and are used by no caller. They now return `UNSUPPORTED_DOMAIN`. Likewise, `search?type=book` was accepted before and is now rejected; no caller used it, and it would only find anchors for unsupported pairs.
- There is no new required request field, and the signed token (v2 `{sid, rev, exp}`) and the `TasteSession` v1 format are unchanged.
- Sessions created before S9.2 can still be answered and finished. Pairs are checked only when a session is created.

## 3. Discovery Path contract (`DiscoveryView.discoveryPath`)

It is an optional field and is present **only when `status === "finished"`**: on the finish response, on the idempotent re-finish, and on an answer that ends the session. It is recomputed from the final `recommendations` on every response and is never stored or signed.

```ts
discoveryPath?: {
  version: 1;
  sourceType: "movie" | "book";      // seed.entityType
  targetType: "movie" | "book";
  featured: Array<{                   // 0–3 items, unique roles, unique IDs
    role: "START_HERE" | "EXPLORE_NEXT" | "ANOTHER_DIRECTION" | "GO_FURTHER";
    recommendationEntityId: string;   // an ID in recommendations[]
    position: number;                 // that item's unchanged rank (1-based)
    explanation: {
      kind: "preference_match" | "metadata_contrast" | "source_grounded";
      text: string;
      evidence: {
        provenance: "qloo" | "mock";  // must equal the candidate's evidence.source
        seedEntityIds: string[];      // ⊆ [seed.entityId] ∩ candidate.evidence.seedEntityIds
        preferenceIds: string[];      // confirmed positive tag/entity IDs this candidate carries
        tagIds: string[];             // candidate tag IDs cited as a contrast
      };
    };
  }>;
  remainingEntityIds: string[];       // every other final recommendation, ranked order
}
```

The `recommendations` array, its order, its `explanation` strings and every other field are unchanged. Old clients can ignore the new field.

## 4. Selection algorithm (`src/lib/discovery/path.ts`, `buildDiscoveryPath`)

The input is the finished view's `recommendations` (the top `FINAL_RECOMMENDATION_COUNT`, which is ≤5), `preferences`, `seed` and `targetType`. *Eligible* means the user has not explicitly rejected the entity; this is the only ineligibility the ranking expresses.

1. **START_HERE** is the first eligible recommendation in ranked order, which is normally position 1.
2. **EXPLORE_NEXT** is the next eligible recommendation in ranked order. It cites a contrast only if the item carries a useful tag that START HERE lacks (`isUsefulTag` from S5).
3. **ANOTHER_DIRECTION** is optional. It is the first remaining eligible item that carries a useful tag absent from both earlier picks, not rejected by the user, and not already cited. If no such item exists, the slot is omitted.
4. **GO_FURTHER** is reserved and never emitted. No current Qloo field supports a difficulty, depth or novelty claim, and the validator flags it.
5. **remainingEntityIds** lists all other final recommendations in ranked order, including explicitly rejected ones.

With fewer candidates the path simply has fewer entries: 1 recommendation gives START HERE only, 2 give START HERE and EXPLORE NEXT, and 0 give an empty path. There are never placeholders, new entities, Qloo or Gemini calls, ranking changes or session writes.

## 5. Explanation grounding

The text is built by deterministic templates. No LLM is involved.

| Kind | Required evidence | Template (qloo provenance) |
|---|---|---|
| `preference_match` | A confirmed positive tag the candidate carries (and that the ranking matched), or a confirmed positive entity that is this candidate | “You said yes to “X”, and it carries that tag.” / “You said yes to this book during your questions.” + the provenance sentence |
| `metadata_contrast` | A candidate tag absent from the reference picks and not rejected | “It is tagged “X”, which your first pick doesn't carry.” + the provenance sentence |
| `source_grounded` | Provenance only | “Qloo returned this among its books for fans of “Seed”, and it is the highest-ranked result.” / “Qloo also returned this for fans of “Seed”; it ranks next.” |

- For mock candidates the provenance sentence says “synthetic sample … not from Qloo”.
- Answer semantics are unchanged: `like`, `both`, `prefer_a` and `prefer_b` produce positive evidence; `dislike` and `neither` never support an item and never appear as a contrast; `unknown` (skip) produces no evidence.

`explanationProblems()` checks every generated item, and any item that fails is **replaced by the provenance-only fallback**. The checks are:

- provenance equals the candidate's;
- seed IDs resolve;
- each preference ID is a confirmed positive the candidate carries;
- tag IDs are on the candidate and not rejected;
- the kind matches its evidence;
- a synthetic item is never called Qloo-returned;
- only cited names appear in quotes;
- with quoted verified names removed, the text contains none of: beginner, easy, accessible, challenging, difficult, advanced, novel(ty), obscure, adventurous, popular, bestselling, acclaimed, classic, must-read, perfect, best, inspired, similar, because.

`discoveryPathProblems()` adds the whole-path invariants: unique IDs, exact coverage of the list, ranked remainder, the correct START HERE, positions equal to ranks, no GO_FURTHER, and no featured item the user rejected. Unit tests, the live-orchestration test and the HTTP route test all assert that this list is empty.

## 6. Budgets (reconciliation)

| Limit | Enforced default (`src/lib/config/env.ts`) | Earlier spec | S9.2 decision |
|---|---|---|---|
| Qloo calls per session | **6** (`MAX_QLOO_CALLS_PER_SESSION`) | 8 | Kept at 6 |
| Agent tool calls per turn | **3** (`MAX_AGENT_TOOL_CALLS_PER_TURN`) | 2 | Kept at 3 |
| Final recommendations | 5 | 5 | Unchanged |

The difference from the earlier spec is recorded here and not resolved silently; changing it is a product decision for S10. The registry gates run before any provider call. The path builder has no provider access, and tests confirm that finish leaves the Qloo Insights, Search and Gemini counters and `usage` unchanged. Rate limits (30 searches, 10 starts and 30 answers per 10 minutes) still run first in each route.

## 7. Regression results (offline, no paid calls)

| Gate | Result |
|---|---|
| `npm run lint` | 0 errors (1 pre-existing warning in the untracked `web-design-atelier` skill) |
| `npm run typecheck` | pass |
| `npm test` | 328 passed, 4 skipped (was 289; +39 S9.2 tests) |
| `npm run build` | pass |
| `npm run smoke` (= `smoke:mock`, real HTTP) | pass, now also asserting `START_HERE > EXPLORE_NEXT > ANOTHER_DIRECTION + 2 more` |
| `npm run evaluate:questions` / `evaluate:question-quality` / `evaluate:question-wording` (S8.7) | pass |
| Live Qloo / Gemini | not run; none needed (0 additional calls) |

`npm run evaluate` does not exist in `package.json`; the three evaluation scripts above are the project's evaluations. The release document's note about a missing local signing secret is unchanged. The user-reported S9 production smoke (Redis, 3 Qloo, 2 Gemini, revisions 0→1→2) remains the latest live evidence; S9.2 did not run a new one.

## 8. S9.3 UI integration notes

- **Capabilities.** Read `health.data.capabilities.pairs`, and offer only those pairs: today, “film → books”. Keep sending the unchanged start body `{sourceType:"movie", targetType:"book", …}`. Never show disabled pairs, even greyed out, unless product decides otherwise.
- **Finale layout.** When `view.discoveryPath` is present:
  - Resolve each `recommendationEntityId` against `view.recommendations` for the cover, title and tags.
  - Render `START_HERE` as dominant, then `EXPLORE_NEXT`, then the optional `ANOTHER_DIRECTION`, then `remainingEntityIds`.
  - Use `explanation.text` verbatim behind a “Why this?” disclosure.
  - `explanation.kind` can choose an icon; `evidence.preferenceIds` can link to taste notes.
- **Fallback.** If `discoveryPath` is absent (an older server), fall back to the current Programme.
- **Truthfulness.** Keep the Qloo/mock and Gemini/fallback labels truthful. Don't add claims beyond `explanation.text`, and don't render a GO_FURTHER style unless that role appears.
- **Errors.** Map `UNSUPPORTED_DOMAIN` to a recoverable “not available yet” message.

## 9. Remaining limitations

- `music_artist → book` stays disabled until S9.4 runs a bounded live Search → Start → Answer → Finish session. Enabling it also requires adding `music_artist` to `EntityTypeSchema` and artist search normalization.
- Contrast evidence is tag-based only. Descriptions are not used for contrasts, because paraphrasing them risks invented claims.
- Contrast uses only tag presence or absence. It says nothing about degree or quality, so the role names are product framing, not calibrated suitability.
- The banned-claim lexicon is conservative and English-only.
- The live budget defaults (6/3) still differ from the earlier 8/2 spec until a product decision is made.
