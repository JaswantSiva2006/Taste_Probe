/**
 * Per-model pricing for cost ESTIMATES (USD per 1M tokens, standard paid tier).
 * Source: ai.google.dev/gemini-api/docs/pricing, checked 2026-10-29 (S2) and
 * re-checked for S6. Thinking tokens are billed at the output rate.
 */
export const GEMINI_PRICING: Readonly<Record<string, { inputPerMillion: number; outputPerMillion: number }>> = {
  "gemini-3.5-flash-lite": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
};

export type TokenUsage = { promptTokens: number; outputTokens: number; thoughtTokens: number; totalTokens: number };

export const emptyUsage = (): TokenUsage => ({ promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 });

/** Reads Gemini `usageMetadata`; missing fields count as 0. */
export function usageFrom(metadata: unknown): TokenUsage {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  const n = (k: string) => (typeof m[k] === "number" && Number.isFinite(m[k]) ? (m[k] as number) : 0);
  const promptTokens = n("promptTokenCount");
  const outputTokens = n("candidatesTokenCount");
  const thoughtTokens = n("thoughtsTokenCount");
  return { promptTokens, outputTokens, thoughtTokens, totalTokens: n("totalTokenCount") || promptTokens + outputTokens + thoughtTokens };
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  thoughtTokens: a.thoughtTokens + b.thoughtTokens,
  totalTokens: a.totalTokens + b.totalTokens,
});

/** Estimated USD, or null when the model has no known price (never guessed). */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = GEMINI_PRICING[model];
  if (!price) return null;
  const cost = (usage.promptTokens * price.inputPerMillion + (usage.outputTokens + usage.thoughtTokens) * price.outputPerMillion) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}
