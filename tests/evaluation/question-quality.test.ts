import { expect, test } from "vitest";
import type { RecommendationCandidate } from "@/lib/contracts";
import { validateProposedQuestions } from "@/lib/agent/question-generation/grounding";
import { optimizeQuestions } from "@/lib/discovery/question-optimizer";
import { buildQuestionCandidates } from "@/lib/discovery/questions";
import { rankCandidates } from "@/lib/discovery/ranking";
import { createSession } from "@/lib/session/state";

const space = { id: "tag:space", name: "Space opera", type: "theme:qloo" };
const mystery = { id: "tag:mystery", name: "Mystery", type: "genre:media" };
const adult = { id: "tag:adult", name: "Adult", type: "age_ranges:qloo" };
const candidate = (index: number, tags: typeof space[], description = "Verified description"): RecommendationCandidate => ({
  entityId: "fixture:book:" + index,
  name: "Fixture Book " + index,
  entityType: "book",
  rank: index,
  description,
  tags,
  syntheticScore: 1 - index * 0.05,
  evidence: { source: "mock", requestId: "offline", seedEntityIds: ["fixture:seed"], fixtureId: "mock:fixture:" + index, note: "Offline structural fixture." },
});
const base = [
  candidate(1, [space]),
  candidate(2, [space, mystery]),
  candidate(3, [mystery]),
  candidate(4, []),
  candidate(5, [adult]),
  candidate(6, []),
];
const tagProposal = {
  proposalId: "space",
  questionText: "Would you enjoy space opera?",
  questionType: "tag",
  preferenceDimension: "Space opera",
  evidence: [{ entityId: "fixture:book:1", tagIds: ["tag:space"] }],
  targetIds: ["tag:space"],
  supportedAnswerTypes: ["like", "dislike", "unknown"],
};
const entityProposal = {
  proposalId: "pair",
  questionText: "Which sounds more appealing?",
  questionType: "entity",
  preferenceDimension: "title comparison",
  evidence: [{ entityId: "fixture:book:1", tagIds: [] }, { entityId: "fixture:book:4", tagIds: [] }],
  targetIds: ["fixture:book:1", "fixture:book:4"],
  supportedAnswerTypes: ["prefer_a", "prefer_b", "both", "neither", "unknown"],
};
const session = () => createSession({
  anchorIds: ["fixture:seed"], sourceType: "movie", targetType: "book",
  maxQuestions: 3, mode: "mock", now: 1, ttlSeconds: 60,
});

const scenarios = Array.from({ length: 20 }, (_, index) => {
  const kind = index % 5;
  const proposals = kind === 0
    ? [tagProposal, entityProposal]
    : kind === 1
      ? [tagProposal, { ...tagProposal, proposalId: "invented-" + index, targetIds: ["tag:invented"], evidence: [{ entityId: "fixture:book:1", tagIds: ["tag:invented"] }] }]
      : kind === 2
        ? [tagProposal, { ...tagProposal, proposalId: "duplicate-" + index }]
        : kind === 3
          ? [{ ...tagProposal, proposalId: "adult-" + index, preferenceDimension: "Adult", targetIds: ["tag:adult"], evidence: [{ entityId: "fixture:book:5", tagIds: ["tag:adult"] }] }]
          : [{ ...tagProposal, proposalId: "mapping-" + index, supportedAnswerTypes: ["like", "unknown"] }];
  return {
    name: ["different-seed", "unsupported-id", "duplicate-dimension", "noisy-age-tag", "missing-answer-mapping"][kind] + "-" + index,
    candidates: index % 4 === 0 ? base.map((item) => ({ ...item, description: undefined })) : base,
    proposals,
  };
});

test("20-scenario offline S5 versus grounded-proposal comparison", () => {
  const started = performance.now();
  const totals = { generated: 0, accepted: 0, rejected: 0, duplicates: 0, unsupported: 0 };
  const types = new Set<string>();
  const baselineScores: number[] = [];
  const groundedScores: number[] = [];
  const counterfactualChanges: number[] = [];
  const blindSamples: Array<{ scenario: string; A: string | null; B: string | null }> = [];

  for (const scenario of scenarios) {
    const ranked = rankCandidates(scenario.candidates, session());
    const baseline = optimizeQuestions(buildQuestionCandidates(scenario.candidates, "book"), ranked).eligible;
    const validated = validateProposedQuestions({ proposals: scenario.proposals }, scenario.candidates, session());
    const grounded = optimizeQuestions(validated.questions, ranked).eligible;
    totals.generated += validated.generated;
    totals.accepted += validated.accepted;
    totals.rejected += validated.rejected;
    totals.duplicates += validated.rejectionCounts.duplicate ?? 0;
    totals.unsupported += Object.entries(validated.rejectionCounts)
      .filter(([reason]) => reason !== "duplicate" && reason !== "previously_asked")
      .reduce((sum, [, count]) => sum + count, 0);
    grounded.forEach((trace) => types.add(trace.questionType));
    if (baseline[0]) baselineScores.push(baseline[0].components.final);
    if (grounded[0]) {
      groundedScores.push(grounded[0].components.final);
      counterfactualChanges.push(grounded[0].components.separation);
    }
    blindSamples.push({
      scenario: scenario.name,
      A: indexParity(scenario.name) ? baseline[0]?.question.text ?? null : grounded[0]?.question.text ?? null,
      B: indexParity(scenario.name) ? grounded[0]?.question.text ?? null : baseline[0]?.question.text ?? null,
    });
  }

  expect(scenarios).toHaveLength(20);
  expect(totals.accepted).toBeGreaterThan(0);
  expect(totals.unsupported).toBeGreaterThan(0);
  expect(types).toEqual(new Set(["tag", "entity_comparison"]));
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  console.log(JSON.stringify({
    methodology: "Controlled structured-proposal fixtures; objective proxies only, no human ratings.",
    scenarios: scenarios.length,
    metrics: {
      groundingPassRate: totals.accepted / totals.generated,
      acceptanceRate: totals.accepted / totals.generated,
      unsupportedRejected: totals.unsupported,
      validQuestions: totals.accepted,
      duplicateRate: totals.duplicates / totals.generated,
      questionTypeDiversity: [...types],
      baselineMeanTopJ: average(baselineScores),
      groundedMeanTopJ: average(groundedScores),
      groundedMeanSeparation: average(counterfactualChanges),
      externalApiCalls: 0,
      estimatedCostUsd: 0,
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
    },
    blindRatingRubric: {
      scale: "1-5",
      dimensions: ["clarity", "naturalness", "answerability", "relevance", "preference usefulness"],
      humanScores: "NOT_PERFORMED",
      samples: blindSamples.slice(0, 10),
    },
  }, null, 2));
});

function indexParity(value: string): boolean {
  return value.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 2 === 0;
}
