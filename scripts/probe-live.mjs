#!/usr/bin/env node
/**
 * S2 live API verification probe (npm run probe:live).
 *
 * Makes REAL authenticated calls to the Qloo hackathon API and Gemini, bounded to
 * at most 8 Qloo and 2 Gemini requests, with no retries. Credentials are read via
 * Next's env loader (.env.local / .env, process env wins) and never printed.
 * Never imports the mock provider or fixtures.
 *
 * Output: a sanitized summary on stdout and in .probe/latest-summary.json
 * (git-ignored). Raw provider payloads are never written to disk.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { AgentDecisionSchema } from "../src/lib/contracts/domain.ts";
import {
  BudgetExceededError,
  agentDecisionResponseSchema,
  buildUrl,
  classifyExclusion,
  classifyHttpFailure,
  classifyPositiveSignal,
  compareIds,
  createBudget,
  describeShape,
  entityIdOf,
  entityTypesOf,
  findEntityList,
  geminiFunctionCalls,
  geminiText,
  isFatalFailure,
  measureEntities,
  missingVariables,
  pickSignalTag,
  redact,
  summarizeUsage,
  tagsOf,
} from "./lib/probe-helpers.ts";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

const QLOO_LIMIT = 8;
const GEMINI_LIMIT = 2;
const DEFAULT_QLOO_BASE = "https://hackathon.api.qloo.com";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EXPECTED_MODEL = "gemini-3.5-flash-lite";
const MOVIE = "urn:entity:movie";
const BOOK = "urn:entity:book";
const TAKE = 10;
const PRICING = {
  [EXPECTED_MODEL]: {
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    source: "ai.google.dev/gemini-api/docs/pricing, standard paid tier, thinking billed as output (checked 2026-10-29)",
  },
};

loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const env = process.env;
const secrets = [env.QLOO_API_KEY, env.GOOGLE_API_KEY];
const say = (msg = "") => console.log(redact(String(msg), secrets));
const sanitize = (v) => JSON.parse(redact(JSON.stringify(v), secrets));

class FatalStop extends Error {}

const summary = {
  startedAt: new Date().toISOString(),
  qloo: { status: "not_run", calls: [], findings: {} },
  gemini: { status: "not_run", calls: [], findings: {} },
};
const qlooBudget = createBudget("Qloo", QLOO_LIMIT);
const geminiBudget = createBudget("Gemini", GEMINI_LIMIT);

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { nonJsonBody: text.slice(0, 200) };
  }
}

function errorMessageOf(body) {
  const m = body?.error?.message ?? body?.message ?? body?.error ?? body?.nonJsonBody ?? "";
  return redact(typeof m === "string" ? m : JSON.stringify(m), secrets).slice(0, 300);
}

// ---------------------------------------------------------------------------- Qloo

async function qloo(label, path, params) {
  qlooBudget.take();
  const url = buildUrl(qlooBase, path, params);
  const started = performance.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { "X-Api-Key": env.QLOO_API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(Number(env.QLOO_TIMEOUT_MS) || 8000),
    });
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    summary.qloo.calls.push({ label, path, params, status: null, ms, error: error?.name ?? "network" });
    throw new FatalStop(`${label}: network/timeout failure (${error?.name ?? "error"}) — no retry`);
  }
  const ms = Math.round(performance.now() - started);
  const body = await readJson(res);
  const call = { label, path, params, status: res.status, ms };
  if (!res.ok) {
    call.failure = classifyHttpFailure(res.status);
    call.error = errorMessageOf(body);
  }
  summary.qloo.calls.push(call);
  say(`  [qloo ${qlooBudget.used}/${QLOO_LIMIT}] ${label}: GET ${path} -> HTTP ${res.status} in ${ms} ms`);
  if (!res.ok) {
    say(`    error: ${call.error}`);
    if (isFatalFailure(call.failure)) throw new FatalStop(`${label}: ${call.failure} failure (HTTP ${res.status}); stopping`);
  }
  return { status: res.status, ok: res.ok, body, ms };
}

const idsOf = (entities) => entities.map(entityIdOf).filter(Boolean);
const brief = (e) => `${entityIdOf(e) ?? "?"} | ${typeof e.name === "string" ? e.name : "?"}`;

async function searchMovie() {
  // R3: start with `type`; only try `types` if `type` is rejected or does not filter.
  const attempts = [];
  for (const param of ["type", "types"]) {
    const r = await qloo(`search (${param}=${MOVIE})`, "/search", { query: "Interstellar", [param]: MOVIE });
    const list = r.ok ? findEntityList(r.body) : null;
    const entities = list?.entities ?? [];
    const typed = entities.filter((e) => entityTypesOf(e).includes(MOVIE));
    const filtered = entities.length > 0 && typed.length === entities.length;
    attempts.push({ param, status: r.status, listPath: list?.path ?? null, results: entities.length, movieTyped: typed.length, filtered });
    say(`    results at "${list?.path ?? "(none)"}": ${entities.length}, typed ${MOVIE}: ${typed.length}`);
    if (r.ok && entities.length) {
      summary.qloo.findings.searchShape = describeShape({ results: entities.slice(0, 5) });
    }
    const pick =
      typed.find((e) => typeof e.name === "string" && e.name.trim().toLowerCase() === "interstellar") ?? null;
    if (pick && filtered) {
      summary.qloo.findings.search = { attempts, typeParam: param, selected: { id: entityIdOf(pick), name: pick.name } };
      say(`    selected: ${brief(pick)} (verified ${MOVIE})`);
      return entityIdOf(pick);
    }
    if (pick && param === "types") {
      summary.qloo.findings.search = { attempts, typeParam: "unverified", selected: { id: entityIdOf(pick), name: pick.name } };
      return entityIdOf(pick);
    }
    if (pick && !filtered) {
      // `type` accepted but did not filter: verify `types` before trusting either.
      summary.qloo.findings.searchFallbackPick = { id: entityIdOf(pick), name: pick.name };
    }
  }
  summary.qloo.findings.search = { attempts, typeParam: null, selected: summary.qloo.findings.searchFallbackPick ?? null };
  return summary.qloo.findings.searchFallbackPick?.id ?? null;
}

async function insights(label, movieId, extra = {}) {
  const r = await qloo(label, "/v2/insights", {
    "filter.type": BOOK,
    "signal.interests.entities": movieId,
    take: TAKE,
    ...extra,
  });
  const list = r.ok ? findEntityList(r.body) : null;
  return { ...r, listPath: list?.path ?? null, entities: list?.entities ?? [] };
}

async function runQloo() {
  const missing = missingVariables(env, ["QLOO_API_KEY"]);
  if (missing.length) {
    summary.qloo.status = "skipped";
    summary.qloo.missing = missing;
    say(`Qloo: SKIPPED — missing variable(s): ${missing.join(", ")}`);
    return;
  }
  say(`Qloo: base ${new URL(qlooBase).origin}, header X-Api-Key (present), budget ${QLOO_LIMIT}`);
  summary.qloo.status = "running";

  const movieId = await searchMovie();
  if (!movieId) throw new FatalStop("search did not yield a verified Interstellar movie ID");

  // R4/R5 baseline
  const base = await insights("insights baseline", movieId);
  if (!base.ok || !base.entities.length) throw new FatalStop(`baseline insights returned no entities (HTTP ${base.status})`);
  const baseIds = idsOf(base.entities);
  const f = summary.qloo.findings;
  f.insightsListPath = base.listPath;
  f.insightsTopLevelKeys = Object.keys(base.body ?? {});
  f.insightsShape = describeShape(base.body);
  f.baseline = { ids: baseIds, names: base.entities.map((e) => e.name), metadata: measureEntities(base.entities, BOOK) };
  say(`    baseline: ${baseIds.length} entities at "${base.listPath}"`);
  base.entities.forEach((e, i) => say(`      ${i + 1}. ${brief(e)} [${tagsOf(e).length} tags]`));
  const m = f.baseline.metadata;
  say(
    `    metadata: validIds ${m.validIds}/${m.total}, book-typed ${m.matchingType}, withTags ${m.withTags}, distinctTags ${m.distinctTags}, usefulTags ${m.usefulTags}`,
  );
  for (const [field, cov] of Object.entries(m.fields)) say(`      ${field}: ${cov.count}/${m.total} via ${cov.paths.join(", ") || "-"}`);

  // Explainability
  const exp = await insights("insights + feature.explainability", movieId, { "feature.explainability": true });
  if (exp.ok) {
    const em = measureEntities(exp.entities, BOOK);
    f.explainability = {
      status: exp.status,
      perEntityCoverage: `${em.fields.explainability.count}/${em.total}`,
      paths: em.fields.explainability.paths,
      topLevel: exp.body?.query?.explainability !== undefined ? "query.explainability" : exp.body?.results?.explainability !== undefined ? "results.explainability" : null,
      shapeOfExplainability: describeShape({ entity0: exp.entities[0]?.query ?? null, top: exp.body?.query ?? null }),
      comparison: compareIds(baseIds, idsOf(exp.entities)),
    };
  } else {
    f.explainability = { status: exp.status, error: errorMessageOf(exp.body) };
  }

  // R6 positive tag signal
  const tag = pickSignalTag(base.entities);
  if (tag) {
    const pos = await insights(`insights + signal.interests.tags`, movieId, { "signal.interests.tags": tag.id });
    const cmp = pos.ok ? compareIds(baseIds, idsOf(pos.entities)) : null;
    const carriers = (list) => list.filter((e) => tagsOf(e).some((t) => t.id === tag.id)).length;
    f.positiveTag = {
      tag,
      status: pos.status,
      comparison: cmp,
      tagCarriersBaseline: carriers(base.entities),
      tagCarriersVariant: pos.ok ? carriers(pos.entities) : null,
      classification: classifyPositiveSignal(pos.status, cmp),
      error: pos.ok ? undefined : errorMessageOf(pos.body),
    };
  } else {
    f.positiveTag = { tag: null, classification: { verdict: "UNVERIFIED", reason: "no splitting tag in baseline" } };
  }

  // R6 exclusion of an entity
  const excludedId = baseIds[0];
  const exc = await insights("insights + filter.exclude.entities", movieId, { "filter.exclude.entities": excludedId });
  f.excludeEntities = {
    excludedId,
    status: exc.status,
    comparison: exc.ok ? compareIds(baseIds, idsOf(exc.entities)) : null,
    classification: classifyExclusion(exc.status, excludedId, baseIds, exc.ok ? idsOf(exc.entities) : null),
    error: exc.ok ? undefined : errorMessageOf(exc.body),
  };

  // Tag exclusion (only if a tag was verified)
  if (tag) {
    const ext = await insights("insights + filter.exclude.tags", movieId, { "filter.exclude.tags": tag.id });
    const stillTagged = ext.ok ? ext.entities.filter((e) => tagsOf(e).some((t) => t.id === tag.id)).length : null;
    const hadTagged = f.positiveTag.tagCarriersBaseline;
    let classification;
    if (!ext.ok) classification = classifyExclusion(ext.status, tag.id, [], null);
    else if (!hadTagged) classification = { verdict: "UNVERIFIED", reason: "tag absent from baseline" };
    else if (stillTagged === 0) classification = { verdict: "SUPPORTED", reason: `${hadTagged} tagged in baseline, 0 after exclusion` };
    else classification = { verdict: "UNSUPPORTED", reason: `${stillTagged} results still carry the excluded tag` };
    f.excludeTags = {
      tag,
      status: ext.status,
      comparison: ext.ok ? compareIds(baseIds, idsOf(ext.entities)) : null,
      classification,
      error: ext.ok ? undefined : errorMessageOf(ext.body),
    };
  }
  summary.qloo.status = "done";
}

// --------------------------------------------------------------------------- Gemini

const OFFERED_QUESTIONS = [
  { questionId: "tag:urn:tag:genre:media:hard_science_fiction", text: "Do you want books with hard science fiction?" },
  { questionId: "tag:urn:tag:genre:media:family_drama", text: "Do you want books with family drama?" },
  { questionId: "entity-pair:book-a|book-b", text: "Which of these two books appeals more?" },
];
const SYNTHETIC_STATE =
  "You are the bounded decision agent of TasteProbe, a movie-to-book discovery app. " +
  "SYNTHETIC TEST STATE: the user's seed movie is a space-exploration film; the shortlist has 10 verified book candidates; " +
  "0 of 3 preference questions have been asked; Qloo call budget remaining: 4. " +
  `Available question IDs (choose only from these, copy exactly): ${OFFERED_QUESTIONS.map((q) => `${q.questionId} ("${q.text}")`).join("; ")}. `;

async function gemini(label, body) {
  geminiBudget.take();
  const model = env.LLM_MODEL;
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env.GOOGLE_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(env.LLM_TIMEOUT_MS) || 15000),
    });
  } catch (error) {
    summary.gemini.calls.push({ label, status: null, ms: Math.round(performance.now() - started), error: error?.name ?? "network" });
    throw new FatalStop(`${label}: network/timeout failure (${error?.name ?? "error"}) — no retry`);
  }
  const ms = Math.round(performance.now() - started);
  const json = await readJson(res);
  const pricing = PRICING[model];
  const usage = pricing ? summarizeUsage(json.usageMetadata, pricing) : { ...summarizeUsage(json.usageMetadata, { inputPerMillion: 0, outputPerMillion: 0 }), estimatedCostUsd: null };
  const call = {
    label,
    status: res.status,
    ms,
    modelVersion: json.modelVersion ?? null,
    finishReason: json.candidates?.[0]?.finishReason ?? null,
    usage,
  };
  if (!res.ok) {
    call.failure = classifyHttpFailure(res.status);
    call.error = errorMessageOf(json);
  }
  summary.gemini.calls.push(call);
  say(`  [gemini ${geminiBudget.used}/${GEMINI_LIMIT}] ${label}: HTTP ${res.status} in ${ms} ms, model ${call.modelVersion ?? "?"}, tokens in/out/thought ${usage.promptTokens}/${usage.outputTokens}/${usage.thoughtTokens}, est $${usage.estimatedCostUsd ?? "n/a"}`);
  if (!res.ok) {
    say(`    error: ${call.error}`);
    if (isFatalFailure(call.failure)) throw new FatalStop(`${label}: ${call.failure} failure (HTTP ${res.status}); stopping`);
  }
  return { ok: res.ok, status: res.status, json };
}

async function runGemini() {
  const missing = missingVariables(env, ["LLM_PROVIDER", "LLM_MODEL", "GOOGLE_API_KEY"]);
  if (missing.length) {
    summary.gemini.status = "skipped";
    summary.gemini.missing = missing;
    say(`Gemini: SKIPPED — missing variable(s): ${missing.join(", ")}`);
    return;
  }
  if (env.LLM_PROVIDER !== "gemini") {
    summary.gemini.status = "skipped";
    say(`Gemini: SKIPPED — LLM_PROVIDER is "${env.LLM_PROVIDER}", expected "gemini"`);
    return;
  }
  const model = env.LLM_MODEL;
  summary.gemini.model = model;
  summary.gemini.expectedModel = EXPECTED_MODEL;
  if (model !== EXPECTED_MODEL) say(`Gemini: WARNING — configured LLM_MODEL "${model}" differs from intended "${EXPECTED_MODEL}"; no cost estimate available`);
  say(`Gemini: model ${model}, header x-goog-api-key (present), budget ${GEMINI_LIMIT}, no tools other than declared functions`);
  summary.gemini.status = "running";
  const temperature = Number.isFinite(Number(env.LLM_TEMPERATURE)) && env.LLM_TEMPERATURE ? Number(env.LLM_TEMPERATURE) : undefined;
  const offeredIds = OFFERED_QUESTIONS.map((q) => q.questionId);
  const f = summary.gemini.findings;

  // 1. Structured output matching AgentDecision
  const actions = AgentDecisionSchema.shape.action.options;
  const reasonCodes = AgentDecisionSchema.shape.reasonCode.options;
  const s = await gemini("structured AgentDecision", {
    contents: [
      {
        role: "user",
        parts: [{ text: `${SYNTHETIC_STATE}Return the next AgentDecision as JSON. If action is "ask", set selectedQuestionId to one available ID and done=false.` }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: agentDecisionResponseSchema(actions, reasonCodes),
      maxOutputTokens: 1024,
      ...(temperature !== undefined ? { temperature } : {}),
    },
  });
  if (s.ok) {
    const text = geminiText(s.json);
    let parsed = null;
    let jsonError = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      jsonError = e.message;
    }
    const validation = parsed ? AgentDecisionSchema.safeParse(parsed) : null;
    const knownQuestion =
      validation?.success && validation.data.action === "ask" ? offeredIds.includes(validation.data.selectedQuestionId ?? "") : null;
    const pass = Boolean(validation?.success) && knownQuestion !== false;
    f.structured = {
      result: pass ? "PASS" : "FAIL",
      jsonParsed: Boolean(parsed),
      jsonError,
      schemaValid: Boolean(validation?.success),
      schemaIssues: validation && !validation.success ? validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : [],
      decision: validation?.success ? validation.data : null,
      selectedKnownQuestion: knownQuestion,
    };
    say(`    structured: ${f.structured.result} — ${JSON.stringify(f.structured.decision ?? f.structured.schemaIssues)}`);
  } else {
    f.structured = { result: "FAIL", status: s.status };
  }

  // 2. Function calling
  const fc = await gemini("function calling", {
    contents: [{ role: "user", parts: [{ text: `${SYNTHETIC_STATE}Call exactly one function to take the next step.` }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: "ask_question",
            description: "Ask the user one of the available preference questions.",
            parameters: {
              type: "OBJECT",
              properties: {
                questionId: { type: "STRING", enum: offeredIds, description: "An available question ID, copied exactly." },
                reasonCode: { type: "STRING", enum: ["informative_question"] },
              },
              required: ["questionId", "reasonCode"],
            },
          },
          {
            name: "finish_discovery",
            description: "Stop asking questions and return final recommendations.",
            parameters: {
              type: "OBJECT",
              properties: { reasonCode: { type: "STRING", enum: ["stable_recommendations", "question_budget_exhausted"] } },
              required: ["reasonCode"],
            },
          },
        ],
      },
    ],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["ask_question", "finish_discovery"] } },
    generationConfig: { maxOutputTokens: 1024, ...(temperature !== undefined ? { temperature } : {}) },
  });
  if (fc.ok) {
    const calls = geminiFunctionCalls(fc.json);
    const declared = new Set(["ask_question", "finish_discovery"]);
    const first = calls[0];
    const argsValid =
      first?.name === "ask_question"
        ? offeredIds.includes(first.args?.questionId)
        : first?.name === "finish_discovery"
          ? ["stable_recommendations", "question_budget_exhausted"].includes(first.args?.reasonCode)
          : false;
    const pass = Boolean(first) && declared.has(first.name) && argsValid;
    f.functionCalling = {
      result: pass ? "PASS" : "FAIL",
      functionCalls: calls,
      textOnlyResponse: calls.length === 0 ? geminiText(fc.json).slice(0, 200) : null,
      argsValid,
    };
    say(`    function calling: ${f.functionCalling.result} — ${JSON.stringify(calls)}`);
  } else {
    f.functionCalling = { result: "FAIL", status: fc.status };
  }
  summary.gemini.status = "done";
}

// ----------------------------------------------------------------------------- main

let qlooBase = DEFAULT_QLOO_BASE;
let exitCode = 0;

async function main() {
  say("TasteProbe S2 live probe — REAL authenticated API calls (no mocks, no retries)");
  if (env.QLOO_MODE !== "live") {
    say(`Refusing to run: QLOO_MODE must be "live" (currently ${env.QLOO_MODE ? `"${env.QLOO_MODE}"` : "unset"}).`);
    process.exitCode = 2;
    return;
  }
  if (env.QLOO_BASE_URL) {
    try {
      const u = new URL(env.QLOO_BASE_URL);
      if (u.protocol !== "https:") throw new Error("not https");
      qlooBase = u.origin;
    } catch {
      say("Refusing to run: QLOO_BASE_URL is not a valid https URL.");
      process.exitCode = 2;
      return;
    }
  }

  for (const [name, run, section] of [
    ["Qloo", runQloo, summary.qloo],
    ["Gemini", runGemini, summary.gemini],
  ]) {
    try {
      await run();
    } catch (error) {
      if (error instanceof FatalStop || error instanceof BudgetExceededError) {
        section.status = "stopped";
        section.stopReason = redact(error.message, secrets);
        say(`${name}: STOPPED — ${section.stopReason}`);
        exitCode = 1;
      } else {
        throw error;
      }
    }
    if (section.status === "skipped") exitCode = 1;
  }

  const geminiCost = summary.gemini.calls.reduce((s, c) => s + (c.usage?.estimatedCostUsd ?? 0), 0);
  summary.usage = {
    qlooRequests: qlooBudget.used,
    qlooLimit: QLOO_LIMIT,
    geminiRequests: geminiBudget.used,
    geminiLimit: GEMINI_LIMIT,
    geminiTokens: summary.gemini.calls.reduce((s, c) => s + (c.usage?.totalTokens ?? 0), 0),
    geminiEstimatedCostUsd: Math.round(geminiCost * 1e6) / 1e6,
    pricing: PRICING[env.LLM_MODEL] ?? null,
  };
  for (const key of ["structured", "functionCalling"]) {
    if (summary.gemini.findings[key]?.result === "FAIL") exitCode = 1;
  }
  summary.finishedAt = new Date().toISOString();

  mkdirSync(".probe", { recursive: true });
  writeFileSync(".probe/latest-summary.json", JSON.stringify(sanitize(summary), null, 2));

  const fq = summary.qloo.findings;
  say("");
  say("=== SUMMARY ===");
  say(`Qloo: ${summary.qloo.status}; requests ${qlooBudget.used}/${QLOO_LIMIT}`);
  if (fq.search) say(`  search type param verified: ${fq.search.typeParam ?? "none"}; movie: ${fq.search.selected?.id ?? "-"}`);
  for (const [k, v] of Object.entries({ positiveTag: fq.positiveTag, excludeEntities: fq.excludeEntities, excludeTags: fq.excludeTags })) {
    if (v) say(`  ${k}: ${v.classification.verdict} — ${v.classification.reason}`);
  }
  say(`Gemini: ${summary.gemini.status}; requests ${geminiBudget.used}/${GEMINI_LIMIT}; structured ${summary.gemini.findings.structured?.result ?? "UNVERIFIED"}; function calling ${summary.gemini.findings.functionCalling?.result ?? "UNVERIFIED"}`);
  say(`Estimated Gemini cost: $${summary.usage.geminiEstimatedCostUsd} (${summary.usage.geminiTokens} tokens)`);
  say("Sanitized summary written to .probe/latest-summary.json (git-ignored).");
  process.exitCode = exitCode;
}

await main();
