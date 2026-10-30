import { describe, expect, it } from "vitest";
import type { SavedDiscovery } from "@/lib/contracts";
import { displayMetadata, parsePassport, passportSummary } from "@/lib/ui/passport-store";

/** S9.13 browser-local Passport: parsing is defensive; nothing unvalidated is trusted. */

const item = (videoId: string, savedAt: string, provenance: SavedDiscovery["video"]["provenance"] = "reviewed_mapping"): SavedDiscovery => ({
  v: 1,
  savedAt,
  artist: { qlooId: "5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC", name: "Jóhann Jóhannsson", provenance: "qloo" },
  video: { videoId, title: `T ${videoId}`, channelTitle: "Jóhann Jóhannsson - Topic", watchUrl: `https://www.youtube.com/watch?v=${videoId}`, provenance },
  anchor: { qlooId: "057DA9D9-399B-437E-8BCA-A80E499125EF", name: "Interstellar", domain: "movie" },
});

describe("Sound Passport storage parsing", () => {
  it("tolerates missing, corrupt and wrong-version data", () => {
    expect(parsePassport(null)).toEqual([]);
    expect(parsePassport("{not json")).toEqual([]);
    expect(parsePassport(JSON.stringify({ v: 2, items: [item("aXlx-YnvgKU", "2026-10-30T10:00:00Z")] }))).toEqual([]);
    expect(parsePassport(JSON.stringify([item("aXlx-YnvgKU", "2026-10-30T10:00:00Z")]))).toEqual([]);
  });

  it("drops invalid records (forged URL, bad video ID, extra secrets are not trusted) and deduplicates by video", () => {
    const forged = { ...item("aXlx-YnvgKU", "2026-10-30T10:00:00Z"), video: { ...item("aXlx-YnvgKU", "x").video, watchUrl: "https://evil.example/watch?v=aXlx-YnvgKU" } };
    const badId = item("../etc/pass", "2026-10-30T10:00:00Z");
    const raw = JSON.stringify({ v: 1, items: [forged, badId, item("mPvqle7mF-U", "2026-10-30T09:00:00Z"), item("mPvqle7mF-U", "2026-10-30T11:00:00Z"), item("aXlx-YnvgKU", "2026-10-30T12:00:00Z")] });
    const out = parsePassport(raw);
    expect(out.map((i) => i.video.videoId)).toEqual(["aXlx-YnvgKU", "mPvqle7mF-U"]); // newest first, one per video
    expect(out.every((i) => i.video.watchUrl.startsWith("https://www.youtube.com/watch?v="))).toBe(true);
  });

  it("hides Data-API-derived titles after 30 days but keeps the reference; reviewed mappings stay", () => {
    const now = Date.parse("2026-12-15T00:00:00Z");
    expect(displayMetadata(item("aXlx-YnvgKU", "2026-10-30T10:00:00Z", "youtube_data_api"), now)).toBeNull();
    expect(displayMetadata(item("aXlx-YnvgKU", "2026-12-01T10:00:00Z", "youtube_data_api"), now)).toMatchObject({ title: "T aXlx-YnvgKU" });
    expect(displayMetadata(item("aXlx-YnvgKU", "2026-10-30T10:00:00Z"), now)).toMatchObject({ title: "T aXlx-YnvgKU" });
  });

  it("text summary lists exact YouTube links and starting points", () => {
    const s = passportSummary([item("aXlx-YnvgKU", "2026-10-30T10:00:00Z")]);
    expect(s).toContain("1 recording");
    expect(s).toContain("(from Interstellar) https://www.youtube.com/watch?v=aXlx-YnvgKU");
  });
});
