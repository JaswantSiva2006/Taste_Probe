import { describe, expect, it } from "vitest";
import { AgentDecisionSchema } from "@/lib/contracts";
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
  findEntityList,
  geminiFunctionCalls,
  geminiText,
  isFatalFailure,
  measureEntities,
  missingVariables,
  pickSignalTag,
  redact,
  summarizeUsage,
} from "../../scripts/lib/probe-helpers";

// Synthetic, hand-written shapes only: no recorded provider responses.
const tag = (id: string, type = "urn:tag:genre:media") => ({ tag_id: id, name: id.split(":").pop(), type });
const book = (id: string, tags: string[], extra: Record<string, unknown> = {}) => ({
  entity_id: id,
  name: `Book ${id}`,
  subtype: "urn:entity:book",
  tags: tags.map((t) => tag(t)),
  ...extra,
});

describe("secrets", () => {
  it("redacts every occurrence and ignores short/empty secrets", () => {
    expect(redact("key=abcdef123 again abcdef123", ["abcdef123", undefined, "ab"])).toBe("key=[REDACTED] again [REDACTED]");
  });
  it("lists missing variable names without values", () => {
    expect(missingVariables({ A: "x", B: " ", C: undefined }, ["A", "B", "C", "D"])).toEqual(["B", "C", "D"]);
  });
});

describe("budget", () => {
  it("allows exactly `limit` requests", () => {
    const b = createBudget("Qloo", 2);
    b.take();
    b.take();
    expect(b.used).toBe(2);
    expect(() => b.take()).toThrow(BudgetExceededError);
    expect(b.used).toBe(2);
  });
});

describe("http helpers", () => {
  it("builds URLs with dotted query parameters", () => {
    const url = new URL(buildUrl("https://hackathon.api.qloo.com", "/v2/insights", { "filter.type": "urn:entity:book", take: 10 }));
    expect(url.origin + url.pathname).toBe("https://hackathon.api.qloo.com/v2/insights");
    expect(url.searchParams.get("filter.type")).toBe("urn:entity:book");
    expect(url.searchParams.get("take")).toBe("10");
  });
  it("classifies failures and treats auth/billing as fatal", () => {
    expect(classifyHttpFailure(401)).toBe("auth");
    expect(classifyHttpFailure(403)).toBe("auth");
    expect(classifyHttpFailure(429)).toBe("billing_or_quota");
    expect(classifyHttpFailure(400)).toBe("bad_request");
    expect(classifyHttpFailure(503)).toBe("server");
    expect(isFatalFailure("auth")).toBe(true);
    expect(isFatalFailure("billing_or_quota")).toBe(true);
    expect(isFatalFailure("bad_request")).toBe(false);
  });
});

describe("shape and metadata", () => {
  it("describes paths and types without values", () => {
    const shape = describeShape({ results: { entities: [{ entity_id: "x", tags: [{ tag_id: "t" }], query: { affinity: 0.5 } }] } });
    expect(shape).toContain("results.entities[].entity_id: string");
    expect(shape).toContain("results.entities[].tags[].tag_id: string");
    expect(shape).toContain("results.entities[].query.affinity: number");
    expect(shape.join("\n")).not.toContain("0.5");
  });

  it("finds entity lists at known locations", () => {
    expect(findEntityList({ results: { entities: [{}] } })?.path).toBe("results.entities");
    expect(findEntityList({ results: [{}] })?.path).toBe("results");
    expect(findEntityList({ nope: 1 })).toBeNull();
  });

  it("measures coverage and useful tags", () => {
    const entities = [
      book("b1", ["g:sf", "g:all"], { properties: { description: "d", image: { url: "https://x" } }, query: { affinity: 0.9 } }),
      book("b2", ["g:all"], { properties: { description: "" } }),
      book("b3", ["g:drama", "g:all"]),
      { name: "no id", subtype: "urn:entity:book" },
    ];
    const r = measureEntities(entities, "urn:entity:book");
    expect(r).toMatchObject({ total: 4, validIds: 3, uniqueIds: 3, matchingType: 4, withTags: 3, distinctTags: 3 });
    expect(r.usefulTags).toBe(3); // each tag is on some but not all four
    expect(r.fields.description).toEqual({ count: 1, paths: ["properties.description"] });
    expect(r.fields.image).toEqual({ count: 1, paths: ["properties.image.url"] });
    expect(r.fields.affinity.count).toBe(1);
    expect(r.fields.explainability.count).toBe(0);
    expect(r.topTags[0]).toMatchObject({ id: "g:all", count: 3 });
  });

  it("picks the most balanced splitting tag", () => {
    const entities = [book("b1", ["a", "c"]), book("b2", ["a"]), book("b3", ["b", "c"]), book("b4", ["c"])];
    // a: 2/4 (balanced), b: 1/4, c: 3/4
    expect(pickSignalTag(entities)?.id).toBe("a");
    expect(pickSignalTag([book("b1", ["x"]), book("b2", ["x"])])).toBeNull();
  });
});

describe("comparison and classification", () => {
  const base = ["a", "b", "c", "d"];

  it("compares ID lists", () => {
    expect(compareIds(base, base)).toMatchObject({ sameOrder: true, overlap: 4, jaccard: 1, added: [], removed: [] });
    const cmp = compareIds(base, ["b", "a", "c", "e"]);
    expect(cmp).toMatchObject({ sameOrder: false, overlap: 3, added: ["e"], removed: ["d"], movedWithinOverlap: 2 });
  });

  it("does not treat an accepted request as proof of support", () => {
    expect(classifyPositiveSignal(200, compareIds(base, base)).verdict).toBe("UNVERIFIED");
    expect(classifyPositiveSignal(200, compareIds(base, ["d", "c", "b", "a"])).verdict).toBe("SUPPORTED");
    expect(classifyPositiveSignal(400, null).verdict).toBe("UNSUPPORTED");
    expect(classifyPositiveSignal(500, null).verdict).toBe("UNVERIFIED");
    expect(classifyPositiveSignal(null, null).verdict).toBe("UNVERIFIED");
  });

  it("classifies exclusion by the excluded ID disappearing", () => {
    expect(classifyExclusion(200, "a", base, ["b", "c", "d", "e"]).verdict).toBe("SUPPORTED");
    expect(classifyExclusion(200, "a", base, base).verdict).toBe("UNSUPPORTED");
    expect(classifyExclusion(200, "z", base, base).verdict).toBe("UNVERIFIED");
    expect(classifyExclusion(422, "a", base, null).verdict).toBe("UNSUPPORTED");
  });
});

describe("gemini helpers", () => {
  it("keeps the response schema in sync with AgentDecision", () => {
    const actions = AgentDecisionSchema.shape.action.options;
    const reasons = AgentDecisionSchema.shape.reasonCode.options;
    const schema = agentDecisionResponseSchema(actions, reasons) as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(schema.properties.action!.enum).toEqual([...actions]);
    expect(schema.properties.reasonCode!.enum).toEqual([...reasons]);
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(AgentDecisionSchema.shape).sort());
    expect(schema.required).toEqual(["action", "reasonCode", "done"]);
  });

  it("extracts non-thought text and declared function calls", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { text: "thinking...", thought: true },
              { text: '{"a":' },
              { text: "1}" },
              { functionCall: { name: "ask_question", args: { questionId: "q1" } } },
            ],
          },
        },
      ],
    };
    expect(geminiText(response)).toBe('{"a":1}');
    expect(geminiFunctionCalls(response)).toEqual([{ name: "ask_question", args: { questionId: "q1" } }]);
    expect(geminiFunctionCalls({ candidates: [{ content: { parts: [{ text: "I would call ask_question" }] } }] })).toEqual([]);
    expect(geminiText({})).toBe("");
  });

  it("estimates cost with thinking tokens billed as output", () => {
    const usage = { promptTokenCount: 1_000_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 100_000, totalTokenCount: 1_200_000 };
    const s = summarizeUsage(usage, { inputPerMillion: 0.3, outputPerMillion: 2.5, source: "test" });
    expect(s).toEqual({ promptTokens: 1_000_000, outputTokens: 100_000, thoughtTokens: 100_000, totalTokens: 1_200_000, estimatedCostUsd: 0.8 });
    expect(summarizeUsage(undefined, { inputPerMillion: 1, outputPerMillion: 1, source: "t" }).estimatedCostUsd).toBe(0);
  });
});
