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
import { AdaptivePoolStateSchema } from "@/lib/discovery/adaptive-pool";
import { signToken, verifyToken } from "./token";

/** Full session state. Authoritative copy lives in the SessionStore, never in the token. */
export const SessionStateSchema = z.object({
  session: TasteSessionSchema,
  seed: EntitySummarySchema,
  candidates: z.array(RecommendationCandidateSchema),
  /** Ranked entity order shown to the user after the last transition. */
  order: z.array(z.string()),
  finishReason: FinishReasonSchema.nullable(),
  /** S9.10 optional foundation; absent is the exact pre-S9.10 session shape. */
  adaptivePool: AdaptivePoolStateSchema.optional(),
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
    // randomUUID uses a CSPRNG: 122 random bits, unpredictable.
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

/**
 * What a token authenticates: which session, which revision the client last
 * saw, and when it expires. It carries no mutable session state.
 */
export const SessionClaimsSchema = z.object({
  v: z.literal(2),
  sid: z.string().min(1),
  rev: z.number().int().nonnegative(),
  exp: z.number().int(),
});
export type SessionClaims = z.infer<typeof SessionClaimsSchema>;

export function issueSessionToken(claims: Omit<SessionClaims, "v">, secret: string): string {
  return signToken(SessionClaimsSchema.parse({ v: 2, ...claims }), secret);
}

export function verifySessionToken(token: string, secret: string, now: number): SessionClaims {
  const parsed = SessionClaimsSchema.safeParse(verifyToken(token, secret));
  if (!parsed.success) throw new AppError("INVALID_SESSION_TOKEN", 401, "Session token is invalid");
  if (now >= parsed.data.exp) throw new AppError("SESSION_EXPIRED", 401, "Session has expired; start a new discovery");
  return parsed.data;
}
