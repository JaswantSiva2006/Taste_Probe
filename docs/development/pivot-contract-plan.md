# TasteProbe pivot contract plan

## Compatibility rule

Keep every existing movie→book request and response valid. Add capabilities and presentation data; do not rename existing fields, change session claims, add anchors, or replace the discovery engine.

## Server-authoritative domain registry

S9.2 should add a small registry next to the existing contracts/configuration, not a speculative taxonomy:

```ts
type CulturalDomain = "movie" | "book" | "music_artist";

type FlowCapability = {
  source: CulturalDomain;
  target: CulturalDomain;
  sourceQlooType: "urn:entity:movie" | "urn:entity:artist";
  targetQlooType: "urn:entity:book" | "urn:entity:artist";
  sourceLabel: string;
  targetLabel: string;
  enabled: boolean;
  evidence: "FULL_E2E_VERIFIED" | "VERIFIED_INSIGHTS" | "INCONCLUSIVE";
};
```

Initial rows:

| Pair | Qloo mapping | Enabled | Evidence |
|---|---|---:|---|
| movie→book | movie / book | yes | `FULL_E2E_VERIFIED` |
| music_artist→book | artist / book | no | `VERIFIED_INSIGHTS` |
| movie→music_artist | movie / artist | no | `INCONCLUSIVE` |

Expose only enabled rows from a read-only capabilities contract. On Search and Start, resolve the exact `(source,target)` row and reject absent/disabled pairs before constructing a provider. Keep `sourceType` and `targetType` field names and preserve `movie`/`book` values. The registry—not the browser—maps product domains to Qloo URNs. Extend `EntitySummary` additively for artist search only in S9.3; book candidate schemas do not need to change for P1.

## Discovery Path presenter

Assign roles after the existing final ranking; never retrieve for a slot:

```ts
type DiscoveryPathItem = {
  role: "START_HERE" | "EXPLORE_NEXT" | "GO_FURTHER" | "ANOTHER_DIRECTION";
  recommendationEntityId: string;
  explanation: {
    kind: "preference_match" | "qloo_grounded" | "metadata_contrast";
    text: string;
    preferenceIds: string[];
    metadataIds: string[];
  };
};
```

Deterministic selection:

1. `START_HERE`: final ranked candidate 1.
2. `EXPLORE_NEXT`: the next valid candidate. Prefer one with a verified, useful tag distinction from START HERE; otherwise candidate 2 with neutral Qloo-grounded copy.
3. `GO_FURTHER`: only a remaining candidate with a concrete verified tag/description contrast. If none exists, use `ANOTHER_DIRECTION` with a factual distinction, or omit the slot.

Every ID must reference an entity already present in `DiscoveryView.recommendations`. No role changes rank, makes a Qloo call, or claims “beginner”, “challenging”, “novel”, or “more adventurous” without explicit metadata that defines that claim.

## Explanation grounding

Allowed evidence, in priority order:

1. Explicit confirmed preferences in `preferences`, `lastAnswer`, and `matchedPositiveTagIds`/`matchedRejectedTagIds`.
2. Verified candidate name, description, image, tags, affinity/provenance, and optional Qloo explainability already in the recommendation.
3. Neutral provenance: Qloo returned the candidate for the selected anchor.

Rules:

- Cite preference/tag labels only when their IDs occur in the server response.
- A description may support a direct factual contrast, but must not be paraphrased into psychology, difficulty, novelty, or causality.
- Qloo provenance supports “Qloo returned this for fans of X,” not “X inspired this” or “they share theme Y.”
- If no explicit preference or verified contrast exists, use neutral text: “Qloo returned this from your selected anchor, and it is currently the highest-ranked result.”
- Build text server-side or with pure deterministic presentation helpers. Never ask an LLM to invent the relationship.

## API and session changes

- P0: no Start/Search request change. Existing clients continue to send movie→book.
- Add a read-only enabled-capabilities response (or include it additively in health/bootstrap data) so the UI cannot advertise disabled rows.
- Add the registry validation at Search/Start boundaries. Do not trust arbitrary source/target combinations even after schemas expand.
- Preserve `TasteSession` version 1 and signed claim version 2. The current state already persists source, target, anchor, preferences, candidates, and provenance.
- Add `discoveryPath` only as an optional response field initially. It can be deterministically recomputed from verified recommendations, so it need not be stored in or signed into the session.

## UI migration dependencies

1. Fetch enabled target/source choices; default to the only P0 target (`book`) and source (`movie`) without breaking old behavior.
2. Render target choice first, then the familiar-anchor search under “What do you already love?”.
3. Parameterize existing Intertitle nouns and recovery copy; keep current question cards and mobile layout.
4. In the finale, make START HERE visually dominant, render supporting path items from IDs in the same final recommendation list, and show a compact “Why this?” disclosure using the explanation object.
5. Keep all Qloo/mock and Gemini/fallback labels truthful.

## Segment scope

### S9.2 — P0 pivot

- Implement registry and enabled-capabilities contract with movie→book as the sole enabled pair.
- Validate pairs server-side while preserving old API payloads.
- Add deterministic optional Discovery Path output and grounding tests.
- Migrate copy/onboarding/finale within the existing Intertitle design.
- Test that no presentation slot triggers provider work and that all path IDs belong to final recommendations.

### S9.3 — P1 completion

- Add `music_artist` to product-domain contracts and map it to Qloo `artist` only inside the registry/provider boundary.
- Extend search normalization and generic labels; keep the target/book question pipeline.
- Add unit/integration coverage, budget accounting, and a bounded real artist→book Search→Start→Answer/Finish session.
- Enable the pair only after that run proves source verification, session persistence, grounded questions, final recommendations, and no budget regression.

### S9.4 conditions

Consider movie→music_artist only after P0 is deployed safely, P1 is fully E2E verified, artist candidate normalization/presentation is designed, deployment secrets and production smoke are green, and a separate live probe verifies metadata adequate for questions and explanations. Otherwise omit S9.4.
