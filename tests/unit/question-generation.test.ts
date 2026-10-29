import { describe, expect, it, vi } from "vitest";
import type { RecommendationCandidate, TasteSession } from "@/lib/contracts";
import { validateProposedQuestions } from "@/lib/agent/question-generation/grounding";
import {
  buildQuestionEvidence,
  buildQuestionGenerationRequest,
  createGeminiQuestionGenerator,
} from "@/lib/agent/question-generation/proposer";
import type { GeminiTransport } from "@/lib/agent/gemini-transport";
import { GeminiTransportError } from "@/lib/agent/gemini-transport";
import { rankCandidates } from "@/lib/discovery/ranking";
import { createSession } from "@/lib/session/state";

const meaningful = { id: "tag:space", name: "Space opera", type: "theme:qloo" };
const format = { id: "tag:hardcover", name: "Hardcover", type: "book_format:qloo" };
const candidate = (index: number, tags = [meaningful]): RecommendationCandidate => ({
  entityId: "qloo:book:" + index,
  name: "Book " + index,
  entityType: "book",
  rank: index,
  description: "A verified description for book " + index,
  tags,
  affinity: 1 - index * 0.01,
  evidence: { source: "qloo", requestId: "request", seedEntityIds: ["qloo:movie:seed"] },
});
const candidates = [candidate(1), candidate(2), candidate(3, [])];
const session = (): TasteSession => createSession({
  anchorIds: ["qloo:movie:seed"], sourceType: "movie", targetType: "book",
  maxQuestions: 3, mode: "live", now: 1, ttlSeconds: 60,
});
const validTag = {
  proposalId: "p1",
  questionText: "Would you like more space opera?",
  questionType: "tag",
  preferenceDimension: "Space opera",
  evidence: [{ entityId: "qloo:book:1", tagIds: ["tag:space"] }],
  targetIds: ["tag:space"],
  supportedAnswerTypes: ["like", "dislike", "unknown"],
};
const validEntity = {
  proposalId: "p2",
  questionText: "Which title appeals more?",
  questionType: "entity",
  preferenceDimension: "title comparison",
  evidence: [
    { entityId: "qloo:book:1", tagIds: [] },
    { entityId: "qloo:book:3", tagIds: [] },
  ],
  targetIds: ["qloo:book:1", "qloo:book:3"],
  supportedAnswerTypes: ["prefer_a", "prefer_b", "both", "neither", "unknown"],
};

describe("deterministic proposal grounding", () => {
  it("accepts grounded tag/entity mappings and constructs server question IDs/text", () => {
    const report = validateProposedQuestions({ proposals: [validTag, validEntity] }, candidates, session());
    expect(report).toMatchObject({ generated: 2, accepted: 2, rejected: 0 });
    expect(report.questions[0]).toMatchObject({
      questionId: "tag:tag:space",
      text: "Would you like more space opera?",
      targetIds: ["tag:space"],
    });
    expect(report.questions[1]?.questionId).toBe("entity:qloo:book:1|qloo:book:3");
  });

  it.each([
    ["invented entity", { ...validTag, evidence: [{ entityId: "invented", tagIds: ["tag:space"] }] }, "unknown_entity"],
    ["invented tag", { ...validTag, targetIds: ["tag:invented"], evidence: [{ entityId: "qloo:book:1", tagIds: ["tag:invented"] }] }, "unknown_tag"],
    ["incorrect association", { ...validTag, evidence: [{ entityId: "qloo:book:3", tagIds: ["tag:space"] }] }, "incorrect_association"],
    ["unsupported paraphrase", { ...validTag, preferenceDimension: "Emotionally immersive cosmic journeys" }, "unsupported_semantics"],
    ["missing answer mapping", { ...validTag, supportedAnswerTypes: ["like", "unknown"] }, "unsupported_mapping"],
  ])("rejects %s", (_label, proposal, reason) => {
    const report = validateProposedQuestions({ proposals: [proposal] }, candidates, session());
    expect(report.questions).toEqual([]);
    expect(report.rejectionCounts).toMatchObject({ [reason]: 1 });
  });

  it("rejects adult/format metadata even with valid IDs and associations", () => {
    const books = [candidate(1, [format]), candidate(2, [])];
    const proposal = {
      ...validTag,
      preferenceDimension: "Hardcover",
      targetIds: ["tag:hardcover"],
      evidence: [{ entityId: "qloo:book:1", tagIds: ["tag:hardcover"] }],
    };
    expect(validateProposedQuestions({ proposals: [proposal] }, books, session()).rejectionCounts)
      .toMatchObject({ unsupported_semantics: 1 });
  });

  it("falls back to canonical wording when generated phrasing exceeds the verified intent", () => {
    const report = validateProposedQuestions({
      proposals: [{ ...validTag, questionText: "Would you like emotionally profound cosmic journeys?" }],
    }, candidates, session());
    expect(report).toMatchObject({ accepted: 1, rejected: 0 });
    expect(report.questions[0]?.text).toBe("Do you like stories that explore the theme of Space opera?");
  });

  it("never reinterprets science fiction as scientific rigor", () => {
    const scienceFiction = { id: "tag:sf", name: "Science fiction", type: "genre:media" };
    const books = [candidate(1, [scienceFiction]), candidate(2, [])];
    const proposal = {
      ...validTag,
      preferenceDimension: "Science fiction",
      targetIds: ["tag:sf"],
      evidence: [{ entityId: "qloo:book:1", tagIds: ["tag:sf"] }],
      questionText: "Would you enjoy scientifically rigorous storytelling?",
    };
    const report = validateProposedQuestions({ proposals: [proposal] }, books, session());
    expect(report).toMatchObject({ accepted: 1, rejected: 0 });
    expect(report.questions[0]).toMatchObject({
      text: "Would you like to read more Science fiction?",
      targetIds: ["tag:sf"],
      allowedResponses: ["like", "dislike", "unknown"],
    });
    expect(report.questions[0]?.text).not.toMatch(/scientific(?:ally)? rigorous/i);
  });

  it("preserves a neutral entity comparison only when both verified titles are exact", () => {
    const safe = validateProposedQuestions({ proposals: [{
      ...validEntity,
      questionText: "Which would you rather read: \"Book 1\" or \"Book 3\"?",
    }] }, candidates, session());
    expect(safe.questions[0]?.text).toBe("Which would you rather read: \"Book 1\" or \"Book 3\"?");

    const unsafe = validateProposedQuestions({ proposals: [{
      ...validEntity,
      questionText: "Would you rather read the thoughtful Book 1 or the exciting Book 3?",
    }] }, candidates, session());
    expect(unsafe.questions[0]?.text).toBe("Which book sounds more appealing: “Book 1” or “Book 3”?");
    expect(unsafe.questions[0]?.targetIds).toEqual(["qloo:book:1", "qloo:book:3"]);
  });

  it("rejects duplicates, repeated dimensions, and previously asked questions", () => {
    const s = { ...session(), askedQuestionIds: ["tag:tag:space"] };
    const repeated = validateProposedQuestions({ proposals: [validTag] }, candidates, s);
    expect(repeated.rejectionCounts).toMatchObject({ previously_asked: 1 });
    const duplicate = validateProposedQuestions({
      proposals: [validTag, { ...validTag, proposalId: "copy" }],
    }, candidates, session());
    expect(duplicate).toMatchObject({ accepted: 1, rejected: 1, rejectionCounts: { duplicate: 1 } });
  });

  it("strictly rejects malformed batches and unknown fields", () => {
    expect(validateProposedQuestions({ proposals: [{ ...validTag, extra: true }] }, candidates, session()).rejectionCounts)
      .toMatchObject({ invalid_schema: 1 });
    expect(validateProposedQuestions({ nope: [] }, candidates, session()).rejectionCounts)
      .toMatchObject({ invalid_schema: 1 });
  });
});

describe("bounded Gemini question proposer", () => {
  const ranked = rankCandidates(candidates, session());
  const input = {
    seed: { entityId: "qloo:movie:seed", name: "Seed", entityType: "movie" as const, provenance: "qloo" as const },
    session: session(),
    ranked,
  };
  const response = (text: string, status = 200) => ({
    status,
    body: {
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 },
    },
  });

  it("bounds and sanitizes the evidence bundle and request", () => {
    const many = Array.from({ length: 35 }, (_, index) => candidate(index + 1));
    const evidence = buildQuestionEvidence({ ...input, ranked: rankCandidates(many, session()) });
    expect(evidence.candidates).toHaveLength(30);
    expect(evidence.candidates.every((item) => item.tags.length <= 8)).toBe(true);
    const request = buildQuestionGenerationRequest(evidence, 0.2);
    expect(request.generationConfig.responseMimeType).toBe("application/json");
    expect(request.generationConfig.maxOutputTokens).toBe(2048);
    expect(request.generationConfig.responseSchema.properties.proposals.maxItems).toBe(8);
    expect(JSON.stringify(request)).not.toContain("x-goog-api-key");
  });

  it("makes one request, validates proposals, and accounts usage/cost", async () => {
    const transport = vi.fn<GeminiTransport>(async () => response(JSON.stringify({ proposals: [validTag] })));
    const generator = createGeminiQuestionGenerator({
      model: "gemini-3.5-flash-lite", temperature: 0.2, timeoutMs: 100, transport,
    });
    const result = await generator.generate(input);
    expect(transport).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ fallbackReason: null, validation: { generated: 1, accepted: 1, rejected: 0 } });
    expect(result.usage).toMatchObject({ requests: 1, promptTokens: 100, outputTokens: 30 });
    expect(result.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it.each([
    ["timeout", async () => { throw new GeminiTransportError("timeout"); }, "transport_error"],
    ["429", async () => response("{}", 429), "rate_limit"],
    ["invalid JSON", async () => response("not json"), "invalid_json"],
    ["empty output", async () => response(JSON.stringify({ proposals: [] })), "no_valid_proposals"],
  ])("falls back on %s", async (_label, responder, reason) => {
    const generator = createGeminiQuestionGenerator({
      model: "gemini-3.5-flash-lite", temperature: 0.2, timeoutMs: 100,
      transport: responder as GeminiTransport,
    });
    const result = await generator.generate(input);
    expect(result.questions).toEqual([]);
    expect(result.fallbackReason).toBe(reason);
    expect(result.usage.requests).toBe(1);
  });
});
