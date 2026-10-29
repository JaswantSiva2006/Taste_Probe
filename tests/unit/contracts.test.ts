import { describe, expect, it } from "vitest";
import {
  AgentDecisionSchema,
  AnswerRequestSchema,
  DiscoveryInputSchema,
  MockRecommendationCandidateSchema,
  PreferenceAnswerSchema,
  RecommendationCandidateSchema,
  StartRequestSchema,
} from "@/lib/contracts";

const mockCandidate = {
  entityId: "mock:book:alpha",
  name: "Alpha",
  entityType: "book",
  rank: 1,
  syntheticScore: 0.9,
  tags: [{ id: "mock:tag:x", name: "x", type: "mock:tag:theme" }],
  evidence: {
    source: "mock",
    requestId: "mock-req-1",
    seedEntityIds: ["mock:movie:interstellar"],
    fixtureId: "mock:book:alpha",
    note: "synthetic",
  },
};

describe("contracts", () => {
  it("accepts a valid discovery input and rejects more than 3 questions", () => {
    const input = { entityQuery: "Interstellar", sourceType: "movie", targetType: "book", maxQuestions: 3 };
    expect(DiscoveryInputSchema.parse(input)).toEqual(input);
    expect(DiscoveryInputSchema.safeParse({ ...input, maxQuestions: 4 }).success).toBe(false);
    expect(DiscoveryInputSchema.safeParse({ ...input, sourceType: "podcast" }).success).toBe(false);
    expect(DiscoveryInputSchema.safeParse({ ...input, entityQuery: "  " }).success).toBe(false);
  });

  it("rejects unknown fields on start requests", () => {
    const base = { entityQuery: "Interstellar", sourceType: "movie", targetType: "book", maxQuestions: 3 };
    expect(StartRequestSchema.safeParse({ ...base, isAdmin: true }).success).toBe(false);
  });

  it("parses mock candidates and keeps their mock provenance", () => {
    const parsed = RecommendationCandidateSchema.parse(mockCandidate);
    expect(parsed.evidence.source).toBe("mock");
    expect("affinity" in parsed).toBe(false);
  });

  it("refuses mock candidates whose fixture IDs are not mock-namespaced", () => {
    const bad = { ...mockCandidate, evidence: { ...mockCandidate.evidence, fixtureId: "Q123" } };
    expect(MockRecommendationCandidateSchema.safeParse(bad).success).toBe(false);
  });

  it("does not let a mock candidate pass as a qloo candidate", () => {
    const disguised = { ...mockCandidate, evidence: { ...mockCandidate.evidence, source: "qloo" } };
    const parsed = RecommendationCandidateSchema.safeParse(disguised);
    // Either rejected, or parsed only as a qloo candidate without the synthetic score/fixture fields.
    if (parsed.success) {
      expect(parsed.data.evidence.source).toBe("qloo");
      expect("syntheticScore" in parsed.data).toBe(false);
    }
  });

  it("validates preference answers and responses", () => {
    const answer = { questionId: "q", targetType: "tag", targetIds: ["t"], response: "like", timestamp: 1 };
    expect(PreferenceAnswerSchema.parse(answer)).toEqual(answer);
    expect(PreferenceAnswerSchema.safeParse({ ...answer, response: "love" }).success).toBe(false);
    expect(PreferenceAnswerSchema.safeParse({ ...answer, targetIds: [] }).success).toBe(false);
    expect(AnswerRequestSchema.safeParse({ sessionToken: "x", questionId: "q", response: "maybe" }).success).toBe(false);
  });

  it("validates agent decisions", () => {
    expect(AgentDecisionSchema.safeParse({ action: "ask", reasonCode: "informative_question", done: false }).success).toBe(true);
    expect(AgentDecisionSchema.safeParse({ action: "dance", reasonCode: "informative_question", done: false }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ action: "finish", reasonCode: "because", done: true }).success).toBe(false);
  });
});
