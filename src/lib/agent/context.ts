import { createHash } from "node:crypto";
import type { EntityType, Question, RankedRecommendation, TasteSession } from "@/lib/contracts";
import type { QuestionScoreComponents, QuestionTrace } from "@/lib/discovery/question-optimizer";
import { isUsefulTag } from "@/lib/discovery/tag-quality";

/**
 * Bounded decision context for the agent (S6). Built only from verified,
 * server-side data: S5-eligible questions, normalized candidates, explicit
 * preferences and budgets. Never contains tokens, secrets or raw provider payloads.
 */

export const DEFAULT_QUESTION_SHORTLIST = 3;
const MAX_CANDIDATES = 8;
const MAX_TAGS_PER_CANDIDATE = 6;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 160;

export type ContextQuestion = {
  questionId: string;
  questionType: QuestionTrace["questionType"];
  /** Approved, deterministic wording; the only text ever displayed. */
  text: string;
  targetIds: string[];
  components: QuestionScoreComponents;
};

export type ContextCandidate = {
  entityId: string;
  name: string;
  rank: number;
  position: number;
  tags: string[];
  description?: string;
};

export type AgentPermissions = { ask: boolean; retrieve: boolean; enrich: boolean; finish: boolean };

export type AgentDecisionContext = {
  /** Hash of the session ID: correlates traces without exposing the identifier. */
  sessionRef: string;
  sessionStatus: "active" | "finished" | "expired";
  sourceType: EntityType;
  targetType: EntityType;
  seedEntityIds: string[];
  questionCount: number;
  maxQuestions: number;
  toolCallsRemaining: number;
  qlooCallsRemaining: number;
  candidates: ContextCandidate[];
  questions: ContextQuestion[];
  askedQuestionIds: string[];
  positive: { tagIds: string[]; entityIds: string[] };
  negative: { tagIds: string[]; entityIds: string[] };
  permissions: AgentPermissions;
};

/** Collapses whitespace/control characters and bounds length. External text stays data. */
export function sanitizeText(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function sessionRefOf(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}

export type BuildContextInput = {
  session: TasteSession;
  ranked: RankedRecommendation[];
  /** S5 eligible traces, already ordered by J(q). */
  eligible: QuestionTrace[];
  toolCallsRemaining: number;
  qlooCallsRemaining: number;
  now: number;
  shortlistSize?: number;
  allowRetrieval?: boolean;
  allowEnrichment?: boolean;
  allowEarlyFinish?: boolean;
};

export function buildAgentContext(input: BuildContextInput): AgentDecisionContext {
  const { session } = input;
  const status = session.status === "finished" ? "finished" : input.now >= session.expiresAt ? "expired" : "active";
  const asked = new Set(session.askedQuestionIds);
  const questions = input.eligible
    .filter((trace) => !asked.has(trace.question.questionId))
    .slice(0, input.shortlistSize ?? DEFAULT_QUESTION_SHORTLIST)
    .map((trace) => ({
      questionId: trace.question.questionId,
      questionType: trace.questionType,
      text: trace.question.text,
      targetIds: [...trace.question.targetIds],
      components: { ...trace.components },
    }));
  const candidates = input.ranked.slice(0, MAX_CANDIDATES).map((item) => ({
    entityId: item.candidate.entityId,
    name: sanitizeText(item.candidate.name, MAX_NAME) ?? item.candidate.entityId,
    rank: item.candidate.rank,
    position: item.position,
    tags: item.candidate.tags
      .filter(isUsefulTag)
      .slice(0, MAX_TAGS_PER_CANDIDATE)
      .map((tag) => sanitizeText(tag.name, 40) ?? tag.id),
    ...(sanitizeText(item.candidate.description, MAX_DESCRIPTION)
      ? { description: sanitizeText(item.candidate.description, MAX_DESCRIPTION) }
      : {}),
  }));
  const toolCallsRemaining = Math.max(0, input.toolCallsRemaining);
  const qlooCallsRemaining = Math.max(0, input.qlooCallsRemaining);
  return {
    sessionRef: sessionRefOf(session.sessionId),
    sessionStatus: status,
    sourceType: session.sourceType,
    targetType: session.targetType,
    seedEntityIds: [...session.anchorIds],
    questionCount: session.questionCount,
    maxQuestions: session.maxQuestions,
    toolCallsRemaining,
    qlooCallsRemaining,
    candidates,
    questions,
    askedQuestionIds: [...session.askedQuestionIds],
    positive: { tagIds: [...session.positiveTagIds], entityIds: [...session.positiveEntityIds] },
    negative: { tagIds: [...session.rejectedTagIds], entityIds: [...session.rejectedEntityIds] },
    permissions: {
      ask: questions.length > 0 && session.questionCount < session.maxQuestions,
      retrieve: (input.allowRetrieval ?? true) && qlooCallsRemaining > 0,
      enrich: (input.allowEnrichment ?? true) && qlooCallsRemaining > 0 && candidates.length > 0,
      finish: input.allowEarlyFinish ?? true,
    },
  };
}

/** Questions as the canonical validator expects them (approved text and targets). */
export function offeredQuestions(context: AgentDecisionContext): Question[] {
  return context.questions.map((q) => ({
    questionId: q.questionId,
    text: q.text,
    targetType: q.questionType === "tag" ? "tag" : "entity",
    targetIds: q.targetIds,
    allowedResponses: q.questionType === "tag" ? ["like", "dislike", "unknown"] : ["prefer_a", "prefer_b", "both", "neither", "unknown"],
  }));
}
