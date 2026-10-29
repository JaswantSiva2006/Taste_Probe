import { z } from "zod";
import { SESSION_DOMAINS } from "./capabilities";

/**
 * Canonical public domain contracts (skill §5). These are provider-agnostic:
 * raw Qloo/fixture response shapes live in src/lib/qloo/raw-types.ts.
 */

/** Session-ready domains, owned by the S9.2 registry (currently movie | book). */
export const EntityTypeSchema = z.enum(SESSION_DOMAINS);
export type EntityType = z.infer<typeof EntityTypeSchema>;

/** Where a piece of data came from. `mock` data must never be labelled `qloo`. */
export const ProvenanceSchema = z.enum(["mock", "qloo"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ProviderModeSchema = z.enum(["mock", "live"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const MAX_QUESTIONS_LIMIT = 3;

export const DiscoveryInputSchema = z.object({
  entityQuery: z.string().trim().min(1).max(200),
  sourceType: EntityTypeSchema,
  targetType: EntityTypeSchema,
  maxQuestions: z.literal(MAX_QUESTIONS_LIMIT),
});
export type DiscoveryInput = z.infer<typeof DiscoveryInputSchema>;

/** Entity returned by search, used to resolve the discovery seed. */
export const EntitySummarySchema = z.object({
  entityId: z.string().min(1),
  name: z.string().min(1),
  entityType: EntityTypeSchema,
  year: z.number().int().optional(),
  provenance: ProvenanceSchema,
});
export type EntitySummary = z.infer<typeof EntitySummarySchema>;

export const TagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
});
export type Tag = z.infer<typeof TagSchema>;

const candidateBase = {
  entityId: z.string().min(1),
  name: z.string().min(1),
  entityType: z.string().min(1),
  rank: z.number().int().positive(),
  description: z.string().optional(),
  imageUrl: z.url().optional(),
  tags: z.array(TagSchema),
};

/** Future real-Qloo candidate (skill §5). Not produced in S1. */
export const QlooRecommendationCandidateSchema = z.object({
  ...candidateBase,
  affinity: z.number().optional(),
  evidence: z.object({
    source: z.literal("qloo"),
    requestId: z.string().min(1),
    seedEntityIds: z.array(z.string().min(1)),
    explainability: z.unknown().optional(),
  }),
});
export type QlooRecommendationCandidate = z.infer<typeof QlooRecommendationCandidateSchema>;

/**
 * Fixture-backed candidate. Scores are synthetic, so they are exposed as
 * `syntheticScore`, never as a Qloo `affinity`.
 */
export const MockRecommendationCandidateSchema = z.object({
  ...candidateBase,
  syntheticScore: z.number().min(0).max(1),
  evidence: z.object({
    source: z.literal("mock"),
    requestId: z.string().min(1),
    seedEntityIds: z.array(z.string().min(1)),
    fixtureId: z.string().startsWith("mock:"),
    note: z.string(),
  }),
});
export type MockRecommendationCandidate = z.infer<typeof MockRecommendationCandidateSchema>;

export const RecommendationCandidateSchema = z.union([
  QlooRecommendationCandidateSchema,
  MockRecommendationCandidateSchema,
]);
export type RecommendationCandidate = z.infer<typeof RecommendationCandidateSchema>;

export const PreferenceResponseSchema = z.enum([
  "like",
  "dislike",
  "prefer_a",
  "prefer_b",
  "both",
  "neither",
  "unknown",
]);
export type PreferenceResponse = z.infer<typeof PreferenceResponseSchema>;

export const PreferenceTargetTypeSchema = z.enum(["tag", "entity"]);

export const PreferenceAnswerSchema = z.object({
  questionId: z.string().min(1),
  targetType: PreferenceTargetTypeSchema,
  targetIds: z.array(z.string().min(1)).min(1),
  response: PreferenceResponseSchema,
  timestamp: z.number().int().nonnegative(),
  /** S9.6: exploration round the answer belongs to (absent = round 1). */
  round: z.number().int().positive().optional(),
});
export type PreferenceAnswer = z.infer<typeof PreferenceAnswerSchema>;

/** A question the server may ask; answers are validated against `allowedResponses`. */
export const QuestionSchema = z.object({
  questionId: z.string().min(1),
  text: z.string().min(1),
  targetType: PreferenceTargetTypeSchema,
  targetIds: z.array(z.string().min(1)).min(1),
  allowedResponses: z.array(PreferenceResponseSchema).min(1),
});
export type Question = z.infer<typeof QuestionSchema>;

/**
 * S9.6 item-level feedback. A rejection concerns that one verified candidate,
 * never its tags. `correction` records an explicit reversal of an earlier
 * positive entity preference.
 */
export const RecommendationFeedbackSchema = z.object({
  action: z.enum(["reject", "accept", "continue"]),
  entityId: z.string().min(1).optional(),
  round: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  correction: z.literal("reversed_positive").optional(),
});
export type RecommendationFeedback = z.infer<typeof RecommendationFeedbackSchema>;

export const TasteSessionSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  anchorIds: z.array(z.string().min(1)).min(1),
  sourceType: EntityTypeSchema,
  targetType: EntityTypeSchema,
  positiveTagIds: z.array(z.string()),
  rejectedTagIds: z.array(z.string()),
  positiveEntityIds: z.array(z.string()),
  rejectedEntityIds: z.array(z.string()),
  answers: z.array(PreferenceAnswerSchema),
  askedQuestionIds: z.array(z.string()),
  currentQuestionId: z.string().optional(),
  questionCount: z.number().int().nonnegative(),
  maxQuestions: z.number().int().positive().max(MAX_QUESTIONS_LIMIT),
  qlooCallCount: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  // Internal additions (allowed by the skill): lifecycle, provider mode and agent usage.
  // S9.6: "finished" = the current round is presenting results (continuable);
  // "accepted" = the user chose a recommendation (terminal).
  status: z.enum(["active", "finished", "accepted"]),
  mode: ProviderModeSchema,
  agentToolCallCount: z.number().int().nonnegative(),
  // S7 live accounting (absent for mock sessions and sessions created before S7).
  geminiRequestCount: z.number().int().nonnegative().optional(),
  geminiCostUsd: z.number().nonnegative().optional(),
  // S9.6 multi-round exploration (all optional: sessions stored before S9.6 are round 1).
  /** Current round; `questionCount`/`maxQuestions` are per round, history is cumulative. */
  round: z.number().int().positive().optional(),
  /** Semantic dimensions already asked (tag label or unordered entity pair), across rounds. */
  askedDimensions: z.array(z.string()).optional(),
  /** Final recommendations already presented in earlier rounds (not the current one). */
  presentedEntityIds: z.array(z.string()).optional(),
  recommendationFeedback: z.array(RecommendationFeedbackSchema).optional(),
  acceptedEntityId: z.string().optional(),
});
export type TasteSession = z.infer<typeof TasteSessionSchema>;

export const AgentDecisionSchema = z.object({
  action: z.enum(["retrieve", "enrich", "ask", "finish"]),
  selectedQuestionId: z.string().min(1).optional(),
  questionText: z.string().min(1).optional(),
  reasonCode: z.enum([
    "insufficient_candidates",
    "insufficient_metadata",
    "informative_question",
    "stable_recommendations",
    "question_budget_exhausted",
  ]),
  done: z.boolean(),
});
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/** A candidate with its current position and the preference evidence that moved it. */
export const RankedRecommendationSchema = z.object({
  candidate: RecommendationCandidateSchema,
  position: z.number().int().positive(),
  previousPosition: z.number().int().positive().nullable(),
  score: z.number(),
  matchedPositiveTagIds: z.array(z.string()),
  matchedRejectedTagIds: z.array(z.string()),
  explanation: z.string(),
});
export type RankedRecommendation = z.infer<typeof RankedRecommendationSchema>;
