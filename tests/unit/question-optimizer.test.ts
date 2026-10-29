import { describe, expect, it } from "vitest";
import type { Question, RecommendationCandidate } from "@/lib/contracts";
import { binaryEntropy, optimizeQuestions, rankWeights, topKSeparation } from "@/lib/discovery/question-optimizer";
import { buildQuestionCandidates, isUsefulTag, selectQuestionsByBalanceHeuristic } from "@/lib/discovery/questions";
import { applyAnswer, buildAnswer } from "@/lib/discovery/preferences";
import { orderOf, rankCandidates } from "@/lib/discovery/ranking";
import { createSession } from "@/lib/session/state";

const tag = (id: string, name = id, type = "theme:qloo") => ({ id, name, type });

function candidate(
  index: number,
  tags: RecommendationCandidate["tags"] = [],
  description: string | undefined = "Description " + index,
): RecommendationCandidate {
  return {
    entityId: "mock:book:" + index,
    name: "Book " + index,
    entityType: "book",
    rank: index,
    ...(description === undefined ? {} : { description }),
    tags,
    syntheticScore: 1 - index * 0.05,
    evidence: {
      source: "mock",
      requestId: "fixture",
      seedEntityIds: ["mock:movie:seed"],
      fixtureId: "mock:book:" + index,
      note: "Deterministic optimizer fixture.",
    },
  };
}

const preferences = {
  positiveTagIds: [],
  rejectedTagIds: [],
  positiveEntityIds: [],
  rejectedEntityIds: [],
};

const session = () =>
  createSession({
    anchorIds: ["mock:movie:seed"],
    sourceType: "movie",
    targetType: "book",
    maxQuestions: 3,
    mode: "mock",
    now: 1,
    ttlSeconds: 60,
  });

describe("optimizer mathematics", () => {
  it("produces positive rank weights that sum to one and favor higher ranks", () => {
    const weights = rankWeights([1, 2, 3, 4]);
    expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(weights.every((value) => value > 0)).toBe(true);
    expect(weights[0]).toBeGreaterThan(weights[1]!);
  });

  it("handles empty ranks and invalid tau safely", () => {
    expect(rankWeights([])).toEqual([]);
    expect(rankWeights([1, 2], 0).every(Number.isFinite)).toBe(true);
  });

  it("has maximal balanced entropy and zero degenerate entropy", () => {
    expect(binaryEntropy(0.5)).toBe(1);
    expect(binaryEntropy(0)).toBe(0);
    expect(binaryEntropy(1)).toBe(0);
    expect(binaryEntropy(1e-20)).toBe(0);
  });

  it("computes bounded top-K counterfactual separation", () => {
    expect(topKSeparation(["a", "b"], ["a", "b"], 2)).toBe(0);
    expect(topKSeparation(["a", "b"], ["c", "d"], 2)).toBe(1);
    expect(topKSeparation([], [], 5)).toBe(0);
  });
});

describe("grounded question construction", () => {
  it("accepts meaningful verified tags and rejects noisy or opaque tags", () => {
    expect(isUsefulTag(tag("genre", "Science Fiction", "genre:media"))).toBe(true);
    expect(isUsefulTag(tag("keyword", "plot", "keyword:qloo"))).toBe(false);
    expect(isUsefulTag(tag("opaque", "urn:tag:abc", "theme:qloo"))).toBe(false);
    expect(isUsefulTag(tag("unknown", "unknown", "theme:qloo"))).toBe(false);
  });

  it("builds tag questions only for tags that split the candidates", () => {
    const shared = tag("shared", "Shared");
    const split = tag("split", "Space opera");
    const questions = buildQuestionCandidates([
      candidate(1, [shared, split]),
      candidate(2, [shared]),
      candidate(3, [shared, split]),
      candidate(4, [shared]),
    ], "book");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ targetType: "tag", targetIds: ["split"] });
  });

  it("uses verified entity comparisons when tags are missing or noisy", () => {
    const candidates = [
      candidate(1, [tag("noise", "format", "book_format:qloo")]),
      candidate(2, []),
      candidate(3, [], undefined),
    ];
    const questions = buildQuestionCandidates(candidates, "book");
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.every((question) => question.targetType === "entity")).toBe(true);
    expect(questions.flatMap((question) => question.targetIds).every((id) =>
      candidates.some((item) => item.entityId === id),
    )).toBe(true);
  });

  it("returns no questions for empty and single-candidate lists", () => {
    expect(buildQuestionCandidates([], "book")).toEqual([]);
    expect(buildQuestionCandidates([candidate(1)], "book")).toEqual([]);
  });
});

describe("complete objective and counterfactuals", () => {
  const candidates = [
    candidate(1, [tag("space", "Space")]),
    candidate(2, [tag("space", "Space")]),
    candidate(3),
    candidate(4),
    candidate(5),
    candidate(6),
  ];
  const ranked = rankCandidates(candidates, preferences);
  const question = buildQuestionCandidates(candidates, "book")[0]!;

  it("exposes H, D, I, R, U and the exact weighted objective", () => {
    const result = optimizeQuestions([question], ranked);
    const score = result.eligible[0]!.components;
    expect(Object.values(score).every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(score.final).toBeCloseTo(
      0.4 * score.entropy +
        0.25 * score.separation +
        0.25 * score.interpretability -
        0.05 * score.redundancy -
        0.05 * score.ambiguity,
      5,
    );
    expect(result.eligible[0]!.positiveOrder).not.toEqual(result.eligible[0]!.negativeOrder);
  });

  it("rejects unsupported tags and entities instead of inventing evidence", () => {
    const unsupportedTag: Question = { ...question, questionId: "tag:missing", targetIds: ["missing"] };
    const pair = buildQuestionCandidates(candidates.map((item) => ({ ...item, tags: [] })), "book")[0]!;
    const unsupportedPair: Question = { ...pair, targetIds: [pair.targetIds[0]!, "missing"] };
    const result = optimizeQuestions([unsupportedTag, unsupportedPair], ranked);
    expect(result.eligible).toEqual([]);
    expect(result.rejected.every((item) => item.reason === "rejected_unsupported")).toBe(true);
  });

  it("hard-rejects a noisy tag even when it exists on a candidate", () => {
    const noisyCandidates = [
      candidate(1, [tag("format", "Hardcover", "book_format:qloo")]),
      candidate(2),
    ];
    const noisyQuestion: Question = {
      questionId: "tag:format",
      text: "Do you enjoy Hardcover books?",
      targetType: "tag",
      targetIds: ["format"],
      allowedResponses: ["like", "dislike", "unknown"],
    };
    const result = optimizeQuestions([noisyQuestion], rankCandidates(noisyCandidates, preferences));
    expect(result.eligible).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("rejected_unsupported");
  });

  it("rejects repeated questions and assigns a full redundancy penalty", () => {
    const result = optimizeQuestions([question], ranked, { askedQuestionIds: [question.questionId] });
    expect(result.eligible).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ reason: "rejected_repeat", components: { redundancy: 1 } });
  });

  it("is deterministic under input question order and tie breaking", () => {
    const localCandidates = [
      candidate(1, [tag("a", "Alpha"), tag("b", "Beta")]),
      candidate(2, [tag("a", "Alpha"), tag("b", "Beta")]),
      candidate(3),
      candidate(4),
    ];
    const questions = buildQuestionCandidates(localCandidates, "book");
    const localRanked = rankCandidates(localCandidates, preferences);
    const a = selectQuestionsByBalanceHeuristic(questions, localRanked).map((item) => item.questionId);
    const b = selectQuestionsByBalanceHeuristic([...questions].reverse(), localRanked).map((item) => item.questionId);
    expect(a).toEqual(b);
    expect(a[0]).toBe("tag:a");
  });
});

describe("entity answers and executable reranking", () => {
  const candidates = [candidate(1, []), candidate(2, []), candidate(3, [])];
  const question = buildQuestionCandidates(candidates, "book")[0]!;

  it("prefer A and prefer B update opposite verified entity preferences", () => {
    const a = applyAnswer(session(), buildAnswer(question, "prefer_a", 2));
    const b = applyAnswer(session(), buildAnswer(question, "prefer_b", 2));
    expect(a.positiveEntityIds).toEqual([question.targetIds[0]]);
    expect(b.positiveEntityIds).toEqual([question.targetIds[1]]);
    expect(orderOf(rankCandidates(candidates, a))).not.toEqual(orderOf(rankCandidates(candidates, b)));
  });

  it("both, neither, and unknown preserve explicit semantics", () => {
    const both = applyAnswer(session(), buildAnswer(question, "both", 2));
    const neither = applyAnswer(session(), buildAnswer(question, "neither", 2));
    const unknown = applyAnswer(session(), buildAnswer(question, "unknown", 2));
    expect(both.positiveEntityIds).toEqual(question.targetIds);
    expect(neither.rejectedEntityIds).toEqual(question.targetIds);
    expect(neither.positiveEntityIds).toEqual([]);
    expect(unknown.positiveEntityIds).toEqual([]);
    expect(unknown.rejectedEntityIds).toEqual([]);
  });
});
