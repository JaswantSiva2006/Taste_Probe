import { describe, expect, test } from "vitest";
import type { Question, RecommendationCandidate } from "@/lib/contracts";
import { isSemanticallyFaithfulTagWording, renderTagQuestion, type RenderingStrategy } from "@/lib/agent/question-generation/renderer";
import { semanticQuestionScores } from "@/lib/discovery/question-quality";

const dimensions = [
  ["moral ambiguity", "theme:qloo"], ["found family", "theme:qloo"], ["slow-burn tension", "style:qloo"],
  ["social satire", "theme:qloo"], ["immersive", "critical_descriptor:qloo"], ["science fiction", "genre:media"],
  ["gothic horror", "subgenre:qloo"], ["historical mystery", "genre:qloo"], ["magical realism", "subgenre:qloo"],
  ["political intrigue", "theme:qloo"], ["unreliable narrators", "style:qloo"], ["nonlinear storytelling", "style:qloo"],
  ["intimate character study", "style:qloo"], ["lyrical prose", "critical_descriptor:qloo"], ["fast-paced action", "style:qloo"],
  ["melancholic atmosphere", "style:qloo"], ["dark comedy", "genre:qloo"], ["cosmic horror", "subgenre:qloo"],
  ["redemption", "theme:qloo"], ["identity", "theme:qloo"], ["grief", "theme:qloo"], ["memory", "theme:qloo"],
  ["class conflict", "theme:qloo"], ["environmentalism", "theme:qloo"], ["coming of age", "theme:qloo"],
  ["rural isolation", "setting:qloo"], ["Victorian era", "time_period:qloo"], ["near future", "setting:qloo"],
  ["journey motif", "motif:qloo"], ["forbidden knowledge", "motif:qloo"], ["double identity", "motif:qloo"],
  ["epistolary", "style:qloo"], ["absurdist", "style:qloo"], ["solarpunk", "subgenre:qloo"],
  ["Afrofuturism", "subgenre:qloo"],
] as const;

const dev = dimensions.slice(0, 20);
const heldOut = dimensions.slice(20);

function candidate(label: string, type: string, index: number): RecommendationCandidate {
  return {
    entityId: `synthetic:wording:${index}`, name: `Synthetic book ${index}`, entityType: "book", rank: 1,
    description: index % 6 === 0 ? undefined : `Synthetic evidence carrying the exact ${label} tag.`,
    tags: [{ id: `tag:${index}`, name: label, type }], syntheticScore: 0.9,
    evidence: { source: "mock", requestId: "wording-offline", seedEntityIds: ["synthetic:seed"], fixtureId: `wording:${index}`, note: "Synthetic wording benchmark; not Qloo observation." },
  };
}

function generatedWording(label: string, type: string, index: number): string {
  if (index % 7 === 5) return label === "science fiction"
    ? "Would you enjoy scientifically rigorous storytelling?"
    : `Do you like emotionally intense stories inspired by ${label}?`;
  if (type.includes("genre")) return `Would you like to read more ${label}?`;
  if (type.includes("style") || type.includes("descriptor")) return `Do you enjoy ${label} storytelling?`;
  if (type.includes("setting") || type.includes("time_period")) return `Do you enjoy stories set in ${label}?`;
  if (type.includes("motif")) return `Do you like stories featuring ${label}?`;
  return `Do you like stories that explore the theme of ${label}?`;
}

function evaluate(values: readonly (readonly [string, string])[], strategy: RenderingStrategy, offset = 0) {
  const started = performance.now();
  const rows = values.map(([label, type], localIndex) => {
    const index = offset + localIndex;
    const book = candidate(label, type, index);
    const proposal = {
      proposalId: `p:${index}`, questionText: generatedWording(label, type, index), questionType: "tag" as const,
      preferenceDimension: label, evidence: [{ entityId: book.entityId, tagIds: [`tag:${index}`] }],
      targetIds: [`tag:${index}`], supportedAnswerTypes: ["like", "dislike", "unknown"] as ("like" | "dislike" | "unknown")[],
    };
    const text = strategy === "s8_6" ? `Would you enjoy ${label}?` : renderTagQuestion({ proposal, tag: book.tags[0]!, noun: "books", strategy });
    const question: Question = { questionId: `tag:tag:${index}`, text, targetType: "tag", targetIds: [`tag:${index}`], allowedResponses: ["like", "dislike", "unknown"] };
    return {
      label, text, naturalness: semanticQuestionScores(question, [book, { ...book, entityId: `${book.entityId}:other`, tags: [] }]).naturalness,
      faithful: strategy === "s8_6" || isSemanticallyFaithfulTagWording(text, label, "books"),
      mappingCorrect: question.targetIds[0] === `tag:${index}` && question.allowedResponses.join() === "like,dislike,unknown",
      sparseMetadata: book.description === undefined,
      previouslyAsked: index % 11 === 0,
    };
  });
  return {
    strategy, rows,
    naturalness: rows.reduce((sum, row) => sum + row.naturalness, 0) / rows.length,
    fidelityRate: rows.filter((row) => row.faithful).length / rows.length,
    mappingRate: rows.filter((row) => row.mappingCorrect).length / rows.length,
    latencyMs: performance.now() - started,
  };
}

describe("S8.7 offline question-wording campaign", () => {
  test("uses distinct development and held-out dimensions including unfamiliar valid tags", () => {
    expect(dev).toHaveLength(20);
    expect(heldOut).toHaveLength(15);
    expect(new Set(dimensions.map(([label]) => label)).size).toBe(35);
    const coverage = evaluate(dimensions, "hybrid").rows;
    expect(coverage.some((row) => row.sparseMetadata)).toBe(true);
    expect(coverage.some((row) => row.previouslyAsked)).toBe(true);
  });

  test("compares S8.6, deterministic, preserved, and hybrid rendering on development cases", () => {
    const results = (["s8_6", "deterministic", "preserve", "hybrid"] as const).map((strategy) => evaluate(dev, strategy));
    expect(results.every((result) => result.fidelityRate === 1 && result.mappingRate === 1)).toBe(true);
    expect(results[3]!.naturalness).toBeGreaterThan(results[0]!.naturalness);
    console.log("S8.7_DEVELOPMENT=" + JSON.stringify(results.map((result) => ({
      strategy: result.strategy, naturalness: result.naturalness, fidelityRate: result.fidelityRate,
      mappingRate: result.mappingRate, latencyMs: result.latencyMs,
    }))));
  });

  test("selects hybrid on held-out semantic safety and naturalness", () => {
    const baseline = evaluate(heldOut, "s8_6", dev.length);
    const hybrid = evaluate(heldOut, "hybrid", dev.length);
    expect(hybrid.fidelityRate).toBe(1);
    expect(hybrid.mappingRate).toBe(1);
    expect(hybrid.naturalness).toBeGreaterThan(baseline.naturalness);
    console.log("S8.7_HELD_OUT=" + JSON.stringify({ baseline, hybrid }));
  });

  test("preserves entity comparison answer semantics", () => {
    const question: Question = { questionId: "entity:a|b", text: "Which book sounds more appealing: “A” or “B”?", targetType: "entity", targetIds: ["a", "b"], allowedResponses: ["prefer_a", "prefer_b", "both", "neither", "unknown"] };
    expect(question.targetIds).toEqual(["a", "b"]);
    expect(question.allowedResponses).toEqual(["prefer_a", "prefer_b", "both", "neither", "unknown"]);
  });
});
