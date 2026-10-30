# TasteProbe — Sound Passport

Start with a movie, artist, TV show, game, or podcast you enjoy. Qloo supplies related music artists; TasteProbe offers verified YouTube recordings, with bounded Gemini selection when there are suitable verified options. Listen in YouTube’s official player and save exact recordings in your device-local Sound Passport.

The public product is music-first. Book sources are unavailable under the current verified provider scope. Artist recommendations and recording availability are separate: a safe fallback does not mean an artist has no music.

## Run locally

Use Node.js 22.12 or later and npm. Install with `npm ci`, copy `.env.example` to `.env.local`, then run `npm run dev:mock`. Mock recommendations are synthetic and do not spend provider quota.

For live use, configure server-side Qloo, Gemini and session credentials. Production requires Upstash Redis; it fails closed rather than using process memory. See [production preparation](docs/production-preparation.md) for exact Vercel variable names, flags, restrictions and publishing steps.

## Architecture and behavior

- Next.js route handlers validate every action against signed, expiring, revisioned sessions in Redis.
- A shared cultural-domain registry controls source types and Qloo wire mappings.
- Qloo provides artist identities. Gemini may select only from server-verified recording IDs; deterministic fallback remains available.
- The optional adaptive reservoir merges verified artist results within cumulative budgets. `ADAPTIVE_POOL_ENABLED` defaults to `false` and must be chosen explicitly for a release.
- Recording reactions and artist-level preferences are separate. Another song retains the artist; a different artist advances discovery.
- YouTube native controls, branding and ads remain visible. Playback starts through user interaction.
- Passport entries stay in browser localStorage without session tokens or API credentials. They survive session expiry on that device.

## Verification

S9.16's experimental cross-artist listening loop is gated by `ADAPTIVE_LISTENING_ENABLED=false` by default. Its verified scope, evidence limits and rollback are documented in [adaptive listening intelligence](docs/adaptive-listening-intelligence.md). Run `smoke:adaptive-listening`, `evaluate:adaptive-listening` and `qa:adaptive-listening` for its dedicated gates. Direct YouTube multimodal enrichment is disabled; no audio-understanding claim is made.

S9.16R adds a playable-supply controller, verified multi-artist YouTube lookup, bounded source-preserving Qloo expansion and recent-exposure ranking. The candidate default is 50 (the previous local override was eight); provider-call quotas remain unchanged. See [discovery supply intelligence](docs/discovery-supply-intelligence.md) and run `smoke:discovery-supply`, `evaluate:discovery-supply`, and `qa:discovery-supply`. The adaptive flags remain off by default.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run audit:release-secrets
npm run smoke:mock
npm run smoke:multi-round
npm run smoke:listening
npm run qa
npm run qa:passport
npm run evaluate
npm run evaluate:adaptive
npm run evaluate:songs
npm run evaluate:question-wording
```

Browser QA needs Playwright’s browser runtime; Passport QA uses installed Edge by default. Ordinary tests and mock smoke commands do not call paid providers. Explicit live scripts can spend quota: the S9.14 Qloo campaign is exhausted and must not be rerun without a separately authorized allowance.

## Deployment and release status

`vercel.json` declares the Next.js framework, `npm ci`, and `npm run build`. Use a supported Node runtime and keep all provider keys server-side. The player derives its origin from the current HTTPS page, so preview and production do not need a hardcoded localhost setting.

No public deployment or repository URL is asserted here. A clean-browser smoke on the actual public HTTPS URL is still required. Prior live verification limitations are recorded in [release verification](docs/final-release-verification.md).

## License and third-party content

A project open-source license has **not yet been approved or added**. Choose and approve a license before presenting this repository as open source. Dependencies retain their own licenses. Qloo metadata, YouTube videos/thumbnails, and provider trademarks remain subject to their respective owners and terms; a project license does not relicense them.

Do not commit environment files, credentials, private keys, local QA evidence or local agent settings. Run the release-secret audit before making a repository public. Its current-value scan is useful evidence, not a guarantee against unknown historical credentials.
