import type { RecommendationCandidate } from "@/lib/contracts";

/** Conservative content dimensions verified in Qloo responses; operational mock theme supports offline fixtures. */
export const MEANINGFUL_TAG_TYPES = new Set([
  "genre:media",
  "genre:qloo",
  "subgenre:qloo",
  "theme:qloo",
  "setting:qloo",
  "style:qloo",
  "motif:qloo",
  "time_period:qloo",
  "critical_descriptor:qloo",
  "mock:tag:theme",
]);

const unusableLabels = /^(unknown|other|misc(?:ellaneous)?|n\/a|none|null|undefined|untitled)$/i;
const opaqueLabel = /^(urn:|https?:|[0-9a-f]{8}-[0-9a-f-]{27,}$)/i;

export function isUsefulTag(tag: RecommendationCandidate["tags"][number]): boolean {
  const label = tag.name.trim();
  return (
    MEANINGFUL_TAG_TYPES.has(tag.type) &&
    label.length >= 2 &&
    label.length <= 60 &&
    !unusableLabels.test(label) &&
    !opaqueLabel.test(label) &&
    /[a-z]/i.test(label)
  );
}
