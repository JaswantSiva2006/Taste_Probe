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
const TransitionSchema = z.object({ round: z.number().int().positive(), decision: z.enum(POOL_DECISIONS), reasons: z.array(z.string()), at: z.number().int().nonnegative() });

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
  targetType: z.string().min(1),
  seedEntityIds: z.array(z.string()).max(20),
  positiveTagIds: z.array(z.string()).max(30),
  excludedCandidateIds: z.array(z.string()).max(90),
  cursor: z.string().max(500).optional(),
  queryHash: z.string().length(24),
  /** S9.10 defines plans only. Execution and pagination support are deliberately deferred. */
  executable: z.literal(false),
});
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

const unique = (values: string[]) => [...new Set(values)];
const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

export function createQueryPlan(input: {
  family: (typeof QUERY_FAMILIES)[number]; targetType: string; seedEntityIds?: string[]; positiveTagIds?: string[];
  excludedCandidateIds?: string[]; cursor?: string; knownEntityIds: Set<string>; knownTagIds: Set<string>;
}): QueryPlan {
  const seedEntityIds = unique(input.seedEntityIds ?? []);
  const positiveTagIds = unique(input.positiveTagIds ?? []);
  const excludedCandidateIds = unique(input.excludedCandidateIds ?? []);
  if ([...seedEntityIds, ...excludedCandidateIds].some((id) => !input.knownEntityIds.has(id))) throw new Error("query_plan_unknown_entity");
  if (positiveTagIds.some((id) => !input.knownTagIds.has(id))) throw new Error("query_plan_unknown_tag");
  if (input.family === "PAGINATE" && !input.cursor) throw new Error("query_plan_missing_cursor");
  const core = { family: input.family, targetType: input.targetType, seedEntityIds, positiveTagIds, excludedCandidateIds, ...(input.cursor ? { cursor: input.cursor } : {}) };
  return QueryPlanSchema.parse({ ...core, queryHash: hashOf(core), executable: false });
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

export function synchronizeAdaptivePool(state: AdaptivePoolState, input: { displayedIds: string[]; presentedIds: string[]; rejectedIds: string[]; pinnedIds?: string[]; round: number; at: number }): AdaptivePoolState {
  const updated = AdaptivePoolStateSchema.parse({
    ...state,
    displayedIds: unique(input.displayedIds), presentedIds: unique(input.presentedIds), rejectedIds: unique(input.rejectedIds),
    pinnedIds: unique(input.pinnedIds ?? state.pinnedIds),
  });
  return recordPoolTransition(updated, evaluatePool(updated), input.round, input.at);
}

function recordPoolTransition(state: AdaptivePoolState, result: ReturnType<typeof evaluatePool>, round: number, at: number): AdaptivePoolState {
  const last = state.transitionHistory.at(-1);
  if (last?.round === round && last.decision === result.decision && JSON.stringify(last.reasons) === JSON.stringify(result.reasons)) return state;
  return AdaptivePoolStateSchema.parse({ ...state, transitionHistory: [...state.transitionHistory, { round, ...result, at }].slice(-20) });
}
