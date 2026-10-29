import type { RecommendationCandidate } from "@/lib/contracts";
import type { ProposedQuestion } from "./schema";

export type RenderingStrategy = "s8_6" | "deterministic" | "preserve" | "hybrid";

const clean = (value: string) => value.trim().replace(/\s+/g, " ");
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bareType = (value: string) => value.trim().replace(/^urn:tag:/, "");

function faithfulPatterns(label: string, noun: "books" | "movies"): RegExp[] {
  const value = escaped(clean(label));
  const item = noun === "books" ? "(?:books|stories)" : "(?:movies|stories)";
  return [
    new RegExp(`^(?:do|would) you (?:enjoy|like|prefer) (?:more )?${value}(?: ${item}| storytelling)?\\?$`, "i"),
    new RegExp(`^(?:do|would) you (?:enjoy|like|prefer) ${item} (?:about|built around|centered on|exploring|featuring|that explore|with) ${value}\\?$`, "i"),
    new RegExp(`^are you (?:drawn to|interested in) ${item} (?:about|centered on|exploring|featuring|with) ${value}\\?$`, "i"),
    new RegExp(`^do you enjoy stories set in (?:the )?${value}\\?$`, "i"),
    new RegExp(`^do you like stories that explore the theme of ${value}\\?$`, "i"),
    new RegExp(`^would you like to (?:read|watch) more ${value}\\?$`, "i"),
  ];
}

/**
 * A generated wording is faithful only when it places the exact verified label
 * inside a positive, single-dimension intent pattern. Similarity is not enough.
 */
export function isSemanticallyFaithfulTagWording(text: string, label: string, noun: "books" | "movies"): boolean {
  const value = clean(text);
  if (value.length > 180 || /\b(?:not|without|avoid|instead|rather than|or)\b/i.test(value)) return false;
  return faithfulPatterns(label, noun).some((pattern) => pattern.test(value));
}

/** General category-aware renderer: it never substitutes or expands the verified label. */
export function deterministicTagWording(
  label: string,
  type: string,
  noun: "books" | "movies",
): string {
  const value = clean(label);
  switch (bareType(type)) {
    case "genre:media":
    case "genre:qloo":
    case "subgenre:qloo":
      return noun === "books"
        ? `Would you like to read more ${value}?`
        : `Would you like to watch more ${value}?`;
    case "setting:qloo":
      return `Do you enjoy stories set in ${value}?`;
    case "time_period:qloo":
      return `Do you enjoy stories set in the ${value}?`;
    case "style:qloo":
    case "critical_descriptor:qloo":
      return `Do you enjoy ${value} storytelling?`;
    case "motif:qloo":
      return `Do you like stories built around ${value}?`;
    case "theme:qloo":
    case "mock:tag:theme":
    default:
      return `Do you like stories that explore the theme of ${value}?`;
  }
}

export function renderTagQuestion(input: {
  proposal: ProposedQuestion;
  tag: RecommendationCandidate["tags"][number];
  noun: "books" | "movies";
  strategy?: RenderingStrategy;
}): string {
  const { proposal, tag, noun } = input;
  const generated = clean(proposal.questionText);
  const conservative = `Do you enjoy ${clean(tag.name)} ${noun}?`;
  if (input.strategy === "s8_6") return conservative;
  if (input.strategy === "deterministic") return deterministicTagWording(tag.name, tag.type, noun);
  const faithful = isSemanticallyFaithfulTagWording(generated, tag.name, noun);
  if (input.strategy === "preserve") return faithful ? generated : conservative;
  return faithful ? generated : deterministicTagWording(tag.name, tag.type, noun);
}

/** Preserves only neutral A/B comparisons that name both exact verified entities. */
export function renderEntityQuestion(input: {
  proposal: ProposedQuestion;
  aName: string;
  bName: string;
  noun: "book" | "movie";
}): string {
  const generated = clean(input.proposal.questionText);
  const a = escaped(clean(input.aName));
  const b = escaped(clean(input.bName));
  const quotedA = `[“\"]${a}[”\"]`;
  const quotedB = `[“\"]${b}[”\"]`;
  const safe = [
    new RegExp(`^which ${input.noun} sounds more appealing: ${quotedA} or ${quotedB}\\?$`, "i"),
    new RegExp(`^which would you rather (?:read|watch): ${quotedA} or ${quotedB}\\?$`, "i"),
  ].some((pattern) => pattern.test(generated));
  return safe
    ? generated
    : `Which ${input.noun} sounds more appealing: “${clean(input.aName)}” or “${clean(input.bName)}”?`;
}
