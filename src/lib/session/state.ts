import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EntitySummarySchema,
  FinishReasonSchema,
  RecommendationCandidateSchema,
  TasteSessionSchema,
  type EntityType,
  type ProviderMode,
  type TasteSession,
} from "@/lib/contracts";
import { AppError } from "@/lib/validation/errors";
import { signToken, verifyToken } from "./token";

/**
 * G2 session service. The full signed state travels with the client so any
 * server instance can continue the session; integrity comes from the HMAC.
 */
export const SessionStateSchema = z.object({
  session: TasteSessionSchema,
  seed: EntitySummarySchema,
  candidates: z.array(RecommendationCandidateSchema),
  /** Ranked entity order shown to the user after the last transition. */
  order: z.array(z.string()),
  finishReason: FinishReasonSchema.nullable(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export type SessionSettings = { signingSecret: string; ttlSeconds: number };

export function createSession(input: {
  anchorIds: string[];
  sourceType: EntityType;
  targetType: EntityType;
  maxQuestions: number;
  mode: ProviderMode;
  now: number;
  ttlSeconds: number;
}): TasteSession {
  return {
    version: 1,
    sessionId: randomUUID(),
    revision: 0,
    anchorIds: input.anchorIds,
    sourceType: input.sourceType,
    targetType: input.targetType,
    positiveTagIds: [],
    rejectedTagIds: [],
    positiveEntityIds: [],
    rejectedEntityIds: [],
    answers: [],
    askedQuestionIds: [],
    currentQuestionId: undefined,
    questionCount: 0,
    maxQuestions: input.maxQuestions,
    qlooCallCount: 0,
    createdAt: input.now,
    expiresAt: input.now + input.ttlSeconds * 1000,
    status: "active",
    mode: input.mode,
    agentToolCallCount: 0,
  };
}

export function encodeSessionState(state: SessionState, settings: SessionSettings): string {
  return signToken(SessionStateSchema.parse(state), settings.signingSecret);
}

export function decodeSessionState(
  token: string,
  settings: SessionSettings,
  expectedMode: ProviderMode,
  now: number,
): SessionState {
  const parsed = SessionStateSchema.safeParse(verifyToken(token, settings.signingSecret));
  if (!parsed.success) {
    throw new AppError("INVALID_SESSION_TOKEN", 401, "Session token is invalid");
  }
  const state = parsed.data;
  if (now >= state.session.expiresAt) {
    throw new AppError("SESSION_EXPIRED", 401, "Session has expired; start a new discovery");
  }
  if (state.session.mode !== expectedMode) {
    throw new AppError("SESSION_MODE_MISMATCH", 409, "Session was created in a different provider mode");
  }
  return state;
}
