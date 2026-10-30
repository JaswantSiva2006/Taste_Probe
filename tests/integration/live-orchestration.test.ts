import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryView, StartRequest } from "@/lib/contracts";
import type { BoundedAgent } from "@/lib/agent/bounded";
import { createBoundedAgent } from "@/lib/agent/factory";
import { GeminiTransportError, type GeminiTransport } from "@/lib/agent/gemini-transport";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import type { QuestionGenerator } from "@/lib/agent/question-generation/proposer";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { answerDiscovery, finishDiscovery, startDiscovery, type DiscoveryDeps } from "@/lib/discovery/service";
import { discoveryPathProblems } from "@/lib/discovery/path";
import { isUsefulTag } from "@/lib/discovery/tag-quality";
import { buildQuestionCandidates } from "@/lib/discovery/questions";
import type { QlooProvider, RecommendationRequest } from "@/lib/qloo/provider";
import type { RawInsightEntity } from "@/lib/qloo/raw-types";
import { createMemorySessionStore } from "@/lib/session/memory-store";
import type { SessionStore } from "@/lib/session/store";
import { AppError } from "@/lib/validation/errors";
import { testConfig } from "../helpers";

/**
 * S7 live orchestration through the real discovery controller, with injected
 * transports: a realistic fake Qloo provider (UUID IDs, urn:tag: types, sparse
 * metadata) and the real S6 Gemini agent over a scripted HTTP transport.
 * Zero network calls.
 */

const FAKE_GEMINI_KEY = "AIzaTEST-not-a-real-key-000000000000";
const MOVIE_ID = "057DA9D9-399B-437E-8BCA-A80E499125EF";
const SF = { id: "urn:tag:genre:media:science_fiction", name: "Science Fiction", type: "urn:tag:genre:media" };
const FANTASY = { id: "urn:tag:genre:media:fantasy", name: "Fantasy", type: "urn:tag:genre:media" };
const SPACE = { id: "urn:tag:theme:qloo:space_travel", name: "Space Travel", type: "urn:tag:theme:qloo" };
const HARDCOVER = { id: "urn:tag:book_format:qloo:hardcover", name: "Hardcover", type: "urn:tag:book_format:qloo" };

const book = (id: string, name: string, affinity: number, tags: typeof SF[], meta = true): RawInsightEntity => ({
  entity_id: id,
  name,
  subtype: "urn:entity:book",
  query: { affinity },
  ...(meta ? { properties: { description: `${name} description from Qloo.`, image: { url: `https://images.example/${id}.jpg` } } } : {}),
  tags: tags.map((t) => ({ id: t.id, name: t.name, type: t.type })),
});

const BASE = [
  book("4B74CED1-0000-0000-0000-000000000001", "Ready Player One", 0.95, [SF, HARDCOVER]),
  book("4B74CED1-0000-0000-0000-000000000002", "Norse Mythology", 0.93, [FANTASY]),
  book("4B74CED1-0000-0000-0000-000000000003", "Ender's Game", 0.9, [SF, SPACE]),
  book("4B74CED1-0000-0000-0000-000000000004", "Mistborn", 0.88, [FANTASY, HARDCOVER]),
  book("4B74CED1-0000-0000-0000-000000000005", "Sparse Book", 0.86, [], false),
  book("4B74CED1-0000-0000-0000-000000000006", "Dune", 0.84, [SF, SPACE]),
];
const SF_BOOST = [
  book("4B74CED1-0000-0000-0000-000000000003", "Ender's Game", 0.97, [SF, SPACE]),
  book("4B74CED1-0000-0000-0000-000000000007", "The Martian", 0.96, [SF, SPACE]),
  book("4B74CED1-0000-0000-0000-000000000006", "Dune", 0.94, [SF, SPACE]),
  book("4B74CED1-0000-0000-0000-000000000001", "Ready Player One", 0.9, [SF]),
  book("4B74CED1-0000-0000-0000-000000000002", "Norse Mythology", 0.7, [FANTASY]),
];

type QlooOpts = { failInsights?: "always" | "after_first"; empty?: boolean; books?: RawInsightEntity[]; profile?: RawInsightEntity[]; failStart?: boolean };

function fakeQloo(opts: QlooOpts = {}) {
  const insights: RecommendationRequest[] = [];
  let searches = 0;
  const qloo = <T>(payload: T) => ({ provenance: "qloo" as const, requestId: randomUUID(), requestCount: 1, payload });
  const provider: QlooProvider = {
    mode: "live",
    async searchEntities() {
      searches += 1;
      return qloo({ results: [{ entity_id: MOVIE_ID, name: "Interstellar", types: ["urn:entity:movie"], properties: { release_year: 2014 } }] });
    },
    async getEntity(id) {
      searches += 1;
      return qloo(id === MOVIE_ID ? { entity_id: MOVIE_ID, name: "Interstellar", types: ["urn:entity:movie"] } : null);
    },
    async getRecommendations(req) {
      insights.push(req);
      if (opts.failStart || opts.failInsights === "always" || (opts.failInsights === "after_first" && insights.length > 1)) {
        throw new AppError("QLOO_TIMEOUT", 504, "Qloo request timed out");
      }
      if (opts.empty && insights.length > 1) return qloo({ success: true, results: { entities: [] } });
      const entities = req.positiveTagIds?.includes(SF.id)
        ? SF_BOOST
        : req.positiveEntityIds?.length ? (opts.profile ?? SF_BOOST) : (opts.books ?? BASE);
      return qloo({ success: true, results: { entities: structuredClone(entities) } });
    },
  };
  return { provider, insights, searches: () => searches };
}

// ---- scripted Gemini transport ---------------------------------------------------------

type Body = { tools: Array<{ functionDeclarations: Array<{ name: string; parameters: { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> } }> }> };
type Responder = (body: Body) => { status?: number; body?: unknown } | GeminiTransportError;

const declared = (b: Body) => b.tools[0]!.functionDeclarations.map((d) => d.name);
const enumOf = (b: Body, tool: string, arg: string) =>
  b.tools[0]!.functionDeclarations.find((d) => d.name === tool)?.parameters.properties[arg]?.enum ?? [];
const fc = (name: string, args: unknown) => ({
  body: {
    candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 40, totalTokenCount: 1040 },
    modelVersion: "gemini-3.5-flash-lite",
  },
});
const askAt = (i: number): Responder => (b) => fc("ask_question", { questionId: enumOf(b, "ask_question", "questionId")[i], reasonCode: "informative_question" });
const askTop = askAt(0);
const finish: Responder = () => fc("finish_discovery", { reasonCode: "stable_recommendations" });
const retrieveTags = (ids: string[]): Responder => () => fc("request_retrieval", { reasonCode: "insufficient_candidates", positiveTagIds: ids });

function scriptedGemini(...responders: Responder[]) {
  const bodies: Body[] = [];
  const transport: GeminiTransport = async ({ body }) => {
    bodies.push(body as Body);
    const r = responders.shift();
    if (!r) return { status: 500, body: { error: "unexpected extra Gemini request" } };
    const reply = r(body as Body);
    if (reply instanceof GeminiTransportError) throw reply;
    return { status: reply.status ?? 200, body: reply.body ?? {} };
  };
  return { transport, bodies };
}

// ---- environment ---------------------------------------------------------------------------

const START: StartRequest = { entityQuery: "Interstellar", sourceType: "movie", targetType: "book", maxQuestions: 3, selectedEntityId: MOVIE_ID };

type BarrierStore = SessionStore & { arm(n: number): void };
function barrier(inner: SessionStore): BarrierStore {
  let armed = 0;
  let waiting: Array<() => void> = [];
  return {
    kind: inner.kind,
    create: (i, r) => inner.create(i, r),
    compareAndSwap: (i, e, n, t) => inner.compareAndSwap(i, e, n, t),
    expire: (i) => inner.expire(i),
    arm: (n) => void (armed = n),
    async read(i, t) {
      const r = await inner.read(i, t);
      if (armed > 0) {
        await new Promise<void>((res) => {
          waiting.push(res);
          if (waiting.length === armed) {
            armed = 0;
            waiting.forEach((f) => f());
            waiting = [];
          }
        });
      }
      return r;
    },
  };
}

function liveEnv(opts: { qloo?: QlooOpts; gemini?: Responder[]; env?: Record<string, string>; agent?: BoundedAgent } = {}) {
  const qloo = fakeQloo(opts.qloo);
  const gemini = scriptedGemini(...(opts.gemini ?? []));
  const config = testConfig({
    QLOO_MODE: "live",
    QLOO_API_KEY: "test-qloo-key",
    LLM_PROVIDER: "google",
    LLM_MODEL: "gemini-3.5-flash-lite",
    GOOGLE_API_KEY: FAKE_GEMINI_KEY,
    ...opts.env,
  });
  const store = barrier(createMemorySessionStore());
  const clock = { t: Date.now() };
  const deps: DiscoveryDeps = {
    config,
    provider: qloo.provider,
    agent: createDeterministicMockAgent(),
    store,
    boundedAgent: opts.agent ?? createBoundedAgent(config, { transport: gemini.transport, log: () => {} }),
    now: () => clock.t,
  };
  return { deps, qloo, gemini, store, clock };
}

const ids = (v: DiscoveryView) => v.recommendations.map((r) => r.candidate.entityId);
const answer = (deps: DiscoveryDeps, v: DiscoveryView, response: string, questionId = v.currentQuestion!.questionId) =>
  answerDiscovery(deps, { sessionToken: v.sessionToken, questionId, response: response as "like" });
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? (r.reason as AppError).code : "ok");

function expectGrounded(v: DiscoveryView) {
  for (const r of v.recommendations) {
    expect(r.candidate.evidence.source).toBe("qloo");
    expect(r.candidate.entityId).not.toMatch(/^mock:/);
    expect(r.candidate.entityType).toBe("book");
    expect(r.candidate.evidence.requestId).toMatch(/^[0-9a-f-]{36}$/); // internal correlation ID
  }
  expect(JSON.stringify(v)).not.toContain("mock:");
  expect(JSON.stringify(v)).not.toContain(FAKE_GEMINI_KEY);
}

afterEach(() => vi.restoreAllMocks());

// ---- tests -------------------------------------------------------------------------------------

describe("1/27/28. agent selection and mode isolation", () => {
  it("live config selects the real Gemini agent; mock config keeps the original path", () => {
    const live = testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "k", LLM_PROVIDER: "google", LLM_MODEL: "gemini-3.5-flash-lite", GOOGLE_API_KEY: FAKE_GEMINI_KEY });
    expect(createDiscoveryDeps(live).boundedAgent?.mode).toBe("LIVE_GEMINI");
    expect(createDiscoveryDeps(testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "k", LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.5-flash-lite", GOOGLE_API_KEY: FAKE_GEMINI_KEY })).boundedAgent?.mode).toBe("LIVE_GEMINI");
    expect(createDiscoveryDeps(testConfig()).boundedAgent).toBeUndefined();
  });

  it("live mode with missing Gemini config fails closed instead of silently using the mock agent", () => {
    const noKey = testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "k", LLM_PROVIDER: "google", LLM_MODEL: "gemini-3.5-flash-lite" });
    expect(() => createDiscoveryDeps(noKey)).toThrowError(expect.objectContaining({ code: "CONFIG_ERROR" }));
  });

  it("LLM_PROVIDER=none is an explicit, truthfully labelled no-inference mode", async () => {
    const config = testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "k", LLM_PROVIDER: "none" });
    const agent = createDiscoveryDeps(config).boundedAgent!;
    const env = liveEnv({ agent });
    const v = await startDiscovery(env.deps, START);
    expect(v.agent).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", fallbackReason: "llm_disabled" });
    expect(env.gemini.bodies).toHaveLength(0);
  });

  it("28. mock mode performs no network calls at all", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const deps = { ...createDiscoveryDeps(testConfig()), store: createMemorySessionStore() };
    const v = await startDiscovery(deps, { ...START, selectedEntityId: "mock:movie:interstellar" });
    await answer(deps, v, "like");
    expect(spy).not.toHaveBeenCalled();
    expect(v.agent.mode).toBeUndefined(); // legacy mock path, unchanged response shape
  });

  it("live tag types (urn:tag:...) are recognised by the S5 tag filter", () => {
    expect(isUsefulTag(SF)).toBe(true);
    expect(isUsefulTag(SPACE)).toBe(true);
    expect(isUsefulTag(HARDCOVER)).toBe(false);
  });
});

describe("start: real retrieval, S5 shortlist, Gemini decision", () => {
  it("S8.5 generates one grounded question pool before the separate S6 decision", async () => {
    const env = liveEnv({ gemini: [askTop], env: { QUESTION_GENERATION_MODE: "llm_grounded", MAX_RECOMMENDATION_CANDIDATES: "30" } });
    let calls = 0;
    env.deps.questionGenerator = {
      async generate(input) {
        calls += 1;
        const questions = buildQuestionCandidates(input.ranked.map((item) => item.candidate), input.session.targetType).slice(0, 2);
        return {
          questions,
          validation: { questions, generated: 3, accepted: 2, rejected: 1, rejectionCounts: { unknown_tag: 1 } },
          fallbackReason: null,
          usage: { promptTokens: 200, outputTokens: 50, thoughtTokens: 0, totalTokens: 250, requests: 1, latencyMs: 5, estimatedCostUsd: 0.000185 },
        };
      },
    } satisfies QuestionGenerator;
    const view = await startDiscovery(env.deps, START);
    expect(calls).toBe(1);
    expect(view.currentQuestion?.questionId).toBeTruthy();
    expect(view.trace).toMatchObject({ geminiRequests: 2, geminiTokens: { input: 1200, output: 90, thinking: 0 } });
    expect(view.usage.geminiRequestCount).toBe(2);
  });

  it("S8.5 falls back to deterministic S5 questions when generation yields none", async () => {
    const env = liveEnv({ gemini: [askTop], env: { QUESTION_GENERATION_MODE: "llm_grounded" } });
    env.deps.questionGenerator = {
      async generate() {
        return {
          questions: [],
          validation: { questions: [], generated: 2, accepted: 0, rejected: 2, rejectionCounts: { unsupported_semantics: 2 } },
          fallbackReason: "no_valid_proposals",
          usage: { promptTokens: 100, outputTokens: 20, thoughtTokens: 0, totalTokens: 120, requests: 1, latencyMs: 4, estimatedCostUsd: 0.00008 },
        };
      },
    } satisfies QuestionGenerator;
    const view = await startDiscovery(env.deps, START);
    expect(view.status).toBe("asking");
    expect(view.currentQuestion?.questionId).toMatch(/^(tag|entity):/);
    expect(view.trace?.geminiRequests).toBe(2);
  });

  it("2/3/25/27. Gemini asks an approved S5 question over grounded Qloo books", async () => {
    const env = liveEnv({ gemini: [askAt(1)] });
    const v = await startDiscovery(env.deps, START);
    const body = env.gemini.bodies[0]!;
    // Only S5-approved, grounded question IDs are offered (top 3), and enrichment is never granted.
    const offered = enumOf(body, "ask_question", "questionId");
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.length).toBeLessThanOrEqual(3);
    expect(declared(body)).not.toContain("request_enrichment");
    expect(declared(body)).not.toContain("request_retrieval"); // nothing new to retrieve with at start
    expect(v.currentQuestion!.questionId).toBe(offered[1]);
    expect(v.agent).toMatchObject({ name: "gemini-agent", mode: "LIVE_GEMINI", fallbackReason: null, decision: { action: "ask" } });
    expect(v.recommendationUpdate).toMatchObject({ mechanism: "INITIAL_RETRIEVAL", qlooRequested: true });
    expect(v.recommendationUpdate!.internalCorrelationIds).toHaveLength(1);
    expect(v.trace).toMatchObject({ qlooRequests: 2, geminiRequests: 1, sessionStore: "memory" });
    expect(v.trace!.estimatedGeminiCostUsd).toBeCloseTo((1000 * 0.3 + 40 * 2.5) / 1e6, 10);
    expect(v.usage).toMatchObject({ qlooCallCount: 1, geminiRequestCount: 1 });
    expectGrounded(v);
  });

  it("26. missing Qloo metadata is not fabricated", async () => {
    const env = liveEnv({ gemini: [askTop] });
    const v = await startDiscovery(env.deps, START);
    const sparse = v.recommendations.find((r) => r.candidate.name === "Sparse Book")!.candidate;
    expect(sparse.description).toBeUndefined();
    expect(sparse.imageUrl).toBeUndefined();
    expect(sparse.tags).toEqual([]);
  });

  it("4. a valid Gemini finish returns at most five grounded books", async () => {
    const env = liveEnv({ gemini: [finish] });
    const v = await startDiscovery(env.deps, START);
    expect(v.status).toBe("finished");
    expect(v.recommendations.length).toBeLessThanOrEqual(5);
    expect(v.agent.mode).toBe("LIVE_GEMINI");
    expectGrounded(v);
  });

  it("7. an invented question ID is rejected and the grounded fallback is labelled as such", async () => {
    const bogus: Responder = () => fc("ask_question", { questionId: "tag:urn:tag:genre:media:made_up", reasonCode: "informative_question" });
    const env = liveEnv({ gemini: [bogus, bogus] });
    const v = await startDiscovery(env.deps, START);
    expect(env.gemini.bodies).toHaveLength(2); // one bounded repair
    expect(v.agent).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", fallbackReason: "invalid_output" });
    expect(enumOf(env.gemini.bodies[0]!, "ask_question", "questionId")).toContain(v.currentQuestion!.questionId);
  });

  it("18. Gemini timeout falls back to the top S5 question, truthfully labelled", async () => {
    const env = liveEnv({ gemini: [() => new GeminiTransportError("timeout"), () => new GeminiTransportError("timeout")] });
    const v = await startDiscovery(env.deps, START);
    expect(v.agent).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", fallbackReason: "provider_error" });
    expect(v.status).toBe("asking");
    expect(v.trace!.decisions[0]).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", validation: "not_called" });
    expectGrounded(v);
  });

  it("17. no valid question and nothing to retrieve: finishes without calling Gemini", async () => {
    const env = liveEnv({ qloo: { books: [BASE[0]!] } });
    const v = await startDiscovery(env.deps, START);
    expect(env.gemini.bodies).toHaveLength(0);
    expect(v).toMatchObject({ status: "finished", agent: { mode: "DETERMINISTIC_FALLBACK", fallbackReason: "hard_stop_no_actions" } });
  });

  it("19a. Qloo timeout at start, with no verified data, is a truthful error", async () => {
    const env = liveEnv({ qloo: { failStart: true } });
    await expect(startDiscovery(env.deps, START)).rejects.toMatchObject({ code: "QLOO_TIMEOUT" });
    expect(env.gemini.bodies).toHaveLength(0);
  });

  it("empty Qloo result at start is NO_RECOMMENDATIONS, never fixtures", async () => {
    const env = liveEnv({ qloo: { books: [] } });
    await expect(startDiscovery(env.deps, START)).rejects.toMatchObject({ code: "NO_RECOMMENDATIONS" });
  });
});

describe("answer loop: preferences, reretrieval, reranking", () => {
  async function startedOnTag(tagId: string, extra: Partial<Parameters<typeof liveEnv>[0]> = {}, after: Responder[] = []) {
    const pick: Responder = () => fc("ask_question", { questionId: `tag:${tagId}`, reasonCode: "informative_question" });
    const env = liveEnv({ ...extra, gemini: [pick, ...after] });
    const v0 = await startDiscovery(env.deps, START);
    expect(v0.currentQuestion!.questionId).toBe(`tag:${tagId}`);
    return { env, v0 };
  }

  it("5/9/14. like -> Gemini requests retrieval -> real Qloo reretrieval -> one follow-up decision", async () => {
    const { env, v0 } = await startedOnTag(SF.id, {}, [retrieveTags([SF.id]), askTop]);
    const v1 = await answer(env.deps, v0, "like");
    expect(v1.preferences.positiveTagIds).toEqual([SF.id]);
    // The retrieval was executed through the provider with the confirmed signal only.
    expect(env.qloo.insights).toHaveLength(2);
    expect(env.qloo.insights[1]).toMatchObject({ positiveTagIds: [SF.id], positiveEntityIds: [], maxAttempts: 2 });
    expect(env.qloo.insights[1]!.excludedTagIds).toBeUndefined();
    // Follow-up decision: retrieval withdrawn, so no loop.
    expect(declared(env.gemini.bodies[1]!)).toContain("request_retrieval");
    expect(declared(env.gemini.bodies[2]!)).not.toContain("request_retrieval");
    expect(env.gemini.bodies).toHaveLength(3);
    expect(v1.recommendationUpdate).toMatchObject({ mechanism: "QLOO_RERETRIEVAL", qlooRequested: true, preferenceIds: [SF.id] });
    expect(ids(v1)).toContain("4B74CED1-0000-0000-0000-000000000007"); // new book from reretrieval
    expect(v1.recommendationUpdate!.updatedTopIds).not.toEqual(v1.recommendationUpdate!.previousTopIds);
    expect(v1.usage).toMatchObject({ qlooCallCount: 2, agentToolCallCount: 1, geminiRequestCount: 3 });
    expect(v1.trace!.decisions.map((d) => d.action)).toEqual(["retrieve", "ask"]);
    expectGrounded(v1);
  });

  it("10/13. dislike -> no retrieval offered; local penalty reranks truthfully", async () => {
    const { env, v0 } = await startedOnTag(SF.id, {}, [askTop]);
    const v1 = await answer(env.deps, v0, "dislike");
    expect(declared(env.gemini.bodies[1]!)).not.toContain("request_retrieval");
    expect(env.qloo.insights).toHaveLength(1);
    expect(v1.preferences.rejectedTagIds).toEqual([SF.id]);
    expect(v1.recommendationUpdate).toMatchObject({ mechanism: "LOCAL_RERANK", qlooRequested: false, internalCorrelationIds: [] });
    expect(v1.recommendationUpdate!.updatedTopIds).not.toEqual(v1.recommendationUpdate!.previousTopIds);
  });

  it("11. unknown -> no inferred preference, no retrieval, UNCHANGED", async () => {
    const { env, v0 } = await startedOnTag(SF.id, {}, [askTop]);
    const v1 = await answer(env.deps, v0, "unknown");
    expect(v1.preferences).toEqual({ positiveTagIds: [], rejectedTagIds: [], positiveEntityIds: [], rejectedEntityIds: [] });
    expect(declared(env.gemini.bodies[1]!)).not.toContain("request_retrieval");
    expect(v1.recommendationUpdate).toMatchObject({ mechanism: "UNCHANGED", qlooRequested: false, preferenceIds: [] });
  });

  it("12. entity-comparison answers confirm entity preferences and can drive retrieval", async () => {
    const untagged = BASE.map((b) => ({ ...b, tags: [] }));
    const env = liveEnv({ qloo: { books: untagged }, gemini: [askTop, () => fc("request_retrieval", { reasonCode: "insufficient_candidates" }), finish] });
    const v0 = await startDiscovery(env.deps, START);
    expect(v0.currentQuestion!.questionId).toMatch(/^entity:/);
    const [a] = v0.currentQuestion!.targetIds;
    const v1 = await answer(env.deps, v0, "prefer_a");
    expect(v1.preferences.positiveEntityIds).toEqual([a]);
    expect(env.qloo.insights[1]).toMatchObject({ positiveEntityIds: [a] }); // confirmed signals used
    expect(v1.recommendationUpdate!.mechanism).toBe("QLOO_RERETRIEVAL");
  });

  it("8. retrieval with an unconfirmed ID is rejected before any Qloo call", async () => {
    const invented: Responder = () => fc("request_retrieval", { reasonCode: "insufficient_candidates", positiveTagIds: ["urn:tag:genre:media:invented"] });
    const { env, v0 } = await startedOnTag(SF.id, {}, [invented, invented]);
    const v1 = await answer(env.deps, v0, "like");
    expect(env.qloo.insights).toHaveLength(1);
    expect(v1.agent).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", fallbackReason: "invalid_output" });
    expect(v1.recommendationUpdate!.qlooRequested).toBe(false);
  });

  it("6. enrichment is not a supported capability: a model call is refused, and an enrich decision falls back safely", async () => {
    const enrich: Responder = () => fc("request_enrichment", { reasonCode: "insufficient_metadata", entityIds: ["4B74CED1-0000-0000-0000-000000000001"] });
    const env = liveEnv({ gemini: [enrich, enrich] });
    const v = await startDiscovery(env.deps, START);
    expect(v.agent).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", fallbackReason: "invalid_output" });

    // A (hypothetical) agent that returns `enrich` anyway is executed safely as a grounded fallback.
    const enricher: BoundedAgent = {
      name: "enricher",
      mode: "LIVE_GEMINI",
      decide: async (ctx) => ({
        decision: { action: "enrich", reasonCode: "insufficient_metadata", done: false },
        mode: "LIVE_GEMINI",
        model: "x",
        requestId: "r",
        toolCalls: { allowed: [], attempted: 1, accepted: null, names: [] },
        validation: "valid",
        usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0, requests: 1, latencyMs: 0, estimatedCostUsd: 0 },
        questionCandidates: ctx.questions.length,
      }),
    };
    const env2 = liveEnv({ agent: enricher });
    const v2 = await startDiscovery(env2.deps, START);
    expect(v2.agent).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", fallbackReason: "enrichment_unsupported", decision: { action: "ask" } });
    expect(env2.qloo.insights).toHaveLength(1);
  });

  it("19b. Qloo timeout on reretrieval: degraded, verified shortlist kept, budget charged", async () => {
    const { env, v0 } = await startedOnTag(SF.id, { qloo: { failInsights: "after_first" } }, [retrieveTags([SF.id])]);
    const v1 = await answer(env.deps, v0, "like");
    expect(v1.degraded).toEqual({ reason: "qloo_qloo_timeout" });
    expect(ids(v1).sort()).toEqual(ids(v0).sort());
    expect(v1.usage.qlooCallCount).toBe(1 + 2); // failure charged at the attempt cap
    expect(v1.agent).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", fallbackReason: "retrieval_failed" });
    expect(v1.recommendationUpdate!.mechanism).not.toBe("QLOO_RERETRIEVAL");
    expectGrounded(v1);
  });

  it("empty reretrieval keeps the verified shortlist and is reported as degraded", async () => {
    const { env, v0 } = await startedOnTag(FANTASY.id, { qloo: { empty: true } }, [retrieveTags([FANTASY.id]), askTop]);
    const v1 = await answer(env.deps, v0, "like");
    expect(v1.degraded).toEqual({ reason: "qloo_empty_result" });
    expect(ids(v1).sort()).toEqual(ids(v0).sort());
  });
});

describe("S9.11 adaptive candidate universe", () => {
  const adaptive = { ADAPTIVE_POOL_ENABLED: "true" };

  it("executes TAG_FOCUS deterministically, merges new IDs, refreshes questions and reports the real transition", async () => {
    const env = liveEnv({ env: adaptive, gemini: [() => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" }), askTop] });
    const v0 = await startDiscovery(env.deps, START);
    const old = new Set(ids(v0));
    const v1 = await answer(env.deps, v0, "like");
    expect(env.qloo.insights).toHaveLength(2);
    expect(env.qloo.insights[1]).toMatchObject({ positiveTagIds: [SF.id], positiveEntityIds: [], maxAttempts: 1 });
    expect(v1.recommendationUpdate?.poolTransition).toMatchObject({
      decision: "FETCH_AND_MERGE", queryFamily: "TAG_FOCUS", retrievalOutcome: "merged", qlooCallsMade: 1, sessionRevision: 1,
    });
    expect(v1.recommendationUpdate!.poolTransition!.newReservoirIds).toContain("4B74CED1-0000-0000-0000-000000000007");
    expect(v1.recommendationUpdate!.poolTransition!.newlyDisplayedIds).toContain("4B74CED1-0000-0000-0000-000000000007");
    expect(ids(v1).some((id) => old.has(id))).toBe(true);
    expect(v1.preferences.positiveTagIds).toEqual([SF.id]);
    expect(v1.currentQuestion).not.toBeNull();
    expectGrounded(v1);
    await expect(answer(env.deps, v0, "like")).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    expect(env.qloo.insights).toHaveLength(2);
  });

  it("chooses KEEP with zero new Qloo calls when a confirmed tag already has strong local coverage", async () => {
    const healthy = BASE.map((item, index) => ({
      ...item,
      tags: index < 5 ? [...(item.tags ?? []).filter((tag) => tag.id !== SF.id), SF] : (item.tags ?? []).filter((tag) => tag.id !== SF.id),
    }));
    const env = liveEnv({ qloo: { books: healthy }, env: adaptive, gemini: [() => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" }), askTop] });
    const v0 = await startDiscovery(env.deps, START);
    const v1 = await answer(env.deps, v0, "like");
    expect(env.qloo.insights).toHaveLength(1);
    expect(v1.recommendationUpdate?.poolTransition).toMatchObject({ decision: "KEEP", retrievalOutcome: "not_requested", qlooCallsMade: 0 });
    expect(v1.recommendationUpdate?.poolTransition?.newReservoirIds).toEqual([]);
  });

  it("executes PROFILE_REFRESH only from an explicitly preferred verified entity", async () => {
    const untagged = BASE.map((item) => ({ ...item, tags: [] }));
    const env = liveEnv({ qloo: { books: untagged }, env: adaptive, gemini: [askTop, askTop] });
    const v0 = await startDiscovery(env.deps, START);
    expect(v0.currentQuestion?.questionId).toMatch(/^entity:/);
    const affirmed = v0.currentQuestion!.targetIds[0]!;
    const v1 = await answer(env.deps, v0, "prefer_a");
    expect(env.qloo.insights[1]).toMatchObject({ positiveEntityIds: [affirmed], positiveTagIds: [], maxAttempts: 1 });
    expect(v1.recommendationUpdate?.poolTransition).toMatchObject({ decision: "FETCH_AND_MERGE", queryFamily: "PROFILE_REFRESH" });
    expect(v1.preferences.positiveEntityIds).toEqual([affirmed]);
  });

  it("keeps the accepted preference and verified pool when adaptive Qloo fails", async () => {
    const env = liveEnv({ qloo: { failInsights: "after_first" }, env: adaptive, gemini: [() => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" }), askTop] });
    const v0 = await startDiscovery(env.deps, START);
    const before = ids(v0);
    const v1 = await answer(env.deps, v0, "like");
    expect(v1.preferences.positiveTagIds).toEqual([SF.id]);
    expect(new Set(ids(v1))).toEqual(new Set(before));
    expect(v1.recommendationUpdate?.poolTransition).toMatchObject({ decision: "DEGRADED_KEEP", retrievalOutcome: "failed", qlooCallsMade: 1 });
    expect(v1.degraded?.reason).toBe("qloo_qloo_timeout");
  });

  it("spends nothing when the cumulative Qloo budget is exhausted", async () => {
    const env = liveEnv({ env: { ...adaptive, MAX_QLOO_CALLS_PER_SESSION: "1" }, gemini: [() => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" }), askTop] });
    const v0 = await startDiscovery(env.deps, START);
    const v1 = await answer(env.deps, v0, "like");
    expect(env.qloo.insights).toHaveLength(1);
    expect(v1.recommendationUpdate?.poolTransition).toMatchObject({ decision: "DEGRADED_KEEP", retrievalOutcome: "budget_exhausted", qlooCallsMade: 0 });
    expect(v1.usage.qlooCallCount).toBe(1);
  });

  it("concurrent duplicate answers produce one adaptive request and one authoritative commit", async () => {
    const env = liveEnv({ env: adaptive, gemini: [() => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" }), askTop] });
    const v0 = await startDiscovery(env.deps, START);
    env.store.arm(2);
    const results = await Promise.allSettled([answer(env.deps, v0, "like"), answer(env.deps, v0, "like")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.map(codeOf)).toContain("SESSION_REVISION_CONFLICT");
    expect(env.qloo.insights).toHaveLength(2);
  });
});

describe("budgets", () => {
  it("15. Qloo budget exhausted: retrieval is never offered and Qloo is not called", async () => {
    const pick: Responder = () => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" });
    const env = liveEnv({ env: { MAX_QLOO_CALLS_PER_SESSION: "1" }, gemini: [pick, askTop] });
    const v0 = await startDiscovery(env.deps, START);
    const v1 = await answer(env.deps, v0, "like");
    expect(declared(env.gemini.bodies[1]!)).not.toContain("request_retrieval");
    expect(env.qloo.insights).toHaveLength(1);
    expect(v1.usage.qlooCallCount).toBe(1);
  });

  it("16. agent tool budget exhausted after one retrieval: no further Gemini call that turn", async () => {
    const pick: Responder = () => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" });
    const env = liveEnv({ env: { MAX_AGENT_TOOL_CALLS_PER_TURN: "1" }, gemini: [pick, retrieveTags([SF.id])] });
    const v0 = await startDiscovery(env.deps, START);
    const v1 = await answer(env.deps, v0, "like");
    expect(env.gemini.bodies).toHaveLength(2);
    expect(v1.trace!.decisions.map((d) => [d.action, d.fallbackReason])).toEqual([["retrieve", null], ["ask", "hard_stop_tool_budget"]]);
    expect(v1.agent.mode).toBe("DETERMINISTIC_FALLBACK");
  });

  it("23. never more than three questions; the last turn finishes without Gemini", async () => {
    const env = liveEnv({ gemini: [askTop, askTop, askTop] });
    let v = await startDiscovery(env.deps, START);
    while (v.status === "asking") v = await answer(env.deps, v, "unknown");
    expect(v.questionCount).toBe(3);
    expect(v.finishReason).toBe("question_budget_exhausted");
    expect(env.gemini.bodies).toHaveLength(3); // start + 2 answers; the 3rd answer hits the hard stop
    expect(v.agent).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", fallbackReason: "hard_stop_question_budget" });
  });
});

describe("S4 security with live work", () => {
  it("S8.5 rejects a stale token before another question-generation call", async () => {
    const env = liveEnv({ gemini: [askTop, askTop], env: { QUESTION_GENERATION_MODE: "llm_grounded" } });
    let generations = 0;
    env.deps.questionGenerator = {
      async generate(input) {
        generations += 1;
        const questions = buildQuestionCandidates(input.ranked.map((item) => item.candidate), input.session.targetType);
        return {
          questions,
          validation: { questions, generated: questions.length, accepted: questions.length, rejected: 0, rejectionCounts: {} },
          fallbackReason: null,
          usage: { promptTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2, requests: 1, latencyMs: 1, estimatedCostUsd: 0.0000028 },
        };
      },
    } satisfies QuestionGenerator;
    const v0 = await startDiscovery(env.deps, START);
    await answer(env.deps, v0, "unknown");
    expect(generations).toBe(2);
    await expect(answer(env.deps, v0, "unknown")).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    expect(generations).toBe(2);
  });

  it("20. a stale token is rejected before any Qloo or Gemini call", async () => {
    const env = liveEnv({ gemini: [askTop, askTop] });
    const v0 = await startDiscovery(env.deps, START);
    await answer(env.deps, v0, "unknown");
    const [q, g] = [env.qloo.insights.length, env.gemini.bodies.length];
    await expect(answer(env.deps, v0, "like")).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    expect([env.qloo.insights.length, env.gemini.bodies.length]).toEqual([q, g]);
  });

  it("21. two simultaneous answers: one succeeds and only it performs Qloo/Gemini work", async () => {
    const pick: Responder = () => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" });
    const env = liveEnv({ gemini: [pick, retrieveTags([SF.id]), askTop] });
    const v0 = await startDiscovery(env.deps, START);
    env.store.arm(2);
    const results = await Promise.allSettled([answer(env.deps, v0, "like"), answer(env.deps, v0, "dislike")]);
    expect(results.map(codeOf).sort()).toEqual(["SESSION_REVISION_CONFLICT", "ok"]);
    expect(env.qloo.insights.length).toBeLessThanOrEqual(2);
    expect(env.gemini.bodies.length).toBeLessThanOrEqual(3); // start + at most one winning turn (2 decisions)
  });

  it("22. simultaneous answer and finish: exactly one mutation", async () => {
    const env = liveEnv({ gemini: [askTop, askTop] });
    const v0 = await startDiscovery(env.deps, START);
    env.store.arm(2);
    const results = await Promise.allSettled([answer(env.deps, v0, "unknown"), finishDiscovery(env.deps, v0.sessionToken)]);
    expect(results.map(codeOf).filter((c) => c === "ok")).toHaveLength(1);
  });

  it("24. an expired session is rejected before paid work", async () => {
    const env = liveEnv({ gemini: [askTop] });
    const v0 = await startDiscovery(env.deps, START);
    env.clock.t += 31 * 60 * 1000;
    await expect(answer(env.deps, v0, "like")).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(env.gemini.bodies).toHaveLength(1);
  });

  it("store outage fails closed and does not reach Gemini", async () => {
    const env = liveEnv({ gemini: [askTop] });
    const v0 = await startDiscovery(env.deps, START);
    env.deps.store = { ...env.store, read: async () => { throw new AppError("SESSION_STORE_UNAVAILABLE", 503, "down"); } };
    await expect(answer(env.deps, v0, "like")).rejects.toMatchObject({ code: "SESSION_STORE_UNAVAILABLE" });
    expect(env.gemini.bodies).toHaveLength(1);
  });

  it("25. finish returns only grounded Qloo books, and preferences/budgets persist", async () => {
    const pick: Responder = () => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" });
    const env = liveEnv({ gemini: [pick, retrieveTags([SF.id]), askTop] });
    const v0 = await startDiscovery(env.deps, START);
    const v1 = await answer(env.deps, v0, "like");
    const done = await finishDiscovery(env.deps, v1.sessionToken);
    expect(done.status).toBe("finished");
    expect(done.recommendations.length).toBeLessThanOrEqual(5);
    expect(done.preferences.positiveTagIds).toEqual([SF.id]);
    expect(done.usage).toMatchObject({ qlooCallCount: 2, geminiRequestCount: 3 });
    expectGrounded(done);
  });

  it("S9.2 Discovery Path is built from the final Qloo books with no extra Qloo or Gemini call", async () => {
    const pick: Responder = () => fc("ask_question", { questionId: `tag:${SF.id}`, reasonCode: "informative_question" });
    const env = liveEnv({ gemini: [pick, retrieveTags([SF.id]), askTop] });
    const v1 = await answer(env.deps, await startDiscovery(env.deps, START), "like");
    const before = { insights: env.qloo.insights.length, searches: env.qloo.searches(), gemini: env.gemini.bodies.length };
    const done = await finishDiscovery(env.deps, v1.sessionToken);
    const again = await finishDiscovery(env.deps, done.sessionToken);
    expect({ insights: env.qloo.insights.length, searches: env.qloo.searches(), gemini: env.gemini.bodies.length }).toEqual(before);
    expect(done.usage).toMatchObject({ qlooCallCount: v1.usage.qlooCallCount, geminiRequestCount: v1.usage.geminiRequestCount });

    const path = done.discoveryPath!;
    expect(again.discoveryPath).toEqual(path);
    expect(path.featured[0]).toMatchObject({ role: "START_HERE", recommendationEntityId: done.recommendations[0]!.candidate.entityId });
    expect(discoveryPathProblems(path, done)).toEqual([]);
    for (const f of path.featured) {
      expect(f.explanation.evidence).toMatchObject({ provenance: "qloo", seedEntityIds: [MOVIE_ID] });
      expect(f.explanation.text).toMatch(/Qloo (also )?returned this/);
    }
    const top = done.recommendations[0]!;
    if (top.matchedPositiveTagIds.includes(SF.id)) {
      expect(path.featured[0]!.explanation).toMatchObject({ kind: "preference_match", evidence: { preferenceIds: [SF.id] } });
    }
  });
});
