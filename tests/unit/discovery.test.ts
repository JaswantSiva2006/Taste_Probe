import { describe, expect, it } from "vitest";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import { validateAgentDecision } from "@/lib/agent/validate";
import type { RecommendationCandidate, TasteSession } from "@/lib/contracts";
import { normalizeRecommendations, normalizeSearchResults } from "@/lib/discovery/normalize";
import { applyAnswer, buildAnswer } from "@/lib/discovery/preferences";
import {
  availableQuestions,
  buildQuestionCandidates,
  selectQuestionsByBalanceHeuristic,
} from "@/lib/discovery/questions";
import { orderOf, rankCandidates, sameOrder } from "@/lib/discovery/ranking";
import { evaluateStop } from "@/lib/discovery/stop";
import { createMockQlooProvider } from "@/lib/qloo/mock-provider";
import { createSession } from "@/lib/session/state";

const SEED = "mock:movie:interstellar";

async function candidates(): Promise<RecommendationCandidate[]> {
  const result = await createMockQlooProvider().getRecommendations({ seedEntityIds: [SEED], targetType: "book", take: 8 });
  return normalizeRecommendations(result, [SEED], 8);
}

function session(): TasteSession {
  return createSession({
    anchorIds: [SEED],
    sourceType: "movie",
    targetType: "book",
    maxQuestions: 3,
    mode: "mock",
    now: 1_000,
    ttlSeconds: 60,
  });
}

describe("normalization (K1)", () => {
  it("normalizes fixture recommendations into mock-provenance candidates", async () => {
    const list = await candidates();
    expect(list.length).toBeGreaterThanOrEqual(4);
    list.forEach((c, i) => {
      expect(c.rank).toBe(i + 1);
      expect(c.entityType).toBe("book");
      expect(c.evidence.source).toBe("mock");
      expect(c.evidence.seedEntityIds).toEqual([SEED]);
      expect(c.evidence.requestId).toMatch(/^mock-/);
      expect("syntheticScore" in c && c.syntheticScore).toBeGreaterThan(0);
      expect("affinity" in c).toBe(false);
      expect(c.tags.length).toBeGreaterThan(0);
    });
  });

  it("applies the candidate limit", async () => {
    const result = await createMockQlooProvider().getRecommendations({ seedEntityIds: [SEED], targetType: "book", take: 8 });
    expect(normalizeRecommendations(result, [SEED], 2)).toHaveLength(2);
  });

  it("normalizes search results and drops unsupported entity types", () => {
    const out = normalizeSearchResults({
      provenance: "mock",
      requestId: "mock-req",
      payload: {
        results: [
          { entity_id: "mock:movie:a", name: "A", types: ["urn:entity:movie"], properties: { release_year: 2000 } },
          { entity_id: "mock:place:b", name: "B", types: ["urn:entity:place"] },
        ],
      },
    });
    expect(out).toEqual([{ entityId: "mock:movie:a", name: "A", entityType: "movie", year: 2000, provenance: "mock" }]);
  });
});

describe("question building and selection (K2/D1)", () => {
  it("builds only questions that split the shortlist, with known targets", async () => {
    const list = await candidates();
    const questions = buildQuestionCandidates(list, "book");
    const knownTags = new Set(list.flatMap((c) => c.tags.map((t) => t.id)));
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q.targetIds.every((id) => knownTags.has(id))).toBe(true);
      const carriers = list.filter((c) => c.tags.some((t) => t.id === q.targetIds[0])).length;
      expect(carriers).toBeGreaterThan(0);
      expect(carriers).toBeLessThan(list.length);
      expect(q.allowedResponses).toEqual(["like", "dislike", "unknown"]);
    }
    expect(new Set(questions.map((q) => q.questionId)).size).toBe(questions.length);
  });

  it("selects deterministically and never repeats an asked question", async () => {
    const list = await candidates();
    const ranked = rankCandidates(list, session());
    const questions = buildQuestionCandidates(list, "book");
    const first = selectQuestionsByBalanceHeuristic(questions, ranked)[0]!;
    expect(selectQuestionsByBalanceHeuristic([...questions].reverse(), ranked)[0]!.questionId).toBe(first.questionId);

    const asked = { ...session(), askedQuestionIds: [first.questionId] };
    const remaining = availableQuestions(questions, asked);
    expect(remaining.map((q) => q.questionId)).not.toContain(first.questionId);
  });

  it("excludes questions whose targets already have a confirmed preference", async () => {
    const questions = buildQuestionCandidates(await candidates(), "book");
    const q = questions[0]!;
    const decided = { ...session(), positiveTagIds: [...q.targetIds] };
    expect(availableQuestions(questions, decided).map((x) => x.questionId)).not.toContain(q.questionId);
  });
});

describe("preference updates (D2)", () => {
  const question = {
    questionId: "tag:mock:tag:a",
    text: "?",
    targetType: "tag" as const,
    targetIds: ["mock:tag:a"],
    allowedResponses: ["like" as const, "dislike" as const, "unknown" as const],
  };

  it("like adds a positive tag, dislike moves it to rejected", () => {
    const liked = applyAnswer(session(), buildAnswer(question, "like", 5));
    expect(liked.positiveTagIds).toEqual(["mock:tag:a"]);
    expect(liked.answers).toHaveLength(1);
    const disliked = applyAnswer(liked, buildAnswer(question, "dislike", 6));
    expect(disliked.positiveTagIds).toEqual([]);
    expect(disliked.rejectedTagIds).toEqual(["mock:tag:a"]);
  });

  it("unknown records the answer but changes no preference", () => {
    const s = applyAnswer(session(), buildAnswer(question, "unknown", 5));
    expect(s.answers).toHaveLength(1);
    expect(s.positiveTagIds).toEqual([]);
    expect(s.rejectedTagIds).toEqual([]);
  });

  it("rejects responses the question does not allow", () => {
    expect(() => buildAnswer(question, "prefer_a", 5)).toThrowError(expect.objectContaining({ code: "INVALID_ANSWER" }));
  });

  it("does not mutate the input session", () => {
    const s = session();
    applyAnswer(s, buildAnswer(question, "like", 5));
    expect(s.positiveTagIds).toEqual([]);
    expect(s.answers).toEqual([]);
  });
});

describe("reranking", () => {
  it("is ordered by the provider rank when there are no preferences", async () => {
    const list = await candidates();
    const ranked = rankCandidates(list, session());
    expect(ranked.map((r) => r.candidate.rank)).toEqual(list.map((c) => c.rank));
    expect(ranked.every((r) => r.previousPosition === null)).toBe(true);
  });

  it("changes order after a liked tag and reports movement", async () => {
    const list = await candidates();
    const before = rankCandidates(list, session());
    const q = selectQuestionsByBalanceHeuristic(buildQuestionCandidates(list, "book"), before)[0]!;
    const prefs = applyAnswer(session(), buildAnswer(q, "like", 1));
    const after = rankCandidates(list, prefs, orderOf(before));

    expect(sameOrder(orderOf(before), orderOf(after))).toBe(false);
    const moved = after.filter((r) => r.previousPosition !== r.position);
    expect(moved.length).toBeGreaterThan(0);
    const boosted = after.filter((r) => r.matchedPositiveTagIds.length > 0);
    expect(boosted.every((r) => r.explanation.toLowerCase().includes("boosted"))).toBe(true);
  });

  it("like and dislike on the same tag produce different rankings", async () => {
    const list = await candidates();
    const q = buildQuestionCandidates(list, "book")[0]!;
    const liked = orderOf(rankCandidates(list, applyAnswer(session(), buildAnswer(q, "like", 1))));
    const disliked = orderOf(rankCandidates(list, applyAnswer(session(), buildAnswer(q, "dislike", 1))));
    expect(sameOrder(liked, disliked)).toBe(false);
  });

  it("unknown does not change the ranking", async () => {
    const list = await candidates();
    const q = buildQuestionCandidates(list, "book")[0]!;
    const before = orderOf(rankCandidates(list, session()));
    const after = orderOf(rankCandidates(list, applyAnswer(session(), buildAnswer(q, "unknown", 1))));
    expect(after).toEqual(before);
  });
});

describe("stop controller (V2)", () => {
  it("stops when the question budget is used", () => {
    expect(evaluateStop({ questionCount: 3, maxQuestions: 3 }, 5)).toEqual({ stop: true, reason: "question_budget_exhausted" });
  });
  it("stops when no informative question remains", () => {
    expect(evaluateStop({ questionCount: 1, maxQuestions: 3 }, 0)).toEqual({ stop: true, reason: "stable_recommendations" });
  });
  it("continues otherwise", () => {
    expect(evaluateStop({ questionCount: 2, maxQuestions: 3 }, 1)).toEqual({ stop: false });
  });
});

describe("deterministic mock agent (A1)", () => {
  const agent = createDeterministicMockAgent();
  const q = { questionId: "tag:x", text: "X?", targetType: "tag" as const, targetIds: ["x"], allowedResponses: ["like" as const] };
  const ctx = { candidateCount: 6, minCandidates: 2, qlooCallsRemaining: 3, stop: { stop: false as const }, rankedQuestions: [q] };

  it("retrieves when there are too few candidates", async () => {
    expect((await agent.decide({ ...ctx, candidateCount: 0 })).action).toBe("retrieve");
  });
  it("asks the top offered question", async () => {
    const d = validateAgentDecision(await agent.decide(ctx), [q]);
    expect(d).toMatchObject({ action: "ask", selectedQuestionId: "tag:x", reasonCode: "informative_question", done: false });
  });
  it("finishes when the stop controller says so", async () => {
    const d = await agent.decide({ ...ctx, stop: { stop: true, reason: "question_budget_exhausted" } });
    expect(d).toEqual({ action: "finish", reasonCode: "question_budget_exhausted", done: true });
  });
  it("validation rejects unknown questions and malformed decisions", () => {
    expect(() =>
      validateAgentDecision({ action: "ask", selectedQuestionId: "tag:nope", reasonCode: "informative_question", done: false }, [q]),
    ).toThrowError(expect.objectContaining({ code: "AGENT_DECISION_INVALID" }));
    expect(() => validateAgentDecision({ action: "ask" }, [q])).toThrowError(
      expect.objectContaining({ code: "AGENT_DECISION_INVALID" }),
    );
  });
});
