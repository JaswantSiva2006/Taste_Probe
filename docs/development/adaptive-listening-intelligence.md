# S9.16 adaptive listening intelligence

S9.16R supersedes the supply, inventory-size, expansion and exposure details below. See [discovery supply intelligence](discovery-supply-intelligence.md) for the verified 50-artist acquisition, multi-artist video lookup and bounded supply controller. The following S9.16 report describes commit `024d305`; its audio-understanding limitations remain.

Status: **PARTIAL**. The flagged continuous-feedback engine is implemented and tested, including real Gemini/Redis comparison. Full musical personalization is not established: current production recordings have verified identities but no independently checked sound profiles. Direct video enrichment failed the unresolved-policy gate, and no human preference study was performed. Do not advertise this as verified audio understanding or a demonstrated satisfaction gain.

## Baseline and root causes

Started from verified release `e9167c4b2579abb9ffb76073d970d2790e84690f` on `seg/S9-16-adaptive-listening-intelligence`. Preserved the unrelated modified S2 skill. The public GitHub main was independently observed at that same SHA. `https://taste-probe.vercel.app/api/health` reports live mode, Redis readiness and `gemini-3.5-flash-lite`. It does not expose a deployed SHA; the public GitHub deployments endpoint returned no deployment records. Exact deployed commit remains unverified. No push/deploy was performed.

| Lifecycle | Existing behavior | S9.16 disposition |
|---|---|---|
| Qloo retrieval | Source-ID-conditioned artist Insights; optional explicit-positive adaptive refresh | Reused; no speculative families or new campaign calls |
| Artist ranking | Provider/rank-fused relevance plus confirmed preferences | Retained as the cultural relationship; raw cross-query affinities are not averaged |
| Recording supply | Reviewed alternates, but dynamic lookup retained only one matching video | Dynamic lookup now retains up to five already-validated videos from the same search/video-list batch |
| Song selector | Gemini chooses within the selected artist; titles provide no sound evidence | Flagged selector ranks cross-artist verified pairs; Gemini compares a top-six shortlist |
| Track knowledge | Verified title/channel/duration; no reviewed sound annotations | Unknown remains unknown; optional annotation schema/ranking seam, not invented profiles |
| Questions | Affect artist order; no explicit cross-artist song fit | Confirmed tag/entity preferences directly enter each pair's deterministic score |
| LOVE | Records exact reaction, keeps current song | Also prepares Up Next; no save or artist endorsement inferred |
| NOT_FOR_ME | Records dislike and asks user where to go | Automatically recomputes and presents an unheard verified recording |
| NEXT | Prefers another song of the current artist | Globally reranks, or consumes a still-eligible prepared recommendation; no negative rating |
| Unplayable artist | Bounded skip list | Preserved; failed resolution skipped for this fixed-lifetime exploration |
| Exhaustion | Can leave previous recording presented | Clears current video and shows truthful exhaustion/Passport copy |
| Round changes | Shared session and cumulative histories | Preserved; optional taste projection rebuilt on listening transitions |
| Session expiry | Fixed 30-minute signed session expires | Unchanged; device-local Passport survives |
| Preview | Timing-based excerpt unless human-reviewed candidates exist | Unchanged; no unsupported musical curation |

## State and evidence

`SessionState.taste` is optional and uses policy `context-v1`. It retains original anchor, explicit answers, exact latest loves/dislikes, explicit artist decisions, bounded exposure history, positive and negative artist-tag associations, tentative hypotheses, and uncertainty (`no_track_evidence`, `limited`, `conflicting`). Earlier sessions migrate lazily from their existing listening history. There is one Redis session store.

The explicit reaction map is rebuilt from history, so a repeated Love cannot repeatedly increase feature weights. Reversal changes the latest explicit reaction; separate contradictory recordings remain positive and negative evidence. Qloo artist tags support only high-uncertainty transfer hypotheses, never assertions about an individual recording's sound or the user's whole genre taste.

`MusicEvidenceSchema` keys annotation identity to artist ID AND video ID, with source reference, version, observed/expiry times, feature values and uncertainty. Only reviewed annotations/authorized external metadata are admitted. The optional ranker seam checks identity and expiry. There is currently no production annotation source or profile cache; no musical descriptors are fabricated to fill it.

`listening.inventory` stores at most 180 verified options. Current-artist `options` remains capped at six. `upNext` is optional. `contextualDecision` records chosen video, mode, reason/fallback, score, evidence references and revision. All remain server-owned, signed-session-authorized and CAS committed.

## Ranking policy

The hard eligibility filter requires a current session music-artist candidate and a resolver-issued option, removes explicit artist rejects, seen video IDs and exact disliked recordings, and deduplicates video IDs. Manual Previous remains an explicit authorized replay; automatic selection never replays a seen ID. No calibrated confidence percentages are shown.

For each eligible artist–recording pair:

```
w = min(0.30, 0.05 * number_of_latest_track_reactions)
score = (0.50 - w/2) * anchorFit
      + 0.35 * explicitAnswerFit
      + w * tentativeArtistTagTransfer
      + 0.18 * artistNovelty
      + 0.20 * supportedTrackFeatureTransfer
```

`anchorFit = 1/(1 + source-conditioned rankIndex/5)`, only for a candidate whose source evidence includes the original anchor. It uses retained provider/fused rank, not raw affinities. `explicitAnswerFit` is bounded cosine overlap of positive minus rejected tag IDs plus explicit entity approval, clamped to [-1,1]. Tag transfer is mean overlap with artists of loved recordings minus mean overlap with artists of disliked recordings. All overlaps are normalized. `artistNovelty = 1/(1 + artist exposure count)`. Optional exact track-profile transfer compares live, independently sourced feature/value pairs; it is zero for missing evidence, not a false negative.

These weights are transparent heuristics validated for mechanical sensitivity and safety, not trained or calibrated quality estimates. Within an artist, unheard tracks without sound evidence may remain tied; the stable ID tie break makes no musical claim. No full reinforcement-learning system is introduced.

## Gemini comparison and reasoning boundary

The existing song-selector mode gets the source, confirmed preferences, explicit track reactions, and a top-six artist–recording shortlist containing Qloo artist tags, deterministic scores and actual evidence references. Its instructions prohibit inferring sound from titles and require abstaining to the first candidate on ambiguity. The model has not heard the music.

The response must select an enumerated video ID and reason code and cite actual references offered for that candidate. Empty, unknown, or cross-candidate citations are rejected. The service independently checks shortlist membership and limits model influence to candidates within 0.15 of the deterministic winner, with explicit-answer fit no more than 0.05 below that winner. The answer-priority guard was added after a matched live comparison showed the model washing out question distinctions. Failure, timeout, invented IDs, unsupported references and budget exhaustion retain deterministic continuation and feedback. No free-form preference claim reaches the UI.

Gemini runs only after a newly accepted meaningful track reaction with multiple candidates and remaining cumulative budget. Play, Pause and neutral Next do not invoke this comparator. Duplicate Love on the current already-loved recording is a no-op. Up Next is discarded/recomputed after a new reaction, rather than reusing a choice based on stale taste.

This is constrained comparative reasoning, **not** a separately implemented semantic Taste Reasoner that writes new musical preferences. That larger P1 component remains incomplete; numeric artist-tag hypotheses stay conservative and deterministic.

## Supply, exhaustion and quotas

The server considers authorized visible and hidden candidates (up to 90), resolves reviewed mappings without network calls, and permits at most three previously unattempted dynamic artists per turn. Existing shared Redis YouTube quota guards still enforce the tighter default two searches per exploration and forty per UTC day. Failures consume attempts; no search retry loop is added. Unavailable artists are suppressed until a new exploration. Cached positive and six-hour negative entries are retained under the existing policy key; no blanket invalidation or additional search is needed. Dynamic alternates are bounded, searched-ID/channel-ID matched, public and embeddable, with existing Topic/VEVO/title checks unchanged. Labels still require reviewed mappings.

On full inventory exhaustion, when both adaptive flags and an existing pool are present, the existing controller may propose a deduplicated refresh from already explicit positive tags/entities. It retains original-anchor grounding, valid query-family restrictions and cumulative budgets. Track feedback never becomes a fabricated Qloo signal. New candidate IDs trigger one more bounded local selection. Unsupported diversification/pagination remains disabled. If no legitimate request/candidate exists, exhaustion is final and honest.

There are 14 resolved reviewed artists and 24 playable registry videos; one additional artist/video remains held for review. This stage did not manufacture mappings or add recording IDs. The dynamic batch improvement increases usable supply where a valid query actually returns multiple recordings, not a guaranteed catalogue size.

## Concurrency, compatibility and rollback

Authorization and revision validation precede all work. One existing lease wraps feedback, inventory, optional model work, taste projection and commit. Duplicate/stale/concurrent feedback cannot advance twice; a late result cannot override a newer revision. Provider failures inside the new comparator/resolver/replenishment paths preserve exact feedback. Redis unavailability fails closed. Existing fixed expiry, Passport storage and preview validation are unchanged.

`ADAPTIVE_LISTENING_ENABLED=false` is the default. Enable only in an explicitly approved preview release, then run `qa:adaptive-listening` and a protected real-provider smoke. Setting it false restores legacy continuation and hides Up Next without deleting optional session state or local Passport entries. Reverting the commit also leaves old optional session fields safely ignored. `ADAPTIVE_POOL_ENABLED` is independent and remains false by default. There is no enabled multimodal flag or new production environment credential.

See [evaluation](adaptive-listening-evaluation.md) and [multimodal feasibility](multimodal-music-feasibility.md). Do not deploy automatically. Promotion still needs human musical checks and a justified quality assessment, beyond green automated tests.
