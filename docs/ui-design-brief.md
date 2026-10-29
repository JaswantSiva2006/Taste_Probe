# TasteProbe UI design brief (S8)

**Audience / primary action:** curious readers, film lovers and students. Job: turn one film they love into a few
books they'll want, in under a minute, with no instructions. Primary action: type a film, pick the right one,
answer up to three questions, leave with up to five books.

**Promise:** Start with something you love. Discover something you didn't know you'd love.

## Three directions considered

| | A. Intertitle (selected) | B. Card Catalogue | C. Double Feature |
| --- | --- | --- | --- |
| Thesis | A silent-film screening room where your film is projected onto a bookshelf, because TasteProbe literally carries taste from cinema to books. | A library card catalogue with index cards and "see also" threads, because discovery feels like browsing drawers. | A split cinema poster with film on the left and bookplate on the right, because it is a crossover of two media. |
| Hero | Projector beam leaving a film frame and landing on a shelf of spines; big serif headline. | Open catalogue drawer, typewritten cards. | Poster halves, marquee type. |
| Type | Instrument Serif (display, italic voice) + Instrument Sans (UI). | Typewriter mono + book serif. | Condensed grotesk + serif. |
| Palette | Warm screening-room black, projector amber, paper cream. | Manila, oak, faded ink blue. | Two-colour poster (red/teal). |
| Signature | Questions shown as silent-film **intertitle cards** revealed with an iris wipe. | Stamped index cards. | Split screen that "merges" at the end. |
| Trade-offs | Dark stage needs careful contrast; strongest narrative fit. | Pleasant but reads as "library app", with less cinema. | Loud; poor fit for long book metadata on mobile. |

**Selected: A, Intertitle.** It is the only direction that tells the product's actual story (film → light → books)
and gives the most important moment, the adaptive question, a memorable form that belongs to TasteProbe alone.
Anti-template check: projector-to-shelf, intertitles and a programme-style finale could not be repurposed for an
unrelated product.

## Composition

```
Landing (desktop)                         Discovery workspace (desktop)
┌───────────────────────────────────┐     ┌──────────────────────────────────────────┐
│ TasteProbe            mock/live   │     │ Now screening: Interstellar   ●●○ 2 of 3   │
│                                   │     ├──────────────────┬───────────────────────┤
│  Start with a film   [projector ▸ │     │  INTERTITLE      │  Your shelf  (5–8)    │
│  you love.            beam ▸ book │     │  question card   │  ┌──┐┌──┐┌──┐┌──┐     │
│  Leave with books…    spines]     │     │  [answers]       │  │  ││  ││  ││  │     │
│  [ Now showing: ______ ] [Search] │     │  taste notes     │  update notice        │
│  1 film · 3 questions · 5 books   │     │  finish early    │                       │
└───────────────────────────────────┘     └──────────────────┴───────────────────────┘
Mobile: one column. Seed strip, then intertitle and answers, then shelf as a vertical list of book rows.
Finale: "The Programme": a playbill with the top pick featured, picks 2–5 listed, taste notes, start again.
```

## Tokens

| Role | Token | Value |
| --- | --- | --- |
| Canvas (screening room) | `--tp-canvas` | `#14110e` |
| Raised stage | `--tp-stage` | `#1d1915` |
| Ink on dark | `--tp-ink` | `#f2e8d6` (15.5:1 on canvas) |
| Muted ink | `--tp-ink-muted` | `#b9ac97` (8.4:1 on canvas, 7.8:1 on stage) |
| Paper (book / programme) | `--tp-paper` | `#f4ecdd` |
| Ink on paper | `--tp-paper-ink` | `#1f1a14` (14.7:1) |
| Muted ink on paper | `--tp-paper-muted` | `#6b5f50` (5.3:1) |
| Projector amber (accent / CTA) | `--tp-amber` | `#e9a43b` (8.8:1 on canvas; CTA text uses canvas colour, 8.8:1) |
| Deep amber on paper | `--tp-amber-deep` | `#8a5a12` (5.0:1) |
| Rule / hairline | `--tp-rule` | `rgba(242,232,214,.16)` |
| Positive / negative notes | `--tp-like` / `--tp-dislike` | `#9cc6a0` (9.9:1) / `#e59a8a` (8.4:1) |
| Focus | `--tp-focus` | `#ffd27a` (13.2:1), 3px ring + offset |

Ratios were computed with the WCAG relative-luminance formula for these exact hex pairs.

- **Type:** Instrument Serif 400 (+ italic) for display, titles and intertitles. Instrument Sans (variable 400–700) for UI and body.
  Fluid scale: display `clamp(2.6rem, 6vw + 1rem, 6.25rem)`, h2 `clamp(1.6rem, 2.4vw + 1rem, 2.6rem)`, body 1.0625rem/1.55, small .8125rem.
- **Spacing:** 4px base; steps 8, 12, 16, 24, 32, 48, 72, 112. Container 76rem; gutters `clamp(16px, 4vw, 48px)`.
- **Radii:** 4px (books and cards are physical objects), 999px only for chips. Elevation means printed objects
  casting a warm shadow onto the dark stage (`0 18px 40px -18px rgba(0,0,0,.7)`). No glass, no glow borders.
- **Icons:** a small original stroke set (1.5px, round caps): arrow, reel, sparkle-free check/cross, refresh.
  No emoji.
- **Motion:** `--tp-fast 160ms`, `--tp-med 320ms`, `--tp-slow 640ms`; ease `cubic-bezier(.2,.7,.2,1)`.
  Two motifs only: (1) iris-in reveal for each new intertitle, (2) FLIP reordering of books, with "new arrival" fades.
  Under `prefers-reduced-motion`, both become instant or opacity-only.

## Graphic system

- **Signature:** an original SVG projector scene. A film frame with sprockets on the left casts an amber beam that widens
  across the composition and lands on a row of book spines. Dust motes are static; there is no looping animation.
- **Intertitle frame:** a double hairline border with corner ornaments, drawn in CSS/SVG, cream serif on black.
- **Book covers:** real Qloo `properties.image.url` artwork when present, at a fixed 2:3 ratio with `object-fit: cover`.
  When it is missing, an original cloth-bound fallback: a coloured board derived from the ID, typeset title, and an
  explicit "No cover from Qloo" caption. It never imitates a publisher cover.
- **Reels:** three film-reel pips mark question progress.

## Asset register

| Asset | Location | Origin | License | Fallback |
| --- | --- | --- | --- | --- |
| Projector-to-shelf scene | `src/components/ProjectorArt.tsx` (inline SVG) | original, S8 | original | decorative; the headline carries the meaning |
| Reel/shelf/arrow icon set | `src/components/Icons.tsx` | original, S8 | original | text labels on every control |
| App icon (film reel) | `src/app/icon.svg` | original, S8 | original | — |
| Cloth-board "no cover" fallback | `src/components/BookCover.tsx` + CSS | original, procedural | original | captioned "No cover from Qloo" |
| Book cover art | runtime `properties.image.url` from Qloo | Qloo / publishers | displayed as returned, not stored | cloth board on missing or failed image |
| Instrument Serif, Instrument Sans | `next/font/google` (self-hosted at build) | Google Fonts | SIL OFL 1.1 | serif/sans system stacks |

No stock photography or image generation was used.

## Interaction principles

1. Every loading label names the real activity ("Asking Qloo for books…"), with no simulated steps.
2. Truthful labels: the update notice states *Fresh picks from Qloo* only for `QLOO_RERETRIEVAL`, *Reordered by
   your answer* for `LOCAL_RERANK`, and *Your shelf held steady* for `UNCHANGED`. The question caption credits Gemini
   only when `agent.mode === "LIVE_GEMINI"`.
3. Affinity is never shown as a probability of liking. The UI shows rank movement, not scores.
4. Ambiguous film titles are never auto-selected: the user always picks a result.
5. Errors are human-readable, each with one recovery action (retry, or start a new screening).
6. Entity comparisons show the prompt as the heading, with both books named in a labelled A/B panel. The full approved
   sentence is kept for screen readers.
7. Display-only cleanups never add content. They hide format/audience labels (Audiobook, Adult, Fiction) from taste
   tags and strip Goodreads catalogue boilerplate ("Librarian's note: an alternate cover edition…") from the start of
   descriptions.

## Visual QA log (rendered, not assumed)

`npm run qa:ui -- --url <mock dev server>` drives the real flow in Chromium at 320/375/768/1024/1440. It covers:
landing, search results, keyboard selection, question, answer, an induced network error with retry, the
programme and restart. A visual-only scenario adds entity comparisons, long series titles and real/failed cover
images. Screenshots go to `.artifacts/ui/` (git-ignored).

| Iteration | Defects found (screenshot evidence) | Fix |
| --- | --- | --- |
| 1 | Hard-edged light rectangle behind the shelf art (1440). Art undersized and the film still read as an "image placeholder". Rank numerals floated below covers. Answers touched the intertitle. "Question 1 · of 3". "5 books from Qloo" claimed in mock mode. A partial-width rule in the programme. On mobile, the shelf consequence was below the fold. | Redrew the art (two-reel projector, planet-rise still, the beam lights the spines). Covers hug the rank tab. Intertitle gap. Copy fixes. Mode-aware, truthful programme subtitle and footer. Full-width double rule. Added a mobile "see how your shelf changed" link. |
| 2 | 1024: the two-column shelf was cramped (3-line titles, tag pills breaking). 320: the jump link had no padding. The rank tab covered the "No cover from Qloo" caption. Hard beam edge. | Two-up shelf only at ≥1280. `nowrap` pills. Padded jump link. Caption clearance. Beam fades out. |
| 3 | Entity question: the approved wording carries two full series titles and grew to 8 lines. Small fallback covers clipped titles. | Prompt as heading with the A/B panel (full text for screen readers). 3-line clamp on small boards. |
| Live (1 bounded run) | Real covers and metadata render correctly. Format tags and Goodreads boilerplate added noise. | Display-only tag filter and boilerplate stripping. |

Hygiene on the final run: 0 horizontal overflow, 0 broken images, 0 console errors and 0 sub-24px targets across all
states and widths. Keyboard: Enter submits search, Space selects a film, focus moves to each new question and to the
programme title, Tab reaches the answers with a visible ring, and restart returns focus to the search box. Reduced
motion: the flow passes with `prefers-reduced-motion: reduce` (iris and FLIP disabled).

## Scorecard (evidence-based design review, not an objective measurement)

| Dimension | Score | Evidence / strongest remaining defect |
| --- | ---: | --- |
| Contextual originality | 18/20 | Projector-to-shelf, intertitle questions and the programme finale are specific to film→books. Remaining: the "how it works" band is conventional. |
| Hierarchy & composition | 17/20 | Clear first fold. The question is the hero of the workspace. The paper finale contrasts with it. Remaining: a large empty area under the taste notes on desktop. |
| Graphic quality | 13/15 | Original SVG scene and real Qloo covers in true 2:3 frames. Remaining: the art is illustrative, not richly textured. |
| UX clarity & states | 14/15 | Truthful update and agent labels, errors with recovery, an ambiguity guard. Remaining: no undo of an answer, since the API has none. |
| Responsive | 9/10 | Five widths verified, with no overflow. Remaining: live covers at 375 were captured blank in the resize-based live pass (not reproduced offline). |
| Accessibility | 8/10 | Labels, landmarks, live regions, focus management, contrast computed. Not audited with axe or a screen reader. |
| Performance | 4/5 | No new runtime dependencies, CSS-only motion and self-hosted fonts. Lighthouse not run. |
| Microdetail | 5/5 | Consistent tokens, icons and states; the finale is fully designed. |
| **Total** | **88/100** | |
