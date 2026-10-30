import { createHash } from "node:crypto";
import { z } from "zod";
import type { ListeningState, RecommendationCandidate } from "@/lib/contracts";
import type { SessionState } from "@/lib/session/state";
import { artistSignals, trackSignals } from "./adaptive-listening";

/**
 * S9.18 taste-graph walk. Qloo is a graph: every artist has a neighbourhood. The
 * starting point is only the first seed. Artists the listener responds to become
 * seeds themselves; querying Qloo with them (alone, or blended) moves the
 * reservoir toward what the listener actually enjoys, instead of staying anchored
 * to the first query forever.
 *
 * This module is pure: provenance bookkeeping, taste-weighted fusion (relevance),
 * a Thompson-sampling bandit over "buckets" (the seed that best explains an artist),
 * and the deterministic frontier policy. Network effects live in the service.
 */

export const WALK_KINDS = ["NEIGHBOURHOOD", "BLEND", "SCOUT"] as const;
const Id = z.string().min(1).max(200);

export const WalkStateSchema = z.object({
  version: z.literal(1),
  /** Seeds the walk has used or may use. Anchors are implicit (the session's anchor IDs). */
  seeds: z.array(z.object({
    entityId: Id,
    origin: z.enum(["listened", "scouted"]),
    status: z.enum(["frontier", "expanded"]),
    /** The seed(s) whose results or reasoning led here (for the visible path). */
    parentIds: z.array(Id).max(3),
    at: z.number().int(),
  })).max(60),
  /** Query provenance: which seeds produced which pool origin. */
  queries: z.array(z.object({ queryHash: z.string().length(24), kind: z.enum(WALK_KINDS), seedIds: z.array(Id).max(6), added: z.number().int().nonnegative(), at: z.number().int(), requestId: z.string().max(200) })).max(60),
  /** Qloo HTTP requests spent by the walk (insights + scout searches). */
  calls: z.number().int().nonnegative(),
  decisions: z.array(z.object({ at: z.number().int(), revision: z.number().int().nonnegative(), action: z.enum(["EXPAND", "BLEND", "SCOUT", "HOLD"]), seedIds: z.array(Id).max(6), scouted: z.array(z.string().max(120)).max(3), mode: z.enum(["GEMINI", "DETERMINISTIC"]), reason: z.string().max(64), added: z.number().int().nonnegative() })).max(40),
});
export type WalkState = z.infer<typeof WalkStateSchema>;

export const emptyWalk = (): WalkState => ({ version: 1, seeds: [], queries: [], calls: 0, decisions: [] });
export const walkHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

/** Minimum same-artist evidence for an artist to become a seed (one Love, two long listens, or an explicit like). */
export const SEED_THRESHOLD = 0.3;

/**
 * How much each seed speaks for this listener now. The starting point fades (never
 * below 0.45) as other seeds earn trust; a seed's weight follows its own evidence.
 */
export function seedWeights(state: SessionState, l: ListeningState | undefined): Map<string, number> {
  const signals = l ? artistSignals(l) : new Map<string, { score: number }>();
  const rejected = new Set([...state.session.rejectedEntityIds, ...(l?.artistFeedback.filter((f) => f.action === "not_this_artist").map((f) => f.artistId) ?? [])]);
  const positives = [...signals.values()].filter((s) => s.score >= SEED_THRESHOLD).length;
  const out = new Map<string, number>(state.session.anchorIds.map((id) => [id, Math.max(0.45, 1 - 0.1 * positives)]));
  for (const seed of state.walk?.seeds ?? []) {
    const score = signals.get(seed.entityId)?.score ?? 0;
    out.set(seed.entityId, rejected.has(seed.entityId) ? 0 : Math.max(0.15, Math.min(1.2, (seed.origin === "scouted" ? 0.7 : 0.5) + 0.7 * score)));
  }
  return out;
}

export type Relevance = { relevance: number; bucket: string; seedIds: string[]; kind: "starting_point" | (typeof WALK_KINDS)[number] };

/**
 * Taste-weighted fusion across every query that returned a candidate. Each origin
 * contributes w(seeds) · 1/(1 + (rank − 1)/5); contributions combine as a noisy-OR,
 * so an artist that several trusted seeds agree on rises, while raw affinities from
 * different queries are still never compared directly.
 */
export function relevanceOf(state: SessionState, l: ListeningState | undefined): Map<string, Relevance> {
  const pool = state.adaptivePool;
  if (!pool) return new Map();
  const ctx = relevanceContext(state, l);
  return new Map(pool.entries.map((entry) => [entry.candidateId, entryRelevance(entry, ctx)]));
}

export type RelevanceContext = { weights: Map<string, number>; queries: Map<string, WalkState["queries"][number]>; anchorIds: string[] };
export const relevanceContext = (state: SessionState, l: ListeningState | undefined, extraQueries: WalkState["queries"] = []): RelevanceContext => ({
  weights: seedWeights(state, l),
  queries: new Map([...(state.walk?.queries ?? []), ...extraQueries].map((q) => [q.queryHash, q])),
  anchorIds: state.session.anchorIds,
});

export function entryRelevance(entry: { origins: Array<{ queryHash: string; rank: number }> }, ctx: RelevanceContext): Relevance {
  let miss = 1;
  let best = { x: -1, seedIds: ctx.anchorIds, kind: "starting_point" as Relevance["kind"] };
  for (const origin of entry.origins) {
    const q = ctx.queries.get(origin.queryHash);
    const seedIds = q?.seedIds ?? ctx.anchorIds;
    const w = Math.min(1, seedIds.reduce((s, id) => s + (ctx.weights.get(id) ?? 0.5), 0) / Math.max(1, seedIds.length));
    const x = w / (1 + (origin.rank - 1) / 5);
    miss *= 1 - Math.min(0.99, x);
    if (x > best.x) best = { x, seedIds, kind: q?.kind ?? "starting_point" };
  }
  return { relevance: 1 - miss, bucket: best.kind === "starting_point" ? "anchor" : best.seedIds.join("+"), seedIds: best.seedIds, kind: best.kind };
}

/** Small deterministic PRNG (mulberry32) so a turn's sampling is reproducible from its state. */
function prng(seed: string) {
  let a = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Beta(α, β) via two Gamma draws (Marsaglia–Tsang, α ≥ 1 here). */
function betaSample(alpha: number, beta: number, rand: () => number): number {
  const gamma = (k: number) => {
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do {
        const u1 = Math.max(rand(), 1e-12), u2 = rand();
        x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.max(rand(), 1e-12);
      if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
    }
  };
  const x = gamma(alpha), y = gamma(beta);
  return x / (x + y);
}

/**
 * Thompson sampling over buckets. Reward = the listener's own signals on artists in
 * the bucket (explicit ±1, listening time ±0.25–0.6). A bucket with no data stays
 * uncertain and keeps getting explored; one that keeps pleasing gets exploited.
 * Returns nothing until the listener has reacted at all (no noise on a cold start).
 */
export function bucketSamples(state: SessionState, l: ListeningState, relevance: Map<string, Relevance>): Map<string, number> {
  const signals = [...trackSignals(l).values()];
  if (!signals.length) return new Map();
  const stats = new Map<string, { a: number; b: number }>();
  for (const r of relevance.values()) if (!stats.has(r.bucket)) stats.set(r.bucket, { a: 1, b: 1 });
  for (const s of signals) {
    const bucket = relevance.get(s.artistId)?.bucket;
    if (!bucket) continue;
    const st = stats.get(bucket)!;
    if (s.weight > 0) st.a += s.weight; else st.b -= s.weight;
  }
  const rand = prng(`${state.session.sessionId}:${l.encounters.length}:${signals.length}`);
  return new Map([...stats].sort(([x], [y]) => x.localeCompare(y)).map(([bucket, st]) => [bucket, betaSample(st.a, st.b, rand)]));
}

export type WalkPlan = { action: "EXPAND" | "BLEND"; seedIds: string[]; reason: string };

/** Artists that have earned seed status and not yet been expanded (strongest first). */
export function frontier(state: SessionState, l: ListeningState): string[] {
  const signals = artistSignals(l);
  // Considered: expanded, or a listened seed the walk already weighed. A scouted artist
  // becomes expandable only once the listener's own reactions earn it.
  const considered = new Set((state.walk?.seeds ?? []).filter((s) => s.status === "expanded" || s.origin === "listened").map((s) => s.entityId));
  const rejected = new Set(state.session.rejectedEntityIds);
  const known = new Set(state.candidates.map((c) => c.entityId));
  return [...signals].filter(([id, s]) => s.score >= SEED_THRESHOLD && !considered.has(id) && !rejected.has(id) && known.has(id)).sort((a, b) => b[1].score - a[1].score).map(([id]) => id);
}

/** Positive seeds already expanded, strongest first: candidates for a blended (centroid) query. */
export function blendSeeds(state: SessionState, l: ListeningState): string[] {
  const signals = artistSignals(l);
  return (state.walk?.seeds ?? []).filter((s) => s.status === "expanded" && (signals.get(s.entityId)?.score ?? 0) >= SEED_THRESHOLD)
    .sort((a, b) => (signals.get(b.entityId)?.score ?? 0) - (signals.get(a.entityId)?.score ?? 0)).map((s) => s.entityId).slice(0, 3);
}

/** Minimum new artists for a neighbourhood to stay worth expanding. */
export const SATURATION_YIELD = 3;

/**
 * Buckets whose expansion already came back (nearly) empty. Seeds in the same bucket
 * share most of their Qloo neighbourhood, so spending on them again is wasted budget.
 */
export function saturatedBuckets(state: SessionState, relevance: Map<string, Relevance>): Set<string> {
  const out = new Set<string>();
  for (const q of state.walk?.queries ?? []) {
    if (q.kind === "SCOUT" || q.added >= SATURATION_YIELD) continue;
    for (const id of q.seedIds) out.add(relevance.get(id)?.bucket ?? "anchor");
    out.add(q.seedIds.join("+"));
  }
  return out;
}

/**
 * Deterministic frontier policy, yield-aware:
 * 1. EXPAND the strongest new seed whose neighbourhood is not saturated;
 * 2. else BLEND the strongest expanded seeds, only across different buckets (a blend of
 *    one neighbourhood with itself adds nothing), once per combination.
 */
export function planWalk(state: SessionState, l: ListeningState): WalkPlan | null {
  const relevance = relevanceOf(state, l);
  const saturated = saturatedBuckets(state, relevance);
  const bucket = (id: string) => relevance.get(id)?.bucket ?? "anchor";
  const next = frontier(state, l).find((id) => !saturated.has(bucket(id)));
  if (next) return { action: "EXPAND", seedIds: [next], reason: "new_seed_neighbourhood" };
  const blend: string[] = [];
  for (const id of blendSeeds(state, l)) if (!blend.some((b) => bucket(b) === bucket(id))) blend.push(id);
  const plan: WalkPlan = { action: "BLEND", seedIds: [...blend].sort(), reason: "taste_centroid" };
  return walkPlanAllowed(state, l, plan) ? plan : null;
}

/** Blends per exploration: each must include a newly expanded seed, so a blend is new evidence, not a reshuffle. */
export const MAX_BLENDS = 3;

/**
 * The same budget rules for every proposer (deterministic or model): never re-run a
 * seed set, never expand an already-expanded seed or a saturated neighbourhood, and
 * blend only across neighbourhoods with something new in the mix.
 */
export function walkPlanAllowed(state: SessionState, l: ListeningState, plan: { action: string; seedIds: string[] }): boolean {
  const walk = state.walk ?? emptyWalk();
  const seeds = [...new Set(plan.seedIds)].sort();
  const tried = new Set(walk.queries.filter((q) => q.kind !== "SCOUT").map((q) => [...q.seedIds].sort().join("+")));
  if (!seeds.length || tried.has(seeds.join("+"))) return false;
  const relevance = relevanceOf(state, l);
  const saturated = saturatedBuckets(state, relevance);
  const bucket = (id: string) => relevance.get(id)?.bucket ?? "anchor";
  if (plan.action === "EXPAND") return seeds.length === 1 && !walk.seeds.some((s) => s.entityId === seeds[0] && s.status === "expanded") && !saturated.has(bucket(seeds[0]!));
  if (plan.action !== "BLEND") return false;
  const blends = walk.queries.filter((q) => q.kind === "BLEND");
  const blended = new Set(blends.flatMap((q) => q.seedIds));
  return seeds.length >= 2 && seeds.length <= 3 && blends.length < MAX_BLENDS && new Set(seeds.map(bucket)).size === seeds.length && !saturated.has(seeds.join("+")) && seeds.some((id) => !blended.has(id));
}

/** A Qloo artist identified from a search result (used for scouted names). */
export function candidateFromSearch(raw: { entity_id: string; name: string; tags?: Array<{ id?: string; tag_id?: string; name: string; type: string }> }, requestId: string, provenance: "qloo" | "mock", rank: number): RecommendationCandidate {
  const tags = (raw.tags ?? []).flatMap((t) => { const id = t.id ?? t.tag_id; return id && t.name.trim() && t.type.trim() ? [{ id, name: t.name, type: t.type }] : []; });
  const base = { entityId: raw.entity_id, name: raw.name, entityType: "music_artist" as const, rank, tags };
  return provenance === "mock"
    ? { ...base, syntheticScore: 0, evidence: { source: "mock", requestId, seedEntityIds: [], fixtureId: raw.entity_id.startsWith("mock:") ? raw.entity_id : `mock:${raw.entity_id}`, note: "Synthetic fixture data for development. Not returned by Qloo; scores are not measured affinities." } }
    : { ...base, evidence: { source: "qloo", requestId, seedEntityIds: [] } };
}
