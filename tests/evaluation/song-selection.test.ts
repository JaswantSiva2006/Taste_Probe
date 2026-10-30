import { describe, expect, it } from "vitest";
import { createGeminiSongSelector } from "@/lib/agent/song-selector";
import type { VerifiedSongOption } from "@/lib/contracts";
import { deterministicSong, eligibleOptions, emptyListening, optionsFrom, withTrackFeedback } from "@/lib/music/listening";
import { REVIEWED_MAPPINGS } from "@/lib/music/mappings";
import { resolveArtistVideo } from "@/lib/music/resolver";

/**
 * S9.12 song-selector evaluation (offline, mechanics only). Identical verified options
 * and feedback for three strategies:
 *   A primary-only, B deterministic with feedback, C Gemini-assisted (scripted fake
 *   transport: valid, out-of-set, malformed and timeout outputs) with server validation.
 * No user-satisfaction or taste-quality claim is made or measurable here.
 */

const NOW = new Date("2026-10-30T12:00:00Z");
/** disliked/heard are within this artist; "elsewhere" scenarios carry evidence from another artist only. */
type Scenario = { artistId: string; artistName: string; options: VerifiedSongOption[]; disliked: string | null; heard: string[] };

async function scenarios(): Promise<Scenario[]> {
  const out: Scenario[] = [];
  for (const m of REVIEWED_MAPPINGS.filter((x) => x.review === "RESOLVED" && x.alternates.length >= 1)) {
    const options = optionsFrom(await resolveArtistVideo({ entityId: m.qlooArtistId, name: m.artistName, provenance: "qloo" }, { explorationId: "eval", now: NOW, momentReview: false }));
    // 1) The user disliked this artist's primary recording. 2) Fresh artist; a recording elsewhere was disliked.
    out.push({ artistId: m.qlooArtistId, artistName: m.artistName, options, disliked: options[0]!.videoId, heard: [options[0]!.videoId] });
    out.push({ artistId: m.qlooArtistId, artistName: m.artistName, options, disliked: null, heard: [] });
  }
  return out;
}

const SCRIPT = ["valid_last", "out_of_set", "valid_last", "malformed", "valid_first", "timeout", "other_artist", "valid_last", "valid_first", "valid_last", "valid_last"] as const;

describe("song selector evaluation (A primary-only · B deterministic · C Gemini-assisted)", () => {
  it("measures validity, artist correctness, rejected recurrence, duplicates, LLM calls and fallback", async () => {
    const cases = await scenarios();
    expect(cases.length).toBeGreaterThanOrEqual(16);
    let step = 0;
    let llmCalls = 0;
    const selector = createGeminiSongSelector({
      model: "gemini-3.5-flash-lite",
      temperature: 0.2,
      timeoutMs: 50,
      transport: async ({ body }) => {
        llmCalls += 1;
        const ids = (body as { tools: Array<{ functionDeclarations: Array<{ parameters: { properties: { videoId: { enum: string[] } } } }> }> }).tools[0]!.functionDeclarations[0]!.parameters.properties.videoId.enum;
        const kind = SCRIPT[step++ % SCRIPT.length]!;
        const call = (videoId: string) => ({ status: 200, body: { candidates: [{ content: { parts: [{ functionCall: { name: "select_verified_song", args: { videoId, reasonCode: "avoids_pattern_of_disliked_recordings" } } }] } }], usageMetadata: { promptTokenCount: 380, candidatesTokenCount: 18 } } });
        if (kind === "timeout") throw Object.assign(new Error("t"), { name: "GeminiTransportError", kind: "timeout" });
        if (kind === "malformed") return { status: 200, body: { candidates: [{ content: { parts: [{ text: "The second track has a dreamier mood." }] } }] } };
        if (kind === "out_of_set") return call("ZZZZZZZZZZZ");
        if (kind === "other_artist") return call("InyT9Gyoz_o" === ids[0] ? "xpZgtFhDbss" : "InyT9Gyoz_o");
        return call(kind === "valid_first" ? ids[0]! : ids.at(-1)!);
      },
    });

    type Pick = { videoId: string | null; mode: string; ms: number };
    const metrics = (picks: Array<{ s: Scenario; p: Pick }>) => {
      const chosen = picks.filter((x) => x.p.videoId);
      return {
        selections: picks.length,
        validIdRate: chosen.filter((x) => x.s.options.some((o) => o.videoId === x.p.videoId)).length / Math.max(1, chosen.length),
        wrongArtist: chosen.filter((x) => !x.s.options.some((o) => o.videoId === x.p.videoId && o.artistId === x.s.artistId)).length,
        rejectedRecurrence: chosen.filter((x) => x.p.videoId === x.s.disliked).length,
        duplicateEncounters: chosen.filter((x) => x.s.heard.includes(x.p.videoId!)).length,
        geminiChoices: picks.filter((x) => x.p.mode === "GEMINI").length,
        fallbacks: picks.filter((x) => x.p.mode === "FALLBACK").length,
        meanMs: Math.round(picks.reduce((a, x) => a + x.p.ms, 0) / picks.length),
      };
    };

    const A: Array<{ s: Scenario; p: Pick }> = [];
    const B: Array<{ s: Scenario; p: Pick }> = [];
    const C: Array<{ s: Scenario; p: Pick }> = [];
    for (const s of cases) {
      const l = s.disliked
        ? withTrackFeedback({ ...emptyListening(), encounters: [{ artistId: s.artistId, artistName: s.artistName, videoId: s.disliked, title: "x", at: 0, revision: 1, selection: "DETERMINISTIC" }] }, { artistId: s.artistId, videoId: s.disliked, action: "not_for_me", at: 0, revision: 2 })
        : emptyListening();
      const eligible = eligibleOptions(l, s.options, s.disliked);
      A.push({ s, p: { videoId: s.options[0]!.videoId, mode: "PRIMARY", ms: 0 } });
      const det = deterministicSong(eligible);
      B.push({ s, p: { videoId: det?.videoId ?? null, mode: "DETERMINISTIC", ms: 0 } });
      if (eligible.length < 2) {
        C.push({ s, p: { videoId: det?.videoId ?? null, mode: "SINGLE_OPTION", ms: 0 } });
        continue;
      }
      const started = performance.now();
      const r = await selector.select({ sessionRef: "eval", anchor: { name: "Interstellar", domain: "movie" }, artist: { entityId: s.artistId, name: s.artistName }, options: eligible, lovedRecordings: [], dislikedRecordings: [s.disliked ? { artistName: s.artistName, title: s.options[0]!.title } : { artistName: "Another artist", title: "An earlier recording" }], confirmedLikes: [], confirmedDislikes: [] });
      const valid = r.ok ? eligible.find((o) => o.videoId === r.videoId && o.artistId === s.artistId) : undefined;
      C.push({ s, p: { videoId: valid?.videoId ?? det!.videoId, mode: valid ? "GEMINI" : "FALLBACK", ms: Math.round(performance.now() - started) } });
    }
    const report = { A_primaryOnly: metrics(A), B_deterministic: metrics(B), C_geminiAssisted: { ...metrics(C), llmCalls } };
    console.log(`SONG_SELECTION_EVAL ${JSON.stringify(report, null, 1)}`);

    expect(report.A_primaryOnly.rejectedRecurrence).toBe(cases.filter((c) => c.disliked).length); // ignoring feedback replays the disliked recording
    for (const k of ["B_deterministic", "C_geminiAssisted"] as const) {
      expect(report[k].validIdRate).toBe(1);
      expect(report[k].wrongArtist).toBe(0);
      expect(report[k].rejectedRecurrence).toBe(0);
      expect(report[k].duplicateEncounters).toBe(0);
    }
    expect(report.C_geminiAssisted.fallbacks).toBeGreaterThan(0); // invalid outputs were caught, not used
    expect(report.C_geminiAssisted.geminiChoices + report.C_geminiAssisted.fallbacks).toBe(llmCalls);
  });
});
