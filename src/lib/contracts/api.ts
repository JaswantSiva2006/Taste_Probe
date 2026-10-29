import { z } from "zod";
import {
  AgentDecisionSchema,
  DiscoveryInputSchema,
  EntitySummarySchema,
  EntityTypeSchema,
  PreferenceAnswerSchema,
  PreferenceResponseSchema,
  ProviderModeSchema,
  QuestionSchema,
  RankedRecommendationSchema,
} from "./domain";

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
  "NO_RECOMMENDATIONS",
  "INVALID_SESSION_TOKEN",
  "SESSION_EXPIRED",
  "SESSION_MODE_MISMATCH",
  "SESSION_FINISHED",
  "QUESTION_MISMATCH",
  "INVALID_QUESTION",
  "INVALID_ANSWER",
  "QUESTION_BUDGET_EXHAUSTED",
  "QLOO_BUDGET_EXHAUSTED",
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

// ---- Shared discovery state view (start/answer/finish responses) ----------

export const FinishReasonSchema = z.enum([
  "user_finished",
  "question_budget_exhausted",
  "stable_recommendations",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

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
  agent: z.object({ name: z.string(), decision: AgentDecisionSchema }),
  usage: z.object({
    qlooCallCount: z.number().int().nonnegative(),
    maxQlooCalls: z.number().int().positive(),
    agentToolCallCount: z.number().int().nonnegative(),
  }),
});
export type DiscoveryView = z.infer<typeof DiscoveryViewSchema>;
