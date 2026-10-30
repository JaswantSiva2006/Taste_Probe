import type { ListeningState, ListeningView, MusicResolution, ResolvedVideo, SongSelection, VerifiedSongOption } from "@/lib/contracts";

/**
 * S9.12 pure listening logic (no I/O). Options come only from a RESOLVED S9.9
 * resolution; every later choice is a subset of those server-issued options.
 */

export const MAX_OPTIONS_PER_ARTIST = 6;
const cap = <T>(list: T[], n: number) => (list.length > n ? list.slice(list.length - n) : list);

export function emptyListening(): ListeningState {
  return {
    version: 1,
    status: "listening",
    currentArtistId: null,
    currentVideoId: null,
    options: [],
    selection: null,
    notice: null,
    visitedArtistIds: [],
    unavailableArtistIds: [],
    encounters: [],
    trackFeedback: [],
    artistFeedback: [],
    navigation: [],
    saved: [],
    geminiSongRequests: 0,
  };
}

const toOption = (artistId: string, v: ResolvedVideo): VerifiedSongOption => ({
  artistId,
  videoId: v.videoId,
  title: v.title,
  channelTitle: v.channelTitle,
  channelKind: v.channelKind,
  provenance: v.provenance,
  watchUrl: v.watchUrl,
  verifiedAt: v.verifiedAt,
  ...(v.durationSeconds ? { durationSeconds: v.durationSeconds } : {}),
});

/** Verified options for one artist: only a RESOLVED result, primary first, deduplicated, bounded. */
export function optionsFrom(resolution: MusicResolution): VerifiedSongOption[] {
  if (resolution.status !== "RESOLVED" || !resolution.video) return [];
  const seen = new Set<string>();
  return [resolution.video, ...resolution.alternates]
    .filter((v) => !seen.has(v.videoId) && seen.add(v.videoId))
    .slice(0, MAX_OPTIONS_PER_ARTIST)
    .map((v) => toOption(resolution.artist.entityId, v));
}

/** Latest track reaction per video (a later LOVE replaces an earlier NOT_FOR_ME and vice versa). */
export function trackReactions(state: ListeningState): Map<string, "love" | "not_for_me"> {
  const out = new Map<string, "love" | "not_for_me">();
  for (const f of state.trackFeedback) out.set(f.videoId, f.action);
  return out;
}

export const seenVideoIds = (state: ListeningState) => new Set(state.encounters.map((e) => e.videoId));

/** Recordings that may be chosen next for this artist: verified, not current, not heard, not disliked. */
export function eligibleOptions(state: ListeningState, options: VerifiedSongOption[], excludeVideoId: string | null): VerifiedSongOption[] {
  const reactions = trackReactions(state);
  const seen = seenVideoIds(state);
  return options.filter((o) => o.videoId !== excludeVideoId && !seen.has(o.videoId) && reactions.get(o.videoId) !== "not_for_me");
}

/**
 * Deterministic selector: verified → unheard → not disliked (already filtered) →
 * reviewed mapping before Data API → registry order. No musical claim is made.
 */
export function deterministicSong(eligible: VerifiedSongOption[]): VerifiedSongOption | null {
  const ranked = eligible
    .map((o, i) => ({ o, i, reviewed: o.provenance === "reviewed_mapping" ? 0 : 1 }))
    .sort((a, b) => a.reviewed - b.reviewed || a.i - b.i);
  return ranked[0]?.o ?? null;
}

/** Artist order for DIFFERENT_ARTIST: the shown programme order, then hidden verified candidates. */
export function nextArtistIds(orderedIds: string[], state: ListeningState, excluded: Set<string>): string[] {
  const visited = new Set(state.visitedArtistIds);
  const unavailable = new Set(state.unavailableArtistIds);
  return orderedIds.filter((id) => !visited.has(id) && !unavailable.has(id) && !excluded.has(id));
}

export function recordEncounter(state: ListeningState, input: { artistId: string; artistName: string; option: VerifiedSongOption; selection: SongSelection; at: number; revision: number }): ListeningState {
  return {
    ...state,
    currentArtistId: input.artistId,
    currentVideoId: input.option.videoId,
    selection: input.selection,
    visitedArtistIds: state.visitedArtistIds.includes(input.artistId) ? state.visitedArtistIds : cap([...state.visitedArtistIds, input.artistId], 100),
    encounters: cap([...state.encounters, { artistId: input.artistId, artistName: input.artistName, videoId: input.option.videoId, title: input.option.title, at: input.at, revision: input.revision, selection: input.selection.mode }], 100),
  };
}

export function withTrackFeedback(state: ListeningState, entry: ListeningState["trackFeedback"][number]): ListeningState {
  return { ...state, trackFeedback: cap([...state.trackFeedback, entry], 100) };
}

export function withArtistFeedback(state: ListeningState, entry: ListeningState["artistFeedback"][number]): ListeningState {
  return { ...state, artistFeedback: cap([...state.artistFeedback, entry], 100) };
}

export function withNavigation(state: ListeningState, entry: ListeningState["navigation"][number]): ListeningState {
  return { ...state, navigation: cap([...state.navigation, entry], 200) };
}

/** Client projection. Names come from the session's verified candidates. */
export function listeningViewOf(state: ListeningState, artistName: (id: string) => string): ListeningView {
  const reactions = trackReactions(state);
  const current = state.options.find((o) => o.videoId === state.currentVideoId) ?? null;
  const alternates = current ? eligibleOptions(state, state.options, current.videoId) : [];
  const status = state.status === "finished" ? "finished" : current ? "listening" : "no_verified_song";
  return {
    status,
    artist: state.currentArtistId ? { entityId: state.currentArtistId, name: artistName(state.currentArtistId) } : null,
    video: current,
    alternates,
    verifiedSongCount: state.options.length,
    selection: state.selection,
    notice: state.notice,
    currentFeedback: current ? (reactions.get(current.videoId) ?? null) : null,
    artistsVisited: state.visitedArtistIds.length,
    history: state.encounters.slice(-30).map((e) => ({ artistId: e.artistId, artistName: e.artistName, videoId: e.videoId, title: e.title, feedback: reactions.get(e.videoId) ?? null })),
    saved: state.saved,
    geminiSongRequests: state.geminiSongRequests,
  };
}
