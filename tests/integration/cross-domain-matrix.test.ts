import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DOMAINS,
  DOMAIN_PAIRS,
  domainLabel,
  pairKey,
  qlooTypeOf,
  tagQuestionText,
  type CulturalDomain,
  type DiscoveryView,
  type StartRequest,
} from "@/lib/contracts";
import { createBoundedAgent } from "@/lib/agent/factory";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import { normalizeTargetCandidates } from "@/lib/discovery/normalize";
import { discoveryPathProblems } from "@/lib/discovery/path";
import { answerDiscovery, finishDiscovery, startDiscovery, type DiscoveryDeps } from "@/lib/discovery/service";
import { buildInsightsUrl, buildSearchUrl } from "@/lib/qloo/live-provider";
import type { QlooProvider, RecommendationRequest } from "@/lib/qloo/provider";
import type { RawInsightEntity, RawSearchEntity } from "@/lib/qloo/raw-types";
import { createMemorySessionStore } from "@/lib/session/memory-store";
import { testConfig } from "../helpers";

/**
 * S9.3 offline cross-domain compatibility matrix.
 *
 * Every directed pair among the six registered domains runs through the ONE
 * live orchestrator (real sessions, S5 optimizer, bounded deterministic agent)
 * against a deterministic fixture provider shaped like Qloo responses.
 *
 * THIS PROVES ENGINE BEHAVIOUR ONLY. It is not evidence that Qloo returns
 * useful results for any pair; live coverage is recorded separately in
 * docs/cross-domain-engine.md.
 */

const SIX = Object.keys(DOMAINS) as CulturalDomain[];
const PAIRS = SIX.flatMap((source) => SIX.filter((t) => t !== source).map((target) => [source, target] as const));
const DISABLED = DOMAIN_PAIRS.filter((p) => !p.enabled).map((p) => pairKey(p.source, p.target));

const ANCHOR_ID = (d: CulturalDomain) => `F1X0${d.length}AA-0000-4000-8000-${String(SIX.indexOf(d)).padStart(12, "0")}`;
const tag = (domain: CulturalDomain, slug: string, kind: "genre:media" | "theme:qloo") => ({
  id: `urn:tag:${kind}:${domain}_${slug}`,
  name: `${slug[0]!.toUpperCase()}${slug.slice(1)} ${domain.replace("_", " ")}`,
  type: `urn:tag:${kind}`,
});

type FixtureOpts = { count?: number; tags?: boolean; meta?: boolean; empty?: boolean; wrongOnly?: boolean; duplicateAnchor?: boolean };

/** Qloo-shaped fixtures for any (source, target). Records every call for assertions. */
function fixtureQloo(opts: FixtureOpts = {}) {
  const calls = { search: [] as Array<{ q: string; type?: string }>, insights: [] as RecommendationRequest[], entity: 0 };
  const result = <T>(payload: T) => ({ provenance: "qloo" as const, requestId: randomUUID(), requestCount: 1, payload });
  const anchors = (type?: CulturalDomain): RawSearchEntity[] =>
    SIX.filter((d) => !type || d === type).flatMap((d) => [
      { entity_id: ANCHOR_ID(d), name: `Anchor ${d}`, types: [qlooTypeOf(d)] },
      ...(opts.duplicateAnchor ? [{ entity_id: `${ANCHOR_ID(d)}-dup`, name: `Anchor ${d}`, types: [qlooTypeOf(d)] }] : []),
    ]);
  const targets = (target: CulturalDomain): RawInsightEntity[] => {
    if (opts.empty) return [];
    const a = tag(target, "alpha", "genre:media");
    const b = tag(target, "beta", "theme:qloo");
    const c = tag(target, "gamma", "genre:media");
    const sets = [[a, b], [a], [b, c], [c], [a, c], [b]];
    const wrong = SIX.find((d) => d !== target)!;
    const decoy: RawInsightEntity = { entity_id: "WRONG-TYPE-0000", name: "Wrong domain", subtype: qlooTypeOf(wrong), query: { affinity: 0.99 }, tags: [] };
    if (opts.wrongOnly) return [decoy];
    const real = Array.from({ length: opts.count ?? 6 }, (_, i): RawInsightEntity => ({
      entity_id: `${target.toUpperCase()}-${String(i + 1).padStart(4, "0")}`,
      name: `${domainLabel(target)} ${i + 1}`,
      subtype: qlooTypeOf(target),
      query: { affinity: 0.9 - i * 0.02 },
      ...(opts.meta === false ? {} : { properties: { description: `Fixture ${target} ${i + 1}.`, image: { url: `https://img.example/${target}/${i}.jpg` } } }),
      tags: opts.tags === false ? [] : sets[i % sets.length]!.map((t) => ({ id: t.id, name: t.name, type: t.type })),
    }));
    return [decoy, ...real];
  };
  const provider: QlooProvider = {
    mode: "live",
    async searchEntities(q, type) {
      calls.search.push({ q, type });
      return result({ results: anchors(type).filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase())) });
    },
    async getEntity(id) {
      calls.entity += 1;
      return result(anchors().find((e) => e.entity_id === id) ?? null);
    },
    async getRecommendations(req) {
      calls.insights.push(req);
      return result({ success: true, results: { entities: targets(req.targetType) } });
    },
  };
  return { provider, calls, total: () => calls.search.length + calls.insights.length + calls.entity };
}

function env(fixture: FixtureOpts = {}, extraEnv: Record<string, string> = {}) {
  const qloo = fixtureQloo(fixture);
  const config = testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "test-key", LLM_PROVIDER: "none", VERIFICATION_PAIRS: DISABLED.join(","), ...extraEnv });
  const deps: DiscoveryDeps = {
    config,
    provider: qloo.provider,
    agent: createDeterministicMockAgent(),
    store: createMemorySessionStore(),
    boundedAgent: createBoundedAgent(config),
  };
  return { deps, qloo };
}

const startBody = (source: CulturalDomain, target: CulturalDomain, selected = true): StartRequest => ({
  entityQuery: `Anchor ${source}`,
  sourceType: source,
  targetType: target,
  maxQuestions: 3,
  ...(selected ? { selectedEntityId: ANCHOR_ID(source) } : {}),
});

const answer = (deps: DiscoveryDeps, v: DiscoveryView, response: "like" | "dislike" | "unknown" | "prefer_a" | "neither") =>
  answerDiscovery(deps, { sessionToken: v.sessionToken, questionId: v.currentQuestion!.questionId, response });

function expectTargetOnly(v: DiscoveryView, target: CulturalDomain) {
  expect(v.recommendations.length).toBeGreaterThan(0);
  for (const r of v.recommendations) {
    expect(r.candidate.entityType).toBe(target);
    expect(r.candidate.evidence.source).toBe("qloo");
    expect(r.candidate.entityId.startsWith(`${target.toUpperCase()}-`)).toBe(true); // fixture IDs preserved, decoy rejected
  }
}

const STORY_WORDS = /\b(stor(y|ies)|storytelling|read|books?|novels?)\b/i;

describe("S9.3 offline matrix — all 30 directed pairs (engine behaviour, NOT live Qloo coverage)", () => {
  it("covers exactly the 30 registered cross-domain pairs", () => {
    expect(PAIRS).toHaveLength(30);
    expect(PAIRS.map(([s, t]) => pairKey(s, t)).sort()).toEqual(DOMAIN_PAIRS.map((p) => pairKey(p.source, p.target)).sort());
  });

  it.each(PAIRS)("%s -> %s: search → start → answer → finish → Discovery Path", async (source, target) => {
    const { deps, qloo } = env();

    // Source verification uses the registry's Search type; Insights uses the target's filter.type.
    const v0 = await startDiscovery(deps, startBody(source, target));
    expect(qloo.calls.search[0]).toEqual({ q: `Anchor ${source}`, type: source });
    expect(buildSearchUrl("https://q.example", "x", source).searchParams.get("type")).toBe(DOMAINS[source].qlooType);
    expect(qloo.calls.insights[0]).toMatchObject({ seedEntityIds: [ANCHOR_ID(source)], targetType: target });
    expect(buildInsightsUrl("https://q.example", qloo.calls.insights[0]!).searchParams.get("filter.type")).toBe(DOMAINS[target].qlooType);
    expect(v0.seed).toMatchObject({ entityId: ANCHOR_ID(source), entityType: source });
    expect(v0.revision).toBe(0);
    expectTargetOnly(v0, target);

    // Grounded, domain-aware question built from a verified target tag.
    expect(v0.status).toBe("asking");
    const q0 = v0.currentQuestion!;
    expect(q0.targetType).toBe("tag");
    const label = v0.recommendations.flatMap((r) => r.candidate.tags).find((t) => t.id === q0.targetIds[0])!.name;
    expect(q0.text).toBe(tagQuestionText(target, label));
    if (!DOMAINS[target].narrative) expect(q0.text.replace(label, "")).not.toMatch(STORY_WORDS);

    // Explicit like → positive preference; revision advances.
    const v1 = await answer(deps, v0, "like");
    expect(v1.revision).toBe(1);
    expect(v1.preferences.positiveTagIds).toEqual(q0.targetIds);
    expectTargetOnly(v1, target);

    // Unknown → no preference change.
    const v2 = v1.status === "asking" ? await answer(deps, v1, "unknown") : v1;
    expect(v2.preferences.positiveTagIds).toEqual(v1.preferences.positiveTagIds);
    expect(v2.preferences.rejectedTagIds).toEqual([]);

    // Finish → Discovery Path over the same verified list.
    const done = v2.status === "finished" ? v2 : await finishDiscovery(deps, v2.sessionToken);
    expect(done.status).toBe("finished");
    expect(done.recommendations.length).toBeLessThanOrEqual(5);
    expectTargetOnly(done, target);
    const path = done.discoveryPath!;
    expect(path).toMatchObject({ sourceType: source, targetType: target });
    expect(path.featured[0]).toMatchObject({ role: "START_HERE", recommendationEntityId: done.recommendations[0]!.candidate.entityId });
    expect(discoveryPathProblems(path, done)).toEqual([]);
    // Quoted verified names (the seed, cited tags) are data; the template copy must name the target domain only.
    const pathText = path.featured.map((f) => f.explanation.text).join(" ").replace(/“[^”]*”/g, "“…”");
    expect(pathText).toContain(`among its ${domainLabel(target, true)}`);
    if (target !== "book") expect(pathText).not.toMatch(/\bbooks?\b/);
    expect(JSON.stringify(done)).not.toContain("WRONG-TYPE");

    // Negative preferences never became Qloo exclusions; the anchor stayed the only seed.
    for (const req of qloo.calls.insights) {
      expect(req.excludedEntityIds ?? []).toEqual([]);
      expect(req.excludedTagIds ?? []).toEqual([]);
      expect(req.seedEntityIds).toEqual([ANCHOR_ID(source)]);
    }
    expect(done.usage.qlooCallCount).toBeLessThanOrEqual(deps.config.limits.maxQlooCallsPerSession);
  });
});

describe("S9.3 matrix — failure handling and safety for every target domain", () => {
  it.each(SIX)("sparse metadata (one candidate) → truthful early finish without a question (target %s)", async (target) => {
    const source = SIX.find((d) => d !== target)!;
    const { deps } = env({ count: 1, tags: false, meta: false });
    const v = await startDiscovery(deps, startBody(source, target));
    expect(v.status).toBe("finished");
    expect(v.questionCount).toBe(0);
    expect(v.currentQuestion).toBeNull();
    expect(v.finishReason).toBe("insufficient_question_evidence");
    const only = v.recommendations[0]!.candidate;
    expect(only.description).toBeUndefined();
    expect(only.imageUrl).toBeUndefined();
    expect(only.tags).toEqual([]);
    expect(v.discoveryPath!.featured.map((f) => f.role)).toEqual(["START_HERE"]);
    expect(v.discoveryPath!.featured[0]!.explanation.kind).toBe("source_grounded");
  });

  it.each(SIX)("untagged candidates fall back to grounded comparisons, never filler (target %s)", async (target) => {
    const source = SIX.find((d) => d !== target)!;
    const { deps } = env({ tags: false });
    const v = await startDiscovery(deps, startBody(source, target));
    expect(v.currentQuestion?.targetType).toBe("entity");
    expect(v.currentQuestion!.text).toMatch(new RegExp(`^Which ${domainLabel(target)} sounds more appealing: “`));
    const ids = v.recommendations.map((r) => r.candidate.entityId);
    expect(v.currentQuestion!.targetIds.every((id) => ids.includes(id))).toBe(true);
  });

  it.each(SIX)("empty Insights and wrong-subtype-only Insights are NO_RECOMMENDATIONS, never fabricated (target %s)", async (target) => {
    const source = SIX.find((d) => d !== target)!;
    for (const fixture of [{ empty: true }, { wrongOnly: true }]) {
      const { deps } = env(fixture);
      await expect(startDiscovery(deps, startBody(source, target))).rejects.toMatchObject({ code: "NO_RECOMMENDATIONS", status: 422 });
    }
  });

  it("every disabled pair is rejected before any provider call without verification config", async () => {
    for (const key of DISABLED) {
      const [source, target] = key.split("->") as [CulturalDomain, CulturalDomain];
      const { deps, qloo } = env({}, { VERIFICATION_PAIRS: "" });
      await expect(startDiscovery(deps, startBody(source, target))).rejects.toMatchObject({ code: "UNSUPPORTED_DOMAIN" });
      expect(qloo.total()).toBe(0);
    }
  });

  it("ambiguous anchors require explicit selection; arbitrary or cross-domain IDs are refused", async () => {
    const { deps } = env({ duplicateAnchor: true });
    await expect(startDiscovery(deps, startBody("music_artist", "book", false))).rejects.toMatchObject({ code: "ENTITY_NOT_RESOLVED" });
    await expect(startDiscovery(deps, { ...startBody("music_artist", "book"), selectedEntityId: "ARBITRARY-ID" })).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    await expect(startDiscovery(deps, { ...startBody("music_artist", "book"), selectedEntityId: ANCHOR_ID("podcast") })).rejects.toMatchObject({ code: "ENTITY_TYPE_MISMATCH" });
  });

  it("normalization classifies by exact registry URN across subtype/type/types and never coerces", () => {
    const res = (entities: RawInsightEntity[]) => ({ provenance: "qloo" as const, requestId: "r", requestCount: 1, payload: { success: true, results: { entities } } });
    const base = { name: "X", query: { affinity: 0.5 }, tags: [] };
    const { candidates, rejected } = normalizeTargetCandidates(
      res([
        { ...base, entity_id: "A", subtype: "urn:entity:artist" },
        { ...base, entity_id: "B", subtype: "urn:entity", type: "urn:entity:artist" },
        { ...base, entity_id: "C", subtype: "urn:entity", types: ["urn:entity:place", "urn:entity:artist"] },
        { ...base, entity_id: "D", subtype: "urn:entity:music_artist" },
        { ...base, entity_id: "E", subtype: "urn:entity:podcast" },
      ]),
      ["seed"],
      10,
      { targetType: "music_artist", provenance: "qloo" },
    );
    expect(candidates.map((c) => [c.entityId, c.entityType, c.rank])).toEqual([["A", "music_artist", 1], ["B", "music_artist", 2], ["C", "music_artist", 3]]);
    expect(rejected).toBe(2);
    expect(candidates.every((c) => c.description === undefined && c.imageUrl === undefined)).toBe(true);
  });

  it("negative answers stay local; a stale token cannot trigger provider work", async () => {
    const { deps, qloo } = env();
    const v0 = await startDiscovery(deps, startBody("podcast", "video_game"));
    const v1 = await answer(deps, v0, "dislike");
    expect(v1.preferences.rejectedTagIds).toEqual(v0.currentQuestion!.targetIds);
    expect(v1.recommendationUpdate?.qlooRequested).toBe(false);
    const before = qloo.total();
    await expect(answer(deps, v0, "like")).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    expect(qloo.total()).toBe(before);
  });
});
