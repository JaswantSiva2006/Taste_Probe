import type { Question, RecommendationCandidate, TasteSession } from "@/lib/contracts";
import { isUsefulTag } from "@/lib/discovery/tag-quality";
import { ProposedQuestionBatchSchema, type ProposedQuestion } from "./schema";
import { renderEntityQuestion, renderTagQuestion } from "./renderer";

export type ProposalRejection =
  | "invalid_schema" | "unknown_entity" | "unknown_tag" | "incorrect_association"
  | "unsupported_semantics" | "unsupported_mapping" | "duplicate" | "previously_asked";

export type ValidationReport = {
  questions: Question[];
  generated: number;
  accepted: number;
  rejected: number;
  rejectionCounts: Partial<Record<ProposalRejection, number>>;
};

const TAG_ANSWERS = ["like", "dislike", "unknown"];
const ENTITY_ANSWERS = ["prefer_a", "prefer_b", "both", "neither", "unknown"];
const sameSet = (a: string[], b: string[]) => {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};
const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

function reject(report: ValidationReport, reason: ProposalRejection): void {
  report.rejected += 1;
  report.rejectionCounts[reason] = (report.rejectionCounts[reason] ?? 0) + 1;
}

function canonicalTagQuestion(proposal: ProposedQuestion, candidates: RecommendationCandidate[]): Question | ProposalRejection {
  if (proposal.targetIds.length !== 1 || !sameSet(proposal.supportedAnswerTypes, TAG_ANSWERS)) return "unsupported_mapping";
  const tagId = proposal.targetIds[0]!;
  const carriers = candidates.filter((candidate) => candidate.tags.some((tag) => tag.id === tagId));
  if (!carriers.length) return "unknown_tag";
  const tag = carriers.flatMap((candidate) => candidate.tags).find((item) => item.id === tagId)!;
  if (!isUsefulTag(tag) || normalized(proposal.preferenceDimension) !== normalized(tag.name)) return "unsupported_semantics";
  for (const evidence of proposal.evidence) {
    const entity = candidates.find((candidate) => candidate.entityId === evidence.entityId);
    if (!entity) return "unknown_entity";
    for (const claimedTag of evidence.tagIds) {
      if (!candidates.some((candidate) => candidate.tags.some((item) => item.id === claimedTag))) return "unknown_tag";
      if (!entity.tags.some((item) => item.id === claimedTag)) return "incorrect_association";
    }
  }
  if (!proposal.evidence.some((evidence) => evidence.tagIds.includes(tagId))) return "incorrect_association";
  const noun = carriers[0]!.entityType === "book" ? "books" as const : "movies" as const;
  return {
    questionId: "tag:" + tagId,
    text: renderTagQuestion({ proposal, tag, noun, strategy: "hybrid" }),
    targetType: "tag",
    targetIds: [tagId],
    allowedResponses: ["like", "dislike", "unknown"],
  };
}

function canonicalEntityQuestion(proposal: ProposedQuestion, candidates: RecommendationCandidate[]): Question | ProposalRejection {
  if (proposal.targetIds.length !== 2 || new Set(proposal.targetIds).size !== 2 || !sameSet(proposal.supportedAnswerTypes, ENTITY_ANSWERS)) {
    return "unsupported_mapping";
  }
  const [aId, bId] = proposal.targetIds as [string, string];
  const a = candidates.find((candidate) => candidate.entityId === aId);
  const b = candidates.find((candidate) => candidate.entityId === bId);
  if (!a || !b) return "unknown_entity";
  for (const evidence of proposal.evidence) {
    const entity = candidates.find((candidate) => candidate.entityId === evidence.entityId);
    if (!entity) return "unknown_entity";
    for (const claimedTag of evidence.tagIds) {
      if (!candidates.some((candidate) => candidate.tags.some((item) => item.id === claimedTag))) return "unknown_tag";
      if (!entity.tags.some((item) => item.id === claimedTag)) return "incorrect_association";
    }
  }
  if (![aId, bId].every((id) => proposal.evidence.some((evidence) => evidence.entityId === id))) return "incorrect_association";
  const noun = a.entityType === "book" ? "book" : "movie";
  return {
    questionId: "entity:" + aId + "|" + bId,
    text: renderEntityQuestion({ proposal, aName: a.name, bName: b.name, noun }),
    targetType: "entity",
    targetIds: [aId, bId],
    allowedResponses: ["prefer_a", "prefer_b", "both", "neither", "unknown"],
  };
}

export function validateProposedQuestions(
  raw: unknown,
  candidates: RecommendationCandidate[],
  session: Pick<TasteSession, "askedQuestionIds">,
): ValidationReport {
  const report: ValidationReport = { questions: [], generated: 0, accepted: 0, rejected: 0, rejectionCounts: {} };
  const parsed = ProposedQuestionBatchSchema.safeParse(raw);
  if (!parsed.success) {
    reject(report, "invalid_schema");
    return report;
  }
  report.generated = parsed.data.proposals.length;
  const dimensions = new Set<string>();
  const ids = new Set<string>();
  for (const proposal of parsed.data.proposals) {
    const question = proposal.questionType === "tag"
      ? canonicalTagQuestion(proposal, candidates)
      : canonicalEntityQuestion(proposal, candidates);
    if (typeof question === "string") {
      reject(report, question);
      continue;
    }
    const dimension = normalized(proposal.preferenceDimension);
    if (session.askedQuestionIds.includes(question.questionId)) reject(report, "previously_asked");
    else if (ids.has(question.questionId) || dimensions.has(dimension)) reject(report, "duplicate");
    else {
      ids.add(question.questionId);
      dimensions.add(dimension);
      report.questions.push(question);
      report.accepted += 1;
    }
  }
  return report;
}
