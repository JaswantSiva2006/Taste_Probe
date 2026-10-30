# S9.15 — Music-first product and verified listening previews

Branch `seg/S9-15-music-only-rebrand-previews`, from `fbbaf38` (S9.14R). Pre-deployment pass. Nothing was merged or deployed.

## 1. Product scope: music only

TasteProbe answers one question: *what music could you discover from the things you already love?*

**Destination:** music is the only public destination. The user chooses only a **starting point**: Movies, Artists, TV shows, Games or Podcasts. These are the server's five enabled `→ music_artist` pairs from the capability registry; the browser never declares one.

**What was removed from the public experience:**
- The Books / Music artists destination selector.
- The "Explore other cultures" path.
- The projector hero.
- Every book CTA and every piece of book copy.

**Server enforcement, not just hiding:**
- **Public projection:** `publicCapabilities()` (`/api/health`) publishes only music pairs. A test asserts that no `book` appears.
- **Start route:** `assertEnabledPair(..., scope)` refuses non-music destinations with `400 UNSUPPORTED_DOMAIN` before any provider call, whenever the config's `publicScope` is `music_only`.
- **When `music_only` applies:** always in production. Also in live development. `LEGACY_GENERIC_JOURNEYS=true` is refused in production.
- **Legacy generic journeys:** remain only for internal regression (`NODE_ENV=test`, mock fixtures). The generic engine and its tests were deliberately not deleted, because removing them carries release risk for no user benefit.

**Book evidence is preserved:**
- `book → music_artist` stays registered as disabled and `INCONCLUSIVE`, after the real S9.14 rejection. No book experiment was run in this stage.
- `movie → book` keeps its `FULL_E2E_VERIFIED` evidence, but is never published.

**Movie-hardcoding audit:**
- No source is preselected: "Start discovering" focuses the selector with nothing chosen. A browser QA check asserts this.
- The search prompt, results and start request all follow the chosen source.
- The old landing copy ("Name a film you love") and the film projector art are gone.
- Old saved Passport records still parse (the `preview` field is optional).

## 2. Art direction

**Research:** principles from Spotify (transport hierarchy, a dense but calm now-playing column) and Apple Music (artwork-led emphasis, generous display type), plus hi-fi amplifier input selectors and record-sleeve print design. These came from product familiarity; no site was browsed in this stage. Nothing was cloned and no assets were copied.

**Directions considered:**

| | Thesis | Verdict |
|---|---|---|
| **A. AFTERHOURS** (chosen) | A modern listening room after dark: cool midnight, one coral action colour, bold grotesk display | Most music-native. Contrast is easy to manage. Keeps the S9.13 record as the signature. |
| B. Signal Room | Near-monochrome with electric poster type | Striking, but cold for a discovery product; the record loses warmth. |
| C. Modern Hi-Fi | Tactile materials and physical-record references | Strong on Passport, but heavy textures cost performance and fight the YouTube frame. |

**Colour tokens** (`src/app/afterhours.css`):
- **Base:** midnight `#0B0E14`, deep `#10141C`, graphite `#181D27`, raised slate `#232A36`, soft white `#F6F5F2`, grey `#A8B0BE` / `#C9CFDA`.
- **Electric coral `#FF7866`** is the only action colour: primary buttons, the now-playing artist, the lit selector indicator, live mode.
- **Ultraviolet `#ADA5FF`** appears only where it means something: the Sound Passport (count, stamps, saved state), focus rings and notices.
- **Legacy colours:** the older token layers are re-pointed, not deleted, and every hard-coded amber and sepia value was retinted.
- **Contrast:** coral on midnight and dark ink on coral both pass AA. The soft-white programme insert uses a darkened coral (`#C4412F`) for emphasis.

**Type:**
- **Archivo** (variable weight + width): display, 700–800, slightly expanded, tight tracking.
- **DM Sans:** interface text.
- **IBM Plex Mono:** timestamps, step numbers and small labels only.
- **Licensing:** all three are SIL Open Font License, self-hosted by `next/font` at build time (no runtime Google request).
- **Italics:** removed. Emphasis in titles is colour, never a second typographic voice.

**Hero, "Many roads, one record":**
- An original SVG/CSS record sleeve whose print carries five fine lines (FILM, ARTIST, TV, GAME, PODCAST in small mono).
- The lines converge into one coral line that runs into a coral-labelled record pulled from the sleeve. The record dominates; the starting points are small type.
- **Motion:** the record slides out once and the lines draw once. Then everything is still, so nothing suggests audio.
- No real artists, covers or data.

**Starting-point selector** (`Landing.tsx`):
- **Metaphor:** a hi-fi input selector. Five tactile cards, each with its icon, name and an "Input 0n" label.
- **Selected state:** a lit coral indicator, a coral inset outline, "✓ Selected" text, and a lifted glyph. The state is not conveyed by colour alone.
- **Semantics:** a native radio group in a fieldset with a legend, so arrow keys work.
- **Search:** selecting a card reveals the real Qloo search, with a source-specific prompt ("Which film stays with you?", "Which artist do you keep coming back to?", …).
- **Layout:** five columns from 640 px; below that two columns, with Podcasts full width.

**Motion audit:**
- **Kept:** the record spins only on the real PLAYING state and holds its angle on pause.
- **Added:**
  - the hero pull-out and line draw (once);
  - staggered entrance of the selector inputs and search results;
  - the search-prompt fade on source change;
  - Passport sleeve entrance;
  - a steady "now" indicator on the active listening mode.
- **Not added:** no fake waveforms, no random audio visualisation.
- **Reduced motion:** every addition is disabled under `prefers-reduced-motion`, and the record never turns (verified while playing).

## 3. Verified previews

### Contract (`PreviewSelectionSchema`, `src/lib/music/preview.ts`)

```
{ candidateId, artistId, videoId, startSeconds, endSeconds, durationSeconds,
  sourceKind: REVIEWED_SEGMENT | VERIFIED_TIMED_CUE | GENERIC_PREVIEW,
  selectionMethod: GEMINI_GROUNDED | REVIEWED_DEFAULT | DETERMINISTIC,
  reasonCode, reviewStatus: APPROVED | TIMING_ONLY,
  label: "Featured preview" | "Quick preview", fallbackReason }
```

Candidates are built on the server from the **current verified recording only**:
- **Reviewed segments:** approved registry moments with a reviewer and date, inside the verified duration, 20–35 s long.
- **Generic window (policy `generic-v1`):** 30 s starting about a third of the way in, on a 5 s grid, leaving at least 10 s after it.
- **No preview:** unknown, non-finite or short (<45 s) durations get none, and the UI says the recording plays in full.

Validation rejects negative, inverted, zero-length, out-of-range, non-finite and fractional bounds. Candidates are deduplicated and capped at 6.

**Reviewed segments today: none.** Every registry moment is `PENDING_REVIEW`, so every real preview is a timing-only **Quick preview**. The UI says so: "a 30-second excerpt chosen by timing, not by listening. It isn't a highlight." `VERIFIED_TIMED_CUE` is reserved and nothing produces it; YouTube chapters and transcripts are not scraped.

### Gemini preview selection

This is a `selectPreview` mode on the **existing** song selector: same model, transport, pricing and per-exploration budget. It is not a new agent.

**When it is called** — only when all of these hold:
- ≥2 approved, **annotated** reviewed segments exist;
- explicit evidence exists: reviewer notes of segments in recordings the user loved or disliked, or confirmed question preferences;
- the budget allows it; it is charged before the call.

**What the model gets and returns:**
- It gets candidate IDs and reviewer notes only, never timestamps.
- It returns an enum ID and a reason code.
- The server re-resolves the ID against its own candidates (artist, video, bounds). Anything invalid falls back to the first reviewed segment and is labelled.

**When it is not called:** with timing-only candidates the model has no basis to choose, so no call is made. A LOVE on a whole recording is not treated as evidence about which minute of another recording to play.

**What actually ran:**
- No live Gemini preview decision ran in this stage, so **no real grounded segment has been selected**.
- The grounded path is proven with test-only fixture moments (labelled `FIXTURE:` in `tests/integration/listening-journey.test.ts`): a valid choice, an invented ID, prose output and budget exhaustion.
- **Deterministic fallback was used for every real preview.**

### Server integration

`listeningTurn` recomputes the preview only when the presented recording changes. Switching between Preview and Full is local playback: it never reaches the server, never changes the revision, and is never feedback. SAVE stores the exact canonical `videoId`; `preview {start, end, sourceKind}` is optional metadata only.

### Official IFrame playback (`YouTubePlayer.tsx`, `src/lib/ui/preview-guard.ts`)

**Loading:**
- When the player is ready, the window is **cued** with `cueVideoById({videoId, startSeconds, endSeconds})`. Even YouTube's own play button therefore starts it bounded.
- The controls enable on the CUED event. This fixed a real race where a fast first press could be overtaken by the pending cue.
- "Hear preview" and "Replay preview" use `loadVideoById` with the same bounds. "Listen in full" uses `loadVideoById({startSeconds: 0})` with **no end bound**.

**Boundary guard:**
- `seekTo` invalidates `endSeconds`, so while a preview is PLAYING the guard samples `getCurrentTime()` every 250 ms and pauses at the end.
- It uses the player's own clock, so pauses and buffering never count.
- Each load bumps a generation counter. A recording change remounts the player and destroys its timers, so an old timer can never stop a new recording.

**Seeking and transport:**
- **Our Back 10 s:** inside a preview it is clamped to the window start.
- **Native scrub:** a scrub well outside the window switches to **full listening** with a notice; there is no seek-back fight.

**Unchanged guarantees:**
- One visible player and native controls.
- No autoplay; nothing plays until a press.
- No hidden audio, no downloading.
- A preview end is not shown as a failure.

## 4. Evidence

### Browser QA (`npm run qa:passport`, real app, local HTTPS Qloo stub, real YouTube embed): **59/59**

The real recording was "Flight from the City" (`aXlx-YnvgKU`, 391 s), with a Quick preview of 1:55–2:25. Timings are from YouTube's own `getCurrentTime()` in one run.

| Check | Observed |
|---|---|
| Play preview | Started at 116.5 s (window 115–145) |
| Pause mid-window, wait 2.5 s, resume | 117.1 s → 118.8 s, still in preview mode |
| Back 10 s inside the preview | 118.8 s → 116.2 s, clamped to the window start |
| Boundary after that seek invalidated `endSeconds` | Stopped at 144.7 s; record still; "Preview finished" |
| Replay preview | 115.6 s |
| External seek to 265 s via the embed's own message channel | Switched to full and kept playing at 268 s |
| Listen in full | Started at 1.0 s with no bound |
| Switch recording during a preview | New player cued, not playing, fresh state |
| Save | Exact `videoId` plus window metadata |

**Seek caveat:** the native progress bar could not be clicked by automation. The external seek is the equivalent, but a hand scrub was not observed.

**Audio caveat:** "Playing" means YouTube reported PLAYING. Nobody listened.

**Also verified:**
- The music-only landing: no destination picker and no book copy.
- The five starting points and their prompts.
- Love, Not for me, Another song, Previous, Next, Different artist.
- The unmapped artist state.
- Passport: Finish, reload persistence, Remove, Clear, empty state.
- Movie → book refused by the server.
- Widths 320, 375, 768, 1024 and 1440 with no overflow and no serious or critical axe violations.
- Reduced motion.

### Mock browser QA (`npm run qa`)

18 journeys and 14 multi-round checks, with 0 problems:
- movie → music at all five widths, including keyboard use, the error-retry path and restart focus;
- an artist starting point with ambiguous search and an honest empty result (the synthetic fixtures hold no artist → artist data);
- TV, game and podcast starting points searching their own catalogues;
- cover fallbacks, capability failure, 429, session conflict;
- movie → music rounds (reject, continue, accept).

### Screenshots

The files are in `.artifacts/passport/` (git-ignored) and were inspected:
- `1440-01-landing`, `1440-02-source-*` (all five), `1440-02-source-selected`;
- `1440-06-preview-playing`, `1440-07-preview-paused`, `1440-07b-preview-ended`, `1440-07c-native-seek-full`, `1440-08a-full-playing`;
- `1440-11-saved`, `1440-12-different-artist`, `1440-14-finished`, `1440-15-passport`, `1440-17-passport-empty`;
- `375-01-landing-full`, `320-05-stage-playing`, `768-05-stage`, `1024-05-stage`.

### Critique pass 1 (defects found, then fixed)

1. The hero record label was clipped ("UR NEXT FAVOURITE ARTI").
2. The coral route was hidden behind the record, so the hero's idea was lost.
3. The sleeve duplicated the H1.
4. The hero glow overflowed the viewport at 320/375/1024.
5. A brown amber halo on the stage panel and ledger came from hard-coded legacy colours. About 50 values were retinted.
6. The Passport stamps used the action colour instead of the "kept" colour.

### Critique pass 2

7. At ≤520 px the search icon dropped below the input.
8. Disabled primary buttons read as muddy brown.
9. The idle intro tonearm overflowed at 320.

All of these were fixed and re-captured.

### Scorecard (heuristic): about 84/100

| Dimension | Score |
|---|---|
| Originality | 17 |
| Hierarchy | 17 |
| Graphics | 12 |
| UX | 13 |
| Responsive | 9 |
| Accessibility | 8 |
| Performance | 4 |
| Microdetail | 4 |

**Strongest remaining defect:** the stub has no artist images, so the artist card shows a placeholder.

**Regression results:**
- Tests: 553 passed, 4 skipped. That is 23 new tests: 15 preview unit, 6 HTTP preview, 2 scope.
- lint: 0 errors (1 pre-existing warning in the untracked atelier skill script).
- typecheck and build: pass.
- smoke ×3, multi-round, listening 20/20: pass.
- evaluate ×3 (6/6), question wording 4/4, adaptive 2/2, songs 1/1: pass.

**Provider usage:** 0 Qloo, 0 Gemini, 0 YouTube Data API. The S9.14 ledger (18/18 Qloo) was not touched.

## 5. Remaining issues

- No reviewed segments exist, so every live preview is a Quick preview. Approving a moment needs a person to listen (`MUSIC_MOMENT_REVIEW` review mode, non-production).
- No live Gemini preview decision has run; grounded selection is fixture-proven only.
- The native-scrub path was verified via the embed's message channel, not a physical scrub.
- No screen-reader session and no Lighthouse run; axe is not a WCAG claim.
- The listen-mode "now" indicator is static, by design.
- The mock fixtures lack artist → artist data.
