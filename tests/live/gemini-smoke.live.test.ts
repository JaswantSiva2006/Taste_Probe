import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { AgentDecisionSchema } from "@/lib/contracts";
import { buildAgentContext } from "@/lib/agent/context";
import { createBoundedAgent } from "@/lib/agent/factory";
import { TOOL_NAMES } from "@/lib/agent/tools";
import { loadConfig } from "@/lib/config/env";
import { normalizeRecommendations } from "@/lib/discovery/normalize";
import { optimizeQuestions } from "@/lib/discovery/question-optimizer";
import { buildQuestionCandidates } from "@/lib/discovery/questions";
import { rankCandidates } from "@/lib/discovery/ranking";
import { createMockQlooProvider } from "@/lib/qloo/mock-provider";
import { createSession } from "@/lib/session/state";

/**
 * LIVE Gemini smoke (npm run smoke:gemini). Runs only with RUN_GEMINI_SMOKE=1.
 * One agent decision = at most 2 real inference requests (initial + optional repair).
 * The S5 shortlist comes from local fixtures (no Qloo); no session store is touched.
 * Every outbound fetch is checked: only the Gemini API host is allowed.
 */
const RUN = process.env.RUN_GEMINI_SMOKE === "1";
const GEMINI_HOST = "generativelanguage.googleapis.com";

describe.skipIf(!RUN)("live Gemini agent smoke", () => {
  const require = createRequire(import.meta.url);
  require("@next/env").loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

  const hosts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    hosts.push(host);
    if (host !== GEMINI_HOST) throw new Error(`smoke blocked a request to a non-Gemini host`);
    return realFetch(input, init);
  }) as typeof fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("makes a real, validated Gemini function-calling decision", async () => {
    const missing = ["LLM_PROVIDER", "LLM_MODEL", "GOOGLE_API_KEY"].filter((k) => !process.env[k]?.trim());
    expect(missing, `missing environment variables: ${missing.join(", ")}`).toEqual([]);
    const apiKey = process.env.GOOGLE_API_KEY!;

    // Central config for llm/features; the mode is forced to live only for agent selection.
    const config = loadConfig({ ...process.env, NODE_ENV: "test", QLOO_MODE: "mock" });
    const agent = createBoundedAgent({ mode: "live", llm: config.llm, features: { ...config.features, agentTracing: false } });
    expect(agent.mode).toBe("LIVE_GEMINI");

    // Fixture-backed S5 shortlist (Interstellar -> books), no network.
    const seed = "mock:movie:interstellar";
    const raw = await createMockQlooProvider().getRecommendations({ seedEntityIds: [seed], targetType: "book", take: 8 });
    const candidates = normalizeRecommendations(raw, [seed], 8);
    const now = Date.now();
    const session = createSession({ anchorIds: [seed], sourceType: "movie", targetType: "book", maxQuestions: 3, mode: "live", now, ttlSeconds: 600 });
    const ranked = rankCandidates(candidates, session);
    const eligible = optimizeQuestions(buildQuestionCandidates(candidates, "book"), ranked, { preferences: session }).eligible;
    const context = buildAgentContext({ session, ranked, eligible, toolCallsRemaining: config.limits.maxAgentToolCallsPerTurn, qlooCallsRemaining: 4, now });
    expect(context.questions.length).toBeGreaterThan(0);

    const result = await agent.decide(context);

    const summary = {
      model: result.model,
      mode: result.mode,
      validation: result.validation,
      fallbackReason: result.fallbackReason ?? null,
      error: result.error ?? null,
      allowedTools: result.toolCalls.allowed,
      functionCalls: result.toolCalls.names,
      acceptedTool: result.toolCalls.accepted,
      decision: result.decision,
      intent: result.intent ?? null,
      offeredQuestionIds: context.questions.map((q) => q.questionId),
      usage: result.usage,
      outboundHosts: hosts,
    };
    const printable = JSON.stringify(summary, null, 2);
    console.log(`GEMINI SMOKE RESULT\n${printable}`);

    // No credential exposure in anything we produce.
    expect(printable).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain(apiKey);

    // Real inference only; never a disguised fallback.
    expect(hosts.length).toBeGreaterThanOrEqual(1);
    expect(hosts.length).toBeLessThanOrEqual(2);
    expect(hosts.every((h) => h === GEMINI_HOST)).toBe(true);
    expect(result.mode, `fallback: ${result.fallbackReason} ${JSON.stringify(result.error)}`).toBe("LIVE_GEMINI");
    expect(result.model).toBe(process.env.LLM_MODEL);

    // A genuine, authorized function call converted to a canonical decision.
    expect(result.toolCalls.attempted).toBeGreaterThanOrEqual(1);
    expect(TOOL_NAMES).toContain(result.toolCalls.accepted);
    expect(result.toolCalls.allowed).toContain(result.toolCalls.accepted);
    expect(AgentDecisionSchema.safeParse(result.decision).success).toBe(true);
    if (result.decision.action === "ask") {
      const approved = context.questions.find((q) => q.questionId === result.decision.selectedQuestionId);
      expect(approved).toBeDefined();
      expect(result.decision.questionText).toBe(approved!.text);
    }

    // Usage and cost metadata from the provider.
    expect(result.usage.requests).toBeLessThanOrEqual(2);
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.estimatedCostUsd).not.toBeNull();
    expect(result.usage.estimatedCostUsd!).toBeGreaterThan(0);
    expect(result.usage.estimatedCostUsd!).toBeLessThan(0.01);
  }, 60_000);
});
