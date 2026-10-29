/**
 * Pure helpers for scripts/probe-live.mjs (S2 live API verification).
 * No network, no environment access: everything here is unit-tested offline.
 * Kept free of TS-only runtime syntax so Node can load it with type stripping.
 */

// ---- Secrets ---------------------------------------------------------------

/** Replaces every occurrence of each secret (length >= 6) with [REDACTED]. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

/** Reports which variables are missing/blank, never their values. */
export function missingVariables(env: Record<string, string | undefined>, names: string[]): string[] {
  return names.filter((n) => !env[n] || env[n]!.trim() === "");
}

// ---- Budgets ---------------------------------------------------------------

export type Budget = { readonly name: string; readonly limit: number; used: number; take(): void };

export class BudgetExceededError extends Error {}

export function createBudget(name: string, limit: number): Budget {
  return {
    name,
    limit,
    used: 0,
    take() {
      if (this.used >= this.limit) {
        throw new BudgetExceededError(`${name} request budget (${limit}) exhausted`);
      }
      this.used += 1;
    },
  };
}

// ---- HTTP ------------------------------------------------------------------

export function buildUrl(base: string, path: string, params: Record<string, string | number | boolean>): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

export type FailureKind = "auth" | "billing_or_quota" | "bad_request" | "not_found" | "server" | "other";

/** Classifies a non-2xx status. auth/billing_or_quota must stop the run. */
export function classifyHttpFailure(status: number): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "billing_or_quota";
  if (status === 400 || status === 422) return "bad_request";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "other";
}

export const isFatalFailure = (kind: FailureKind): boolean => kind === "auth" || kind === "billing_or_quota";

// ---- JSON inspection --------------------------------------------------------

export function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * Collects JSON paths with observed types, e.g. "results.entities[].tags[].tag_id: string".
 * Arrays are merged across all elements; values are never included.
 */
export function describeShape(value: unknown, maxDepth = 6): string[] {
  const seen = new Map<string, Set<string>>();
  const walk = (v: unknown, path: string, depth: number) => {
    const t = typeName(v);
    if (path) {
      const set = seen.get(path) ?? new Set<string>();
      set.add(t);
      seen.set(path, set);
    }
    if (depth >= maxDepth) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, `${path}[]`, depth + 1);
    } else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(value, "", 0);
  return [...seen.entries()].map(([p, types]) => `${p}: ${[...types].sort().join("|")}`).sort();
}

// ---- Qloo entities -----------------------------------------------------------

export type RawEntity = Record<string, unknown>;

/** Entity arrays observed at known locations; returns the path that matched. */
export function findEntityList(body: unknown): { path: string; entities: RawEntity[] } | null {
  for (const path of ["results.entities", "results", "entities"]) {
    const v = getPath(body, path);
    if (Array.isArray(v) && v.every((e) => e && typeof e === "object")) return { path, entities: v as RawEntity[] };
  }
  return null;
}

export const entityIdOf = (e: RawEntity): string | undefined =>
  typeof e.entity_id === "string" && e.entity_id.trim() ? e.entity_id : undefined;

/** Type URNs from `subtype` and/or `types[]`, whichever are present. */
export function entityTypesOf(e: RawEntity): string[] {
  const out: string[] = [];
  if (typeof e.subtype === "string") out.push(e.subtype);
  if (Array.isArray(e.types)) out.push(...e.types.filter((t): t is string => typeof t === "string"));
  if (typeof e.type === "string") out.push(e.type);
  return [...new Set(out)];
}

export type TagRef = { id: string; name: string; type: string };

export function tagsOf(e: RawEntity): TagRef[] {
  if (!Array.isArray(e.tags)) return [];
  return e.tags.flatMap((t) => {
    const tag = t as Record<string, unknown>;
    const id = typeof tag.tag_id === "string" ? tag.tag_id : typeof tag.id === "string" ? tag.id : undefined;
    if (!id) return [];
    return [{ id, name: typeof tag.name === "string" ? tag.name : id, type: typeof tag.type === "string" ? tag.type : "unknown" }];
  });
}

const nonEmpty = (v: unknown): boolean =>
  v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && v.length === 0);

/** Candidate JSON paths checked for each metadata field; the first present path wins. */
export const METADATA_PATHS = {
  description: ["properties.description", "properties.short_description", "description"],
  image: ["properties.image.url", "properties.images", "image.url"],
  affinity: ["query.affinity", "affinity"],
  explainability: ["query.explainability", "explainability"],
  popularity: ["popularity", "properties.popularity"],
} as const;

export type FieldCoverage = { count: number; paths: string[] };

export type MetadataReport = {
  total: number;
  validIds: number;
  uniqueIds: number;
  matchingType: number;
  withTags: number;
  distinctTags: number;
  usefulTags: number;
  tagTypes: Record<string, number>;
  fields: Record<keyof typeof METADATA_PATHS, FieldCoverage>;
  topTags: Array<TagRef & { count: number }>;
};

/**
 * Measures recommendation metadata. A tag is "useful" for questioning when it
 * appears on at least one but not all candidates (it can split the shortlist).
 */
export function measureEntities(entities: RawEntity[], expectedType: string): MetadataReport {
  const ids = entities.map(entityIdOf);
  const tagCounts = collectTags(entities);
  const tagTypes: Record<string, number> = {};
  for (const t of tagCounts.values()) tagTypes[t.type] = (tagTypes[t.type] ?? 0) + 1;

  const fields = Object.fromEntries(
    Object.entries(METADATA_PATHS).map(([field, paths]) => {
      const used = new Set<string>();
      let count = 0;
      for (const e of entities) {
        const hit = paths.find((p) => nonEmpty(getPath(e, p)));
        if (hit) {
          count += 1;
          used.add(hit);
        }
      }
      return [field, { count, paths: [...used] }];
    }),
  ) as MetadataReport["fields"];

  const n = entities.length;
  return {
    total: n,
    validIds: ids.filter(Boolean).length,
    uniqueIds: new Set(ids.filter(Boolean)).size,
    matchingType: entities.filter((e) => entityTypesOf(e).includes(expectedType)).length,
    withTags: entities.filter((e) => tagsOf(e).length > 0).length,
    distinctTags: tagCounts.size,
    usefulTags: [...tagCounts.values()].filter((t) => t.count > 0 && t.count < n).length,
    tagTypes,
    fields,
    topTags: [...tagCounts.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).slice(0, 10),
  };
}

/**
 * Picks a verified tag to use as a positive signal: one that splits the
 * shortlist most evenly (so a change is observable), preferring genre tags.
 */
export function pickSignalTag(entities: RawEntity[]): TagRef | null {
  const n = entities.length;
  const candidates = [...collectTags(entities).values()].filter((t) => t.count > 0 && t.count < n);
  if (!candidates.length) return null;
  candidates.sort(
    (a, b) =>
      Math.abs(a.count - n / 2) - Math.abs(b.count - n / 2) ||
      Number(!a.type.includes("genre")) - Number(!b.type.includes("genre")) ||
      a.id.localeCompare(b.id),
  );
  const { id, name, type } = candidates[0]!;
  return { id, name, type };
}

/** Tag ID -> tag with the number of entities carrying it. */
export function collectTags(entities: RawEntity[]): Map<string, TagRef & { count: number }> {
  const map = new Map<string, TagRef & { count: number }>();
  for (const e of entities) {
    for (const t of new Map(tagsOf(e).map((x) => [x.id, x])).values()) {
      const entry = map.get(t.id) ?? { ...t, count: 0 };
      entry.count += 1;
      map.set(t.id, entry);
    }
  }
  return map;
}

// ---- Result comparison & classification ------------------------------------

export type Comparison = {
  baseCount: number;
  variantCount: number;
  overlap: number;
  jaccard: number;
  sameOrder: boolean;
  added: string[];
  removed: string[];
  movedWithinOverlap: number;
};

export function compareIds(base: string[], variant: string[]): Comparison {
  const b = new Set(base);
  const v = new Set(variant);
  const shared = base.filter((id) => v.has(id));
  const union = new Set([...base, ...variant]);
  const variantShared = variant.filter((id) => b.has(id));
  return {
    baseCount: base.length,
    variantCount: variant.length,
    overlap: shared.length,
    jaccard: union.size ? Math.round((shared.length / union.size) * 1000) / 1000 : 1,
    sameOrder: base.length === variant.length && base.every((id, i) => id === variant[i]),
    added: variant.filter((id) => !b.has(id)),
    removed: base.filter((id) => !v.has(id)),
    movedWithinOverlap: shared.filter((id, i) => variantShared[i] !== id).length,
  };
}

export type Verdict = "SUPPORTED" | "UNSUPPORTED" | "UNVERIFIED";
export type Classification = { verdict: Verdict; reason: string };

/** Positive signal: SUPPORTED only if accepted AND results materially changed. */
export function classifyPositiveSignal(status: number | null, cmp: Comparison | null): Classification {
  if (status === null) return { verdict: "UNVERIFIED", reason: "not tested" };
  if (status === 400 || status === 422) return { verdict: "UNSUPPORTED", reason: `rejected with HTTP ${status}` };
  if (status < 200 || status >= 300 || !cmp) return { verdict: "UNVERIFIED", reason: `HTTP ${status}; no comparable result` };
  if (cmp.sameOrder) return { verdict: "UNVERIFIED", reason: "accepted (HTTP 2xx) but results identical to baseline" };
  return {
    verdict: "SUPPORTED",
    reason: `accepted and results changed (jaccard ${cmp.jaccard}, +${cmp.added.length}/-${cmp.removed.length}, ${cmp.movedWithinOverlap} reordered)`,
  };
}

/** Exclusion: SUPPORTED only if the excluded ID was in the baseline and is absent from the variant. */
export function classifyExclusion(
  status: number | null,
  excludedId: string | null,
  baselineIds: string[],
  variantIds: string[] | null,
): Classification {
  if (status === null || !excludedId) return { verdict: "UNVERIFIED", reason: "not tested" };
  if (status === 400 || status === 422) return { verdict: "UNSUPPORTED", reason: `rejected with HTTP ${status}` };
  if (status < 200 || status >= 300 || !variantIds) return { verdict: "UNVERIFIED", reason: `HTTP ${status}; no comparable result` };
  if (!baselineIds.includes(excludedId)) return { verdict: "UNVERIFIED", reason: "excluded ID was not in the baseline" };
  return variantIds.includes(excludedId)
    ? { verdict: "UNSUPPORTED", reason: "accepted but excluded ID still returned" }
    : { verdict: "SUPPORTED", reason: "excluded ID absent from otherwise comparable results" };
}

// ---- Gemini ----------------------------------------------------------------

/** Mirrors AgentDecision (src/lib/contracts/domain.ts) as a Gemini responseSchema (OpenAPI subset). */
export function agentDecisionResponseSchema(actions: string[], reasonCodes: string[]): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      action: { type: "STRING", enum: actions },
      selectedQuestionId: { type: "STRING" },
      questionText: { type: "STRING" },
      reasonCode: { type: "STRING", enum: reasonCodes },
      done: { type: "BOOLEAN" },
    },
    required: ["action", "reasonCode", "done"],
    propertyOrdering: ["action", "selectedQuestionId", "questionText", "reasonCode", "done"],
  };
}

export type GeminiPart = { text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown } };

function partsOf(response: unknown): GeminiPart[] {
  const parts = getPath(response, "candidates.0.content.parts");
  return Array.isArray(parts) ? (parts as GeminiPart[]) : [];
}

/** Concatenated non-thought text from the first candidate. */
export function geminiText(response: unknown): string {
  return partsOf(response)
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
}

export function geminiFunctionCalls(response: unknown): Array<{ name: string; args: unknown }> {
  return partsOf(response).flatMap((p) =>
    p.functionCall && typeof p.functionCall.name === "string" ? [{ name: p.functionCall.name, args: p.functionCall.args ?? {} }] : [],
  );
}

export type Pricing = { inputPerMillion: number; outputPerMillion: number; source: string };

export type UsageSummary = {
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

/** Thinking tokens are billed at the output rate. */
export function summarizeUsage(usage: unknown, pricing: Pricing): UsageSummary {
  const num = (p: string) => {
    const v = getPath(usage, p);
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const promptTokens = num("promptTokenCount");
  const outputTokens = num("candidatesTokenCount");
  const thoughtTokens = num("thoughtsTokenCount");
  const cost =
    (promptTokens * pricing.inputPerMillion + (outputTokens + thoughtTokens) * pricing.outputPerMillion) / 1_000_000;
  return {
    promptTokens,
    outputTokens,
    thoughtTokens,
    totalTokens: num("totalTokenCount") || promptTokens + outputTokens + thoughtTokens,
    estimatedCostUsd: Math.round(cost * 1e6) / 1e6,
  };
}
