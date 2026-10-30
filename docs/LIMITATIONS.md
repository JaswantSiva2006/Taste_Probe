# Known limitations

- **No audio understanding.** No audio or video is analysed. Gemini reasons over text: names, titles, Qloo tags and the listener's reactions. The ranking's "musical" term receives no data in production.
- **Recording coverage is finite.** Some Qloo artists have no recording that passes verification, or exceed the YouTube search budget for an exploration. TasteProbe then says it could not verify a recording and offers a YouTube search link. That never means the artist has no music.
- **Attribution from metadata.** Label uploads are attributed from their title or description credits. A mislabelled third-party upload can occasionally pass. Topic, VEVO and own-channel recordings are always preferred, and covers, edits and clips are filtered out. Namesakes are separated only when another artist from the Qloo context is also credited; otherwise they stay unresolved.
- **Credit roles are not distinguished.** A composer credit and a singer credit both count as attribution.
- **Featured previews are inactive.** They need human-approved annotated segments, and none exist yet. Every preview is a 30-second "Quick preview" chosen by timing; it makes no claim about the music.
- **Sources.** Five starting domains are offered. Movie → music has full end-to-end evidence; TV show, video game, podcast and music artist → music are verified at the Qloo Insights level. Book sources are disabled.
- **Budgets bound the experience.** Each exploration has caps on Qloo walk calls (15), Gemini requests (30) and YouTube searches (configurable). When they are spent, TasteProbe keeps working deterministically from what it already has.
- **Evaluation scope.** The offline evaluations and benchmarks measure mechanics (coverage, repetition, cluster reach) on fixtures and synthetic graphs. No user study has been run.
- **Session lifetime.** Explorations expire after 30 minutes. The Sound Passport survives on the same browser and device only, and is not synced.
- **Gemini knowledge.** Scouted artist names and the affinity ordering rely on the model's general knowledge of artists. Only Qloo-identified artists are ever used.
- **Rate limits.** Per-IP limits apply in production, so shared networks share a budget.
- **Daily Mix and Taste Report** are not implemented.
