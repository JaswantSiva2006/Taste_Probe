import type { Question, RankedRecommendation, RecommendationCandidate } from "@/lib/contracts";
import { orderOf, rankCandidates, type PreferenceSets } from "./ranking";
import { isUsefulTag } from "./tag-quality";
import { orderAwareSeparation, semanticQuestionScores } from "./question-quality";

export const DEFAULT_TAU = 3;
export const DEFAULT_TOP_K = 5;

export type QuestionScoreComponents = {
  entropy: number;
  separation: number;
  interpretability: number;
  redundancy: number;
  ambiguity: number;
  final: number;
};

export type QuestionTrace = {
  question: Question;
  questionType: "tag" | "entity_comparison";
  components: QuestionScoreComponents;
  evidenceIds: string[];
  positiveOrder: string[];
  negativeOrder: string[];
  reason: "eligible" | "rejected_unsupported" | "rejected_repeat" | "rejected_degenerate";
};

export type OptimizerResult = { eligible: QuestionTrace[]; rejected: QuestionTrace[] };
export type OptimizerOptions = {
  tau?: number;
  topK?: number;
  askedQuestionIds?: string[];
  preferences?: PreferenceSets;
  profile?: "s5" | "quality_v1";
};
type ResolvedOptions = Required<Omit<OptimizerOptions, "preferences">> & { preferences: PreferenceSets };

const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function rankWeights(ranks: number[], tau = DEFAULT_TAU): number[] {
  if (!ranks.length) return [];
  const safeTau = Number.isFinite(tau) && tau > 0 ? tau : DEFAULT_TAU;
  const minimum = Math.min(...ranks);
  const raw = ranks.map((rank) => Math.exp(-(rank - minimum) / safeTau));
  const sum = raw.reduce((total, weight) => total + weight, 0);
  return raw.map((weight) => weight / sum);
}

export function binaryEntropy(probability: number): number {
  const p = clamp(probability);
  if (p <= Number.EPSILON || p >= 1 - Number.EPSILON) return 0;
  return clamp(-p * Math.log2(p) - (1 - p) * Math.log2(1 - p));
}

export function topKSeparation(positive: string[], negative: string[], topK = DEFAULT_TOP_K): number {
  const k = Math.min(Math.max(0, Math.trunc(topK)), positive.length, negative.length);
  if (!k) return 0;
  const plus = new Set(positive.slice(0, k));
  const overlap = negative.slice(0, k).filter((id) => plus.has(id)).length;
  return clamp(1 - overlap / k);
}

const emptyPreferences = (): PreferenceSets => ({
  positiveTagIds: [],
  rejectedTagIds: [],
  positiveEntityIds: [],
  rejectedEntityIds: [],
});

function counterfactuals(
  question: Question,
  candidates: RecommendationCandidate[],
  preferences: PreferenceSets,
): { positive: string[]; negative: string[] } {
  const [a, b] = question.targetIds;
  const plus: PreferenceSets = {
    positiveTagIds: [...preferences.positiveTagIds],
    rejectedTagIds: [...preferences.rejectedTagIds],
    positiveEntityIds: [...preferences.positiveEntityIds],
    rejectedEntityIds: [...preferences.rejectedEntityIds],
  };
  const minus: PreferenceSets = {
    positiveTagIds: [...preferences.positiveTagIds],
    rejectedTagIds: [...preferences.rejectedTagIds],
    positiveEntityIds: [...preferences.positiveEntityIds],
    rejectedEntityIds: [...preferences.rejectedEntityIds],
  };
  if (question.targetType === "tag" && a) {
    plus.positiveTagIds = [...new Set([...plus.positiveTagIds, a])];
    minus.rejectedTagIds = [...new Set([...minus.rejectedTagIds, a])];
  } else if (a && b) {
    plus.positiveEntityIds = [...new Set([...plus.positiveEntityIds, a])];
    minus.positiveEntityIds = [...new Set([...minus.positiveEntityIds, b])];
  }
  return {
    positive: orderOf(rankCandidates(candidates, plus)),
    negative: orderOf(rankCandidates(candidates, minus)),
  };
}

function carrierIds(tagId: string, candidates: RecommendationCandidate[]): Set<string> {
  return new Set(
    candidates
      .filter((candidate) => candidate.tags.some((tag) => tag.id === tagId))
      .map((candidate) => candidate.entityId),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  return [...a].filter((value) => b.has(value)).length / union.size;
}

function redundancy(question: Question, candidates: RecommendationCandidate[], asked: string[]): number {
  if (asked.includes(question.questionId)) return 1;
  if (question.targetType === "entity") {
    const targets = new Set(question.targetIds);
    return clamp(
      Math.max(
        0,
        ...asked
          .filter((id) => id.startsWith("entity:"))
          .map((id) => jaccard(targets, new Set(id.slice("entity:".length).split("|")))),
      ),
    );
  }
  const current = carrierIds(question.targetIds[0] ?? "", candidates);
  return clamp(
    Math.max(
      0,
      ...asked
        .filter((id) => id.startsWith("tag:"))
        .map((id) => jaccard(current, carrierIds(id.slice("tag:".length), candidates))),
    ),
  );
}

function interpretability(question: Question, candidates: RecommendationCandidate[]): number {
  if (question.targetType === "tag") return 0.9;
  const selected = question.targetIds.map((id) =>
    candidates.find((candidate) => candidate.entityId === id),
  );
  const described = selected.filter((candidate) => candidate?.description?.trim()).length;
  return clamp(0.75 + described * 0.1);
}

function ambiguity(question: Question, candidates: RecommendationCandidate[]): number {
  if (question.targetType === "tag") return question.text.length > 100 ? 0.2 : 0.05;
  const [a, b] = question.targetIds.map((id) =>
    candidates.find((candidate) => candidate.entityId === id),
  );
  if (!a || !b) return 1;
  let penalty = 0;
  if (!a.description?.trim()) penalty += 0.2;
  if (!b.description?.trim()) penalty += 0.2;
  if (a.name.trim().toLowerCase() === b.name.trim().toLowerCase()) penalty += 0.5;
  return clamp(penalty);
}

function evidenceIsValid(question: Question, candidates: RecommendationCandidate[]): boolean {
  if (question.targetType === "tag") {
    if (
      question.targetIds.length !== 1 ||
      !question.allowedResponses.includes("like") ||
      !question.allowedResponses.includes("dislike")
    ) return false;
    return candidates.some((candidate) =>
      candidate.tags.some((tag) => tag.id === question.targetIds[0] && isUsefulTag(tag)),
    );
  }
  return (
    question.targetIds.length === 2 &&
    new Set(question.targetIds).size === 2 &&
    question.targetIds.every((id) =>
      candidates.some((candidate) => candidate.entityId === id),
    ) &&
    question.allowedResponses.includes("prefer_a") &&
    question.allowedResponses.includes("prefer_b")
  );
}

function scoreTrace(
  question: Question,
  ranked: RankedRecommendation[],
  options: ResolvedOptions,
): QuestionTrace {
  const candidates = ranked.map((item) => item.candidate);
  const weights = rankWeights(candidates.map((candidate) => candidate.rank), options.tau);
  const supported = evidenceIsValid(question, candidates);
  const repeated = options.askedQuestionIds.includes(question.questionId);
  let probability = 0;
  if (question.targetType === "tag") {
    probability = weights.reduce(
      (sum, weight, index) =>
        sum +
        (candidates[index]?.tags.some((tag) => tag.id === question.targetIds[0])
          ? weight
          : 0),
      0,
    );
  } else {
    const [a, b] = question.targetIds;
    const ai = candidates.findIndex((candidate) => candidate.entityId === a);
    const bi = candidates.findIndex((candidate) => candidate.entityId === b);
    const pairWeight = (weights[ai] ?? 0) + (weights[bi] ?? 0);
    probability = pairWeight ? (weights[ai] ?? 0) / pairWeight : 0;
  }
  const entropy = binaryEntropy(probability);
  const ranks = counterfactuals(question, candidates, options.preferences);
  const separation = topKSeparation(ranks.positive, ranks.negative, options.topK);
  const i = interpretability(question, candidates);
  const r = redundancy(question, candidates, options.askedQuestionIds);
  const u = ambiguity(question, candidates);
  const legacy = 0.4 * entropy + 0.25 * separation + 0.25 * i - 0.05 * r - 0.05 * u;
  const semantic = (semanticQuestionScores(question, candidates).mean - 1) / 4;
  const ordered = orderAwareSeparation(ranks.positive, ranks.negative, options.topK);
  const final = options.profile === "quality_v1"
    ? 0.6 * legacy + 0.25 * semantic + 0.15 * ordered
    : legacy;
  const reason = !supported
    ? "rejected_unsupported"
    : repeated
      ? "rejected_repeat"
      : question.targetType === "tag" && entropy === 0
        ? "rejected_degenerate"
        : "eligible";
  return {
    question,
    questionType: question.targetType === "tag" ? "tag" : "entity_comparison",
    components: {
      entropy: rounded(entropy),
      separation: rounded(separation),
      interpretability: rounded(i),
      redundancy: rounded(r),
      ambiguity: rounded(u),
      final: rounded(final),
    },
    evidenceIds: [...question.targetIds],
    positiveOrder: ranks.positive,
    negativeOrder: ranks.negative,
    reason,
  };
}

export function optimizeQuestions(
  questions: Question[],
  ranked: RankedRecommendation[],
  options: OptimizerOptions = {},
): OptimizerResult {
  const resolved: ResolvedOptions = {
    tau: options.tau ?? DEFAULT_TAU,
    topK: options.topK ?? DEFAULT_TOP_K,
    askedQuestionIds: options.askedQuestionIds ?? [],
    preferences: options.preferences ?? emptyPreferences(),
    profile: options.profile ?? "s5",
  };
  const traces = questions.map((question) => scoreTrace(question, ranked, resolved));
  const eligible = traces
    .filter((item) => item.reason === "eligible")
    .sort(
      (a, b) =>
        b.components.final - a.components.final ||
        b.components.entropy - a.components.entropy ||
        b.components.separation - a.components.separation ||
        a.question.questionId.localeCompare(b.question.questionId),
    );
  return {
    eligible,
    rejected: traces.filter((item) => item.reason !== "eligible"),
  };
}
