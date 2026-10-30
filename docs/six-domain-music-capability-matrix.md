# S9.14 source-to-music evidence

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
