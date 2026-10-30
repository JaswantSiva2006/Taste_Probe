import { z } from "zod";
import type { ListeningState, RecommendationCandidate, VerifiedSongOption } from "@/lib/contracts";
import type { SessionState } from "@/lib/session/state";
import { trackReactions, seenVideoIds } from "./listening";

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
  explicitTrackLoves: z.array(z.string()).max(100), explicitTrackDislikes: z.array(z.string()).max(100),
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
    const artistId = l.encounters.find((e) => e.videoId === videoId)?.artistId;
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

const overlap = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const bs = new Set(b);
  return a.filter((id) => bs.has(id)).length / Math.sqrt(a.length * b.length);
};

export type ContextRank = { option: VerifiedSongOption; score: number; anchor: number; answer: number; transfer: number; novelty: number; evidenceRefs: string[] };

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
  for (const e of l.encounters) exposure.set(e.artistId, (exposure.get(e.artistId) ?? 0) + 1);
  const liked = taste.explicitTrackLoves.map((v) => candidates.get(l.encounters.find((e) => e.videoId === v)?.artistId ?? "")).filter((c): c is RecommendationCandidate => !!c);
  const disliked = taste.explicitTrackDislikes.map((v) => candidates.get(l.encounters.find((e) => e.videoId === v)?.artistId ?? "")).filter((c): c is RecommendationCandidate => !!c);
  const feedbackWeight = Math.min(0.3, (liked.length + disliked.length) * 0.05);
  const unique = new Set<string>();
  return inventory.flatMap((option): ContextRank[] => {
    const c = candidates.get(option.artistId);
    if (!c || c.entityType !== "music_artist" || rejected.has(c.entityId) || latestArtists.get(c.entityId) === "not_this_artist" || seen.has(option.videoId) || taste.explicitTrackDislikes.includes(option.videoId) || unique.has(option.videoId)) return [];
    unique.add(option.videoId);
    const tags = c.tags.map((t) => t.id);
    const anchor = c.evidence.seedEntityIds.includes(state.seed.entityId) ? 1 / (1 + (anchorRank.get(c.entityId) ?? 999) / 5) : 0;
    const answer = Math.max(-1, Math.min(1, overlap(tags, state.session.positiveTagIds) - overlap(tags, state.session.rejectedTagIds) + (state.session.positiveEntityIds.includes(c.entityId) ? 1 : 0)));
    const mean = (cs: RecommendationCandidate[]) => cs.length ? cs.reduce((sum, x) => sum + overlap(tags, x.tags.map((t) => t.id)), 0) / cs.length : 0;
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
    const score = (0.5 - feedbackWeight / 2) * anchor + 0.35 * answer + feedbackWeight * transfer + 0.18 * novelty + 0.2 * musical;
    return [{ option, score, anchor, answer, transfer, novelty, evidenceRefs: [...new Set([`artist:${c.entityId}`, ...taste.explicitAnswers.map((a) => `answer:${a.questionId}`), ...taste.featureEvidence.filter((f) => tags.includes(f.id)).flatMap((f) => f.references), ...(profile ? [profile.sourceRef] : [])])] }];
  }).sort((a, b) => b.score - a.score || a.option.videoId.localeCompare(b.option.videoId));
}
