import { expect, test } from "vitest";
import { normalizeRecommendations } from "../../src/lib/discovery/normalize";
import { optimizeQuestions } from "../../src/lib/discovery/question-optimizer";
import { buildQuestionCandidates } from "../../src/lib/discovery/questions";
import { rankCandidates } from "../../src/lib/discovery/ranking";
import { createMockQlooProvider } from "../../src/lib/qloo/mock-provider";

test("offline fixture-backed question evaluation", async () => {
  const started = performance.now();
  const seed = "mock:movie:interstellar";
  const raw = await createMockQlooProvider().getRecommendations({
    seedEntityIds: [seed],
    targetType: "book",
    take: 30,
  });
  const candidates = normalizeRecommendations(raw, [seed], 30);
  const ranked = rankCandidates(candidates, {
    positiveTagIds: [],
    rejectedTagIds: [],
    positiveEntityIds: [],
    rejectedEntityIds: [],
  });
  const generated = buildQuestionCandidates(candidates, "book");
  const evaluation = optimizeQuestions(generated, ranked);
  const selected = evaluation.eligible[0];
  expect(selected).toBeDefined();
  expect(selected!.positiveOrder).not.toEqual(selected!.negativeOrder);

  console.log(JSON.stringify({
    fixture: "synthetic mock recommendations (not a preference measurement)",
    candidates: candidates.length,
    eligibleQuestions: evaluation.eligible.length,
    rejectedQuestions: evaluation.rejected.length,
    selected: {
      questionId: selected!.question.questionId,
      type: selected!.questionType,
      components: selected!.components,
      reason: selected!.reason,
      evidenceIds: selected!.evidenceIds,
    },
    counterfactualTop5: {
      positive: selected!.positiveOrder.slice(0, 5),
      negative: selected!.negativeOrder.slice(0, 5),
    },
    executionMs: Math.round((performance.now() - started) * 1000) / 1000,
    externalApiCalls: 0,
  }, null, 2));
});
