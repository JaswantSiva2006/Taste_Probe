# S9.14 release verification — PARTIAL

## S9.14R recovery

Recovery base `e208be1`, branch `seg/S9-14R-release-recovery`. Five music-source paths enabled with accurate evidence levels. Source choice is explicit. Books disabled after a real typed source was rejected by upstream artist Insights. Five complete fixture-backed route tests preserve source context through listening/Gemini/feedback/save; the sixth fixture verifies safe rejection.

Production browser acceptance reached revision 4 with Nils Frahm as source, real Qloo, one real Gemini decision, Redis, official YouTube playback/pause, track dislike, and another song. It failed its Gemini-song assertion because only one eligible recording remained. This is expected deterministic behavior, not a fabricated model decision. Later live steps were not run. Combined Qloo allowance is exhausted at 18; Gemini usage verified directly from the authoritative Redis session is one request, $0.0006128.

Secret audit: `npm run audit:release-secrets` checks all reachable Git blobs and the current client build against five currently configured secret values and rejects tracked environment files. Result: 928 Git objects and 18 client files, zero matches, zero tracked environment files. This is not proof against unknown historical or rotated credentials. No publication occurred.

Recovery regression results: 530 tests passed, four skipped; build, lint (one unrelated existing warning), typecheck, mock/multi-round/listening smoke, standard/adaptive/song/wording evaluations passed. Passport browser QA passed 43/43, including real official YouTube playback with a fixture Qloo boundary, source selection, storage, widths 320–1440 and reduced motion. The generic browser harness needed two obsolete capability expectations updated; the corrected harness passed 17/17 with no hygiene or serious/critical axe problems. Multi-round browser QA passed 16/16.

Added `vercel.json` for the existing Next.js build and `npm ci`. No authenticated GitHub/Vercel CLI or hosting token was found; no remote/project/URL exists. Publication/license choice and account access were requested. No license was silently chosen. Public release remains blocked pending these user-controlled prerequisites and final live acceptance.

`qa:music` now targets the current Passport harness; `qa:listening` targets the recovery harness with persistent campaign checks. The old scripts remain historical source, not the advertised npm entry points. Expiry copy explains that saved Passport entries remain on this device. Session signing and absolute expiry were not changed.

Baseline: `ee42607`. Branch: `seg/S9-14-six-domain-release-verification`.

This is a partial engineering checkpoint, not a release candidate or six-domain PASS. The bounded real provider matrix is in `six-domain-music-capability-matrix.md`.

## Changes

- Removed the misleading header claim that Gemini was active merely because the deployment selected live mode. It now says “Live discovery”.
- Registered artist-to-artist discovery for isolated verification while keeping public enablement gated by actual end-to-end evidence.
- Recorded new live Insights evidence for artist, TV, game, and podcast sources in the existing capability registry.
- Added canonical source-ID exclusion to target normalization, preventing an original artist from appearing as a new discovery.
- Added a persistent, bounded six-domain provider probe and source-type/self-exclusion regressions.
- Production configuration now refuses `NODE_TLS_REJECT_UNAUTHORIZED=0`; the local QA certificate bypass cannot be used to start the production application.

## Evidence and limits

Real provider probes used 12 Qloo requests and returned eight typed artists for five source domains. The book path returned `QLOO_BAD_REQUEST`. No S9.14 production browser listening journey, Gemini selection, Redis live transition, or adaptive expansion was performed. Earlier S9.12/S9.13 evidence is historical and is not relabelled as S9.14 live acceptance.

Final regression: 524 tests passed with four live skips; lint (one existing unrelated warning), typecheck, production build, mock smoke, multi-round smoke, listening smoke, standard evaluation, adaptive evaluation, song evaluation, and wording evaluation passed. Browser QA passed 17 generic journeys, 16 multi-round checks, and 43 Passport checks. Passport QA uses stubbed Qloo and deterministic selection, with real YouTube playback. Screenshots inspected: 1440 stage ready and 375 stage playing. No new production-provider browser acceptance is claimed.

## Acceptance matrix

| Requirement | Status | Evidence |
|---|---|---|
| Six source-to-music paths | PARTIAL | Five real typed provider probes; book error; four new pairs remain disabled |
| Verified source and artist identities | PASS_WITH_DEBT | Five live query paths; no six-domain session acceptance |
| Source artist exclusion | PASS | Canonical normalizer exclusion and regression |
| Adaptive retrieval | NOT_TESTED | Existing service tests pass; no new live adaptive journey |
| Gemini authorized song choice | PASS_WITH_DEBT | Offline listening/song evaluation; no S9.14 live choice |
| Playback, track/artist feedback, another song/artist | PASS_WITH_DEBT | Listening integration tests; current live browser acceptance outstanding |
| Passport save/reload/remove/clear | PASS_WITH_DEBT | Existing browser QA harness; fresh results in completion report |
| Signed sessions and replay | PASS_WITH_DEBT | Existing regression suite; no fresh Redis live campaign |
| Provider quotas | PASS_WITH_DEBT | Matrix persistent request ledger; wider release audit unfinished |
| Generic discovery | PASS | Mock and multi-round smoke; existing full suite |
| Mobile/accessibility | PASS_WITH_DEBT | Browser QA; no screen-reader or Lighthouse claim |
| YouTube compliance | NOT_TESTED | Existing visible official player retained; final audit outstanding |
| Deployment | BLOCKED | No Git remote or configured deployment discovered |

## Remaining P1 release work

Resolve the precise book request failure; complete production-mode session/listening/browser verification for the new source paths; enable only accepted pairs; verify a non-movie live listening and Passport lifecycle; retire obsolete live selectors; finish expiry, TLS, security, playback, and accessibility audits. The UI still exposes the previously enabled source scope. No final public-release readiness is claimed.
