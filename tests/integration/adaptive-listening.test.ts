import { describe, expect, it, vi } from "vitest";
import { listeningFeedback, startListening } from "@/lib/discovery/service";
import type { DiscoveryView, ListeningAction } from "@/lib/contracts";
import { adaptiveFixture } from "../helpers/adaptive-listening";

const react = (f: ReturnType<typeof adaptiveFixture>, v: DiscoveryView, action: ListeningAction) => listeningFeedback(f.deps, {
  sessionToken: v.sessionToken, artistId: v.listening!.artist!.entityId, videoId: v.listening!.video!.videoId, action,
});

describe("S9.16 adaptive listening through the session transaction", () => {
  it("Gemini cannot wash out a materially better explicit-answer fit, even inside its score margin", async () => {
    const f = adaptiveFixture();
    f.state.candidates = f.state.candidates.slice(0, 2);
    const a = f.state.candidates[0]!, b = f.state.candidates[1]!;
    const tag = (id: string) => ({ id, name: `FIXTURE ${id}`, type: "fixture" });
    a.tags = [tag("a"), tag("b"), tag("c")]; b.tags = [tag("a"), tag("b")];
    f.state.session.positiveTagIds = ["a"];
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state), artistId: a.entityId });
    f.deps.songSelector = { model: "fixture", select: async (input) => ({ ok: true, videoId: input.options.find((o) => o.artistId === a.entityId)!.videoId, reasonCode: "fits_confirmed_preferences", requests: 1, usage: { promptTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 }, costUsd: 0, latencyMs: 1, requestId: "fixture" }) };
    v = await react(f, v, "LOVE");
    expect(v.listening!.upNext!.artistId).toBe(b.entityId);
    expect((await f.sessions.load(v.sessionToken)).state.listening!.contextualDecision?.fallbackReason).toBe("explicit_answer_priority");
  });
  it("dislike advances automatically; love preserves current and prepares a verified next recording; Next is neutral", async () => {
    const f = adaptiveFixture();
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const original = v.listening!.video!.videoId;
    v = await react(f, v, "LOVE");
    expect(v.listening!.video!.videoId).toBe(original);
    expect(v.listening!.upNext?.videoId).not.toBe(original);
    const pending = v.listening!.upNext!.videoId;
    const saved = v.sessionToken;
    v = await react(f, v, "NEXT");
    expect(v.listening!.video!.videoId).toBe(pending);
    await expect(listeningFeedback(f.deps, { sessionToken: saved, artistId: v.listening!.artist!.entityId, videoId: pending, action: "NOT_FOR_ME" })).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    const rejected = v.listening!.video!.videoId;
    v = await react(f, v, "NOT_FOR_ME");
    expect(v.listening!.video!.videoId).not.toBe(rejected);
    expect(v.listening!.notice).toBe("adaptive_next_ready");
    const loaded = await f.sessions.load(v.sessionToken);
    expect(loaded.state.taste?.explicitTrackLoves).toEqual([original]);
    expect(loaded.state.taste?.explicitTrackDislikes).toEqual([rejected]);
    expect(loaded.state.session.positiveEntityIds).toEqual([]);
    expect(loaded.state.session.rejectedEntityIds).toEqual([]);
  });

  it.each(["love5", "dislike5", "next10", "mixed15"])("%s does not loop, fabricate pairs, or spend Qloo", async (sequence) => {
    const f = adaptiveFixture();
    f.deps.provider.getRecommendations = vi.fn(() => { throw new Error("No new Qloo authorization"); });
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const seen = new Set<string>();
    const n = sequence === "mixed15" ? 15 : sequence === "next10" ? 10 : 5;
    for (let i = 0; i < n; i++) {
      const video = v.listening!.video!;
      expect(video).not.toBeNull();
      expect(seen.has(video.videoId)).toBe(false);
      seen.add(video.videoId);
      const action = sequence === "love5" ? "LOVE" : sequence === "dislike5" ? "NOT_FOR_ME" : sequence === "next10" ? "NEXT" : (["LOVE", "NOT_FOR_ME", "NEXT"] as const)[i % 3]!;
      v = await react(f, v, action);
      if (action === "LOVE") v = await react(f, v, "NEXT");
    }
    expect(seen.size).toBe(n);
    expect(f.deps.provider.getRecommendations).not.toHaveBeenCalled();
  });

  it("exhaustion clears the current video; it does not replay an excluded recording", async () => {
    const f = adaptiveFixture();
    f.state.candidates = [f.state.candidates[0]!]; f.state.order = [f.state.candidates[0]!.entityId];
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    for (let i = 0; i < 3; i++) v = await react(f, v, "NOT_FOR_ME");
    expect(v.listening!.video).toBeNull();
    expect(v.listening!.notice).toBe("verified_inventory_exhausted");
  });

  it("rollback retains the old non-advancing dislike behavior", async () => {
    const f = adaptiveFixture(false);
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const id = v.listening!.video!.videoId;
    v = await react(f, v, "NOT_FOR_ME");
    expect(v.listening!.video!.videoId).toBe(id);
    expect(v.listening!.notice).toBe("recording_disliked_choose_next");
  });

  it("Gemini failure retains the dislike, consumes its allowance and advances deterministically", async () => {
    const f = adaptiveFixture();
    f.deps.songSelector = { model: "fixture", select: vi.fn(async () => { throw new Error("timeout"); }) };
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const id = v.listening!.video!.videoId;
    v = await react(f, v, "NOT_FOR_ME");
    expect(v.listening!.video!.videoId).not.toBe(id);
    const loaded = await f.sessions.load(v.sessionToken);
    expect(loaded.state.taste!.explicitTrackDislikes).toContain(id);
    expect(loaded.state.session.geminiRequestCount).toBe(1);
  });
});
