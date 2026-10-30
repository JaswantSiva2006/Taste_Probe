# S9.16 multimodal feasibility — 2026-10-30

Decision: **direct YouTube enrichment disabled; no audio-understanding success claimed**.

The current [Gemini video guide](https://ai.google.dev/gemini-api/docs/video-understanding) documents public YouTube URL input and processing audio and visual streams. This is a provider capability, not proof that a particular recording was processed, or that its inferred instrumentation/timestamps are reliable. TasteProbe uses stateless REST `v1beta/models/{model}:generateContent`, not the Interactions API, and has no Gemini SDK to migrate.

The configured model, `gemini-3.5-flash-lite`, successfully answered six real text/function-calling requests in this stage. Its [standard pricing](https://ai.google.dev/gemini-api/docs/pricing) is $0.30/million input tokens and $2.50/million output tokens including thinking. Account-specific rate limits, prepaid balance and billing invoices are not visible from the API configuration; the reported ₹990 balance is the user's estimate.

## Compliance gate

Reviewed the [Gemini additional terms](https://ai.google.dev/gemini-api/terms), [YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies) and [policy guide](https://developers.google.com/youtube/terms/developer-policies-guide). The documentation for Gemini's supported URL input does not by itself establish permission for this YouTube API client's proposed reusable musical-descriptor generation and storage. YouTube restricts alternative access to audiovisual content and derived data. No app-specific approval or rightsholder authorization for this analysis was established.

Following the specification's explicit uncertain-policy fallback, no YouTube URL was sent to Gemini. This is an unresolved compatibility assessment, not a claim that every Gemini YouTube use is prohibited. No video/audio was downloaded, extracted, rehosted or scraped. No multimodal production switch or asynchronous analysis worker was added. Resolving permission is necessary before implementing that path.

## Experiment results and limits

| Item | Result |
|---|---|
| Real configured Gemini text endpoint | 6 HTTP 200 responses |
| Video IDs analyzed multimodally | None |
| Actual audio processing | Not tested |
| Feature/timestamp accuracy | Not measured |
| Human listening validation | Not performed |
| Multimodal cost | $0 |
| Musical evidence populated from titles | None |
| Personalized musical highlights | None |

The official IFrame browser test confirmed user-triggered full playback and non-autoplay transitions. A PLAYING event is not human listening evidence.

`MusicEvidenceSchema` and the ranker's optional evidence input separate independently sourced/reviewed track annotations from Qloo artist tags. The production path currently supplies no track annotations. Unknown audio features therefore remain unknown; artist-tag transfer is explicitly tentative. A profile-cache/enrichment service is deliberately not activated without a permitted source. No per-visitor paid analysis occurs.

Previews retain the existing server-validated timing-only Quick preview and Listen in full. No segment was approved, and no model-selected musical segment is claimed.
