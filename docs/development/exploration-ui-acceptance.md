# Exploration UI acceptance (S9.4)

Baseline: S9.3 commit `6aeb539`, on the branch `seg/S9-4-universal-ui`.
Positioning: TasteProbe, an agentic cultural exploration companion. Tagline: "Your gateway to something new." Hero: "Love something? Discover what comes next."

## 1. Implemented journey

| Screen | What happens | Contract used |
|---|---|---|
| **1 · Exploration goal** | Shows the hero, then the question "What would you like to explore?". Each enabled destination is a placard such as "Books — Start from a movie or a music artist". | `GET /api/health` → `capabilities.pairs` |
| **2 · Familiar anchor** | Asks "What do you already love?". The source chips are filtered to the chosen destination. Search runs with `type=<source>`, and results are shown as tickets with domain, year, provenance and ID tail. The user must make an explicit selection. "Begin with …" stays disabled until a valid, server-published pair and a selected entity exist. | `GET /api/entities/search`, `POST /api/discovery/start` (`sourceType`, `targetType`, `selectedEntityId`) |
| **3 · Discovery** | A strip reads "From movie to books / Interstellar". Below it come the existing Intertitle question card and answer controls, the taste notes, and the grounded candidate list with FLIP reordering and movement badges. Notices appear only when the order or the results really changed. "Show my way in" finishes the session. | `POST /api/discovery/answer`, `POST /api/discovery/finish` |
| **4 · Your way in** | A paper programme titled "From *Interstellar* into music artists.". START HERE is a large framed card with "Why this starting point?" (the backend text, verbatim) and an "I'll try this" button that records intention only. Below it, "Where to go next" lists EXPLORE NEXT and ANOTHER DIRECTION (each only if returned, each with its own "Why this?"), followed by "Other good starting points", "What you told us", **Explore another world** and **Try another {source}**. | `discoveryPath`, rendered from the response without re-ranking |

**Early finish.** When the backend returns `finishReason: "insufficient_question_evidence"`, the start response is already finished, so the app goes straight to the finale. It never shows a question, and its subtitle says none was asked.

**Agent progress.** No agent steps are simulated. Every loading label corresponds to a real request in flight.

## 2. Dynamic capability handling

- `src/lib/ui/domains.ts`:
  - `targetChoices` lists the distinct targets.
  - `sourceChoices(target)` lists the sources allowed for one target.
  - `isOfferedPair` gates the start button.
- All three read **only** the server projection. The UI has no hard-coded pair list or 6×6 matrix.
- Cosmetic per-domain data (glyph and art shape) has a neutral fallback, so a newly enabled domain renders without code changes; a unit test covers this.
- **When a destination has only one source**, that domain is pre-chosen (Music artists → a movie). Entities are never pre-selected.
- **Loading** shows a status line.
- **Failure** shows nothing selectable, an explanation and a **Try again** button.
- **An older server without capabilities** offers nothing; it never guesses.
- **Disabled pairs** are never rendered. The server still rejects them (`UNSUPPORTED_DOMAIN`), and the browser QA checks this directly.

Public pairs served at QA time (`/api/health`):

| Source | Target |
|---|---|
| movie | book |
| movie | music_artist |
| music_artist | book |

## 3. Design direction and component changes

Three directions were considered:

- **Intertitle, extended (selected).** It keeps the established cinematic identity.
- **Departures board.** Worlds shown as destinations; it fits the metaphor but would discard the existing system.
- **Card catalogue.** Too book-specific for music artists.

The visual thesis: the projector of something you love throws light onto a new world.

- **Hero art** (`ProjectorArt.tsx`). The beam now lights book spines *and* a record sleeve with its disc, so the hero no longer says "film → books" only.
- **World placards and source chips** are native radios: keyboard-operable, with visible focus rings, and a "Chosen ✓" label so selection never relies on colour alone. Below 560px the placards collapse into compact rows, so every world fits in the first view.
- **`EntityArt.tsx`** replaces `BookCover.tsx`.
  - Artwork frames follow the domain: portrait for books, films and shows; square for artists, games and podcasts.
  - The fallback is an original typeset board. For artists it is a cloth sleeve with a vinyl disc.
  - It is always captioned "No image from Qloo" (books: "No cover from Qloo").
  - Alt text never claims more than is known: "Cover of …" for books, "Image for … from Qloo" for everything else.
- **`ResultShelf.tsx`** replaces `BookShelf.tsx` and provides `ResultCard` for any domain. It shows only the fields Qloo supplied.
- **CSS.** `tp-book` was renamed to `tp-card` and `tp-cover` to `tp-art`. New styles were added for the onboarding steps, placards, chips, square art, START HERE, the "Why" disclosures and the path.
- **Copy.** "Screening" and "shelf" wording became exploration and target-noun copy (`domainLabel`). Error messages name the user's actual choices, for example "No books for this music artist".

## 4. Backend changes (each forced by an integration defect or by testability)

1. **`src/lib/discovery/service.ts`, mock agent path (`runAgent`).**
   - *Defect.* An anchor with a single verified result looped `retrieve` until the per-turn tool budget threw `AGENT_DECISION_INVALID` (HTTP 500). The browser QA found this.
   - *Fix.* After one retrieval in a turn, `minCandidates` is 1, matching the live path. The result is a truthful `insufficient_question_evidence` finish.
   - *Coverage.* A regression route test was added.
   - *Unchanged.* The live engine, the Gemini agent, the optimizer, the capability rules, sessions and budgets.
2. **`src/lib/qloo/fixtures.ts`.** Synthetic, mock-only data was added:
   - music-artist anchors, including an ambiguous pair: Glass Harbor and Glass Harbor Ensemble;
   - artist results for the movie anchor;
   - books for the artist anchors;
   - a one-result anchor (Lone Signal) for the early-finish case.

   These make all three enabled journeys runnable offline over the real routes. They are labelled synthetic everywhere and never reach live mode.

## 5. Browser E2E (Playwright 1.64.1, Chromium, mock dev server, real HTTP routes)

`npm run qa:ui` (`scripts/ui-qa.mjs`) was run against `next dev` with `QLOO_MODE=mock`. **Final run: 15/15 journey checks passed, with 0 hygiene problems** (no horizontal overflow, no broken images, no console errors, no targets under 24px). The reduced-motion run at 375 passed 11/11 checks with 0 problems.

| Case | Widths | Result |
|---|---|---|
| **movie → book**, full path: capabilities match `/api/health` → keyboard choice of destination → sources = {movie, music artist} → search sends `type=movie` → ambiguous results with nothing auto-selected and Begin disabled → keyboard selection → start body carries the selected ID and pair → question focused → Tab reaches the first answer with a solid focus ring → "like" posted → change notice shown only if the order changed → induced network failure → **Try again** re-sends the same answer → finish → one START HERE matching the backend lead, roles exactly as returned, every final result shown once, no external links → **Why this starting point?** shows the backend text verbatim → **I'll try this** toggles → **Explore another world** resets and refocuses the destination picker | 320, 375, 768, 1024, 1440 | PASS |
| **music_artist → book**: ambiguous "Glass Harbor" requires an explicit choice; search sends `type=music_artist`; dislike; finish; **Try another music artist** keeps the world | 375, 1440 | PASS |
| **movie → music_artist**: only "a movie" offered, pre-chosen; artist wording ("Do you enjoy music artists associated with …?"); only square art, never book frames; like; finish; the finale contains no book copy | 375, 1440 | PASS |
| **Early finish** (Lone Signal): no question; `insufficient_question_evidence`; START HERE only; no padded sections | 375, 1440 | PASS |
| **Capability load failure** (health returns 500): no worlds rendered; error shown; **Try again** recovers | 375 | PASS |
| **HTTP 429 on search**: "Too many requests"; exactly one request after 1.5s, so no auto-retry | 375 | PASS |
| **Stale revision (409)**: "This exploration moved on"; no Try again offered; **Start again** returns to the anchor step | 1440 | PASS |
| **Server rejects pairs the UI never offers** (`music_artist→music_artist`, `movie→podcast`) | n/a | 400 `UNSUPPORTED_DOMAIN` |

**Screenshots** are in `.artifacts/ui/` (git-ignored, regenerated by `npm run qa:ui`):

- `{320,375,768,1024,1440}-01-landing-fold`, `-01-landing-full`, `-02-anchor-step`, `-03-selected`, `-04-question-1`, `-04b-keyboard-focus`, `-05-after-answer`, `-06-error`, `-07-way-in`, `-07-way-in-fold`
- `{375,1440}-10-artist-selected`, `-11-artist-question`, `-12-artists-question`, `-13-artists-way-in`, `-14-early-finish`
- `375-20-capabilities-error`, `375-21-rate-limited`, `1440-22-session-conflict`
- reduced-motion set in `.artifacts/ui-reduced/`

**Visual QA passes** (screenshots opened and inspected):

1. Mobile placards were about 150px tall each, pushing the second world below the fold. Fixed with the compact rows.
2. Two problems in the anchor step:
   - the step-2 `<legend>` cut the fieldset's top border into a stray rule; fixed with a box-shadow rule and a floated legend;
   - mock mode said "real books from Qloo"; the hint is now mode-aware.
3. On the finale:
   - at 375, START HERE squeezed its text beside the large artwork; it now stacks;
   - "Then" was renamed "Where to go next";
   - small vinyl fallbacks hid their title under the disc; the disc now only peeks.
4. Pass 3 caused a 320/375 overflow: the floated legend's `clear` missed the worlds grid. Fixed and re-verified at all widths.

## 6. Accessibility

Verified by the automated browser checks:

- Native radio groups inside `fieldset`/`legend` for both pickers, keyboard-selectable with Space.
- Selection shown as text ("Chosen ✓", "Selected"), never by colour alone.
- Search results are `aria-pressed` buttons, and an `aria-live` results region.
- Focus moves to the question, to the programme title and, on restart, to the destination picker; it also moves to the error alert.
- Visible 3px focus rings, including on visually hidden radios via `:has(:focus-visible)`.
- Reduced motion is honoured.
- `<details>`/`<summary>` disclosures with 44px targets.
- One `h1` per screen.
- Status and alert roles for loading, capability errors and API errors.

Contrast uses the existing audited tokens (5.0:1 to 15.5:1). **No axe audit, Lighthouse run or screen-reader session was performed**, so no WCAG compliance is claimed.

## 7. Error recovery

| Situation | Behaviour |
|---|---|
| Capabilities unavailable | Nothing to choose; **Try again** |
| Search failure or timeout | **Try again**, resubmitted only by the user |
| No matches | "No books matched …" with guidance |
| Ambiguous names | All matches listed; explicit choice required |
| Unsupported pair | Never offered; if the server refuses one, "That combination isn't available yet" (edit) |
| Empty recommendations | "No {targets} for this {anchor}" (edit) |
| Gemini fallback | The credit line says the optimizer chose the question and Gemini was not used |
| Insufficient question evidence | Goes straight to the finale and says so |
| Session expiry or stale revision | **Start again**, with no blind retry |
| 429 | Message and manual retry only; no retry loop |
| Network loss / failed answer | **Try again** re-sends the same answer |

No stack traces or infrastructure details are shown; only a short request reference.

## 8. Known limitations

- Browser E2E ran on the **mock** server only. In S9.4 no live Qloo or Gemini session was driven through the new UI (**0 live calls**), so live imagery, live artist search and live latency in this UI are unverified.
- Artist→book and movie→artist were browser-tested at 375 and 1440, not at all five widths. Movie→book covered all five.
- "I'll try this" is not persisted, by design, because no backend endpoint exists; the UI says so.
- The dev-only Next.js indicator ("N") appears in screenshots; it is absent from production builds.
- `tp-programme` keeps its historical class name.
- Lint has 1 pre-existing warning in the untracked `web-design-atelier` skill script.

## 9. S9.5 integration and verification requirements

1. Run the new UI once against **live** mode for each enabled pair (`npm run dev` with live keys, or the production build), with about 3 Qloo and 2 Gemini calls per journey. Check real cover and portrait images in both frames, real ambiguous artist names, and the Gemini credit line.
2. Add an axe pass plus Lighthouse, and a short screen-reader walkthrough (NVDA/VoiceOver) of onboarding and the finale.
3. When S9.5 enables more pairs (e.g. movie → TV shows), confirm they appear automatically. TV shows use the portrait frame and the screen glyph; games and podcasts use the square frame. No UI change should be needed.
4. Re-run `npm run qa:ui` after any copy or CSS change; it is the regression gate for all three journeys.
