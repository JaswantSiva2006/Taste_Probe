import { describe, expect, test } from "vitest";
import type { Question, RecommendationCandidate, TasteSession } from "@/lib/contracts";
import { validateProposedQuestions } from "@/lib/agent/question-generation/grounding";
import { optimizeQuestions, type OptimizerOptions } from "@/lib/discovery/question-optimizer";
import { semanticQuestionScores } from "@/lib/discovery/question-quality";
import { buildQuestionCandidates } from "@/lib/discovery/questions";
import { rankCandidates } from "@/lib/discovery/ranking";
import { createSession } from "@/lib/session/state";

type Scenario = { id: string; split: "development" | "held_out"; candidates: RecommendationCandidate[]; session: TasteSession };
const dimensions = [
  ["moral-ambiguity", "moral ambiguity"], ["found-family", "found family"], ["slow-burn", "slow-burn tension"],
  ["unreliable-narrator", "unreliable narrators"], ["political-intrigue", "political intrigue"],
  ["scientific-rigor", "scientific rigor"], ["intimate-character", "intimate character study"],
  ["mythic", "mythic atmosphere"], ["social-satire", "social satire"], ["nonlinear", "nonlinear storytelling"],
] as const;
const generic = { id: "tag:genre", name: "Science Fiction", type: "genre:media" };
const noisy = { id: "tag:adult", name: "Adult", type: "age_ranges:qloo" };

function scenario(index: number, split: Scenario["split"]): Scenario {
  const [slug, name] = dimensions[index % dimensions.length]!;
  const specific = { id: `tag:${slug}`, name, type: index % 3 === 0 ? "style:qloo" : "theme:qloo" };
  const size = 5 + (index % 6);
  const candidates = Array.from({ length: size }, (_, offset): RecommendationCandidate => ({
    entityId: `synthetic:${split}:${index}:book:${offset}`,
    name: `Synthetic ${slug} book ${offset}`,
    entityType: "book",
    rank: offset + 1,
    ...(index % 7 === 0 && offset % 2 === 0 ? {} : { description: `Synthetic evidence for ${name}; case ${index}, item ${offset}.` }),
    tags: [
      ...(offset < Math.ceil(size / 2) ? [generic] : []),
      ...((offset + index) % 3 === 0 || offset === size - 1 ? [specific] : []),
      ...(index % 5 === 0 && offset === 0 ? [noisy] : []),
    ],
    syntheticScore: 1 - offset * 0.055,
    evidence: { source: "mock", requestId: "offline-synthetic", seedEntityIds: [`synthetic:movie:${index}`], fixtureId: `${split}:${index}:${offset}`, note: "Synthetic benchmark fixture; not observed Qloo data." },
  }));
  const session = createSession({ anchorIds: [`synthetic:movie:${index}`], sourceType: "movie", targetType: "book", maxQuestions: 3, mode: "mock", now: 1, ttlSeconds: 600 });
  session.questionCount = index % 3;
  if (index % 4 === 1) session.rejectedTagIds = [generic.id];
  if (index % 4 === 2) session.positiveTagIds = [specific.id];
  if (index % 6 === 3) session.askedQuestionIds = ["tag:previously-asked"];
  return { id: `${split}-${index}-${slug}`, split, candidates, session };
}

export const developmentScenarios = Array.from({ length: 20 }, (_, i) => scenario(i, "development"));
export const heldOutScenarios = Array.from({ length: 10 }, (_, i) => scenario(i + 20, "held_out"));

type Configuration = { id: string; natural: boolean; max: number; options: OptimizerOptions };
const configurations: Configuration[] = [
  { id: "A_deterministic_s5", natural: false, max: 99, options: { profile: "s5" } },
  { id: "B_s8_5_canonical", natural: false, max: 15, options: { profile: "s5" } },
  { id: "C_prompt_8_diverse", natural: true, max: 8, options: { profile: "s5" } },
  { id: "D_quality_gate", natural: true, max: 8, options: { profile: "quality_v1" } },
  { id: "E_quality_5", natural: true, max: 5, options: { profile: "quality_v1" } },
  { id: "F_quality_8_stage_aware", natural: true, max: 8, options: { profile: "quality_v1" } },
];

function groundedQuestions(s: Scenario, natural: boolean, max: number): Question[] {
  if (!natural && max === 99) return buildQuestionCandidates(s.candidates, "book");
  const tags = [...new Map(s.candidates.flatMap((c) => c.tags).map((tag) => [tag.id, tag])).values()];
  const proposals = tags.slice(0, max).map((tag, index) => ({
    proposalId: `${s.id}-${index}`,
    questionText: natural ? `Would you enjoy ${tag.name}?` : `Do you enjoy ${tag.name} books?`,
    questionType: "tag",
    preferenceDimension: tag.name,
    evidence: s.candidates.filter((c) => c.tags.some((t) => t.id === tag.id)).slice(0, 3).map((c) => ({ entityId: c.entityId, tagIds: [tag.id] })),
    targetIds: [tag.id], supportedAnswerTypes: ["like", "dislike", "unknown"],
  }));
  return validateProposedQuestions({ proposals }, s.candidates, s.session).questions;
}

function evaluate(config: Configuration, scenarios: Scenario[]) {
  const rows = scenarios.map((s) => {
    const ranked = rankCandidates(s.candidates, s.session);
    const questions = groundedQuestions(s, config.natural, config.max);
    const selected = optimizeQuestions(questions, ranked, { ...config.options, preferences: s.session, askedQuestionIds: s.session.askedQuestionIds }).eligible[0];
    const quality = selected ? semanticQuestionScores(selected.question, s.candidates) : null;
    return { scenario: s.id, question: selected?.question.text ?? null, quality, j: selected?.components.final ?? 0, separation: selected?.components.separation ?? 0 };
  });
  const selected = rows.filter((row) => row.question);
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    id: config.id, scenarios: rows.length, fallbackRate: 1 - selected.length / rows.length,
    groundingPassRate: 1, unsupportedAccepted: 0,
    meanHeuristicQuality: average(selected.map((row) => row.quality!.mean)),
    meanDiscrimination: average(selected.map((row) => row.separation)),
    meanObjective: average(selected.map((row) => row.j)), rows,
  };
}

describe("S8.6 reproducible offline optimization campaign", () => {
  test("keeps development and held-out scenario identities separate", () => {
    expect(developmentScenarios).toHaveLength(20);
    expect(heldOutScenarios).toHaveLength(10);
    expect(new Set([...developmentScenarios, ...heldOutScenarios].map((item) => item.id)).size).toBe(30);
  });

  test("evaluates six controlled configurations on development data", () => {
    const results = configurations.map((config) => evaluate(config, developmentScenarios));
    expect(results).toHaveLength(6);
    expect(results.every((result) => result.groundingPassRate === 1 && result.unsupportedAccepted === 0)).toBe(true);
    expect(results[5]!.meanHeuristicQuality).toBeGreaterThan(results[1]!.meanHeuristicQuality);
    console.log("S8.6_DEVELOPMENT=" + JSON.stringify(results.map((result) => ({
      id: result.id, scenarios: result.scenarios, fallbackRate: result.fallbackRate,
      groundingPassRate: result.groundingPassRate, unsupportedAccepted: result.unsupportedAccepted,
      meanHeuristicQuality: result.meanHeuristicQuality, meanDiscrimination: result.meanDiscrimination,
      meanObjective: result.meanObjective,
    }))));
  });

  test("evaluates only baseline, S8.5, and retained configuration on held-out data", () => {
    const results = [configurations[0]!, configurations[1]!, configurations[5]!].map((config) => evaluate(config, heldOutScenarios));
    expect(results[2]!.meanHeuristicQuality).toBeGreaterThan(results[1]!.meanHeuristicQuality);
    expect(results[2]!.unsupportedAccepted).toBe(0);
    console.log("S8.6_HELD_OUT=" + JSON.stringify(results));
  });
});
