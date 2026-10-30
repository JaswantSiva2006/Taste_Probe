import { createHash } from "node:crypto";
import { z } from "zod";
import type { RecommendationCandidate } from "@/lib/contracts";

export const ADAPTIVE_POOL_MAX_CANDIDATES = 90;
export const POOL_DECISIONS = ["KEEP", "LOCAL_REPLACE", "FETCH_AND_MERGE", "EXPAND", "DEGRADED_KEEP"] as const;
export type PoolDecision = (typeof POOL_DECISIONS)[number];
export const QUERY_FAMILIES = ["BASE", "PROFILE_REFRESH", "TAG_FOCUS", "PAGINATE", "DIVERSIFY"] as const;

const PoolOriginSchema = z.object({ family: z.enum(QUERY_FAMILIES), queryHash: z.string().length(24), rank: z.number().int().positive(), requestId: z.string().min(1) });
const PoolEntrySchema = z.object({
  candidateId: z.string().min(1),
  targetType: z.string().min(1),
  metadata: z.object({ tagIds: z.array(z.string()), hasDescription: z.boolean(), hasImage: z.boolean() }),
  origins: z.array(PoolOriginSchema).min(1),
});
const TransitionSchema = z.object({
  round: z.number().int().positive(), decision: z.enum(POOL_DECISIONS), reasons: z.array(z.string()), at: z.number().int().nonnegative(),
  queryHash: z.string().length(24).optional(), family: z.enum(QUERY_FAMILIES).optional(), addedIds: z.array(z.string()).optional(),
  qlooCalls: z.number().int().nonnegative().optional(), outcome: z.enum(["not_requested", "merged", "empty", "failed", "duplicate", "budget_exhausted"]).optional(),
});

export const AdaptivePoolStateSchema = z.object({
  version: z.literal(1),
  targetType: z.string().min(1),
  entries: z.array(PoolEntrySchema).max(ADAPTIVE_POOL_MAX_CANDIDATES),
  displayedIds: z.array(z.string()),
  presentedIds: z.array(z.string()),
  rejectedIds: z.array(z.string()),
  pinnedIds: z.array(z.string()),
  attemptedQueryHashes: z.array(z.string().length(24)),
  transitionHistory: z.array(TransitionSchema).max(20),
});
export type AdaptivePoolState = z.infer<typeof AdaptivePoolStateSchema>;

export const QueryPlanSchema = z.object({
  family: z.enum(QUERY_FAMILIES),
  endpoint: z.literal("/v2/insights").default("/v2/insights"),
  targetType: z.string().min(1),
  seedEntityIds: z.array(z.string()).max(20),
  positiveEntityIds: z.array(z.string()).max(30).default([]),
  positiveTagIds: z.array(z.string()).max(30),
  excludedCandidateIds: z.array(z.string()).max(90),
  take: z.number().int().min(1).max(50).default(30),
  includeExplainability: z.boolean().default(true),
  cursor: z.string().max(500).optional(),
  queryHash: z.string().length(24),
  executable: z.boolean(),
});
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

const unique = (values: string[]) => [...new Set(values)];
const uniqueSorted = (values: string[]) => unique(values).sort((a, b) => a.localeCompare(b));
const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

export function createQueryPlan(input: {
  family: (typeof QUERY_FAMILIES)[number]; targetType: string; seedEntityIds?: string[]; positiveTagIds?: string[];
  positiveEntityIds?: string[]; excludedCandidateIds?: string[]; cursor?: string; take?: number; includeExplainability?: boolean;
  knownEntityIds: Set<string>; knownTagIds: Set<string>; executable?: boolean;
}): QueryPlan {
  const seedEntityIds = uniqueSorted(input.seedEntityIds ?? []);
  const positiveEntityIds = uniqueSorted(input.positiveEntityIds ?? []);
  const positiveTagIds = uniqueSorted(input.positiveTagIds ?? []);
  const excludedCandidateIds = uniqueSorted(input.excludedCandidateIds ?? []);
  if ([...seedEntityIds, ...positiveEntityIds, ...excludedCandidateIds].some((id) => !input.knownEntityIds.has(id))) throw new Error("query_plan_unknown_entity");
  if (positiveTagIds.some((id) => !input.knownTagIds.has(id))) throw new Error("query_plan_unknown_tag");
  if (input.family === "PAGINATE" && !input.cursor) throw new Error("query_plan_missing_cursor");
  if ((input.family === "PAGINATE" || input.family === "DIVERSIFY") && input.executable) throw new Error("query_plan_family_not_executable");
  const core = {
    endpoint: "/v2/insights" as const, family: input.family, targetType: input.targetType, seedEntityIds,
    positiveEntityIds, positiveTagIds, excludedCandidateIds, take: input.take ?? 30,
    includeExplainability: input.includeExplainability ?? true, ...(input.cursor ? { cursor: input.cursor } : {}),
  };
  return QueryPlanSchema.parse({ ...core, queryHash: hashOf(core), executable: input.executable ?? false });
}

export function planAdaptiveRetrieval(input: {
  pool: AdaptivePoolState; candidates: RecommendationCandidate[]; anchorIds: string[]; targetType: string;
  newPositiveEntityIds: string[]; newPositiveTagIds: string[]; take: number; includeExplainability: boolean;
}): { decision: PoolDecision; reasons: string[]; plan: QueryPlan | null } {
  if (!input.newPositiveEntityIds.length && !input.newPositiveTagIds.length) return { decision: evaluatePool(input.pool).decision, reasons: ["no_new_positive_signal"], plan: null };
  const knownEntityIds = new Set([...input.anchorIds, ...input.candidates.map((candidate) => candidate.entityId)]);
  const knownTagIds = new Set(input.candidates.flatMap((candidate) => candidate.tags.map((tag) => tag.id)));
  const family = input.newPositiveEntityIds.length ? "PROFILE_REFRESH" : "TAG_FOCUS";
  const signalIds = family === "PROFILE_REFRESH" ? input.newPositiveEntityIds : input.newPositiveTagIds;
  const eligible = input.pool.entries.filter((entry) => !input.pool.rejectedIds.includes(entry.candidateId));
  const covered = family === "PROFILE_REFRESH"
    ? eligible.filter((entry) => signalIds.includes(entry.candidateId)).length
    : eligible.filter((entry) => entry.metadata.tagIds.some((id) => signalIds.includes(id))).length;
  const coverage = eligible.length ? covered / eligible.length : 0;
  // Strong local coverage is sufficient. Entity affirmation is intentionally a profile refresh:
  // Qloo can use that explicit artist identity to discover genuinely adjacent candidates.
  if (family === "TAG_FOCUS" && covered >= 5 && coverage >= 0.6) return { decision: "KEEP", reasons: ["confirmed_signal_well_covered_locally"], plan: null };
  const plan = createQueryPlan({
    family, targetType: input.targetType, seedEntityIds: input.anchorIds,
    positiveEntityIds: family === "PROFILE_REFRESH" ? signalIds : [], positiveTagIds: family === "TAG_FOCUS" ? signalIds : [],
    excludedCandidateIds: [], take: input.take, includeExplainability: input.includeExplainability,
    knownEntityIds, knownTagIds, executable: true,
  });
  if (input.pool.attemptedQueryHashes.includes(plan.queryHash)) return { decision: "DEGRADED_KEEP", reasons: ["query_already_attempted"], plan: null };
  return { decision: "FETCH_AND_MERGE", reasons: [family === "PROFILE_REFRESH" ? "new_confirmed_entity_profile" : "confirmed_tag_underrepresented"], plan };
}

export function initializeAdaptivePool(candidates: RecommendationCandidate[], targetType: string, displayedIds: string[], round = 1, at = Date.now()): AdaptivePoolState {
  const bounded = candidates.slice(0, ADAPTIVE_POOL_MAX_CANDIDATES);
  const queryHash = hashOf({ family: "BASE", targetType, seedEntityIds: bounded[0]?.evidence.seedEntityIds ?? [] });
  const state: AdaptivePoolState = {
    version: 1,
    targetType,
    entries: bounded.map((candidate) => ({
      candidateId: candidate.entityId,
      targetType: candidate.entityType,
      metadata: { tagIds: unique(candidate.tags.map((tag) => tag.id)), hasDescription: Boolean(candidate.description), hasImage: Boolean(candidate.imageUrl) },
      origins: [{ family: "BASE", queryHash, rank: candidate.rank, requestId: candidate.evidence.requestId }],
    })),
    displayedIds: unique(displayedIds), presentedIds: [], rejectedIds: [], pinnedIds: [], attemptedQueryHashes: [queryHash], transitionHistory: [],
  };
  return recordPoolTransition(state, evaluatePool(state), round, at);
}

export function evaluatePool(state: AdaptivePoolState): { decision: PoolDecision; reasons: string[] } {
  const rejected = new Set(state.rejectedIds);
  const eligible = state.entries.filter((entry) => !rejected.has(entry.candidateId));
  if (!eligible.length) return { decision: "DEGRADED_KEEP", reasons: ["no_eligible_verified_candidates"] };
  if (eligible.length < 5) return { decision: "FETCH_AND_MERGE", reasons: ["fewer_than_five_eligible_candidates"] };
  const display = state.displayedIds.filter((id) => !rejected.has(id));
  if (display.length < Math.min(5, eligible.length)) return { decision: "LOCAL_REPLACE", reasons: ["verified_local_replacement_available"] };
  const complete = eligible.slice(0, 10).filter((entry) => entry.metadata.hasDescription || entry.metadata.hasImage || entry.metadata.tagIds.length > 0).length;
  const distinctTags = new Set(eligible.slice(0, 10).flatMap((entry) => entry.metadata.tagIds)).size;
  if (complete < Math.ceil(Math.min(10, eligible.length) * 0.6) || distinctTags < 2) return { decision: "EXPAND", reasons: ["metadata_or_diversity_below_threshold"] };
  return { decision: "KEEP", reasons: ["current_slate_is_adequate"] };
}

export function selectLocalReplacements(state: AdaptivePoolState, count = 5): string[] {
  const rejected = new Set(state.rejectedIds);
  const valid = new Set(state.entries.map((entry) => entry.candidateId));
  const pins = state.pinnedIds.filter((id) => valid.has(id) && !rejected.has(id));
  const current = state.displayedIds.filter((id) => valid.has(id) && !rejected.has(id));
  const reserve = state.entries.map((entry) => entry.candidateId).filter((id) => !rejected.has(id));
  // Stable union: adequate incumbents do not churn; pins cannot be displaced.
  return unique([...pins, ...current, ...reserve]).slice(0, count);
}

const QLOO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Merge one verified query window; raw affinities are not compared across queries. */
export function mergeAdaptiveCandidates(input: {
  current: RecommendationCandidate[]; incoming: RecommendationCandidate[]; pool: AdaptivePoolState;
  plan: QueryPlan; requestId: string; round: number; at: number; qlooCalls: number;
}): { candidates: RecommendationCandidate[]; pool: AdaptivePoolState; addedIds: string[] } {
  const validIncoming = input.incoming.filter((candidate) =>
    candidate.entityType === input.pool.targetType &&
    (candidate.evidence.source === "mock" ? true : QLOO_ID.test(candidate.entityId)),
  );
  const candidates = new Map(input.current.map((candidate) => [candidate.entityId, candidate]));
  const entries = new Map(input.pool.entries.map((entry) => [entry.candidateId, entry]));
  const addedIds: string[] = [];
  for (const candidate of validIncoming) {
    const prior = candidates.get(candidate.entityId);
    if (!prior) addedIds.push(candidate.entityId);
    const tags = prior
      ? [...new Map([...prior.tags, ...candidate.tags].map((tag) => [tag.id, tag])).values()]
      : candidate.tags;
    candidates.set(candidate.entityId, prior ? {
      ...prior,
      ...(prior.description ? {} : candidate.description ? { description: candidate.description } : {}),
      ...(prior.imageUrl ? {} : candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
      tags,
    } : candidate);
    const origin = { family: input.plan.family, queryHash: input.plan.queryHash, rank: candidate.rank, requestId: input.requestId };
    const oldEntry = entries.get(candidate.entityId);
    entries.set(candidate.entityId, oldEntry ? {
      ...oldEntry,
      metadata: {
        tagIds: unique([...oldEntry.metadata.tagIds, ...candidate.tags.map((tag) => tag.id)]),
        hasDescription: oldEntry.metadata.hasDescription || Boolean(candidate.description),
        hasImage: oldEntry.metadata.hasImage || Boolean(candidate.imageUrl),
      },
      origins: oldEntry.origins.some((item) => item.queryHash === input.plan.queryHash) ? oldEntry.origins : [...oldEntry.origins, origin].slice(-8),
    } : {
      candidateId: candidate.entityId, targetType: candidate.entityType,
      metadata: { tagIds: unique(candidate.tags.map((tag) => tag.id)), hasDescription: Boolean(candidate.description), hasImage: Boolean(candidate.imageUrl) },
      origins: [origin],
    });
  }

  const fused = [...entries.values()].map((entry) => ({
    entry,
    score: entry.origins.reduce((sum, origin) => sum + 1 / (60 + origin.rank), 0),
  })).sort((a, b) => b.score - a.score || a.entry.origins[0]!.rank - b.entry.origins[0]!.rank || a.entry.candidateId.localeCompare(b.entry.candidateId));
  const protectedIds = new Set([...input.pool.pinnedIds, ...input.pool.rejectedIds]);
  const retained = unique([
    ...fused.filter(({ entry }) => protectedIds.has(entry.candidateId)).map(({ entry }) => entry.candidateId),
    ...fused.map(({ entry }) => entry.candidateId),
  ]).slice(0, ADAPTIVE_POOL_MAX_CANDIDATES);
  const retainedSet = new Set(retained);
  const orderedCandidates = fused
    .filter(({ entry }) => retainedSet.has(entry.candidateId) && candidates.has(entry.candidateId))
    .map(({ entry }, index) => {
      const candidate = candidates.get(entry.candidateId)!;
      // The fused within-query rank becomes the conservative cross-query base.
      if ("affinity" in candidate) {
        const normalized = { ...candidate, rank: index + 1, affinity: undefined };
        return normalized as RecommendationCandidate;
      }
      return { ...candidate, rank: index + 1 };
    });
  const mergedPool = AdaptivePoolStateSchema.parse({
    ...input.pool,
    entries: retained.map((id) => entries.get(id)!),
    attemptedQueryHashes: unique([...input.pool.attemptedQueryHashes, input.plan.queryHash]),
  });
  return {
    candidates: orderedCandidates,
    pool: recordPoolTransition(mergedPool, {
      decision: addedIds.length ? "FETCH_AND_MERGE" : "DEGRADED_KEEP",
      reasons: [addedIds.length ? "new_verified_candidates_merged" : "no_new_verified_candidates"],
      queryHash: input.plan.queryHash, family: input.plan.family, addedIds, qlooCalls: input.qlooCalls,
      outcome: addedIds.length ? "merged" : "empty",
    }, input.round, input.at),
    addedIds,
  };
}

export function recordAdaptiveAttempt(state: AdaptivePoolState, input: {
  decision: PoolDecision; reasons: string[]; round: number; at: number; plan?: QueryPlan;
  qlooCalls: number; outcome: "not_requested" | "merged" | "empty" | "failed" | "duplicate" | "budget_exhausted";
}): AdaptivePoolState {
  const attemptedQueryHashes = input.plan ? unique([...state.attemptedQueryHashes, input.plan.queryHash]) : state.attemptedQueryHashes;
  return recordPoolTransition({ ...state, attemptedQueryHashes }, {
    decision: input.decision, reasons: input.reasons, queryHash: input.plan?.queryHash, family: input.plan?.family,
    qlooCalls: input.qlooCalls, outcome: input.outcome,
  }, input.round, input.at);
}

export function synchronizeAdaptivePool(state: AdaptivePoolState, input: { displayedIds: string[]; presentedIds: string[]; rejectedIds: string[]; pinnedIds?: string[]; round: number; at: number }): AdaptivePoolState {
  const updated = AdaptivePoolStateSchema.parse({
    ...state,
    displayedIds: unique(input.displayedIds), presentedIds: unique(input.presentedIds), rejectedIds: unique(input.rejectedIds),
    pinnedIds: unique(input.pinnedIds ?? state.pinnedIds),
  });
  return recordPoolTransition(updated, evaluatePool(updated), input.round, input.at);
}

function recordPoolTransition(state: AdaptivePoolState, result: { decision: PoolDecision; reasons: string[] } & Partial<z.infer<typeof TransitionSchema>>, round: number, at: number): AdaptivePoolState {
  const last = state.transitionHistory.at(-1);
  if (last?.round === round && last.decision === result.decision && last.queryHash === result.queryHash && last.outcome === result.outcome && JSON.stringify(last.reasons) === JSON.stringify(result.reasons)) return state;
  return AdaptivePoolStateSchema.parse({ ...state, transitionHistory: [...state.transitionHistory, { round, ...result, at }].slice(-20) });
}
