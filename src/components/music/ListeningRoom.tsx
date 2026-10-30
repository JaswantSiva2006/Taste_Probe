"use client";

import { useEffect, useRef, useState } from "react";
import { ApiClientError, api } from "@/lib/api-client";
import type { MusicResolution } from "@/lib/contracts";
import { YouTubePlayer } from "./YouTubePlayer";

/**
 * S9.9 listening room: one player for the artist the user chose to hear. The video
 * comes from the server (`/api/music/resolve`); the client only names the artist.
 * Responses for an artist that is no longer selected are dropped, so a slow lookup
 * can never replace the current artist's player.
 */

type Props = {
  sessionToken: string;
  artist: { entityId: string; name: string } | null;
};

/** A settled lookup, tagged with the request it answers (artist + attempt). */
type Load =
  | { kind: "done"; key: string; result: MusicResolution }
  | { kind: "error"; key: string; message: string };

const UNAVAILABLE_COPY: Record<string, string> = {
  synthetic_artist: "Sample artists have no real recordings, so there is nothing to play.",
  no_reviewed_mapping: "TasteProbe hasn’t verified a YouTube video for this artist yet, and automatic lookup is switched off.",
  no_match: "YouTube had no video we could confirm is by this artist.",
  mapping_stale: "Our check of this artist’s video is out of date, so it isn’t played until it is reviewed again.",
  artist_name_mismatch: "The verified video no longer matches this artist’s name, so it isn’t played.",
  youtube_quota_exhausted: "TasteProbe’s video-lookup allowance is used up for now (for this exploration or for today).",
};

function explain(result: MusicResolution): string {
  if (result.reason && UNAVAILABLE_COPY[result.reason]) return UNAVAILABLE_COPY[result.reason]!;
  if (result.status === "NEEDS_REVIEW") return "A possible video was found, but it isn’t confirmed to be by this artist, so TasteProbe won’t play it.";
  if (result.status === "UPSTREAM_FAILURE") return "YouTube didn’t answer in time.";
  return "No verified video is available for this artist.";
}

export function ListeningRoom({ sessionToken, artist }: Props) {
  const [load, setLoad] = useState<Load | null>(null);
  const [attempt, setAttempt] = useState(0);
  const tokenRef = useRef(sessionToken);
  useEffect(() => {
    tokenRef.current = sessionToken;
  }, [sessionToken]);
  const artistId = artist?.entityId ?? null;
  const key = `${artistId}:${attempt}`;

  useEffect(() => {
    if (!artistId) return;
    let current = true;
    const requestKey = `${artistId}:${attempt}`;
    api
      .resolveMusic(tokenRef.current, artistId)
      .then(({ data }) => {
        if (current && data.artist.entityId === artistId) setLoad({ kind: "done", key: requestKey, result: data });
      })
      .catch((error: unknown) => {
        if (!current) return;
        const code = error instanceof ApiClientError ? error.code : "NETWORK_ERROR";
        const message =
          code === "RATE_LIMITED" ? "Too many video lookups just now. Wait a moment, then try again."
          : code === "SESSION_EXPIRED" ? "This exploration has expired, so videos can’t be looked up any more."
          : code === "ARTIST_NOT_IN_EXPLORATION" ? "That artist is no longer part of this exploration."
          : "Couldn’t reach TasteProbe to find a video.";
        setLoad({ kind: "error", key: requestKey, message });
      });
    return () => {
      current = false;
    };
  }, [artistId, attempt]);

  if (!artist) return null;
  // Anything not answering the current request is stale: show "finding" instead.
  const mine = load?.key === key ? load : null;

  return (
    <section className="tp-listen" aria-labelledby="tp-listen-title">
      <div className="tp-listen__head">
        <p className="tp-listen__kicker">Listen</p>
        <h2 className="tp-listen__title" id="tp-listen-title" tabIndex={-1}>
          {artist.name}
        </h2>
        {mine?.kind === "done" && mine.result.status === "RESOLVED" ? (
          <p className="tp-listen__note">Qloo recommended the artist. The recording is a YouTube video TasteProbe checked is by them; Qloo didn’t choose the song.</p>
        ) : null}
      </div>

      {!mine ? (
        <p className="tp-listen__status" role="status">
          Finding a verified video for {artist.name}…
        </p>
      ) : null}

      {mine?.kind === "error" ? (
        <div className="tp-listen__fallback" role="alert">
          <p>{mine.message}</p>
          <button type="button" className="tp-btn tp-btn--ink tp-btn--sm" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : null}

      {mine?.kind === "done" && mine.result.status === "RESOLVED" && mine.result.video ? (
        <YouTubePlayer
          key={artist.entityId}
          artistName={artist.name}
          videos={[mine.result.video, ...mine.result.alternates]}
          moment={mine.result.featuredMoment}
          fallbackUrl={mine.result.fallback.url}
          fallbackLabel={mine.result.fallback.label}
        />
      ) : null}

      {mine?.kind === "done" && mine.result.status !== "RESOLVED" ? (
        <div className="tp-listen__fallback" data-resolution={mine.result.status}>
          <p>
            {explain(mine.result)} {artist.name} is still a verified pick from Qloo.
          </p>
          {mine.result.reason === "synthetic_artist" ? null : (
          <p>
            <a href={mine.result.fallback.url} target="_blank" rel="noopener noreferrer">
              {mine.result.fallback.label}
            </a>{" "}
            (opens YouTube search; results there aren’t checked by TasteProbe), or choose another artist below.
          </p>
          )}
          {mine.result.status === "RATE_LIMITED" || mine.result.status === "UPSTREAM_FAILURE" ? (
            <button type="button" className="tp-btn tp-btn--ink tp-btn--sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
