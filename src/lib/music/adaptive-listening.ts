import { z } from "zod";
import type { ListeningState, RecommendationCandidate, VerifiedSongOption } from "@/lib/contracts";
import type { SessionState } from "@/lib/session/state";
import { trackReactions, seenVideoIds } from "./listening";
import { bucketSamples, relevanceOf } from "./taste-walk";

/** Identity is verified separately. No audio attribute is inferred from a title or artist tag. */
export const MusicEvidenceSchema = z.object({
  version: z.literal(1), artistId: z.string(), videoId: z.string(),
  source: z.enum(["REVIEWED_TRACK_ANNOTATION", "AUTHORIZED_EXTERNAL_METADATA"]),
  sourceRef: z.string().min(1), annotationVersion: z.string(),
  observedAt: z.number(), expiresAt: z.number(),
  features: z.array(z.object({ id: z.string(), value: z.string(), uncertainty: z.enum(["low", "high"]) })).max(20),
}).strict();
export type MusicEvidence = z.infer<typeof MusicEvidenceSchema>;

export const TasteStateSchema = z.object({
  version: z.literal(1), policyVersion: z.literal("context-v1"),
  originalAnchor: z.object({ id: z.string(), domain: z.string(), name: z.string() }),
  explicitAnswers: z.array(z.object({ questionId: z.string(), response: z.string(), targetIds: z.array(z.string()) })).max(100),
  explicitTrackLoves: z.array(z.string()).max(600), explicitTrackDislikes: z.array(z.string()).max(600),
  explicitArtistPreferences: z.array(z.object({ artistId: z.string(), action: z.string() })).max(100),
  featureEvidence: z.array(z.object({ id: z.string(), positive: z.number(), negative: z.number(), references: z.array(z.string()) })).max(100),
  activeHypotheses: z.array(z.object({ id: z.string(), uncertainty: z.literal("high"), references: z.array(z.string()) })).max(100),
  uncertainty: z.enum(["no_track_evidence", "conflicting", "limited"]),
  exposureHistory: z.array(z.object({ artistId: z.string(), videoId: z.string() })).max(100),
});
export type TasteState = z.infer<typeof TasteStateSchema>;

/** Rebuild from authoritative history, rather than repeatedly adding weight for the same reaction. */
export function tasteOf(state: SessionState, l: ListeningState): TasteState {
  const reactions = trackReactions(l);
  const features = new Map<string, { id: string; positive: number; negative: number; references: string[] }>();
  for (const [videoId, action] of reactions) {
    const artistId = l.trackFeedback.find((e) => e.videoId === videoId)?.artistId;
    const tags = state.candidates.find((c) => c.entityId === artistId)?.tags ?? [];
    for (const tag of tags) {
      const f = features.get(tag.id) ?? { id: tag.id, positive: 0, negative: 0, references: [] };
      f[action === "love" ? "positive" : "negative"] += 1;
      f.references.push(`track:${videoId}:${action}`);
      features.set(tag.id, f);
    }
  }
  const values = [...features.values()].slice(0, 100);
  return {
    version: 1, policyVersion: "context-v1",
    originalAnchor: { id: state.seed.entityId, domain: state.seed.entityType, name: state.seed.name },
    explicitAnswers: state.session.answers.slice(-100).map((a) => ({ questionId: a.questionId, response: a.response, targetIds: a.targetIds })),
    explicitTrackLoves: [...reactions].filter(([, a]) => a === "love").map(([id]) => id),
    explicitTrackDislikes: [...reactions].filter(([, a]) => a === "not_for_me").map(([id]) => id),
    explicitArtistPreferences: l.artistFeedback.map(({ artistId, action }) => ({ artistId, action })),
    featureEvidence: values,
    // Qloo ARTIST-tag association is only a tentative transfer hypothesis about other tracks.
    activeHypotheses: values.map((f) => ({ id: f.id, uncertainty: "high", references: f.references })),
    uncertainty: values.some((f) => f.positive && f.negative) ? "conflicting" : reactions.size ? "limited" : "no_track_evidence",
    exposureHistory: l.encounters.map(({ artistId, videoId }) => ({ artistId, videoId })),
  };
}

/**
 * S9.17 implicit listening signal for a navigation action (NEXT, ANOTHER_SONG,
 * DIFFERENT_ARTIST): how much of the recording (or of its preview) actually played.
 * Zero seconds means the listener never pressed play: no evidence either way.
 * Thresholds are heuristics, not calibrated probabilities.
 */
export function implicitWeight(e: { action: string; listenedSeconds: number; durationSeconds: number | null; mode?: "preview" | "full" }, previewSeconds?: number): number {
  if (!["NEXT", "ANOTHER_SONG", "DIFFERENT_ARTIST"].includes(e.action) || e.listenedSeconds <= 0) return 0;
  const span = e.mode === "preview" && previewSeconds ? previewSeconds : Math.min(e.durationSeconds ?? 210, 300);
  const ratio = Math.min(1, e.listenedSeconds / span);
  if (e.listenedSeconds < 12) return -0.5; // skipped within seconds
  if (ratio < 0.25) return -0.25;
  if (ratio >= 0.8) return 0.6; // stayed for (nearly) all of it
  if (ratio >= 0.5) return 0.3;
  return 0;
}

export type TrackSignal = { artistId: string; videoId: string; weight: number; strength: "strong" | "weak"; source: "love" | "not_for_me" | "saved" | "listening" };

/** Per recording: explicit reactions and saves win; otherwise the latest listening observation. */
export function trackSignals(l: ListeningState): Map<string, TrackSignal> {
  const out = new Map<string, TrackSignal>();
  for (const e of l.engagement ?? []) {
    const weight = implicitWeight(e, e.mode === "preview" ? 30 : undefined);
    if (weight) out.set(e.videoId, { artistId: e.artistId, videoId: e.videoId, weight, strength: "weak", source: "listening" });
  }
  for (const s of l.saved) out.set(s.video.videoId, { artistId: s.artist.qlooId, videoId: s.video.videoId, weight: 1, strength: "strong", source: "saved" });
  const reactions = trackReactions(l);
  for (const f of l.trackFeedback) {
    const latest = reactions.get(f.videoId);
    if (latest !== f.action) continue;
    out.set(f.videoId, { artistId: f.artistId, videoId: f.videoId, weight: f.action === "love" ? 1 : -1, strength: "strong", source: f.action });
  }
  return out;
}

/** Same-artist evidence in [-1, 1], shrunk toward 0 when there is little of it. */
export function artistSignals(l: ListeningState): Map<string, { score: number; strong: boolean; count: number }> {
  const sums = new Map<string, { total: number; count: number; strong: boolean }>();
  for (const s of trackSignals(l).values()) {
    const a = sums.get(s.artistId) ?? { total: 0, count: 0, strong: false };
    sums.set(s.artistId, { total: a.total + s.weight, count: a.count + 1, strong: a.strong || s.strength === "strong" });
  }
  for (const f of l.artistFeedback) {
    if (f.action !== "like_artist") continue;
    const a = sums.get(f.artistId) ?? { total: 0, count: 0, strong: true };
    sums.set(f.artistId, { total: a.total + 3, count: a.count + 1, strong: true });
  }
  // Shrunk toward 0: one track reaction nudges its artist; an explicit artist decision moves it decisively.
  return new Map([...sums].map(([id, a]) => [id, { score: Math.max(-1, Math.min(1, a.total / (a.count + 2))), strong: a.strong, count: a.count }]));
}

/** Model-assisted artist affinity (S9.17): favoured rank → bonus, disfavoured → penalty; only for the evidence it was computed on. */
export function modelAffinity(l: ListeningState, artistId: string): number {
  const a = l.artistAffinity;
  if (!a) return 0;
  const i = a.favoured.indexOf(artistId);
  if (i >= 0) return 1 - i / 10;
  return a.disfavoured.includes(artistId) ? -0.8 : 0;
}

const overlap = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const bs = new Set(b);
  return a.filter((id) => bs.has(id)).length / Math.sqrt(a.length * b.length);
};

export type ContextRank = { option: VerifiedSongOption; score: number; baseScore: number; diversityPenalty: number; anchor: number; answer: number; transfer: number; novelty: number; affinity: number; model: number; bucket: string; explore: number; evidenceRefs: string[] };

/** Rank within the authorized candidate reservoir; raw affinities from different queries are never mixed. */
export function rankRecordings(state: SessionState, l: ListeningState, inventory: VerifiedSongOption[], evidence: MusicEvidence[] = [], now = Date.now()): ContextRank[] {
  const taste = tasteOf(state, l);
  const seen = seenVideoIds(l);
  if (seen.size >= 600) return []; // bounded lifetime history; exhaust rather than forget and repeat
  const rejected = new Set(state.session.rejectedEntityIds);
  const candidates = new Map(state.candidates.map((c) => [c.entityId, c]));
  const byAnchor = [...state.candidates].sort((a, b) => a.rank - b.rank);
  const anchorRank = new Map(byAnchor.map((c, i) => [c.entityId, i]));
  const latestArtists = new Map(l.artistFeedback.map((f) => [f.artistId, f.action]));
  const exposure = new Map<string, number>();
  if (l.artistExposure) for (const e of l.artistExposure) exposure.set(e.artistId, e.count);
  else for (const e of l.encounters) exposure.set(e.artistId, (exposure.get(e.artistId) ?? 0) + 1);
  // Explicit reactions, saves and listening time, each weighted (S9.17).
  const signals = [...trackSignals(l).values()];
  const weighted = (sign: 1 | -1) => signals.filter((s) => Math.sign(s.weight) === sign).flatMap((s) => { const c = candidates.get(s.artistId); return c ? [{ c, w: Math.abs(s.weight) }] : []; });
  const liked = weighted(1), disliked = weighted(-1);
  const byArtist = artistSignals(l);
  // S9.18: relevance to the listener's evolving seeds (taste-weighted fusion over every Qloo query),
  // and a Thompson sample per bucket so promising neighbourhoods are exploited and new ones explored.
  const relevance = relevanceOf(state, l);
  const samples = bucketSamples(state, l, relevance);
  const feedbackWeight = Math.min(0.3, (liked.reduce((n, x) => n + x.w, 0) + disliked.reduce((n, x) => n + x.w, 0)) * 0.05);
  const unique = new Set<string>();
  return inventory.flatMap((option): ContextRank[] => {
    const c = candidates.get(option.artistId);
    if (!c || c.entityType !== "music_artist" || rejected.has(c.entityId) || latestArtists.get(c.entityId) === "not_this_artist" || seen.has(option.videoId) || taste.explicitTrackDislikes.includes(option.videoId) || unique.has(option.videoId)) return [];
    unique.add(option.videoId);
    const tags = c.tags.map((t) => t.id);
    const rel = relevance.get(c.entityId);
    const anchor = rel ? rel.relevance : c.evidence.seedEntityIds.includes(state.seed.entityId) ? 1 / (1 + (anchorRank.get(c.entityId) ?? 999) / 5) : 0;
    const bucket = rel?.bucket ?? "anchor";
    const explore = samples.size ? 0.12 * (2 * (samples.get(bucket) ?? 0.5) - 1) : 0;
    const answer = Math.max(-1, Math.min(1, overlap(tags, state.session.positiveTagIds) - overlap(tags, state.session.rejectedTagIds) + (state.session.positiveEntityIds.includes(c.entityId) ? 1 : 0)));
    const mean = (cs: Array<{ c: RecommendationCandidate; w: number }>) => { const total = cs.reduce((n, x) => n + x.w, 0); return total ? cs.reduce((sum, x) => sum + x.w * overlap(tags, x.c.tags.map((t) => t.id)), 0) / total : 0; };
    const transfer = mean(liked) - mean(disliked);
    const novelty = 1 / (1 + (exposure.get(c.entityId) ?? 0));
    // Only independently sourced track annotations may support track-level feature transfer.
    const profile = evidence.find((e) => e.artistId === option.artistId && e.videoId === option.videoId && e.expiresAt > now);
    let musical = 0;
    if (profile) {
      for (const [ids, sign] of [[taste.explicitTrackLoves, 1], [taste.explicitTrackDislikes, -1]] as const) {
        for (const id of ids) {
          const other = evidence.find((e) => e.videoId === id && e.expiresAt > now);
          if (other) musical += sign * overlap(profile.features.map((f) => `${f.id}:${f.value}`), other.features.map((f) => `${f.id}:${f.value}`)) / Math.max(1, ids.length);
        }
      }
    }
    // Direct same-artist evidence works even when Qloo returns no tags; model affinity adds general artist knowledge.
    const affinity = byArtist.get(c.entityId)?.score ?? 0;
    const model = modelAffinity(l, c.entityId);
    const baseScore = (0.5 - feedbackWeight / 2) * anchor + 0.35 * answer + feedbackWeight * transfer + 0.18 * novelty + 0.2 * musical + 0.16 * affinity + 0.25 * model + explore;
    const recent = l.encounters.slice(-8);
    const share = recent.length ? recent.filter((e) => e.artistId === c.entityId).length / recent.length : 0;
    let consecutive = 0;
    for (const e of [...recent].reverse()) { if (e.artistId !== c.entityId) break; consecutive++; }
    // S9.18: short window catches alternation between two favourites, which a consecutive count misses.
    const lastFour = l.encounters.slice(-4).filter((e) => e.artistId === c.entityId).length;
    const reactions = signals.filter((s) => s.artistId === c.entityId);
    const negativePressure = reactions.reduce((n, s) => n + (s.weight < 0 ? -s.weight : 0), 0) / (1 + reactions.length);
    const recentSimilarity = recent.length ? recent.reduce((sum, e) => sum + overlap(tags, candidates.get(e.artistId)?.tags.map((t) => t.id) ?? []), 0) / recent.length : 0;
    // Contextual MMR-style soft redundancy, never a hard artist rotation or tag exclusion.
    const diversityPenalty = 0.24 * share + 0.2 * Math.min(1, consecutive / 2) + 0.12 * lastFour + 0.18 * negativePressure + 0.06 * recentSimilarity;
    const score = baseScore - diversityPenalty;
    return [{ option, score, baseScore, diversityPenalty, anchor, answer, transfer, novelty, affinity, model, bucket, explore, evidenceRefs: [...(rel && rel.kind !== "starting_point" ? rel.seedIds.map((id) => `seed:${id}`) : []), ...new Set([`artist:${c.entityId}`, ...reactions.map((s) => `${s.source}:${s.videoId}`), ...(model ? [`model_affinity:${c.entityId}`] : []), ...taste.explicitAnswers.map((a) => `answer:${a.questionId}`), ...taste.featureEvidence.filter((f) => tags.includes(f.id)).flatMap((f) => f.references), ...(profile ? [profile.sourceRef] : [])])] }];
  }).sort((a, b) => b.score - a.score || a.option.videoId.localeCompare(b.option.videoId));
}
