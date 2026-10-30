import type { FeaturedMomentEntry, ReviewedMapping, ReviewedVideo } from "./types";

/**
 * S9.9 reviewed artist → YouTube video registry (Tier A).
 *
 * Qloo IDs and names are exactly as returned by Qloo for "Interstellar → artists"
 * in the S9.8 live probe (docs/development/sound-passport-feasibility.md §8–§9). Video titles and
 * channels are exactly as reported by YouTube oEmbed and by the IFrame player in the
 * mapping audit (scripts/verify-music-mappings.mjs). A mapping is accepted only when
 * the channel is the artist's Topic or VEVO channel or a named label's channel; a
 * title containing "Official" is never enough on its own.
 *
 * Featured moments here are PENDING_REVIEW: nobody has listened to them yet. They are
 * placeholders inside the verified duration and are never offered to listeners until a
 * person approves them (status APPROVED, reviewedBy, reviewedAt).
 */

const CHECKED = "2026-10-30";
// Durations are as reported by the IFrame player in the 2026-10-30 audit (npm run verify:mappings).

const v = (
  videoId: string,
  title: string,
  channelTitle: string,
  channelUrl: string,
  channelKind: ReviewedVideo["channelKind"],
  durationSeconds?: number,
): ReviewedVideo => ({
  videoId,
  title,
  channelTitle,
  channelUrl,
  channelKind,
  verifiedAt: CHECKED,
  evidence: durationSeconds === undefined ? ["oembed_200"] : ["oembed_200", "iframe_playing"],
  ...(durationSeconds === undefined ? {} : { durationSeconds }),
});

const pending = (videoId: string, startSeconds: number, endSeconds: number): FeaturedMomentEntry => ({
  videoId,
  startSeconds,
  endSeconds,
  status: "PENDING_REVIEW",
  provenance: "human_curated",
  note: "Unlistened placeholder window inside the verified duration. A reviewer must listen, then approve or replace these bounds.",
});

const map = (
  qlooArtistId: string,
  artistName: string,
  primary: ReviewedVideo,
  alternates: ReviewedVideo[] = [],
  moments: FeaturedMomentEntry[] = [],
): ReviewedMapping => ({ qlooArtistId, artistName, review: "RESOLVED", primary, alternates, moments });

const TOPIC = (id: string) => `https://www.youtube.com/channel/${id}`;

export const REVIEWED_MAPPINGS: readonly ReviewedMapping[] = [
  map(
    "5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC",
    "Jóhann Jóhannsson",
    v("aXlx-YnvgKU", "Jóhannsson: Flight from the City", "Jóhann Jóhannsson - Topic", TOPIC("UC7S5bZP45MbwgfwFy9NEmcA"), "topic", 391),
    [
      v("mPvqle7mF-U", "Jóhannsson: A Song for Europa", "Jóhann Jóhannsson - Topic", TOPIC("UC7S5bZP45MbwgfwFy9NEmcA"), "topic", 154),
      v("dCWbVxfkoKg", "Jóhann Jóhannsson - A Song For Europa", "Deutsche Grammophon - DG", "https://www.youtube.com/@deutschegrammophon", "label", 155),
    ],
    [pending("aXlx-YnvgKU", 60, 90)],
  ),
  map(
    "0704ADB9-6270-4D71-B252-A42D8A4EAA47",
    "Max Richter",
    v("InyT9Gyoz_o", "Max Richter - On The Nature Of Daylight (Official Video)", "MaxRichterVEVO", "https://www.youtube.com/@MaxRichterVEVO", "vevo", 396),
    [v("b_YHE4Sx-08", "Max Richter - On The Nature Of Daylight (Entropy) | 2018 Version", "MaxRichterVEVO", "https://www.youtube.com/@MaxRichterVEVO", "vevo", 420)],
    [pending("InyT9Gyoz_o", 60, 90)],
  ),
  map(
    "02940707-9635-45DA-B290-243F84C6B910",
    "Ólafur Arnalds",
    v("xpZgtFhDbss", "Ólafur Arnalds - saman (Sunrise Session II / Performance Video)", "OlafurArnaldsVEVO", "https://www.youtube.com/@OlafurArnaldsVEVO", "vevo", 155),
    [v("XmHs_sMDueA", "saman", "Ólafur Arnalds - Topic", TOPIC("UCDQlvsMEM5j0k5cqmfHBzVA"), "topic", 132)],
    [pending("xpZgtFhDbss", 30, 60)],
  ),
  map(
    "D7918037-2D25-4990-BC34-4502B136E5AE",
    "Goldmund",
    v("Yyl5X7HqYAA", "Threnody", "Goldmund - Topic", TOPIC("UCeMhZbWtGvULvXgEspzzfKA"), "topic", 281),
    [v("wkIIZLDX25w", "Sometimes", "Goldmund - Topic", TOPIC("UCeMhZbWtGvULvXgEspzzfKA"), "topic", 169)],
  ),
  map(
    "5AC77C2A-0A4F-4A6B-B2EE-D915F0E92549",
    "Sylvain Chauveau",
    v("pR3CEtnEo_k", "Pauvre Simon", "Sylvain Chauveau - Topic", TOPIC("UClyLqIQG39Y1vRUcts__2vA"), "topic", 111),
    // A FatCat label upload (U-xTYSo3tMo) was rejected as an alternate: it is a 27-second teaser, not a track.
    [],
  ),
  map(
    "70BE1CE0-6D03-4125-BF8F-F538A9449F86",
    "Peter Broderick",
    v("Qkc42ah4nnM", "Eyes Closed and Traveling", "Peter Broderick - Topic", TOPIC("UCKKYmIsNgA6k491_fyV_MeA"), "topic", 212),
    [v("R5ZPMcL9xF8", "Broderick: Eyes Closed And Traveling", "Peter Broderick - Topic", TOPIC("UCKKYmIsNgA6k491_fyV_MeA"), "topic", 220)],
  ),
  map(
    "08ADBAF0-7267-4239-BCF8-DAD243B09BFC",
    "Eluvium",
    v("xuZnS2cNJhc", "Prelude For Time Feelers", "Eluvium - Topic", TOPIC("UCOMTkV8emKhP3QUy8c_SJkA"), "topic", 349),
  ),
  map(
    "41B1FF16-564C-4BC1-82F9-1FC443AC3D6D",
    "Greg Haines",
    // Two "Greg Haines - Topic" channels exist; only UCCT4p4… (Erased Tapes-era releases) is used.
    v("bZFkBajkgMM", "183 Times", "Greg Haines - Topic", TOPIC("UCCT4p4tQWD7Xc4P_7BFHv5Q"), "topic", 548),
    [v("d_qoJ-jaHGI", "The Intruder", "Greg Haines - Topic", TOPIC("UCCT4p4tQWD7Xc4P_7BFHv5Q"), "topic", 387)],
  ),
  map(
    "24259855-E26C-43A3-93E5-5BB4E09ABBBF",
    "Hildur Guðnadóttir",
    v("LNYCuj4ur-U", "Bathroom Dance", "Hildur Guðnadóttir - Topic", TOPIC("UCzY71RJtOlKpMaDP5aljnhw"), "topic", 128),
  ),
  map(
    "0D8EAFA4-CEEA-44D5-8E1F-26A8A9F49A77",
    "Nils Frahm",
    v("luXZuPTJ3f8", "Says", "Nils Frahm - Topic", TOPIC("UCHUlZT-VoVWIID4xcJZ5s6g"), "topic", 498),
    [v("hs1yXpaDgiE", "Nils Frahm - Says", "Erased Tapes", "https://www.youtube.com/@ErasedTapes", "label", 499)],
  ),
  map(
    "34F09ED4-6170-4DF9-AB79-8348D2465EC5",
    "Hauschka",
    v("Lsg9ZZF-240", "Hauschka - Elizabeth Bay (Official Video)", "Temporary Residence Ltd", "https://www.youtube.com/@temporaryresidence", "label", 356),
  ),
  map(
    "37EA7EEF-A51E-4D54-9728-5BCFEB9B3E85",
    "A Winged Victory for the Sullen",
    v("SwmRJQAx8eA", "Requiem for the Static King, Pt. 1", "A Winged Victory For The Sullen - Topic", TOPIC("UC9ROQ5ZHs7eNd9qTlAWJ9LQ"), "topic", 166),
    [v("-TOGFiiidAs", "Requiem for the Static King, Pt. 2", "A Winged Victory For The Sullen - Topic", TOPIC("UC9ROQ5ZHs7eNd9qTlAWJ9LQ"), "topic", 457)],
  ),
  map(
    "4358B267-4DF8-49FF-A4A2-5C84586EA882",
    "Philip Glass",
    v("8l9Lr9loHG4", "Metamorphosis: One", "Philip Glass - Topic", TOPIC("UCEBgE26BBZk7jnXKzcmVs0A"), "topic", 340),
  ),
  map(
    "76FD7956-0732-4F83-A6F0-DE21C07CE293",
    "Library Tapes",
    v("R850HNDA-yY", "Library Tapes: Fall", "Library Tapes - Topic", TOPIC("UCnzqyBYB5cgA9Pbwe7qEgqg"), "topic", 124),
    [v("uja-wLfRyUg", "Library Tapes: Contemplate", "Library Tapes - Topic", TOPIC("UCnzqyBYB5cgA9Pbwe7qEgqg"), "topic", 157)],
  ),
  {
    qlooArtistId: "75AE7DFF-0996-4522-BAEE-064A5CB73FD0",
    artistName: "Poppy Ackroyd",
    review: "NEEDS_REVIEW",
    reviewReason: "Only a self-described artist channel was found (no Topic, VEVO or label upload); identity not independently established.",
    primary: v("vWW9knyjU7U", "Poppy Ackroyd - Stillness (Official Video)", "Poppy Ackroyd Music", "https://www.youtube.com/@poppyackroydmusic2394", "artist_self_described", 297),
    alternates: [],
    moments: [],
  },
];

const BY_ID = new Map(REVIEWED_MAPPINGS.map((m) => [m.qlooArtistId, m]));

export function reviewedMappingFor(qlooArtistId: string): ReviewedMapping | undefined {
  return BY_ID.get(qlooArtistId);
}
