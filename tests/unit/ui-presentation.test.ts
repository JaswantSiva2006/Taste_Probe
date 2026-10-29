import { describe, expect, it } from "vitest";
import type { DiscoveryView, PreferenceResponse, Question, RankedRecommendation } from "@/lib/contracts";
import {
  answerLabel,
  answeredCount,
  cleanDescription,
  clothFor,
  createNameBook,
  displayTags,
  finishLine,
  friendlyError,
  humanizeId,
  movementOf,
  questionCredit,
  splitTitle,
  tasteNotes,
  updateNotice,
} from "@/lib/ui/presentation";

const rec = (id: string, name: string, position: number, previousPosition: number | null, tags: Array<[string, string, string]> = []): RankedRecommendation => ({
  candidate: {
    entityId: id,
    name,
    entityType: "book",
    rank: position,
    tags: tags.map(([tid, tname, type]) => ({ id: tid, name: tname, type })),
    affinity: 0.9,
    evidence: { source: "qloo", requestId: "00000000-0000-0000-0000-000000000000", seedEntityIds: ["M"] },
  },
  position,
  previousPosition,
  score: 1,
  matchedPositiveTagIds: [],
  matchedRejectedTagIds: [],
  explanation: "",
});

function view(over: Partial<DiscoveryView> = {}): DiscoveryView {
  return {
    sessionToken: "t",
    sessionId: "s",
    revision: 1,
    status: "asking",
    finishReason: null,
    seed: { entityId: "M", name: "Interstellar", entityType: "movie", provenance: "qloo" },
    targetType: "book",
    questionCount: 2,
    maxQuestions: 3,
    currentQuestion: null,
    lastAnswer: { questionId: "tag:urn:tag:theme:qloo:space_travel", targetType: "tag", targetIds: ["urn:tag:theme:qloo:space_travel"], response: "like", timestamp: 1 },
    preferences: { positiveTagIds: ["urn:tag:theme:qloo:space_travel"], rejectedTagIds: [], positiveEntityIds: [], rejectedEntityIds: [] },
    recommendations: [
      rec("B1", "Ender's Game (Ender's Saga, #1)", 1, 2, [["urn:tag:theme:qloo:space_travel", "Space Travel", "urn:tag:theme:qloo"]]),
      rec("B2", "Dune", 2, 1),
      rec("B3", "The Martian", 3, null),
    ],
    rankingChanged: true,
    agent: { name: "gemini-agent", decision: { action: "ask", reasonCode: "informative_question", done: false }, mode: "LIVE_GEMINI", fallbackReason: null },
    usage: { qlooCallCount: 2, maxQlooCalls: 6, agentToolCallCount: 1 },
    ...over,
  };
}

const tagQ: Question = { questionId: "tag:x", text: "Do you enjoy X books?", targetType: "tag", targetIds: ["x"], allowedResponses: ["like", "dislike", "unknown"] };
const entityQ: Question = {
  questionId: "entity:B1|B2",
  text: "Which book…",
  targetType: "entity",
  targetIds: ["B1", "B2"],
  allowedResponses: ["prefer_a", "prefer_b", "both", "neither", "unknown"],
};

describe("answer labels map every backend response value", () => {
  it("covers tag and entity questions without inventing values", () => {
    const names = createNameBook();
    names.remember(view());
    const all: PreferenceResponse[] = ["like", "dislike", "prefer_a", "prefer_b", "both", "neither", "unknown"];
    for (const r of all) expect(answerLabel(r, r.startsWith("prefer") || r === "both" || r === "neither" ? entityQ : tagQ, names)).toBeTruthy();
    expect(answerLabel("prefer_a", entityQ, names)).toBe("I'd pick Ender's Game");
    expect(answerLabel("prefer_b", entityQ, names)).toBe("I'd pick Dune");
    expect(answerLabel("unknown", entityQ, names)).toBe("I don't know them");
    expect(answerLabel("unknown", tagQ, names)).toBe("Not sure");
  });
});

describe("truthful update notices", () => {
  const names = createNameBook();
  names.remember(view());

  it("only claims a Qloo refresh for QLOO_RERETRIEVAL", () => {
    const re = updateNotice(
      view({ recommendationUpdate: { mechanism: "QLOO_RERETRIEVAL", qlooRequested: true, internalCorrelationIds: ["c"], previousTopIds: [], updatedTopIds: [], preferenceIds: [] } }),
      names,
    )!;
    expect(re.title).toBe("Fresh picks from Qloo");
    expect(re.detail).toContain("1 new book arrived");
    const local = updateNotice(
      view({ recommendationUpdate: { mechanism: "LOCAL_RERANK", qlooRequested: false, internalCorrelationIds: [], previousTopIds: [], updatedTopIds: [], preferenceIds: [] } }),
      names,
    )!;
    expect(local.title).toBe("Your shelf was reordered");
    expect(local.detail).not.toMatch(/Qloo/);
    expect(local.detail).toContain("You said yes to Space Travel.");
  });

  it("derives LOCAL_RERANK/UNCHANGED on the mock path and says when nothing was assumed", () => {
    expect(updateNotice(view({ rankingChanged: false }), names)!.mechanism).toBe("UNCHANGED");
    const skip = updateNotice(view({ rankingChanged: false, lastAnswer: { ...view().lastAnswer!, response: "unknown" } }), names)!;
    expect(skip.detail).toContain("nothing was assumed");
    expect(updateNotice(view({ lastAnswer: null }), names)).toBeNull();
  });
});

describe("agent credit never credits Gemini for a fallback", () => {
  it("labels each mode truthfully", () => {
    expect(questionCredit(view(), "live")).toMatch(/Gemini/);
    const fb = questionCredit(view({ agent: { ...view().agent, mode: "DETERMINISTIC_FALLBACK", fallbackReason: "provider_error" } }), "live");
    expect(fb).toMatch(/optimizer/);
    expect(fb).toMatch(/Gemini was not used/);
    expect(questionCredit(view({ agent: { name: "m", decision: view().agent.decision } }), "mock")).toMatch(/mock agent/);
  });
});

describe("counts, titles, notes and errors", () => {
  it("counts answered questions correctly when finishing early", () => {
    expect(answeredCount(view({ status: "finished", finishReason: "user_finished", questionCount: 2 }))).toBe(1);
    expect(answeredCount(view({ status: "finished", finishReason: "question_budget_exhausted", questionCount: 3 }))).toBe(3);
    expect(answeredCount(view({ status: "finished", finishReason: "user_finished", questionCount: 1, lastAnswer: null }))).toBe(0);
    expect(finishLine(view({ status: "finished", finishReason: "user_finished", questionCount: 1 }))).toBe("You went straight to the books.");
  });

  it("splits series titles and humanizes unseen IDs", () => {
    expect(splitTitle("The Name of the Wind (The Kingkiller Chronicle, #1)")).toEqual({ title: "The Name of the Wind", series: "The Kingkiller Chronicle, #1" });
    expect(splitTitle("Norse Mythology")).toEqual({ title: "Norse Mythology", series: null });
    expect(humanizeId("urn:tag:theme:qloo:space_travel")).toBe("space travel");
  });

  it("keeps preference names after reretrieval removes the tagged book", () => {
    const names = createNameBook();
    names.remember(view());
    const later = view({ recommendations: [rec("B9", "Other", 1, null)] });
    names.remember(later);
    expect(tasteNotes(later, names)).toEqual([{ id: "urn:tag:theme:qloo:space_travel", label: "Space Travel", kind: "liked", target: "tag" }]);
  });

  it("shows only meaningful Qloo tags and reports movement", () => {
    const r = rec("B", "X", 1, 3, [
      ["urn:tag:theme:qloo:space_travel", "Space Travel", "urn:tag:theme:qloo"],
      ["urn:tag:book_format:qloo:hardcover", "Hardcover", "urn:tag:book_format:qloo"],
    ]);
    expect(displayTags(r)).toEqual(["Space Travel"]);
    expect(movementOf(r, true)).toEqual({ kind: "up", by: 2 });
    expect(movementOf(rec("N", "N", 2, null), true).kind).toBe("new");
    expect(movementOf(r, false).kind).toBe("initial");
    expect(clothFor("abc")).toBe(clothFor("abc"));
  });

  it("hides format/audience labels and strips catalogue boilerplate without adding text", () => {
    const r = rec("B", "X", 1, null, [
      ["urn:tag:genre:media:adult", "Adult", "urn:tag:genre:media"],
      ["urn:tag:genre:media:audiobook", "Audiobook", "urn:tag:genre:media"],
      ["urn:tag:genre:media:epic_fantasy", "Epic Fantasy", "urn:tag:genre:media"],
    ]);
    expect(displayTags(r)).toEqual(["Epic Fantasy"]);
    expect(cleanDescription("Librarian's note: An alternate cover edition can be found here IN THE YEAR 2044, reality is ugly.")).toBe(
      "IN THE YEAR 2044, reality is ugly.",
    );
    expect(cleanDescription("This is an alternate cover edition for ISBN 9780393356182 Neil Gaiman, long inspired by myth.")).toBe(
      "Neil Gaiman, long inspired by myth.",
    );
    expect(cleanDescription("An alternate cover for this ISBN can be found here Here is the third volume.")).toBe("Here is the third volume.");
    expect(cleanDescription("A normal description stays exactly as it is.")).toBe("A normal description stays exactly as it is.");
    expect(cleanDescription(undefined)).toBeUndefined();
  });

  it("maps API errors to human recovery actions", () => {
    expect(friendlyError("SESSION_REVISION_CONFLICT").recovery).toBe("restart");
    expect(friendlyError("SESSION_EXPIRED").recovery).toBe("restart");
    expect(friendlyError("NETWORK_ERROR").recovery).toBe("retry");
    expect(friendlyError("QLOO_TIMEOUT").recovery).toBe("retry");
    expect(friendlyError("NO_RECOMMENDATIONS").recovery).toBe("edit");
    expect(friendlyError("SOMETHING_NEW").title).toBe("Something went wrong");
  });
});
