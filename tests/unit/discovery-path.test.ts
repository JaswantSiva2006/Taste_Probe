import { describe, expect, it } from "vitest";
import { DiscoveryPathSchema, type DiscoveryPathItem, type Tag } from "@/lib/contracts";
import { buildDiscoveryPath, discoveryPathProblems, explanationProblems, type PathInput } from "@/lib/discovery/path";
import { rankCandidates } from "@/lib/discovery/ranking";

const SEED = "qloo:movie:seed";
const tag = (id: string, name = id, type = "urn:tag:genre:media"): Tag => ({ id: `urn:tag:genre:media:${id}`, name, type });
const T = {
  space: tag("space", "Space Opera"),
  war: tag("war", "War Fiction"),
  mystery: tag("mystery", "Mystery"),
  classic: tag("classic", "Classic Literature"),
  romance: tag("romance", "Romance"),
  audio: { id: "urn:tag:format:audiobook", name: "Audiobook", type: "urn:tag:format:qloo" },
};

function qloo(id: string, rank: number, tags: Tag[], extra: { description?: string; imageUrl?: string } = {}) {
  return {
    entityId: id,
    name: `Book ${id}`,
    entityType: "book",
    rank,
    tags,
    affinity: 1 - rank * 0.01,
    evidence: { source: "qloo" as const, requestId: "req-1", seedEntityIds: [SEED] },
    ...extra,
  };
}

type Prefs = PathInput["preferences"];
const noPrefs: Prefs = { positiveTagIds: [], rejectedTagIds: [], positiveEntityIds: [], rejectedEntityIds: [] };

function input(candidates: ReturnType<typeof qloo>[], prefs: Prefs = noPrefs): PathInput {
  return {
    recommendations: rankCandidates(candidates, prefs).slice(0, 5),
    preferences: prefs,
    seed: { entityId: SEED, name: "Interstellar", entityType: "movie", provenance: "qloo" },
    targetType: "book",
  };
}

const five = () => [
  qloo("a", 1, [T.space, T.audio], { description: "d", imageUrl: "https://example.com/a.jpg" }),
  qloo("b", 2, [T.space, T.war]),
  qloo("c", 3, [T.space]),
  qloo("d", 4, [T.mystery]),
  qloo("e", 5, [T.space, T.war]),
];

const featuredIds = (p: ReturnType<typeof buildDiscoveryPath>) => p.featured.map((f) => f.recommendationEntityId);

describe("buildDiscoveryPath — selection", () => {
  it("START HERE is the top-ranked recommendation; roles follow ranking; output validates", () => {
    const i = input(five());
    const path = buildDiscoveryPath(i);
    expect(DiscoveryPathSchema.parse(path)).toEqual(path);
    expect(path.featured.map((f) => f.role)).toEqual(["START_HERE", "EXPLORE_NEXT", "ANOTHER_DIRECTION"]);
    expect(path.featured[0]!.recommendationEntityId).toBe(i.recommendations[0]!.candidate.entityId);
    expect(path.featured[0]!.position).toBe(1);
    expect(path.featured[1]!.recommendationEntityId).toBe("b");
    // c only repeats tags already on a/b; d carries Mystery, which neither has.
    expect(path.featured[2]).toMatchObject({ recommendationEntityId: "d", position: 4 });
    expect(path.remainingEntityIds).toEqual(["c", "e"]);
    expect(discoveryPathProblems(path, i)).toEqual([]);
  });

  it("never duplicates an entity and covers exactly the final recommendations", () => {
    const i = input(five());
    const path = buildDiscoveryPath(i);
    const all = [...featuredIds(path), ...path.remainingEntityIds];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(i.recommendations.map((r) => r.candidate.entityId).sort());
  });

  it("does not modify the recommendations it presents", () => {
    const i = input(five());
    const before = structuredClone(i.recommendations);
    buildDiscoveryPath(i);
    expect(i.recommendations).toEqual(before);
  });

  it("is deterministic", () => {
    expect(buildDiscoveryPath(input(five()))).toEqual(buildDiscoveryPath(input(five())));
  });

  it("one recommendation → START HERE only, no placeholders", () => {
    const path = buildDiscoveryPath(input([qloo("a", 1, [])]));
    expect(path.featured.map((f) => f.role)).toEqual(["START_HERE"]);
    expect(path.remainingEntityIds).toEqual([]);
  });

  it("two recommendations → START HERE and EXPLORE NEXT only", () => {
    const path = buildDiscoveryPath(input([qloo("a", 1, [T.space]), qloo("b", 2, [T.space])]));
    expect(path.featured.map((f) => f.role)).toEqual(["START_HERE", "EXPLORE_NEXT"]);
    expect(path.featured[1]!.explanation.kind).toBe("source_grounded");
  });

  it("empty recommendations → empty path", () => {
    expect(buildDiscoveryPath(input([]))).toMatchObject({ featured: [], remainingEntityIds: [] });
  });

  it("omits the third direction when no verified distinction exists", () => {
    const same = [1, 2, 3, 4].map((n) => qloo(`s${n}`, n, [T.space]));
    const path = buildDiscoveryPath(input(same));
    expect(path.featured.map((f) => f.role)).toEqual(["START_HERE", "EXPLORE_NEXT"]);
    expect(path.remainingEntityIds).toEqual(["s3", "s4"]);
  });

  it("never emits GO_FURTHER, and the validator rejects an unjustified one", () => {
    const i = input(five());
    const path = buildDiscoveryPath(i);
    expect(path.featured.some((f) => f.role === "GO_FURTHER")).toBe(false);
    const forged = { ...path, featured: path.featured.map((f) => (f.role === "ANOTHER_DIRECTION" ? { ...f, role: "GO_FURTHER" as const } : f)) };
    expect(discoveryPathProblems(forged, i)).toContain("GO_FURTHER has no supporting metadata");
  });

  it("handles missing descriptions, artwork and tags with neutral copy", () => {
    const path = buildDiscoveryPath(input([qloo("a", 1, []), qloo("b", 2, []), qloo("c", 3, [])]));
    expect(path.featured).toHaveLength(2);
    for (const f of path.featured) {
      expect(f.explanation.kind).toBe("source_grounded");
      expect(f.explanation.evidence).toMatchObject({ preferenceIds: [], tagIds: [], provenance: "qloo", seedEntityIds: [SEED] });
    }
    expect(path.featured[0]!.explanation.text).toBe("Qloo returned this among its books for fans of “Interstellar”, and it is the highest-ranked result.");
  });

  it("does not cite non-content tags (format) as a contrast", () => {
    const path = buildDiscoveryPath(input([qloo("a", 1, []), qloo("b", 2, [T.audio])]));
    expect(path.featured[1]!.explanation).toMatchObject({ kind: "source_grounded", evidence: { tagIds: [] } });
  });

  it("skips an explicitly rejected entity for featured roles but keeps it in the list", () => {
    const prefs = { ...noPrefs, rejectedEntityIds: ["a"] };
    // Give a an inflated base so it still ranks first despite the rejection penalty.
    const cands = [{ ...qloo("a", 1, [T.space]), affinity: 5 }, qloo("b", 2, [T.space]), qloo("c", 3, [T.mystery])];
    const i = input(cands, prefs);
    expect(i.recommendations[0]!.candidate.entityId).toBe("a");
    const path = buildDiscoveryPath(i);
    expect(featuredIds(path)).toEqual(["b", "c"]);
    expect(path.remainingEntityIds).toEqual(["a"]);
    expect(path.featured[0]!.explanation.text).toContain("highest-ranked result you didn't turn down");
    expect(discoveryPathProblems(path, i)).toEqual([]);
  });
});

describe("buildDiscoveryPath — grounded explanations", () => {
  it("cites a confirmed positive tag only when the candidate carries it", () => {
    const prefs = { ...noPrefs, positiveTagIds: [T.war.id] };
    const i = input(five(), prefs);
    const path = buildDiscoveryPath(i);
    const start = path.featured[0]!;
    expect(start.recommendationEntityId).toBe("b");
    expect(start.explanation.kind).toBe("preference_match");
    expect(start.explanation.evidence.preferenceIds).toEqual([T.war.id]);
    expect(start.explanation.text).toContain("You said yes to “War Fiction”");
    for (const f of path.featured.filter((x) => x.recommendationEntityId !== "b" && x.recommendationEntityId !== "e")) {
      expect(f.explanation.evidence.preferenceIds).toEqual([]);
      expect(f.explanation.text).not.toContain("War Fiction");
    }
    expect(discoveryPathProblems(path, i)).toEqual([]);
  });

  it("cites a liked entity from a comparison answer", () => {
    const prefs = { ...noPrefs, positiveEntityIds: ["c"] };
    const path = buildDiscoveryPath(input(five(), prefs));
    expect(path.featured[0]).toMatchObject({ recommendationEntityId: "c", explanation: { kind: "preference_match", evidence: { preferenceIds: ["c"] } } });
    expect(path.featured[0]!.explanation.text).toContain("You said yes to this book");
  });

  it("never turns a rejected tag into support or a contrast", () => {
    const prefs = { ...noPrefs, rejectedTagIds: [T.mystery.id] };
    const i = input(five(), prefs);
    const path = buildDiscoveryPath(i);
    for (const f of path.featured) {
      expect(f.explanation.evidence.preferenceIds).not.toContain(T.mystery.id);
      expect(f.explanation.evidence.tagIds).not.toContain(T.mystery.id);
      expect(f.explanation.text).not.toMatch(/Mystery/);
    }
    expect(discoveryPathProblems(path, i)).toEqual([]);
  });

  it("a skipped answer adds no preference evidence", () => {
    // `unknown` leaves every preference set empty (preferences.ts); the path must stay neutral.
    const path = buildDiscoveryPath(input(five(), noPrefs));
    expect(path.featured.every((f) => f.explanation.kind !== "preference_match")).toBe(true);
  });

  it("allows a verified tag name that contains a claim word only inside quotes", () => {
    const i = input([qloo("a", 1, [T.space]), qloo("b", 2, [T.classic])]);
    const path = buildDiscoveryPath(i);
    expect(path.featured[1]!.explanation).toMatchObject({ kind: "metadata_contrast", evidence: { tagIds: [T.classic.id] } });
    expect(path.featured[1]!.explanation.text).toContain("“Classic Literature”");
    expect(discoveryPathProblems(path, i)).toEqual([]);
  });

  it("labels synthetic fixtures as not from Qloo", () => {
    const mock = {
      entityId: "mock:book:x", name: "X", entityType: "book", rank: 1, tags: [], syntheticScore: 0.9,
      evidence: { source: "mock" as const, requestId: "r", seedEntityIds: [SEED], fixtureId: "mock:x", note: "fixture" },
    };
    const i: PathInput = { ...input([]), recommendations: rankCandidates([mock], noPrefs) };
    const path = buildDiscoveryPath(i);
    expect(path.featured[0]!.explanation.text).toContain("synthetic sample books");
    expect(path.featured[0]!.explanation.text).toContain("not from Qloo");
    expect(path.featured[0]!.explanation.evidence.provenance).toBe("mock");
  });
});

describe("explanation validator rejects unsupported claims", () => {
  const i = input(five(), { ...noPrefs, positiveTagIds: [T.war.id] });
  const base = buildDiscoveryPath(i).featured[0]!;
  const withExp = (e: Partial<DiscoveryPathItem["explanation"]>, ev: Partial<DiscoveryPathItem["explanation"]["evidence"]> = {}): DiscoveryPathItem => ({
    ...base,
    explanation: { ...base.explanation, ...e, evidence: { ...base.explanation.evidence, ...ev } },
  });

  it.each([
    ["beginner claim", { text: "Perfect for beginners." }, {}],
    ["difficulty", { text: "A more challenging read." }, {}],
    ["popularity", { text: "A popular pick." }, {}],
    ["invented similarity", { text: "Similar to “Interstellar”." }, {}],
    ["unquoted invented name", { text: "Fans of “Dune” love it." }, {}],
  ])("%s", (_label, e, ev) => {
    expect(explanationProblems(withExp(e, ev), i).length).toBeGreaterThan(0);
  });

  it("unresolvable preference and tag evidence", () => {
    expect(explanationProblems(withExp({}, { preferenceIds: ["urn:tag:genre:media:space"] }), i)).toEqual(
      expect.arrayContaining([expect.stringContaining("not a confirmed positive preference")]),
    );
    expect(explanationProblems(withExp({}, { tagIds: ["urn:tag:none"] }), i)).toEqual(
      expect.arrayContaining([expect.stringContaining("not on this candidate")]),
    );
    expect(explanationProblems(withExp({}, { provenance: "mock" }), i).length).toBeGreaterThan(0);
    expect(explanationProblems(withExp({}, { seedEntityIds: ["qloo:movie:other"] }), i).length).toBeGreaterThan(0);
    expect(explanationProblems({ ...base, recommendationEntityId: "invented" }, i)).toEqual(["invented: not a final recommendation"]);
  });

  it("every generated explanation in a full path passes", () => {
    for (const f of buildDiscoveryPath(i).featured) expect(explanationProblems(f, i)).toEqual([]);
  });
});
