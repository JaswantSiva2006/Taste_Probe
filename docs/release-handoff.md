# Release handoff

## S9.17 verified supply + adaptive listening

See [listening-intelligence.md](listening-intelligence.md).

**YouTube identity:** the resolver now also accepts:
- the artist's own channel;
- label uploads that credit the artist by full name in the title or a description credit line.

The same song filters apply to both (Music category, 60 s–15 min, no covers, edits, shorts or clips).

**Supply and learning:**
- One search also harvests recordings for other reservoir artists.
- Crowded-out artists get a focused search, and lookups follow artist priority.
- Listening time, saves and reactions feed ranking.
- A bounded Gemini artist-affinity mode (same allowance) orders authorized candidates.

**New defaults:**
- `ADAPTIVE_LISTENING_ENABLED=true`
- `YOUTUBE_SEARCHES_PER_EXPLORATION=6`
- `YOUTUBE_DAILY_SEARCH_MAX=80`

Explicit host or `.env` values still override them. Review those values before promotion.

## S9.16R controlled release candidate

Branch `seg/S9-16R-discovery-intelligence`, based on `024d305`. See [the complete supply repair report](discovery-supply-intelligence.md). No push, merge or deployment has been performed. Public main was observed at `e9167c4`; public health is live/Redis-ready, but the deployed SHA and production flags were not exposed.

The candidate uses up to 50 artists per supported Qloo request, a 90-artist reservoir, a bounded playable inventory and batch YouTube verification within the existing two-search limit. Both adaptive flags still default to false. Review host overrides and promote only through an explicitly approved preview; `MAX_RECOMMENDATION_CANDIDATES=50` is the verified setting. The new six-request Qloo campaign is exhausted at 6/6, separately from S9.14's unchanged 18/18. Do not rerun it without another allowance. No new paid Gemini calls or billing changes occurred. Passport rollback is preserved.

## S9.15 current handoff — music-only product

Branch `seg/S9-15-music-only-rebrand-previews`, based on `fbbaf38`. See `music-final-polish.md`.

**What the public product is:** music discovery only.
- **Starting points:** five (movie, music artist, TV show, video game, podcast). Music is always the destination. There is no destination choice and no public book path.
- **Server enforcement:** production is `publicScope: music_only`, so `/api/health` publishes only music pairs and Start refuses any other destination before a provider call. `LEGACY_GENERIC_JOURNEYS` is refused in production.
- **Book evidence:** the earlier book work is preserved in the registry (`book → music_artist` disabled and INCONCLUSIVE after the S9.14 upstream rejection). Do not claim that Books → Music works.

**Listening:**
- Every verified recording with a known duration of at least 45 seconds offers a server-validated 30-second **Quick preview** (timing only, not a highlight) and **Listen in full**, through the official IFrame player.
- No reviewed segments exist yet, so Gemini preview selection, which needs annotated human-reviewed segments, has not run live. Do not claim Gemini listened to anything or curated a highlight.

**Deployment prerequisites (unchanged from S9.14R):**
- Repository owner/name and licence approval.
- Authenticated hosting.
- Production secrets entered in the host's protected settings.
- `npm run audit:release-secrets` run before publication.
- The Qloo campaign ledger stays at 18/18; any further live Qloo use needs separate authorization.

**Next:** deployment (S10) is not started.

## S9.14 handoff (historical) — not yet ready for S10

## S9.14R current handoff

Branch `seg/S9-14R-release-recovery`, based on `e208be1`. Deploy using the tracked `vercel.json` (`npm ci`, `npm run build`, Next.js framework). The music journey now offers five verified source domains; Books is disabled after a precise upstream signal rejection. The source chooser is explicit. Existing generic exploration is preserved.

Do not rerun a full live campaign: `.artifacts/s9-14/ledger.json` is now at **18/18 Qloo**, **1 Gemini**, **$0.0006128**, zero YouTube Data API calls. Additional Qloo spending requires separate authorization. The recovery browser test is a recorded partial failure (single remaining song option caused a deterministic selection); no completed production listening/Passport pass is claimed.

Publication prerequisites: approve the public repository name/owner and open-source license, and authenticate GitHub/Vercel (or identify an already authorized repository/hosting project). Neither CLI nor hosting credentials was available. No public repo, approved license, preview URL, or public deployment was created. Do not describe this checkpoint as submission-ready. Keep the exact secret values out of chat, Git, browser storage, and command arguments; enter production secrets through the host's protected settings.

Run `npm run audit:release-secrets` before publication. It found no currently configured secrets in reachable history and no tracked environment files; obtain a broader secret scan before publication if old credentials may have existed. Required remaining acceptance: actual constrained Gemini song decision among multiple eligible recordings, complete non-movie production listening/Passport workflow, and a clean-browser public HTTPS smoke including CSP/Referer/player behavior. Do not submit to Devpost automatically.

Use branch `seg/S9-14-six-domain-release-verification`. This checkpoint deliberately keeps new source pairs disabled pending end-to-end acceptance. See `final-release-verification.md` and `six-domain-music-capability-matrix.md` before making demo claims.

Build and test: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Run `smoke:mock`, `smoke:multi-round`, `smoke:listening`, `qa`, `qa:passport`, `evaluate`, `evaluate:adaptive`, `evaluate:songs`, and `evaluate:question-wording` through npm.

Production needs Node >=22.12, a supported Next.js host, HTTPS origin, Upstash Redis, `QLOO_MODE=live`, `QLOO_API_KEY`, `QLOO_BASE_URL=https://hackathon.api.qloo.com`, `LLM_PROVIDER=google` (or supported alias), `LLM_MODEL`, `GOOGLE_API_KEY`, `SESSION_SIGNING_SECRET`, `SESSION_STORE=redis`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN`. A dedicated restricted `YOUTUBE_API_KEY` is optional for dynamic lookup. Never expose these values through client-prefixed variables. Preserve security headers and official player origin/referrer behavior.

No remote, hosting project, verified public URL, or preview deployment was found. No infrastructure or billing was created. A host must support server-side route handlers and outbound provider/Redis HTTPS. Keep the 30-minute signed-session lifetime; Passport is local browser data and survives it. Do not introduce global TLS verification bypasses in production.

For real-provider checks, retain `.artifacts/s9-14/ledger.json`; the campaign has used 12/18 Qloo calls. Do not reset it or spend from historical campaign ledgers. Current S9.14 Gemini/YouTube usage is zero. The six-domain probe can be run with `npx vitest run --config scripts/vitest.pivot.config.mts scripts/probe-six-domain.test.ts`; existing recorded domains are skipped.

Honest demo scope: existing movie-to-music listening experience and generic enabled journeys; five source query paths have provider evidence, but complete six-domain discovery is not verified or enabled. No Devpost submission or S10 work has been started.
