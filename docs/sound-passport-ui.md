# Sound Passport experience (S9.13)

Branch `seg/S9-13-sound-passport-experience`, from `92a935a` (S9.12, accepted). Before starting, all baseline gates were green on `92a935a`: lint, typecheck, 510 tests, build, smoke, multi-round, qa, evaluate, adaptive, songs and the listening smoke.

**Method.** The `web-design-atelier` skill was applied in **IN-REPO BUILD + REDESIGN** mode. From it I read `SKILL.md`, `creative-direction.md`, `experience-patterns.md`, `graphic-production.md`, `frontend-craft.md`, `visual-qa.md`, `scorecard.md` and `tools-and-sources.md`. The S9.13 skill was used as the product brief. Backend services were preserved. The only backend addition is a server-authorized "Previous recording" replay (§6).

## 1. Brief

| Item | Decision |
|---|---|
| Audience | Curious listeners who know what films they love but not what music to explore next. Mostly mobile, desktop for longer sessions. |
| Job to be done | "From something I already love, let me *hear* something new in seconds, react naturally, and keep the ones that matter." |
| Promise | *Your taste is the starting point. The world is your playlist.* |
| Primary action | Start exploring, then Begin listening |
| Secondary actions | Love, Not for me, Save, Another song, Different artist, Finish, Open Passport |
| Trust signals | Every name is Qloo's; every recording is a verified YouTube video in YouTube's own player; layers are labelled ("Qloo's artist / Verified recording / you keep"). No invented stats, testimonials or covers. |
| Constraints | Official visible IFrame player; no autoplay; no audio extraction; server-authoritative listening state; existing generic (books) discovery must remain; deadline. |

**Visual thesis:** the experience should feel like a late-night listening room lit by a valve amplifier. The current recording is on the screen; a record turns only when YouTube says it is playing; what you keep goes into a printed record sleeve, your Passport.

## 2. Research and references

These principles come from long familiarity with the products, not from a fresh browsing session. No proprietary assets were consulted or copied.

| Reference | What it teaches | How TasteProbe uses it differently |
|---|---|---|
| Spotify, Now Playing | One dominant Play/Pause, flanking previous/next, and reactions one tap away; transport is never ambiguous. | A larger amber play disc, rewind-10 and replay as distinct icons. **Previous** means a recording *you already heard*, server-authorized; **Next** is explicitly "no rating". No Spotify green. |
| Apple Music, album view | Artwork-led emotion: big title type, generous space, artwork as the hero. | Real artwork is the *YouTube video itself*, so the player is the hero. The title is set large in Instrument Serif. Album covers are never fabricated; the record label carries only verified text. |
| Vinyl/turntable interfaces and record-shop crates | A material signature: grooves, labels, the arm dropping on the record; collections as sleeves in a crate. | An original SVG record with a fixed light sheen and a tonearm that lowers *only on real PLAYING*. The Passport is a crate of sleeves with the record peeking out. |
| Editorial record collections and liner notes | Typographic hierarchy and the "sleeve as document". | The landing hero is a printed Sound Passport sleeve with a track list that *describes the product journey*, plus Film → Music passport stamps for the cultural story. |
| YouTube IFrame / embed policy (S9.9) | A visible player, native controls, branding and ads intact, and no autoplay. | Custom controls sit *outside* the iframe and use only supported API calls (`playVideo`, `pauseVideo`, `seekTo`, `loadVideoById`). |

## 3. Three directions considered

| | A — The Listening Atelier (**selected**) | B — Liner Notes | C — Passport Stamps |
|---|---|---|---|
| Thesis | Dark listening room, valve-amber light, signature record and tonearm | Ivory paper editorial, like the existing book "programme" | Travel passport: stamps and visas per discovery, map-like journey |
| Hero | Printed sleeve with the record drawn out | Typographic poster | Stamped passport spread |
| Strength | The player stays the main event on a dark stage; strong signature; natural for music | Continuity with the book UI | Memorable metaphor |
| Weakness | Risk of generic "dark music app" | Bright paper fights a video player and feels like reading, not listening | Cluttered on mobile; stamps compete with listening controls |
| Verdict | Chosen. Adopts B's typography for the Passport and C's stamps as accents (hero stamps, "From Interstellar" sleeve stamps). | Kept for the generic programme | Folded into A as details |

**Anti-template check.** The amber valve light, record sleeve, passport stamps and three-layer provenance strip ("From → Qloo's artist → Verified recording") are specific to this product and wouldn't fit an unrelated one.

## 4. Visual system (`src/app/sound-passport.css`)

**Colour tokens:**

| Token | Value | Role |
|---|---|---|
| `--sp-night` | `#0c0b0a` | Darkest surface |
| `--sp-deck` | `#151311` | Stage |
| `--sp-panel` | `#1b1815` | Panel |
| `--sp-panel-2` | `#24201c` | Raised panel |
| `--sp-ink` | `#f4ede1` | Primary text |
| `--sp-ink-2` | `#c3b7a5` | Secondary text |
| `--sp-ink-3` | `#978c7c` | Meta text (≥4.5:1 on the deck) |
| `--sp-amber` | `#efaa45` | Accent, with `--sp-amber-hi` `#ffc46b` and `--sp-amber-ink` `#1d1307` |
| `--sp-love` | `#ec6f55` | Love |
| `--sp-line` / `--sp-line-2` | 11% / 22% ink | Rules and borders |

**Other tokens:**
- Radii: 16 and 10 px; pills at 999 px.
- Motion: `--sp-fast` 160 ms and `--sp-med` 260 ms, with ease `cubic-bezier(.2,.7,.2,1)`.
- Shadow: one plausible top-down light (`--sp-shadow`).

**Type:** the existing Instrument Serif (display, titles, record labels) and Instrument Sans (UI), kept deliberately for brand continuity.

| Role | Size |
|---|---|
| Hero | `clamp(3rem, 4.9vw + .9rem, 6.1rem)` |
| Now-playing title | `clamp(2rem, 2.6vw + 1rem, 3.5rem)` |
| Passport title | up to 5.2rem |
| Labels | 0.74rem, 0.16em tracking |

**Controls:**
- Touch targets are ≥44 px: transport 48 px, play 64 px (44/56 px at ≤380 px), reaction pills 48 px.
- Focus: a 3 px `--tp-focus` ring on every control.
- Icons: a new set in the existing 1.5 px round-cap family in `Icons.tsx` (Play, Pause, Rewind10, SkipBack/Forward, Replay, Heart, NotForMe, Stamp, AnotherSong, DifferentArtist, ExternalLink, PassportIcon). No emoji.

## 5. Page compositions

1. **Landing.**
   - **Hero:** eyebrow *TasteProbe / Sound Passport*; *Discover music beyond your world.*; lede *Start with something you love. Hear something you never knew you'd love.*; an honest one-paragraph explanation.
   - **Actions:** **Start exploring** opens the music journey and focuses the film search; **How it works**; **Explore other cultures** jumps to the planner.
   - **Artwork:** the original sleeve, record and stamps.
   - **Below the hero:** three steps (*Start somewhere familiar / Hear something unexpected / Keep what moves you*), then the existing verified **planner**, retitled "Choose your journey". It keeps the books world and all S9.4 selectors.
   - A Passport shortcut appears when the Passport has items.
2. **Source search.** The existing capability-driven chips, Qloo search with disambiguating tickets (year and ID tail), and explicit selection. All S9.4 states are kept.
3. **Discovery transition.** The existing truthful states: "Asking Qloo for music artists…", plus questions when the backend asks them (optional; "Show my way in" skips). There is no fake "thinking" animation.
4. **Listening Stage.** This is a new component, `ListeningStage.tsx`, placed above the existing programme. Its states:
   - **Intro:** an idle record, "Start with *{START HERE artist}*", **Begin listening**, and "Or begin with" chips.
   - **Listening, desktop two-column:**
     - Main column: provenance strip, kicker, large recording title, artist (amber), "via {channel} on YouTube", how the recording was chosen, then the **official player at full column width**, the transport row, reactions, a nonjudgmental follow-up after Not for me, a status line, and the Another song / Different artist tiles.
     - Aside: the record and tonearm, an artist card (Qloo image when available, *Why this artist?*, "More like this artist" / "Not this artist"), the Passport ledger, a "Heard so far" history and **Finish listening**.
   - **Mobile, single column:** identity → player → transport → Love/Not for me/Save → moves → record (subordinate) → artist → ledger.
   - **No recording:** "No verified recording for {artist} yet", with Try the next artist and Search YouTube yourself.
   - **Finished:** "{n} recordings kept from {anchor}", Open your Sound Passport, Keep listening.
5. **Bridge and programme.** "Every artist Qloo found from {anchor}" introduces the unchanged paper programme. It keeps accept, set aside, Listen and keep exploring (S9.7), with questions per round (S9.11).
6. **Sound Passport.** `PassportView.tsx` is reachable from the header at any time ("Sound Passport ·n"). It has:
   - a title, *The sounds you discovered.*, and an honest summary (recordings, artists, starting points, device-only);
   - Continue listening / Start exploring, and Copy as text;
   - a crate of sleeves, each with a YouTube thumbnail, a vinyl edge, a "From {anchor}" stamp, title, artist, channel, save date, Listen on YouTube and Remove;
   - a two-step **Clear Passport…** ("Remove all n?" → Yes / Keep them);
   - an empty state: an idle record, a dashed ghost sleeve, guidance and Start exploring.
7. **Generic discovery.** "Explore other cultures" → Books journey: unchanged and verified by QA.

## 6. Transport-control semantics

| Control | Implementation | Meaning |
|---|---|---|
| Play / Pause / Resume | `PlayerHandle.toggle()` → `loadVideoById` (first play) / `pauseVideo` / `playVideo` | Current recording only |
| Back 10 s | `seekTo(current − 10, true)` | Within the current recording; disabled until playing or paused |
| Replay | `loadVideoById({startSeconds: 0})` | Restart the current recording |
| Previous recording | `POST /api/discovery/listen {artistId, videoId}` (S9.13) | Only a recording **already heard** in this exploration, for an authorized artist, still verified. Recorded as `USER_REPLAY` navigation, not a new encounter. A forged or unheard ID gets 409. Disabled when nothing earlier exists. |
| Next recording | `NEXT` (S9.12) | Neutral, with no rating; labelled "Next recording (no rating)" |
| Another song / Different artist | `ANOTHER_SONG` / `DIFFERENT_ARTIST` | Same Qloo artist / a new Qloo artist |
| Open on YouTube | Link to `watchUrl` | Source attribution |

The YouTube native controls stay available inside the embed. The custom state label (Playing, Paused, Loading…, Unavailable) comes only from the player's real phase.

## 7. Vinyl implementation (`VinylDisc.tsx`)

**Drawing.** An original 400×400 SVG:
- a radial-gradient disc with 46 fine grooves (every third slightly brighter) and 4 darker track gaps;
- a paper label whose colour comes from five label stocks, chosen deterministically from the artist ID (amber, vermilion, ivory, patina, midnight);
- curved Instrument Sans artist name, an italic serif recording title, "TASTEPROBE" / "SOUND PASSPORT · 33⅓", and a spindle hole.

Label text is verified text only: the Qloo artist and the YouTube title.

**Light.** A conic "sheen" overlay sits **outside** the rotating element, so the reflection stays fixed while the record turns, as on a real platter.

**Tonearm.** An SVG arm that lowers onto the record only in `playing` / `paused` (700 ms transform) and lifts otherwise.

**Rotation.** A CSS keyframe at 33⅓ rpm (1.8 s per turn) with `animation-play-state`, so React never re-renders per frame.

| State | Behaviour |
|---|---|
| `playing` | Running |
| `paused` | Held at the exact angle (QA verified the identical transform 900 ms apart) |
| `idle` / `buffering` / `failed` | `animation: none` |
| `failed` | Also desaturated |
| Reduced motion | No animation at all (QA verified `animation-name: none` while playing) |

**Source of state.** The stage maps `YouTubePlayer`'s `onPhase` (from IFrame `onStateChange` / `onReady` / `onError`) to these states. A Play click alone never starts the spin.

**Video switch.** The player and record are keyed by `videoId`; the label fades in.

## 8. Feedback UX

| Action | Behaviour |
|---|---|
| Love | The heart fills with a 420 ms pop. *"Loved. Remembered for this recording only."* is shown only after the server commits. |
| More like this artist | *"Noted: more like {artist}. That steers which artists come next."* |
| Not for me | The button shows pressed. A follow-up panel offers *"Not this one — no problem. That's about this recording only, not {artist}."* with **Another {artist} song**, **A different artist**, or **Not sure — just keep going** (NEXT). |
| Save | A distinctive amber pill. The stamp icon animates, *"Stamped into your Sound Passport."* appears, the header count updates, and the pill becomes "In your Passport" (disabled, so no duplicate). |
| Next / Another / Different | No negative copy. The new title rises in, and focus stays in the stage. |
| Finish | Always available in the aside, and works with zero saves (*"Nothing was saved, and that's fine…"*). |

All confirmations live in a polite live region. Errors use the existing error banner with a manual "Try again" (no auto-retry).

## 9. Sound Passport storage (`src/lib/ui/passport-store.ts`)

**What is stored.**
- Key: `localStorage["tasteprobe.passport.v1"]`, holding `{ v: 1, items: SavedDiscovery[] }`, the exact S9.12 canonical record.
- **Only server-confirmed saves** enter it: the app merges `view.listening.saved` after each committed response.
- No tokens, credentials, model context or personal data.

**How it is read and protected.**
- Every read re-validates with `SavedDiscoverySchema`. Corrupt JSON, wrong versions, forged URLs and invalid IDs are dropped.
- Records are deduplicated by `videoId`, sorted newest first, and capped at 200.
- Storage unavailable or full falls back to an in-tab copy, with an honest warning shown in the Passport.
- Multiple tabs stay in sync through the `storage` event, and the store is read through `useSyncExternalStore`.

**Retention.** Titles and channels from the YouTube Data API are hidden 30 days after saving; the reference still opens. Reviewed-registry titles remain.

**Thumbnails.** These are YouTube's own `i.ytimg.com/vi/{id}/mqdefault.jpg`, unmodified, labelled "YouTube video", and linked to the video. They are never presented as album art.

## 10. Accessibility

**Automated.** axe-core 4.14.0 (WCAG 2.0/2.1/2.2 A/AA tags) found **0 serious or critical** issues on:
- landing (1440);
- stage intro (1440) and stage ready (1440, 768, 1024);
- stage playing (375, 320);
- Passport with items (1440, 375, 320) and the empty Passport (1440).

The existing mock QA's axe runs are also clean.

**One defect found and fixed.** `label-content-name-mismatch` on the sleeve thumbnail links. The link name now comes from the image alt, "YouTube video thumbnail: {title} by {artist}".

**Semantics and focus:**
- Landmarks, one `h1` per screen, sections labelled by their headings, and controls grouped with `role="group"` and labels ("Playback", "Your reaction to …", "Where next").
- `aria-pressed` on Love, Not for me and Save; transport buttons have explicit names ("Back 10 seconds", "Previous recording: {title}", "Next recording (no rating)").
- Focus moves to the stage title on results and after each listening action, and to the Passport title when it opens.
- Status is announced through live regions.

**Motion.** Reduced motion turns off record rotation, label fades, rises and icon pops.

**Not claimed.** No screen-reader session was run, so this is not a WCAG certification.

## 11. YouTube compliance

- One official IFrame player at a time. It is keyed per recording and destroyed when you leave the stage (opening the Passport unmounts it, so nothing plays hidden).
- The player is never overlaid, cropped or hidden while playing; the record is beside it, never on top.
- Native controls, branding and ads are intact.
- There is no autoplay: recordings are only cued, and QA verified `ready` before the user presses Play.
- The source is always shown ("via {channel} on YouTube", "Open on YouTube").
- No audio extraction, and thumbnails are unmodified.

## 12. Visual QA

The harness is `npm run qa:passport` (`scripts/ui-qa-passport.mjs`). It runs the **real app** (`next dev`) in live-shaped mode:
- Qloo is a local **HTTPS stub** (`scripts/lib/qloo-stub.mjs`) serving the genuine identities recorded in S9.8. The app still requires an HTTPS Qloo URL; a throwaway self-signed certificate is trusted only by the QA child process.
- `LLM_PROVIDER=none`, a memory session store, and no YouTube key, so recordings come from the reviewed registry.
- The real YouTube player runs on Edge.
- **No Qloo or Gemini budget is spent.**

Screenshots are in `.artifacts/passport/` (git-ignored) and were inspected:
- **1440:** landing (fold and full), source selected, stage intro, ready, playing, paused, loved, not-for-me, another song, saved, different artist, no-recording, finished, Passport (fold and full), clear confirmation, empty Passport.
- **375 and 320:** landing (fold and full), stage intro, stage playing (fold and full), Passport.
- **768 and 1024:** landing and stage.

### Critique pass 1 (first render)

| Severity | Defect | Fix |
|---|---|---|
| Major | 320 px: the transport row wrapped, leaving Next alone on a second line | 44/56 px controls and tighter gaps at ≤380 px |
| Major | Landing sleeve: "Verified recordings to hear" overflowed the sleeve, and the stamps collided with the track list | Track list capped at 78%, stamps moved to the top corner |
| Major | Stage: the selection sentence sat under "Why this artist?" and read as its answer | Moved under the recording identity ("how this recording was chosen") |
| Major | Artist-intent links wrapped with a dangling "·" | Two chips: "More like this artist" / "Not this artist" |
| Serious (a11y) | Sleeve link label didn't match its visible text | Name from the image alt |
| Polish | Hero headline orphaned "beyond" on its own line | Wider copy column; title max 6.1rem |
| Polish | Sleeve record invisible (dark on dark) | Lighter grooves, rim and more peek |
| Polish | The paper programme under the stage looked greyed | It was its unfold animation mid-frame; the QA now waits. Also added the bridge heading so stage and programme read as one page. |

### Critique pass 2 (re-rendered)

| Severity | Defect | Status |
|---|---|---|
| Polish | Landing sleeve line "Verified recordings to / hear" wrapped | Fixed by shortening the copy |
| Mock QA overflow | At 375 the intro record's tonearm reached past the viewport | Fixed: tonearm wrappers reserve 13% on the right |

Other screens in pass 2: the 375 stage, finished card, empty Passport and the Passport crate all showed **no further blocker or major defects**. Remaining polish items are listed in §14.

### Scorecard (evidence: the screenshots above, axe and the QA checks)

| Dimension | Score | Strongest remaining issue |
|---|---:|---|
| Originality and brand fit | 17/20 | The dark-player genre is familiar; distinctiveness rests on the sleeve, stamps and tonearm |
| Hierarchy and composition | 16/20 | At 1440×900 the follow-up panel and move tiles fall below the fold |
| Graphic and art direction | 12/15 | Artist imagery depends on Qloo images (absent in the QA stub, so placeholders show) |
| UX clarity and states | 13/15 | Two artist-intent chips may still be read as track-level by some users |
| Responsive | 9/10 | The 320 provenance strip truncates names (by design) |
| Accessibility | 8/10 | No screen-reader session |
| Performance | 4/5 | Lighthouse not run; no images on landing, and one iframe |
| Microdetail | 4/5 | The empty-Passport ghost sleeve alignment could be tighter |
| **Total** | **83/100** | Heuristic, not a measurement |

## 13. Test results

| Gate | Result |
|---|---|
| `lint` | 0 errors (1 pre-existing warning in the untracked skill) |
| `typecheck` | pass |
| `test` | **515 passed**, 4 skipped. New: Passport parsing (4) and Previous replay over HTTP (1). |
| `build` | pass |
| `smoke` / `smoke:multi-round` | pass |
| `qa` (mock) | 17/17 + 16/16, 0 problems |
| `evaluate` / question wording / `evaluate:adaptive` / `evaluate:songs` | 6/6, 4/4, 2/2, 1/1 |
| `smoke:listening` | 8/8 |
| **`qa:passport`** | **43/43** |

The `qa:passport` checks cover:
- landing with no autoplay, and Start exploring → film anchor;
- results focused on the stage, with the programme still present;
- ready with no autoplay; Play → PLAYING with the record turning; Pause → PAUSED with the record held;
- rewind 10 s; replay; Love; Not for me with the follow-up; another song (same artist);
- Previous (server replay); Next (neutral); Save with the count updated and no duplicate;
- different artist; unmapped artist reported truthfully; Finish;
- Passport with 2 exact items, holding canonical records only, persisting across reload;
- remove; clear → empty → Start exploring;
- no console errors; the books journey still offered;
- the player ≥200×200 inside the viewport at 375 and 320;
- axe and overflow at all widths; reduced motion stops the record.

No live Qloo or Gemini calls were made in S9.13.

## 14. Remaining defects and limitations

- The header chip reads "Live · Qloo + Gemini" from the provider mode alone; in the QA harness (`LLM_PROVIDER=none`) that overstates Gemini. In production it's accurate.
- At 1440×900 the Not-for-me follow-up appears just below the fold. It's announced in the live region, but users may need to scroll.
- Artist portraits rely on Qloo `imageUrl`, which the stub doesn't provide, so the captioned placeholder shows in QA.
- The tonearm and record are decorative; at 320 px the provenance strip shows only two of its three steps.
- No screen-reader session and no Lighthouse run.
- The old S9.9 `qa:music` script targets the superseded preview UI; `qa:passport` and `qa:listening` replace it.
- Session TTL is still 30 minutes (S9.12 limitation); the Passport survives expiry because it's local.

## 15. S9.14 live verification needs

1. Production build against **real** Qloo, Gemini, Upstash and YouTube: run `qa:listening` (≤4 Qloo, ≤5 Gemini) on the new stage UI, and update its selectors ("Begin listening", "Save to Passport", "Finish listening").
2. Run `qa:passport`-equivalent checks against the **deployed URL** in a private window: reload persistence, the storage-blocked path and cross-tab sync.
3. Confirm the header mode chip and footer copy in production.
4. Do a screen-reader pass (NVDA/VoiceOver) on the stage and the Passport, plus keyboard-only playback through Previous / Rewind / Next.
5. Re-run `npm run verify:mappings` within 30 days of the demo, and approve at least a few featured moments if desired.
