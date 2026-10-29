# TasteProbe pivot capability audit (S9.1)

## Decision

The cultural-exploration pivot is feasible as a thin, backward-compatible workflow change. The production-shaped movie-to-books pipeline is already the P0 engine: target-first onboarding can still submit the existing `sourceType: "movie"`, `targetType: "book"` request, and the final ranked candidates can be presented as a path without another Qloo call. Do not enable artist-to-books yet. Its Search and Insights primitives are verified, but its complete API/session/question flow was not exercised in this segment.

Evidence levels used here are deliberately distinct: `VERIFIED_SOURCE_SEARCH`, `VERIFIED_INSIGHTS`, `VERIFIED_METADATA`, `FULL_E2E_VERIFIED`, `UNSUPPORTED`, and `INCONCLUSIVE`.

## Repository baseline and ancestry

- Audit branch: `seg/S9-1-pivot-audit`, initially at `58d6966` (`S9: harden production reliability and observability`).
- `58d6966` and S8.7 `87a8879` are both ancestors of the audit branch. `main` remains at S8 `2b1aa4c`; S8.5–S9 are integrated by ancestry on the segment branch, not merged to `main`.
- The user-reported successful S9 production smoke (Redis, revisions 0→1→2, eight grounded recommendations, three Qloo and two Gemini requests) is accepted as prior evidence. The checked-in `docs/release-readiness.md` records a later local rerun blocked before startup by a missing signing secret; it does not invalidate the reported successful run.
- Unrelated modified/untracked skills were preserved.

## Actual contracts and limitations

| Boundary | Current behavior | Pivot consequence |
|---|---|---|
| Public domains | `EntityTypeSchema = "movie" | "book"` in `src/lib/contracts/domain.ts` | `music_artist` cannot enter an API or signed session today. |
| Search route | Optional `type` is the same closed entity enum in `src/lib/contracts/api.ts`; `src/app/api/entities/search/route.ts` delegates to the provider | Movie/book only. |
| Provider | `src/lib/qloo/provider.ts` accepts `EntityType`; `src/lib/qloo/live-provider.ts` maps it to `urn:entity:<type>` and uses `GET /search` and `GET /v2/insights` | The URL machinery is generic, but the public union needs a deliberate mapping because Qloo calls music artists `artist`, not `music_artist`. |
| Verification | `src/lib/discovery/service.ts` re-resolves a selected ID and rejects a source-type mismatch | Preserve this; validate an enabled pair before any paid work. |
| Normalization | `src/lib/discovery/normalize.ts` recognizes movie/book search entities and normalizes book Insights metadata/provenance | Book outputs from an artist signal already normalize; artist search normalization needs an additive domain mapping. |
| Session | `TasteSessionSchema` stores `anchorIds`, `sourceType`, and `targetType`; mutable state is server-side (`src/lib/contracts/domain.ts`, `src/lib/session/state.ts`) | No token or session version change is demonstrated. |
| Questions | `src/lib/discovery/questions.ts` builds book/movie wording; `tag-quality.ts` filters content tags; entity comparisons use verified candidates | Book target questions already work regardless of whether the anchor was a movie or artist. Generalize noun labels through the registry rather than branching broadly. |
| Output | `DiscoveryViewSchema` returns seed, target, explicit preferences, ranked recommendations, provenance, matched preference IDs, update mechanism, usage and trace (`src/lib/contracts/api.ts`) | Enough for a deterministic presentation layer; no new recommendation engine is needed. |
| UI | `DiscoveryApp.tsx`, `Landing.tsx`, `Workspace.tsx`, and `Programme.tsx` hard-code film/book and screening/shelf copy | Layout and active-question interactions are reusable; onboarding and finale copy/roles need migration. |

## Capability matrix

| Product pair | Search | Insights | Metadata | Complete E2E | Enabled recommendation |
|---|---|---|---|---|---|
| `movie -> book` | `VERIFIED_SOURCE_SEARCH` | `VERIFIED_INSIGHTS` | `VERIFIED_METADATA` | `FULL_E2E_VERIFIED` from current implementation/tests and the reported S9 smoke | P0 enabled; preserve existing clients |
| `music_artist -> book` | `VERIFIED_SOURCE_SEARCH` | `VERIFIED_INSIGHTS` | `VERIFIED_METADATA` for normalized book fields | `INCONCLUSIVE` / not tested as a session | P1 disabled until a later bounded full flow |
| `movie -> music_artist` | Existing source search only | `INCONCLUSIVE` | `INCONCLUSIVE` | `INCONCLUSIVE` | P2 disabled |

An available Qloo type is not proof of a product flow. Any pair absent from an enabled server registry is `UNSUPPORTED` by TasteProbe.

## Live artist-to-books probe

`npm run probe:pivot` reuses `createLiveQlooProvider`, disables retries (`maxAttempts: 1`), makes no Gemini call, and never logs keys, tokens, raw responses, or descriptions. The committed harness is excluded from ordinary `npm test`.

- Official Qloo documentation names the wire category `urn:entity:artist`; the product-facing domain should remain `music_artist`. The initially tested conjecture `urn:entity:music_artist` returned no verified artist and was rejected, not adopted.
- A final sanitized Search check returned HTTP 200, 8 artist candidates, and exact-name Coldplay with public Qloo ID `B6FA456F-B729-4700-B01F-E82AD3AC8ADA` and type `urn:entity:artist`.
- Book Insights accepted that verified ID with `filter.type=urn:entity:book`, `take=10`, and explainability enabled. The provider returned a nonempty set of 10 book candidates, all with nonempty Qloo IDs; current normalization represented all returned entities as Qloo-grounded books.
- The response exposed the fields the current provider retains: description, image URL, tags (`id`, name, type), affinity, and explainability. That is sufficient to build conservative tag questions and verified entity-comparison fallbacks. It is not evidence for novelty, accessibility, difficulty, or a causal relationship between Coldplay and a specific book.
- Total new live traffic: 4 Qloo requests. Request 1 tested and rejected the incorrect `music_artist` URN; requests 2–3 were the passing provider Search/Insights probe; request 4 captured the sanitized exact search evidence. Gemini requests: 0. No live discovery session or production smoke was run.

## Safety, budgets, and deployment

- Preserve signed v2 session claims, server-side state, atomic Redis CAS/leases, revision checks, and replay protection (`src/lib/session/*`). Adding a domain enum value does not require a token-format change.
- Preserve `MAX_QUESTIONS <= 3`, final count ≤5, and the configured session Qloo budget. Current defaults in `src/lib/config/env.ts` are six Qloo calls and three agent tool calls per turn; the product requirement's stated 8/2 values differ from these defaults and must be reconciled explicitly before S9.2 changes configuration. Do not silently claim they already match.
- Production rate limits remain 30 searches, 10 starts, and 30 answers per 10 minutes by default, enforced before provider construction by `src/lib/reliability/rate-limit.ts` and route wrappers.
- `QUESTION_GENERATION_MODE` remains deterministic by default; `llm_grounded` stays opt-in. The existing Gemini agent, deterministic fallback, grounding validation, and Qloo provenance rules remain unchanged.
- Environment precedence is centralized through Next's loader for probes and `src/lib/config/env.ts` for application configuration. Existing `.env`/`.env.local` credentials are sufficient; no new credential is required.
- Deployment is production-shaped but the checked-in release document still records the missing local `SESSION_SIGNING_SECRET` as the current rerun blocker. This audit did not request or print it.

## UI migration map

- `src/components/DiscoveryApp.tsx`: add target/source selection state driven by server capabilities; continue submitting the unchanged movie→book payload for P0.
- `src/components/Landing.tsx`: preserve the Intertitle visual system, replace film-first copy with target-first selection and “What do you already love?”, and show only enabled pairs.
- `src/components/Workspace.tsx`: generalize film/book labels while preserving question cards, answer semantics, progress, recovery states, and responsive shelf layout.
- `src/components/Programme.tsx`: relabel the first verified candidate `START HERE`, remaining candidates `EXPLORE NEXT`, and render an optional evidence-supported third role.
- `src/components/BookShelf.tsx`, `BookCover.tsx`, and `src/lib/ui/presentation.ts`: retain book presentation for P0/P1; add role/explanation helpers derived only from response evidence.
- `src/lib/api-client.ts`: no movie→book wire change is needed; consume an additive capabilities response only when introduced.

## Blockers and conclusion

There is no P0 architecture blocker. P1 requires additive artist search normalization, pair validation, tests, and one complete live session before enablement. P2 has no live evidence and remains disabled. The most important correctness risk is confusing the product domain `music_artist` with Qloo's wire value `artist`; a server-owned registry must own that mapping.
