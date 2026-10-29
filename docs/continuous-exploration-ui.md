# Continuous exploration UI (S9.7)

Baseline `92fb764` (S9.6), on the branch `seg/S9-7-continuous-exploration-ui`. All S9.7 testing used mock providers with **0 Qloo calls and 0 Gemini calls**.

## 1. User journey

1. **Round 1.** Destination → anchor → explicit selection → questions (unchanged S9.4 UI). Then "Show my way in" opens the **Your way in · Round 1** programme.
2. **Results.** The results screen separates three intentions:
   - **I'll try this** (primary, solid ink) is on START HERE and on every shown pick. It calls `api.accept(entityId)` and opens the **completed state**: "You'll start with *X*", "On your list to try", and "TasteProbe records only your intention; nothing is marked as finished".
   - **Not for me** (secondary, outline) is on each shown pick. It calls `api.reject(entityId)`. The server's new view replaces the screen: the pick is gone and START HERE is rebuilt by the server. It does **not** continue automatically. Focus moves to the new START HERE label.
   - **Keep exploring** sits in its own **"Not quite there?"** panel. It calls `api.continue()` and is enabled only when `view.exploration.canContinue` is true. The panel says what continues ("everything you've told it… up to three new questions, none repeated. Nothing is set aside unless you say 'Not for me'"). When continuing is blocked, it shows the backend's `continueBlockedReason` in plain words.
3. **Later rounds.**
   - The strip shows a **ROUND n** pill, the reels count questions **per round** ("Round 2, question 1 of up to 3"), and the anchor and destination stay visible.
   - There is no "round x of y", because no fixed number of rounds exists.
   - The shelf intro reads "Round 2 starts from everything you've told us; picks you set aside are gone".
   - There is no stale "your picks were reordered" notice, and no movement badges carried over from the previous round's answer.
4. **Completed.** After accepting, the only actions are "Explore another world" and "Try another {anchor}". "Keep exploring" is not rendered.

## 2. API integration and tokens

- **Calls.** The UI uses the existing `api.reject`, `api.accept` and `api.continue` client methods (S9.6) and the existing `DiscoveryView` contract. No endpoint was invented.
- **Tokens.**
  - Each action uses the `sessionToken` of the view on screen.
  - A successful response replaces the whole view, including the token, in one state update, so the next action always carries the newest token.
  - The browser QA asserts this token chain for every mutation in the three-round journey.
- **Retries.**
  - **No automatic retries.** `accept`, `reject` and `continue` are sent once.
  - After a network failure the user may click **Try again**, which reuses the same token. If the first request did reach the server, the store's revision check returns 409 instead of applying it twice. Tested: a single request before the click, one retry after it, with an identical token.
- **Double submission.**
  - A synchronous in-flight ref blocks a second action before React re-renders the disabled buttons. Tested: a double-click sends exactly one reject.
  - While any request is pending, all action buttons are disabled. A polite live region announces "Updating your picks…", "Saving your choice…" or "Opening the next round…".
- **Client state.** The client never sends preference history. Tokens appear in no URL, log or screenshot.
- **Session recovery.**
  - A page refresh returns to the start screen, because tokens are held in memory only. Restoring an exploration after a reload would mean persisting a bearer token in the browser. That is not part of the current security model and was not added.

## 3. What TasteProbe remembers

The **"What you told us" / "Your taste notes"** panel shows only server data:
- confirmed likes and passes from `preferences` (cumulative), labelled "· across n rounds";
- a **"Not for me"** group listing `exploration.rejectedRecommendationIds` (struck through), kept apart from answer-level preferences;
- a collapsible **"Your answers so far (n)"** list: round, verified label, answer. A skip reads **"Skipped (not counted)"** and is never shown as a dislike.

No confidence scores are shown and no preferences are inferred.

**Backend deviation (minimal, documented).** `view.exploration.answerHistory` was added. It is a server-side projection of the stored answers, newest 40, with labels resolved from verified candidate tags and names (falling back to the ID's readable last segment). It is optional in the schema, so S9.6 responses still validate. No other backend file changed. Tests: route-level (rounds, labels, skips stay `unknown`) and unit-level (copy).

## 4. Exhaustion, limits and errors

| Situation | UI behaviour |
|---|---|
| `continueBlockedReason: candidates_exhausted` | "Keep exploring" disabled; message: "You've seen or turned down every verified {noun} found for {anchor}, and no new question is left. Try a different {source} or destination." The remaining picks stay on screen. |
| `budget_exhausted` | Disabled; message: "This exploration has used its question allowance…" |
| 429 `EXPLORATION_BUDGET_EXHAUSTED` (a race) | Error message; the results stay; no retry |
| 401 `SESSION_EXPIRED` | "This exploration expired…" with **Start again** (same world). The exploration is never silently replaced; the QA asserts no new `start` request. |
| 409 `SESSION_REVISION_CONFLICT` | "This exploration moved on…" with **Start again**; no Try again |
| 409 `EXPLORATION_CLOSED` | "This exploration is complete" |
| 409 `ROUND_IN_PROGRESS` / 400 `INVALID_RECOMMENDATION` | Explanatory message; dismissable |
| Network failure | Manual **Try again** only |
| Redis unavailable | The existing `SESSION_STORE_UNAVAILABLE` message, with retry |

**Expiry.** The panel always states "This exploration stays open until HH:MM; after that, start a new one", from `exploration.expiresAt`. **Known backend limitation:** the expiry is fixed at 30 minutes from `start`, and continuing does not extend it. This needs separate backend remediation. The UI does not work around it.

## 5. Browser verification

`npm run qa` starts a mock `next dev` server, then runs `scripts/ui-qa.mjs` (S9.4/S9.5 checks, updated for real accept) and the new **`scripts/ui-qa-rounds.mjs`**. Final run: **17/17 + 16/16 checks passed, 0 problems** (overflow, broken images, console errors, and serious or critical axe violations).

**Three-round journey (375 and 1440): PASS.** The flow was R1 answer → finish → *Not for me* → R2 *Keep exploring* → answer → finish → *Not for me* → R3 *Keep exploring* → answer → finish → *I'll try this*. It asserted:
- **Identity and progression:** one `explorationId`; revisions advance exactly 1 per transition; rounds go 1 → 2 → 3 and never back to 1.
- **Tokens:** every mutation used the latest token.
- **Questions:** 5 distinct questions, none repeated.
- **Memory:** earlier likes stay visible; set-aside picks are listed.
- **Rejections:** both rejected picks are absent from every later featured slot; focus lands on the new START HERE.
- **Display:** no stale notice at round start; the answer history spans rounds; the completed state says "over 3 rounds".
- **Replay:** a replayed accept with the previous token returns 409.

**Variations:**

| Check | Widths | Result |
|---|---|---|
| Continue without rejection (also the overflow check for the new screens) | 320, 375, 1440 | PASS |
| Real candidate exhaustion, reached after 3 rounds | 1440 | PASS |
| Budget-exhausted state; 429 on continue keeps results with no retry | 375, 1440 | PASS |
| Expired exploration | 375 | PASS |
| Network failure, then manual retry | 1440 | PASS |
| 409 on accept | 375 | PASS |
| Double-click prevention | 1440 | PASS |
| music_artist→book and movie→music_artist: reject → continue → accept (frames kept; no book copy for artists) | 375, 1440 | PASS |
| Early finish (Lone Signal): continuing truthfully unavailable | in `ui-qa.mjs` | PASS |
| Missing artwork: captioned fallbacks on every screen | — | PASS |

**axe-core 4.14.0** found **0 serious or critical violations** on the round-3 finale (history open), the accepted state, the exhausted state, and the S9.4 landing, question and finale screens, at 375 and 1440.
- It initially found one serious issue, `label-content-name-mismatch` (WCAG 2.5.3). The per-pick accessible name "I'll try {title}" did not contain the visible "I'll try this".
- Fixed by naming the buttons "I'll try this: {title}" and "Not for me: {title}".
- No screen-reader session was run, so no WCAG compliance is claimed.

**Screenshots** (`.artifacts/ui-rounds/`, git-ignored) were inspected:
- `{375,1440}-r1-way-in`, `-r1-after-reject`, `-r2-question`, `-r3-way-in`, `-accepted`
- `1440-exhausted`, `375-budget-exhausted`, `375-expired`
- `{320,375,1440}-plain-way-in` and `-plain-round-2`
- cross-domain accepted states

No layout defects remained after the accessibility fix.

**Other gates:**

| Gate | Result |
|---|---|
| `npm run lint` | 0 errors (1 pre-existing warning in the untracked skill) |
| `npm run typecheck` | pass |
| `npm test` | 431 passed, 4 skipped (the pre-existing live-only skips) |
| `npm run build` | pass |
| `npm run smoke` | pass |
| `npm run smoke:multi-round` | pass |
| `npm run evaluate` | 6/6 |
| `npm run evaluate:question-wording` | 4/4 |

## 6. Remaining limitations and live verification

- **Live verification.** No live Qloo, Gemini or Upstash run of the multi-round UI was done in S9.7, as instructed. Before release, extend `npm run qa:live` with one bounded multi-round journey (about 1 continue and 1–2 extra Gemini calls) on the production build, and confirm `continue`'s lease and CAS against Upstash.
- **Expiry.** The fixed 30-minute expiry, not extended by continuing, is a backend limitation and is shown truthfully.
- **Reload.** There is no restoration after a page reload (by design, see §2).
- **Small pools.** With a small candidate pool, later rounds may bring back earlier picks. The backend labels them as shown before, and the UI shows that text verbatim.
