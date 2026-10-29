import { domainLanguageOfNoun, domainLanguageOfPlural, type RecommendationCandidate } from "@/lib/contracts";
import type { ProposedQuestion } from "./schema";

export type RenderingStrategy = "s8_6" | "deterministic" | "preserve" | "hybrid";

/** Plural target noun from the domain registry, e.g. "books" or "movies". */
export type TargetNoun = string;

const clean = (value: string) => value.trim().replace(/\s+/g, " ");
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bareType = (value: string) => value.trim().replace(/^urn:tag:/, "");

const registryWording = (label: string, noun: TargetNoun) => domainLanguageOfPlural(noun).tagQuestion.replace("{label}", clean(label));

function faithfulPatterns(label: string, noun: TargetNoun): RegExp[] {
  const value = escaped(clean(label));
  const { narrative, verb } = domainLanguageOfPlural(noun);
  const exact = new RegExp(`^${escaped(registryWording(label, noun))}$`, "i");
  if (!narrative) {
    // Non-narrative targets (music artists, games, podcasts): never "stories"/"storytelling".
    const item = `(?:${escaped(noun)})`;
    return [
      exact,
      new RegExp(`^(?:do|would) you (?:enjoy|like|prefer) ${value} ${item}\\?$`, "i"),
      new RegExp(`^(?:do|would) you (?:enjoy|like|prefer) ${item} (?:associated with|featuring|with|about) ${value}\\?$`, "i"),
      new RegExp(`^(?:are|would) you (?:be )?(?:drawn to|interested in) ${item} (?:associated with|about|featuring|with) ${value}\\?$`, "i"),
      new RegExp(`^would you like to ${escaped(verb)} more ${value}\\?$`, "i"),
    ];
  }
  const item = `(?:${escaped(noun)}|stories)`;
  return [
    exact,
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
export function isSemanticallyFaithfulTagWording(text: string, label: string, noun: TargetNoun): boolean {
  const value = clean(text);
  if (value.length > 180 || /\b(?:not|without|avoid|instead|rather than|or)\b/i.test(value)) return false;
  return faithfulPatterns(label, noun).some((pattern) => pattern.test(value));
}

/** General category-aware renderer: it never substitutes or expands the verified label. */
export function deterministicTagWording(
  label: string,
  type: string,
  noun: TargetNoun,
): string {
  const value = clean(label);
  // Non-narrative targets keep the registry's own phrasing for every tag type.
  if (!domainLanguageOfPlural(noun).narrative) return registryWording(value, noun);
  switch (bareType(type)) {
    case "genre:media":
    case "genre:qloo":
    case "subgenre:qloo":
      return `Would you like to ${domainLanguageOfPlural(noun).verb} more ${value}?`;
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
  noun: TargetNoun;
  strategy?: RenderingStrategy;
}): string {
  const { proposal, tag, noun } = input;
  const generated = clean(proposal.questionText);
  // Registry wording; for books/movies this is exactly "Do you enjoy <label> <noun>?".
  const conservative = registryWording(tag.name, noun);
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
  /** Singular target noun from the domain registry. */
  noun: string;
}): string {
  const generated = clean(input.proposal.questionText);
  const a = escaped(clean(input.aName));
  const b = escaped(clean(input.bName));
  const quotedA = `[“\"]${a}[”\"]`;
  const quotedB = `[“\"]${b}[”\"]`;
  const { narrative, verb } = domainLanguageOfNoun(input.noun);
  const verbs = narrative ? "(?:read|watch)" : escaped(verb);
  const safe = [
    new RegExp(`^which ${escaped(input.noun)} sounds more appealing: ${quotedA} or ${quotedB}\\?$`, "i"),
    new RegExp(`^which would you rather ${verbs}: ${quotedA} or ${quotedB}\\?$`, "i"),
  ].some((pattern) => pattern.test(generated));
  return safe
    ? generated
    : `Which ${input.noun} sounds more appealing: “${clean(input.aName)}” or “${clean(input.bName)}”?`;
}
