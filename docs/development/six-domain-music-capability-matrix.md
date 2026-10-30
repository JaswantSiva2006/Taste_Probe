# S9.14 source-to-music evidence

## S9.14R recovery update

The five previously provider-verified sources (movie, music artist, TV show, video game, podcast) are now enabled through the shared registry. Their exact evidence remains `VERIFIED_INSIGHTS` except the historical movie full-E2E record; enablement is no longer mislabelled as five separate live browser acceptances. Five fixture-backed HTTP listening-chain tests additionally cover Gemini selection, track/artist separation, switching, and SavedDiscovery anchor provenance. Books remain disabled.

Book root cause: typed Search succeeds with the genuine novel **Dune (Dune, #1)** (1965), ID `9BA85467-2189-46DC-BB98-4B25EE182A9D`. `/v2/insights?filter.type=urn:entity:artist&signal.interests.entities=9BA85467-2189-46DC-BB98-4B25EE182A9D&take=8&feature.explainability=true` returns HTTP 400: `All of the provided signal.interests.entities were invalid. At least one valid signal or filter is required for entity insights.` This is an upstream signal rejection, not an application schema or encoding error. It establishes rejection of this verified book under this key; it does not prove every book is unsupported.

Recovery production browser: Nils Frahm source, real Qloo/Gemini/Redis, authorized Ólafur Arnalds recording, actual YouTube PLAYING, Pause, track dislike preserving artist, and Another song all passed. Revisions 0–4. The next acceptance assertion failed because the remaining recording correctly used `SINGLE_OPTION` rather than Gemini. The harness stopped, so Save/Finish/Passport and explicit artist feedback were not reached in that live run. No full production-browser pass is claimed.

Combined campaign ledger: 18/18 Qloo calls (six additional: three book diagnosis calls including one search with no exact-name match, and three reserved/executed browser discovery calls), one Gemini request, estimated $0.0006128, zero YouTube Data API calls. No further Qloo requests are authorized by the current allowance.

Public music sources: Movies, Music artists, TV shows, Video games, Podcasts. Books unavailable. Primary Start exploring opens explicit source selection. Generic book-destination exploration remains available through its existing enabled sources.

The matrix below is the original S9.14 checkpoint; this recovery update supersedes its enablement and book-diagnosis columns.

Date: 2026-10-30. All requests used the existing Qloo provider and `https://hackathon.api.qloo.com`, typed `/search`, then `/v2/insights` with `filter.type=urn:entity:artist`, verified source ID, `take=8`, explainability enabled, and one Insights attempt. Persistent campaign ledger: `.artifacts/s9-14/ledger.json`.

| Source | Verified source ID | Artist count | Actual evidence | Public enablement |
|---|---|---:|---|---|
| Movie: Interstellar (2014) | `057DA9D9-399B-437E-8BCA-A80E499125EF` | 8 | Live Search + Insights; earlier stages provide session/playback evidence | Existing enabled |
| Book: Dune | Not retained: the probe failed and did not preserve which request failed | — | `QLOO_BAD_REQUEST`; inconclusive book support | Disabled |
| Artist: Nils Frahm | `0D8EAFA4-CEEA-44D5-8E1F-26A8A9F49A77` | 8 | Live Search + Insights; original artist absent | Disabled pending session/browser acceptance |
| TV: Breaking Bad (2008) | `D03D0913-A7B9-4C46-BFEB-958C1B3FA387` | 8 | Live Search + Insights | Disabled pending session/browser acceptance |
| Game: Celeste (2018) | `FC14952D-5C27-48D8-908A-044ABD07FEAF` | 8 | Live Search + Insights; search wire type `urn:entity:videogame` | Disabled pending session/browser acceptance |
| Podcast: Radiolab | `B4D6B6FD-7146-4E1C-AE48-B8EBD2BB71DA` | 8 | Live Search + Insights | Disabled pending session/browser acceptance |

Every successful Insights result reported `urn:entity:artist`; all eight per row normalized successfully. Exact returned artist IDs are stored in the campaign ledger. No new pair has been labelled FULL_E2E_VERIFIED. Search/Insights evidence does not establish session, song-selection, playback, or browser completion.

Campaign usage for this matrix: 12 Qloo HTTP requests, 0 Gemini, 0 YouTube Search, 0 videos.list, $0 Gemini; remaining Qloo allowance 6/18. The failed book attempt is included. The probe skips already recorded domains and never resets the ledger.

Six-domain objective: PARTIAL. Five provider query paths returned artists; only the existing movie music path remains publicly advertised. Book support and four new full browser journeys remain unresolved.
