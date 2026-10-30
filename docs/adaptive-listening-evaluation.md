# S9.16 completion report

Status: **PARTIAL — implemented and verified continuous-feedback mechanics; full musical-intelligence acceptance remains incomplete.**

## Baseline

- Starting commit: `e9167c4b2579abb9ffb76073d970d2790e84690f`.
- Branch: `seg/S9-16-adaptive-listening-intelligence`.
- Final commit: the commit containing this report, titled `S9.16: build multimodal adaptive taste intelligence` (`git log -1` on this branch).
- Public repository main observed at the starting commit. Public Vercel health is live/Redis/Gemini-ready; exact deployed SHA is not published by health and remains unverified.
- `ADAPTIVE_LISTENING_ENABLED=false` and `ADAPTIVE_POOL_ENABLED=false` are defaults. No deployment, push or submission performed.

## Root causes and implementation

The original selector chose recordings within one artist, used registry order for deterministic fallback, and had no sound profiles. Questions influenced artist recommendations but had no explicit cross-artist song-pair score. Dislike recorded feedback and required a follow-up direction; Love recorded feedback without preparing a next recommendation. Dynamic YouTube lookup discarded other verified videos from its existing batch.

Implemented optional server-authoritative TasteState, cross-artist verified inventory, exact-track exclusions, contextual ranking, constrained Gemini comparison, automatic dislike continuation, Love/Up Next without interrupting current playback, neutral Next, bounded resolution and truthful exhaustion. The formula, normalized components, feature missingness, query restrictions and failure semantics are in [the engineering document](adaptive-listening-intelligence.md).

Taste retains explicit answers and reactions separately from high-uncertainty artist-tag transfer hypotheses. Conflicting evidence remains represented. Artist endorsement/rejection is still explicit only. A dedicated semantic musical Taste Reasoner and production sound-profile cache are **not implemented**; the comparator does not pretend to supply them.

## Matched B0/B1 comparison

Both actual services used the same 14 resolved artist identities and 24 reviewed video options with synthetic, clearly labelled counterfactual tag assignments. No new Qloo or YouTube call was made.

| Five NOT_FOR_ME reactions | B0 existing flag-off service | B1 deterministic flagged service |
|---|---:|---:|
| Distinct presented video IDs | 1 | 6 |
| Distinct artists | 1 | 4 |
| Repeated presentations | 5 | 0 |
| Invalid artist/video pairs | 0 | 0 |
| Qloo / Gemini / YouTube calls | 0 / 0 / 0 | 0 / 0 / 0 |
| In-memory service P50 (sample run) | 1.45 ms | 2.32 ms |
| In-memory service P95 (sample run) | 3.33 ms | 4.48 ms |

B0 repeats here mean it leaves the same disliked recording presented while awaiting a direction; it does not automatically play it again. This comparison measures removal of that interaction bottleneck, not taste satisfaction. Local fixture latency excludes provider/browser/production Redis latency and is not a production performance SLA.

## Counterfactual and trajectory tests

- Same inventory, different explicit tag answers: distinct chosen artist/video (`aXlx-YnvgKU` versus `b_YHE4Sx-08`).
- Same inventory, different evidenced source relationship: ranking follows the appropriate anchor relationship; no source-name stereotype is invented.
- Love versus dislike of the same encountered recording: future choice changes; both exact histories stay distinct.
- Contradictory feedback on encountered recordings retains positive and negative evidence and reports uncertainty.
- Unknown track metadata remains neutral. Test-only exact track annotations can distinguish same-artist recordings; expired annotations cannot affect ranking. These annotations are not real musical findings.
- Forged artist options are excluded. Existing session, authorization, expiry, provider/quota, preview and Passport regression tests remain in the full suite.
- LOVE ×5 (with neutral Next between retained loves), NOT_FOR_ME ×5, NEXT ×10, and mixed ×15 do not repeat automatic video IDs.
- Single-artist depletion produces a null current video and truthful exhaustion instead of a replay loop.
- Durable seen IDs are independent of the 100-entry UI encounter log (bounded at 600 lifetime IDs, then exhaustion rather than forgetting).
- Resolver failure and throwing Gemini retain valid feedback and deterministic continuation. Feature-off behavior is tested.
- HTTP tests for movie, music artist, TV, game and podcast sources verify automatic advance and concurrent duplicate feedback (one 200, one 409), with no double skip. Neutral Next makes no comparator call.
- A regression reproduces Gemini attempting to erase a better question-answer fit within its permitted score margin; the new answer-priority guard rejects that override.

## Real B2 Gemini and Redis evidence

All inputs used retained Qloo identities/associations and previously reviewed videos. Experimental question preferences/reactions were controlled inputs, not human preference judgments. Sessions were created in actual configured Redis using normal signed claims, leases and CAS, then only the newly created experimental session keys were removed. The first harness attempt used the Redis SDK's default JSON deserialization and failed before model usage; it was corrected to match production's `automaticDeserialization:false`. This was a harness issue, not a production Redis defect.

The initial three-call trajectory used Love → Next → Not for me → Not for me:

- Love retained `aXlx-YnvgKU`, prepared `dCWbVxfkoKg`.
- Neutral Next presented that prepared recording without a model call.
- Dislike advanced to `b_YHE4Sx-08`; an invalid evidence-reference response fell back deterministically.
- Another dislike accepted a constrained Gemini selection of `XmHs_sMDueA` for its authorized artist.

Two matched live counterfactual calls then compared Ambient and Contemporary Classical explicit preferences on the same anchor, initial recording and inventory:

| Controlled preference | B1 deterministic Up Next | Initial B2 Gemini Up Next |
|---|---|---|
| Ambient | `dCWbVxfkoKg` | `dCWbVxfkoKg` (valid comparison) |
| Contemporary Classical | `b_YHE4Sx-08` | `dCWbVxfkoKg` (valid IDs, but poorer explicit-answer fit) |

This was **not** evidence of B2 improving quality. It exposed a weakness. Added the deterministic explicit-answer-priority guard (maximum fit drop 0.05), then made one targeted new-model call to verify the corrected case: the same proposed override was rejected with `explicit_answer_priority`, preserving `b_YHE4Sx-08`. No unrelated equivalent experiment was repeated to improve the reported result.

Gemini model/request latency ranged about 1.10–1.38 s, excluding Redis overhead. Accepted selections are verified-ID/evidence-constrained comparisons, not audio understanding or human preference wins. B2 currently has no demonstrated satisfaction advantage over B1. B3 was not run.

## Multimodal and preview results

Configured endpoint/model: stateless Gemini GenerateContent / `gemini-3.5-flash-lite`. Current official documentation supports public YouTube URL input, but this app's proposed derived-descriptor use did not clear the policy-compatibility gate. Direct URL analysis stayed disabled, with zero tested video IDs, zero measured audio-feature/timestamp accuracy and no human listening validation. See [feasibility](multimodal-music-feasibility.md).

No musically grounded preview was created. Existing timing-only Quick preview, independently validated bounds, official visible IFrame, and Listen in full remain. Browser automation verified PLAYING/cued states; nobody's listening judgment is claimed.

## Usage and cost ledger

Durable local ledger: `.artifacts/s9-16/cost-ledger.json`; results and counterfactual snapshots are in the same ignored directory. This document retains the aggregate for the commit.

| Item | Measured / accounted |
|---|---:|
| Gemini calls | 6 (all HTTP 200) |
| Input tokens | 11,806 |
| Output tokens | 693 |
| Reported thinking tokens | 0 |
| Provider-price USD estimate | $0.0052743 |
| Conservative accounting at ₹100/USD | ₹0.52743 |
| New Qloo calls | 0 |
| Historical S9.14 Qloo campaign | Unchanged, 18/18 exhausted |
| YouTube Data API searches/video-list calls | 0 / 0 |
| Multimodal calls | 0 |

Pricing source: current [official standard pricing](https://ai.google.dev/gemini-api/docs/pricing), $0.30/million input, $2.50/million output including thinking. ₹100/USD is an intentionally conservative accounting assumption, not an observed FX rate or exact invoice charge. Actual billing/tax/balance was not accessible. Relative to the user's reported ₹990 starting balance, arithmetic would leave about ₹989.47 before other usage/billing adjustments; no verified remaining balance is claimed.

The runner reserves ₹5 before each bounded request, persists the reservation before network I/O, records usage including invalid model outputs, refuses further work on unresolved/missing usage, warns at ₹150, requires review at ₹200 and refuses requests that would cross ₹250. The counters are cumulative and never reset by the runner. Remaining ₹740 judge allocation is protected by staying far below the test ceiling. Production retains existing cumulative per-exploration Gemini/Qloo and shared YouTube quotas; no paid multimodal runtime is activated.

## Security, gates and release recommendation

Existing signed authorization, current-video checks, fixed session expiry, Redis CAS leases/revisions, replay protection and quota guards remain. A repeated dislike cannot advance twice; duplicate Love cannot amplify evidence. Provider comparison failure does not erase accepted feedback. Passport continues storing exact verified records without tokens.

Commands run: lint, typecheck, complete tests, production build, smoke:mock, smoke:multi-round, smoke:listening, evaluate, evaluate:adaptive, evaluate:songs, evaluate:adaptive-listening, qa, qa:passport, qa:adaptive-listening, and release-secret audit. The full suite includes preview, question-wording, session/security and fallback tests. Ordinary tests stayed offline.

Automated result: **570 passed, 4 skipped**, 35 passing test files and two opt-in live files skipped. Typecheck and production build passed; lint had zero errors and the pre-existing local-skill warning noted below. All listed smoke/evaluation gates passed.

Recorded browser gates: generic QA 18/18 journeys; multi-round 14/14; Passport 59/59; new adaptive sequence 16/16. The adaptive browser run used a local Qloo fixture, no Gemini/YouTube Data API key, and actual official YouTube playback. It verified uninterrupted Love playback, five distinct automatic dislike transitions, no autoplay, exact Save, Finish and Passport persistence. It was not a fully live fresh-Qloo journey, which the exhausted campaign forbids.

The release-secret audit found no configured secret values in reachable history/client files and no tracked private environment files. This current-value audit does not certify the absence of unknown historical credentials. Lint retains one unrelated pre-existing unused-variable warning in a local untracked design skill.

Rollback: keep/set `ADAPTIVE_LISTENING_ENABLED=false`; hide Up Next and restore legacy continuation without deleting Passport or session histories. No public release was changed. Promote only after separately approved preview testing and human quality review.

Remaining acceptance gaps: independently checked musical track profiles; permitted reusable enrichment/cache; semantic Gemini taste-state reasoning; human/blinded preference evidence; exact deployed-SHA verification; full live frontend + fresh Qloo campaign; validation of a larger diverse playable catalogue. ID-level novelty does not detect identical audio uploaded under different video IDs. No unlimited discovery, audio understanding, personalized highlight, or satisfaction improvement claim is justified.
