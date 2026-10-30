# Third-party notices

TasteProbe's **source code** is licensed under the MIT License (see [LICENSE](LICENSE)). That license covers only the code and documentation written for this project. It does **not** grant any rights to the third-party services, data, media or trademarks below, which remain subject to their owners' terms.

## Services and data

| Third party | How TasteProbe uses it | Terms |
|---|---|---|
| **Qloo** (Taste AI™ Insights API, hackathon endpoint) | Entity search, cultural-affinity Insights, artist identities, tags, descriptions and images shown in the app | Qloo API terms. Qloo data is not redistributed in this repository; tests use synthetic fixtures. |
| **Google Gemini API** | Bounded, server-validated decisions (questions, recording choice, artist affinity, walk planning) | Google Gemini API terms |
| **YouTube** (Data API v3 and the official IFrame Player) | Finding and verifying recordings; all playback happens in YouTube's own embedded player with its native controls, branding and ads | YouTube Terms of Service and YouTube API Services Terms. TasteProbe does not download, rehost or extract audio. Videos, thumbnails, titles and recordings belong to their rights holders. |
| **Upstash Redis** | Session state, rate limits and lookup caches | Upstash terms |
| **Vercel** | Hosting | Vercel terms |

Songs, music videos, album art, artist names and trademarks (including "Qloo", "YouTube" and "Gemini") belong to their respective owners. Their appearance in TasteProbe does not imply endorsement.

## Fonts

Self-hosted at build time through `next/font/google`, all under the SIL Open Font License 1.1:

- **Archivo** (Omnibus-Type)
- **DM Sans** (Colophon Foundry, Google)
- **IBM Plex Mono** (IBM)

## Software dependencies

Runtime and development dependencies (Next.js, React, zod, @upstash/redis, Vitest, Playwright, ESLint, Tailwind CSS, axe-core, fengari and others) are distributed under their own open-source licenses. Their license texts are installed alongside each package in `node_modules`, and the exact versions are pinned in `package-lock.json`.

## Original artwork

The icons, vinyl and passport artwork in `src/components` and the favicon `src/app/icon.svg` were created for this project and are covered by the MIT License.
