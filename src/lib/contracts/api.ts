import { z } from "zod";
import {
  AgentDecisionSchema,
  DiscoveryInputSchema,
  EntitySummarySchema,
  EntityTypeSchema,
  PreferenceAnswerSchema,
  PreferenceResponseSchema,
  ProviderModeSchema,
  ProvenanceSchema,
  QuestionSchema,
  RankedRecommendationSchema,
} from "./domain";
import { PublicCapabilitiesSchema } from "./capabilities";
import { ListeningViewSchema } from "./listening";

/**
 * HTTP wire contracts. The session token travels in the JSON body:
 * returned by start/answer/finish as `data.sessionToken`, sent back by
 * answer/finish as `sessionToken`.
 */

// ---- Envelope -------------------------------------------------------------

export const ResponseMetaSchema = z.object({
  requestId: z.string().min(1),
  mode: ProviderModeSchema,
});
export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;

export const ApiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "INVALID_JSON",
  "ENTITY_NOT_FOUND",
  "ENTITY_TYPE_MISMATCH",
  "ENTITY_NOT_RESOLVED",
  "UNSUPPORTED_DOMAIN",
  "NO_RECOMMENDATIONS",
  "INVALID_SESSION_TOKEN",
  "SESSION_EXPIRED",
  "SESSION_MODE_MISMATCH",
  "SESSION_FINISHED",
  "SESSION_REVISION_CONFLICT",
  "SESSION_STORE_UNAVAILABLE",
  "QUESTION_MISMATCH",
  "INVALID_QUESTION",
  "INVALID_ANSWER",
  "QUESTION_BUDGET_EXHAUSTED",
  // S9.6 multi-round exploration
  "ROUND_IN_PROGRESS",
  "EXPLORATION_CLOSED",
  "EXPLORATION_EXHAUSTED",
  "EXPLORATION_BUDGET_EXHAUSTED",
  "INVALID_RECOMMENDATION",
  // S9.9 music playback
  "ARTIST_NOT_IN_EXPLORATION",
  // S9.12 listening loop
  "LISTENING_NOT_STARTED",
  "LISTENING_STATE_CONFLICT",
  "LISTENING_FINISHED",
  "QLOO_BUDGET_EXHAUSTED",
  "QLOO_AUTH_ERROR",
  "QLOO_PERMISSION_ERROR",
  "QLOO_BAD_REQUEST",
  "QLOO_RATE_LIMITED",
  "QLOO_TIMEOUT",
  "QLOO_UPSTREAM_ERROR",
  "QLOO_INVALID_RESPONSE",
  "RATE_LIMITED",
  "SERVICE_DISABLED",
  "AGENT_DECISION_INVALID",
  "LIVE_PROVIDER_NOT_IMPLEMENTED",
  "CONFIG_ERROR",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
});

export const apiSuccessSchema = <T extends z.ZodType>(data: T) =>
  z.object({ ok: z.literal(true), data, meta: ResponseMetaSchema });

export const ApiFailureSchema = z.object({
  ok: z.literal(false),
  error: ApiErrorSchema,
  meta: ResponseMetaSchema,
});
export type ApiFailure = z.infer<typeof ApiFailureSchema>;

export type ApiSuccess<T> = { ok: true; data: T; meta: ResponseMeta };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

// ---- GET /api/health ------------------------------------------------------

export const HealthDataSchema = z.object({
  status: z.literal("ok"),
  mode: ProviderModeSchema,
  qloo: z.object({ mode: ProviderModeSchema, implemented: z.boolean() }),
  agent: z.string(),
  readiness: z.object({ configuration: z.literal("ready"), sessionStore: z.enum(["memory", "redis"]), dependencies: z.literal("configured") }).optional(),
  /** S9.2: enabled domain pairs only (read-only projection of the server registry). */
  capabilities: PublicCapabilitiesSchema.optional(),
});
export type HealthData = z.infer<typeof HealthDataSchema>;

// ---- GET /api/entities/search?q=&type= ------------------------------------

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  type: EntityTypeSchema.optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchDataSchema = z.object({ results: z.array(EntitySummarySchema) });
export type SearchData = z.infer<typeof SearchDataSchema>;

// ---- POST /api/discovery/start --------------------------------------------

export const StartRequestSchema = DiscoveryInputSchema.extend({
  /** ID chosen from search results. Validated server-side against the provider. */
  selectedEntityId: z.string().trim().min(1).max(200).optional(),
}).strict();
export type StartRequest = z.infer<typeof StartRequestSchema>;

// ---- POST /api/discovery/answer -------------------------------------------

export const AnswerRequestSchema = z
  .object({
    sessionToken: z.string().min(1).max(32_000),
    questionId: z.string().min(1).max(200),
    response: PreferenceResponseSchema,
  })
  .strict();
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

// ---- POST /api/discovery/finish -------------------------------------------

export const FinishRequestSchema = z
  .object({ sessionToken: z.string().min(1).max(32_000) })
  .strict();
export type FinishRequest = z.infer<typeof FinishRequestSchema>;

// ---- S9.6: POST /api/discovery/{reject,accept,continue} --------------------
// Each carries only the signed token and, where needed, ONE entity ID that the
// server checks against the current round's verified final recommendations.
// History is never accepted from the client.

const EntityRef = z.string().trim().min(1).max(200);

export const RecommendationFeedbackRequestSchema = z
  .object({ sessionToken: z.string().min(1).max(32_000), entityId: EntityRef })
  .strict();
export type RecommendationFeedbackRequest = z.infer<typeof RecommendationFeedbackRequestSchema>;

export const ContinueRequestSchema = z
  .object({ sessionToken: z.string().min(1).max(32_000) })
  .strict();
export type ContinueRequest = z.infer<typeof ContinueRequestSchema>;

// ---- Shared discovery state view (start/answer/finish responses) ----------

export const FinishReasonSchema = z.enum([
  "user_finished",
  "question_budget_exhausted",
  "stable_recommendations",
  /** S9.3: the verified candidates supported no grounded question, so none was asked. */
  "insufficient_question_evidence",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const UpdateMechanismSchema = z.enum(["INITIAL_RETRIEVAL", "QLOO_RERETRIEVAL", "LOCAL_RERANK", "UNCHANGED"]);
export type UpdateMechanism = z.infer<typeof UpdateMechanismSchema>;

export const RecommendationUpdateSchema = z.object({
  mechanism: UpdateMechanismSchema,
  /** True only when a Qloo Insights request actually ran in this request. */
  qlooRequested: z.boolean(),
  /** Internal application correlation IDs of those requests (not Qloo-issued IDs). */
  internalCorrelationIds: z.array(z.string()),
  previousTopIds: z.array(z.string()),
  updatedTopIds: z.array(z.string()),
  /** Confirmed preference IDs that drove the update. */
  preferenceIds: z.array(z.string()),
  /** S9.11 server-confirmed adaptive-pool transition (absent while the feature is off). */
  poolTransition: z.object({
    decision: z.enum(["KEEP", "LOCAL_REPLACE", "FETCH_AND_MERGE", "EXPAND", "DEGRADED_KEEP"]),
    reasonCodes: z.array(z.string()),
    previousDisplayedIds: z.array(z.string()), currentDisplayedIds: z.array(z.string()),
    newReservoirIds: z.array(z.string()), newlyDisplayedIds: z.array(z.string()), removedDisplayedIds: z.array(z.string()),
    qlooCallsMade: z.number().int().nonnegative(),
    queryFamily: z.enum(["BASE", "PROFILE_REFRESH", "TAG_FOCUS", "PAGINATE", "DIVERSIFY", "VALIDATED_EXCLUSION_REFRESH"]).nullable(),
    retrievalOutcome: z.enum(["not_requested", "merged", "empty", "failed", "duplicate", "budget_exhausted"]),
    sessionRevision: z.number().int().nonnegative(),
  }).optional(),
});
export type RecommendationUpdate = z.infer<typeof RecommendationUpdateSchema>;

export const TurnTraceSchema = z.object({
  turnId: z.string(),
  qlooRequests: z.number().int().nonnegative(),
  geminiRequests: z.number().int().nonnegative(),
  geminiRequestBreakdown: z.object({ proposer: z.number().int().nonnegative(), decisionAgent: z.number().int().nonnegative() }).optional(),
  geminiTokens: z.object({ input: z.number(), output: z.number(), thinking: z.number() }),
  estimatedGeminiCostUsd: z.number().nullable(),
  latencyMs: z.number(),
  sessionStore: z.enum(["memory", "redis"]),
  decisions: z.array(
    z.object({
      mode: z.enum(["LIVE_GEMINI", "MOCK_AGENT", "DETERMINISTIC_FALLBACK"]),
      action: z.enum(["retrieve", "enrich", "ask", "finish"]),
      selectedQuestionId: z.string().nullable(),
      validation: z.string(),
      fallbackReason: z.string().nullable(),
    }),
  ),
  questionGeneration: z.object({
    mode: z.enum(["deterministic", "llm_grounded"]),
    generated: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    fallbackReason: z.string().nullable(),
    selected: z.object({
      questionId: z.string(),
      evidenceIds: z.array(z.string()),
      components: z.object({
        entropy: z.number(), separation: z.number(), interpretability: z.number(),
        redundancy: z.number(), ambiguity: z.number(), final: z.number(),
      }),
      positiveTop: z.array(z.string()),
      negativeTop: z.array(z.string()),
    }).optional(),
  }).optional(),
});
export type TurnTrace = z.infer<typeof TurnTraceSchema>;

// ---- S9.2 Discovery Path (presentation of the final shortlist) ------------

/** GO_FURTHER is reserved: no current metadata can justify it, so the presenter never emits it. */
export const DiscoveryPathRoleSchema = z.enum(["START_HERE", "EXPLORE_NEXT", "ANOTHER_DIRECTION", "GO_FURTHER"]);
export type DiscoveryPathRole = z.infer<typeof DiscoveryPathRoleSchema>;

export const PathExplanationKindSchema = z.enum(["preference_match", "metadata_contrast", "source_grounded"]);
export type PathExplanationKind = z.infer<typeof PathExplanationKindSchema>;

/** Every ID resolves inside the same response: seed, preferences, or the candidate's own tags. */
export const PathEvidenceSchema = z.object({
  provenance: ProvenanceSchema,
  seedEntityIds: z.array(z.string()),
  /** Confirmed positive preference IDs (tag or entity) found in `preferences`. */
  preferenceIds: z.array(z.string()),
  /** Candidate tag IDs cited as metadata (e.g. a contrast). */
  tagIds: z.array(z.string()),
});
export type PathEvidence = z.infer<typeof PathEvidenceSchema>;

export const DiscoveryPathItemSchema = z.object({
  role: DiscoveryPathRoleSchema,
  recommendationEntityId: z.string().min(1),
  /** 1-based position in `recommendations` (unchanged ranking). */
  position: z.number().int().positive(),
  explanation: z.object({
    kind: PathExplanationKindSchema,
    text: z.string().min(1),
    evidence: PathEvidenceSchema,
  }),
});
export type DiscoveryPathItem = z.infer<typeof DiscoveryPathItemSchema>;

export const DiscoveryPathSchema = z.object({
  version: z.literal(1),
  sourceType: EntityTypeSchema,
  targetType: EntityTypeSchema,
  featured: z.array(DiscoveryPathItemSchema).max(3),
  /** Remaining final recommendations in ranked order, never repeating a featured ID. */
  remainingEntityIds: z.array(z.string()),
});
export type DiscoveryPath = z.infer<typeof DiscoveryPathSchema>;

// ---- S9.6 exploration state -----------------------------------------------

export const ExplorationStatusSchema = z.enum(["asking", "presenting", "accepted"]);

/** Why a "continue" is not currently possible (null when it is). */
export const ContinueBlockedReasonSchema = z.enum(["round_in_progress", "accepted", "candidates_exhausted", "budget_exhausted"]);

export const ExplorationStateSchema = z.object({
  /** Same as sessionId: one exploration = one server-side session record. */
  explorationId: z.string().min(1),
  round: z.number().int().positive(),
  status: ExplorationStatusSchema,
  acceptedEntityId: z.string().nullable(),
  rejectedRecommendationIds: z.array(z.string()),
  /** Questions asked across all rounds (cumulative). */
  totalQuestionsAsked: z.number().int().nonnegative(),
  /** Final recommendations presented in earlier rounds. */
  previouslyPresentedIds: z.array(z.string()),
  /** Eligible verified candidates not yet presented (what a new round can surface). */
  unseenCandidateCount: z.number().int().nonnegative(),
  canContinue: z.boolean(),
  continueBlockedReason: ContinueBlockedReasonSchema.nullable(),
  budget: z.object({
    qlooUsed: z.number().int().nonnegative(),
    qlooMax: z.number().int().positive(),
    geminiUsed: z.number().int().nonnegative(),
    geminiMax: z.number().int().positive(),
  }),
  expiresAt: z.number().int(),
  /**
   * S9.7 projection of the stored answers, oldest first, for the "what TasteProbe
   * remembers" panel. Labels come from verified candidate data on the server; a skip
   * stays `unknown` and is never a dislike. Optional so S9.6 responses still validate.
   */
  answerHistory: z
    .array(
      z.object({
        round: z.number().int().positive(),
        questionId: z.string(),
        targetType: z.enum(["tag", "entity"]),
        response: PreferenceResponseSchema,
        label: z.string(),
      }),
    )
    .optional(),
});
export type ExplorationState = z.infer<typeof ExplorationStateSchema>;

export const DiscoveryViewSchema = z.object({
  sessionToken: z.string().min(1),
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  status: z.enum(["asking", "finished"]),
  finishReason: FinishReasonSchema.nullable(),
  seed: EntitySummarySchema,
  targetType: EntityTypeSchema,
  questionCount: z.number().int().nonnegative(),
  maxQuestions: z.number().int().positive(),
  currentQuestion: QuestionSchema.nullable(),
  lastAnswer: PreferenceAnswerSchema.nullable(),
  preferences: z.object({
    positiveTagIds: z.array(z.string()),
    rejectedTagIds: z.array(z.string()),
    positiveEntityIds: z.array(z.string()),
    rejectedEntityIds: z.array(z.string()),
  }),
  /** Full ranked shortlist while asking; top FINAL_RECOMMENDATION_COUNT when finished. */
  recommendations: z.array(RankedRecommendationSchema),
  rankingChanged: z.boolean(),
  agent: z.object({
    name: z.string(),
    decision: AgentDecisionSchema,
    /** S7 (live): who actually made the decision. Absent for the legacy mock path. */
    mode: z.enum(["LIVE_GEMINI", "MOCK_AGENT", "DETERMINISTIC_FALLBACK"]).optional(),
    fallbackReason: z.string().nullable().optional(),
  }),
  usage: z.object({
    qlooCallCount: z.number().int().nonnegative(),
    maxQlooCalls: z.number().int().positive(),
    agentToolCallCount: z.number().int().nonnegative(),
    geminiRequestCount: z.number().int().nonnegative().optional(),
  }),
  /** S7 (live): how the shortlist changed in this request. */
  recommendationUpdate: RecommendationUpdateSchema.nullable().optional(),
  /** S7 (live): set when a provider failed and an existing verified shortlist was kept. */
  degraded: z.object({ reason: z.string() }).nullable().optional(),
  /** S7 (live): sanitized per-request accounting. */
  trace: TurnTraceSchema.optional(),
  /** S9.2: present only on finished views; derived from `recommendations`, never stored. */
  discoveryPath: DiscoveryPathSchema.optional(),
  /** S9.6: multi-round exploration state (additive; old clients may ignore it). */
  exploration: ExplorationStateSchema.optional(),
  /** S9.12: listening loop (music explorations only; additive). */
  listening: ListeningViewSchema.optional(),
});
export type DiscoveryView = z.infer<typeof DiscoveryViewSchema>;
