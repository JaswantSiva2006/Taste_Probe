import { describe, expect, it } from "vitest";
import { publicCapabilities, type DiscoveryView, type PreferenceResponse, type PublicDomainPair, type RankedRecommendation } from "@/lib/contracts";
import { artAlt, isOfferedPair, lookOf, sourceChoices, targetChoices, withArticle } from "@/lib/ui/domains";
import { continueBlockedCopy, createNameBook, finishLine, friendlyError, historyAnswer, resolvePath, ROLE_LABEL, updateNotice } from "@/lib/ui/presentation";

/** S9.4: the onboarding derives every choice from the server projection. */

const LIVE = publicCapabilities().pairs;
const pair = (source: string, target: string, sourceLabel: string, targetLabel: string): PublicDomainPair =>
  ({ source, target, sourceLabel, targetLabel }) as PublicDomainPair;

describe("capability-driven pickers", () => {
  it("targets are the distinct enabled destinations in registry order", () => {
    expect(targetChoices(LIVE).map((t) => [t.domain, t.label])).toEqual([
      ["book", "Books"],
      ["music_artist", "Music artists"],
    ]);
  });

  it("sources are filtered by the chosen destination", () => {
    expect(sourceChoices(LIVE, "book").map((s) => s.domain)).toEqual(["movie", "music_artist"]);
    expect(sourceChoices(LIVE, "music_artist").map((s) => s.domain)).toEqual(["movie", "music_artist", "tv_show", "video_game", "podcast"]);
    expect(sourceChoices(LIVE, null)).toEqual([]);
    expect(sourceChoices(LIVE, "podcast")).toEqual([]);
  });

  it("unsupported pairs are never offered", () => {
    expect(isOfferedPair(LIVE, "movie", "book")).toBe(true);
    expect(isOfferedPair(LIVE, "music_artist", "music_artist")).toBe(true);
    expect(isOfferedPair(LIVE, "book", "movie")).toBe(false);
    expect(isOfferedPair(LIVE, "podcast", "book")).toBe(false);
    expect(isOfferedPair(LIVE, null, "book")).toBe(false);
  });

  it("an empty or failed projection offers nothing", () => {
    expect(targetChoices([])).toEqual([]);
    expect(sourceChoices([], "book")).toEqual([]);
  });

  it("a newly enabled pair appears without code changes, with a neutral look", () => {
    const extended = [...LIVE, pair("movie", "podcast", "movie", "podcasts"), pair("movie", "zine", "movie", "zines")];
    expect(targetChoices(extended).map((t) => t.label)).toEqual(["Books", "Music artists", "Podcasts", "Zines"]);
    expect(lookOf("podcast")).toEqual({ glyph: "mic", shape: "square" });
    expect(lookOf("zine")).toEqual({ glyph: "spark", shape: "square" });
  });

  it("artwork frames and alt text follow the domain without inventing what an image shows", () => {
    expect(lookOf("book").shape).toBe("portrait");
    expect(lookOf("music_artist").shape).toBe("square");
    expect(artAlt("book", "Dune")).toBe("Cover of Dune");
    expect(artAlt("music_artist", "Max Richter")).toBe("Image for Max Richter from Qloo");
    expect([withArticle("movie"), withArticle("music artist")]).toEqual(["a movie", "a music artist"]);
  });
});

const rec = (id: string, position: number, entityType = "music_artist"): RankedRecommendation => ({
  candidate: {
    entityId: id,
    name: `Name ${id}`,
    entityType,
    rank: position,
    tags: [],
    affinity: 0.9,
    evidence: { source: "qloo", requestId: "00000000-0000-0000-0000-000000000000", seedEntityIds: ["S"] },
  },
  position,
  previousPosition: null,
  score: 1,
  matchedPositiveTagIds: [],
  matchedRejectedTagIds: [],
  explanation: "",
});

const exp = (text: string) => ({ kind: "source_grounded" as const, text, evidence: { provenance: "qloo" as const, seedEntityIds: ["S"], preferenceIds: [], tagIds: [] } });

function finished(over: Partial<DiscoveryView> = {}): DiscoveryView {
  return {
    sessionToken: "t",
    sessionId: "s",
    revision: 2,
    status: "finished",
    finishReason: "user_finished",
    seed: { entityId: "S", name: "Interstellar", entityType: "movie", provenance: "qloo" },
    targetType: "music_artist",
    questionCount: 1,
    maxQuestions: 3,
    currentQuestion: null,
    lastAnswer: null,
    preferences: { positiveTagIds: [], rejectedTagIds: [], positiveEntityIds: [], rejectedEntityIds: [] },
    recommendations: [rec("A", 1), rec("B", 2), rec("C", 3), rec("D", 4)],
    rankingChanged: false,
    agent: { name: "m", decision: { action: "finish", reasonCode: "stable_recommendations", done: true } },
    usage: { qlooCallCount: 1, maxQlooCalls: 6, agentToolCallCount: 0 },
    discoveryPath: {
      version: 1,
      sourceType: "movie",
      targetType: "music_artist",
      featured: [
        { role: "START_HERE", recommendationEntityId: "A", position: 1, explanation: exp("Qloo returned this among its music artists for fans of “Interstellar”.") },
        { role: "EXPLORE_NEXT", recommendationEntityId: "B", position: 2, explanation: exp("Qloo also returned this.") },
      ],
      remainingEntityIds: ["C", "D"],
    },
    ...over,
  };
}

describe("Discovery Path finale", () => {
  it("resolves backend roles in backend order without re-ranking", () => {
    const r = resolvePath(finished())!;
    expect(r.featured.map((f) => [f.item.role, f.rec.candidate.entityId])).toEqual([
      ["START_HERE", "A"],
      ["EXPLORE_NEXT", "B"],
    ]);
    expect(r.others.map((o) => o.candidate.entityId)).toEqual(["C", "D"]);
    expect(ROLE_LABEL.START_HERE).toBe("Start here");
  });

  it("drops unresolvable or duplicate IDs instead of rendering invented cards", () => {
    const v = finished();
    v.discoveryPath!.featured.push({ role: "ANOTHER_DIRECTION", recommendationEntityId: "GHOST", position: 9, explanation: exp("x") });
    v.discoveryPath!.remainingEntityIds = ["C", "A", "D", "NOPE"];
    const r = resolvePath(v)!;
    expect(r.featured.map((f) => f.rec.candidate.entityId)).toEqual(["A", "B"]);
    expect(r.others.map((o) => o.candidate.entityId)).toEqual(["C", "D"]);
  });

  it("a single result renders a single entry; an older server has no path", () => {
    const one = finished({
      recommendations: [rec("A", 1)],
      discoveryPath: { version: 1, sourceType: "movie", targetType: "music_artist", featured: [{ role: "START_HERE", recommendationEntityId: "A", position: 1, explanation: exp("x") }], remainingEntityIds: [] },
    });
    expect(resolvePath(one)).toEqual({ featured: [expect.objectContaining({ rec: expect.anything() })], others: [] });
    expect(resolvePath(finished({ discoveryPath: undefined }))).toBeNull();
  });

  it("early finish is described truthfully, never as an answered question", () => {
    expect(finishLine(finished({ finishReason: "insufficient_question_evidence", questionCount: 0 }))).toMatch(/none was asked/);
  });
});

describe("S9.7 continuous exploration copy", () => {
  const ex = (over: Partial<NonNullable<DiscoveryView["exploration"]>> = {}): NonNullable<DiscoveryView["exploration"]> => ({
    explorationId: "s",
    round: 2,
    status: "presenting",
    acceptedEntityId: null,
    rejectedRecommendationIds: [],
    totalQuestionsAsked: 4,
    previouslyPresentedIds: [],
    unseenCandidateCount: 1,
    canContinue: true,
    continueBlockedReason: null,
    budget: { qlooUsed: 1, qlooMax: 6, geminiUsed: 2, geminiMax: 20 },
    expiresAt: 0,
    ...over,
  });

  it("explains a blocked continue from the backend reason only", () => {
    expect(continueBlockedCopy(finished({ exploration: ex() }))).toBeNull();
    expect(continueBlockedCopy(finished({ exploration: ex({ canContinue: false, continueBlockedReason: "candidates_exhausted" }) }))).toMatch(/every verified music artist found for Interstellar/);
    expect(continueBlockedCopy(finished({ exploration: ex({ canContinue: false, continueBlockedReason: "budget_exhausted" }) }))).toMatch(/question allowance/);
    expect(continueBlockedCopy(finished({ exploration: undefined }))).toBeNull();
  });

  it("a skip in the history is never shown as a dislike", () => {
    const h = (response: PreferenceResponse) => historyAnswer({ round: 1, questionId: "q", targetType: "tag", response, label: "X" });
    expect(h("unknown")).toEqual({ text: "Skipped (not counted)", kind: "skipped" });
    expect(h("dislike").kind).toBe("passed");
    expect(h("like").kind).toBe("liked");
  });

  it("no stale update notice once a new round begins", () => {
    const names = createNameBook();
    const answeredR1 = { questionId: "q", targetType: "tag" as const, targetIds: ["t"], response: "like" as const, timestamp: 1 };
    expect(updateNotice(finished({ status: "asking", lastAnswer: answeredR1, exploration: ex({ round: 2, status: "asking" }) }), names)).toBeNull();
    expect(updateNotice(finished({ status: "asking", lastAnswer: { ...answeredR1, round: 2 }, exploration: ex({ round: 2, status: "asking" }) }), names)).not.toBeNull();
  });

  it("new exploration errors are recoverable without blind retries", () => {
    for (const code of ["EXPLORATION_EXHAUSTED", "EXPLORATION_BUDGET_EXHAUSTED", "INVALID_RECOMMENDATION", "ROUND_IN_PROGRESS"]) expect(friendlyError(code).recovery).toBe("edit");
    expect(friendlyError("EXPLORATION_CLOSED").recovery).toBe("restart");
  });
});

describe("domain-aware copy and errors", () => {
  it("update notices use the target noun", () => {
    const names = createNameBook();
    const v = finished({ status: "asking", lastAnswer: { questionId: "q", targetType: "tag", targetIds: ["t"], response: "dislike", timestamp: 1 }, rankingChanged: true });
    v.recommendations[0]!.previousPosition = 2;
    names.remember(v);
    expect(updateNotice(v, names)!.detail).toContain("1 music artist changed place");
  });

  it("errors name the user's choices and never auto-retry a rate limit", () => {
    expect(friendlyError("NO_RECOMMENDATIONS", { sourceLabel: "music artist", targetLabel: "books" }).title).toBe("No books for this music artist");
    expect(friendlyError("UNSUPPORTED_DOMAIN")).toMatchObject({ recovery: "edit" });
    expect(friendlyError("CAPABILITIES_UNAVAILABLE")).toMatchObject({ recovery: "retry" });
    expect(friendlyError("RATE_LIMITED").recovery).toBe("retry"); // a button, never a loop
    expect(friendlyError("SESSION_REVISION_CONFLICT").recovery).toBe("restart");
  });
});
