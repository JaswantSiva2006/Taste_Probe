"use client";

import type { ArtistIntent, ListeningAction, ListeningView } from "@/lib/contracts";
import { YouTubePlayer } from "./YouTubePlayer";

/**
 * S9.12 listening session (minimal controls; S9.13 owns the final experience).
 * Everything shown comes from the server's listening projection: the recording is the
 * one the server presented, and every action names that exact artist/recording pair.
 * The player gets only that recording, so a client-side failover can never make the
 * page play something the server would not accept feedback for.
 */

type Props = {
  listening: ListeningView;
  busy: boolean;
  pending: boolean;
  onAction: (action: ListeningAction, intent?: ArtistIntent) => void;
  onListen: (artistId?: string) => void;
};

const SELECTION_COPY: Record<string, string> = {
  GEMINI: "TasteProbe’s agent picked this from {n} verified recordings using only your reactions and answers. It hasn’t heard the music.",
  DETERMINISTIC: "The first verified recording you haven’t heard yet.",
  SINGLE_OPTION: "This is the only verified recording TasteProbe has for this artist.",
};

const NOTICE_COPY: Record<string, string> = {
  recording_disliked_choose_next: "Noted: not this recording. That isn’t held against the artist. Try another song, a different artist, or keep listening.",
  only_one_verified_song: "This artist has only one verified recording, so there’s no other song to offer. Try a different artist.",
  no_other_unheard_song: "You’ve heard every other verified recording of this artist. Try a different artist.",
  no_other_artist: "There’s no other artist with a verified recording left in this exploration.",
  no_verified_song_in_next_artists: "The next few artists have no verified recording yet. Try again to keep looking.",
  skipped_artist_without_verified_song: "Skipped an artist with no verified recording yet.",
  no_verified_song: "TasteProbe hasn’t verified a recording for this artist yet. The recommendation still stands.",
  all_recordings_disliked: "You turned down every verified recording of this artist.",
  saved: "Saved this recording.",
  already_saved: "Already saved.",
  finished: "Listening finished.",
  finished_without_saves: "Listening finished. Nothing was saved, and that’s fine.",
};

const searchUrl = (name: string) => `https://www.youtube.com/results?${new URLSearchParams({ search_query: name.slice(0, 120) })}`;

export function ListeningSession({ listening: l, busy, pending, onAction, onListen }: Props) {
  const savedHere = l.video ? l.saved.some((s) => s.video.videoId === l.video!.videoId) : false;
  const notice = l.notice ? NOTICE_COPY[l.notice] : null;
  const selection = l.selection ? SELECTION_COPY[l.selection.mode]?.replace("{n}", String(l.selection.eligibleCount)) : null;
  const button = (label: string, action: ListeningAction, opts: { intent?: ArtistIntent; primary?: boolean; pressed?: boolean; disabled?: boolean } = {}) => (
    <button
      type="button"
      className={`tp-btn ${opts.primary ? "tp-btn--ink-solid" : "tp-btn--ink"} tp-btn--sm`}
      disabled={busy || opts.disabled}
      aria-pressed={opts.pressed}
      onClick={() => onAction(action, opts.intent)}
    >
      {label}
    </button>
  );

  return (
    <section className="tp-listen tp-listen--session" aria-labelledby="tp-listen-title" aria-busy={pending}>
      <div className="tp-listen__head">
        <p className="tp-listen__kicker">
          {l.status === "finished" ? "Listening finished" : `Listening · artist ${Math.max(1, l.artistsVisited)}`}
        </p>
        <h2 className="tp-listen__title" id="tp-listen-title" tabIndex={-1}>
          {l.artist?.name ?? "Your listening session"}
        </h2>
        {l.video ? <p className="tp-listen__note">Qloo recommended the artist. The recording is a YouTube video TasteProbe checked is by them; Qloo didn’t choose the song.</p> : null}
        {selection && l.status !== "finished" ? <p className="tp-listen__note">{selection}</p> : null}
      </div>

      <p className="tp-listen__status" role="status" aria-live="polite">
        {pending ? "Updating your listening…" : (notice ?? "")}
      </p>

      {l.status === "finished" ? (
        <div className="tp-listen__summary">
          <p>
            {l.saved.length ? `You saved ${l.saved.length} recording${l.saved.length === 1 ? "" : "s"}` : "You didn’t save anything"} after {l.history.length} recording
            {l.history.length === 1 ? "" : "s"} from {l.artistsVisited} artist{l.artistsVisited === 1 ? "" : "s"}.
          </p>
          {l.saved.length ? (
            <ul className="tp-listen__saved">
              {l.saved.map((s) => (
                <li key={s.video.videoId}>
                  <a href={s.video.watchUrl} target="_blank" rel="noopener noreferrer">
                    {s.video.title}
                  </a>{" "}
                  · {s.artist.name}
                </li>
              ))}
            </ul>
          ) : null}
          <button type="button" className="tp-btn tp-btn--ink tp-btn--sm" disabled={busy} onClick={() => onListen()}>
            Keep listening
          </button>
        </div>
      ) : l.video && l.artist ? (
        <>
          <YouTubePlayer key={l.video.videoId} artistName={l.artist.name} videos={[l.video]} moment={null} fallbackUrl={searchUrl(l.artist.name)} fallbackLabel={`Search for ${l.artist.name} on YouTube`} />
          <div className="tp-listen__controls" role="group" aria-label={`Your reaction to ${l.video.title}`}>
            {button("Love this song", "LOVE", { primary: true, pressed: l.currentFeedback === "love" })}
            {button("Not for me", "NOT_FOR_ME", { pressed: l.currentFeedback === "not_for_me" })}
            {button(savedHere ? "Saved" : "Save this recording", "SAVE", { disabled: savedHere, pressed: savedHere })}
          </div>
          <div className="tp-listen__controls" role="group" aria-label="What next">
            {button("Another song", "ANOTHER_SONG")}
            {button("Different artist", "DIFFERENT_ARTIST")}
            {button("Next", "NEXT")}
            {button("Finish listening", "FINISH")}
          </div>
          <div className="tp-listen__controls" role="group" aria-label={`About ${l.artist.name}`}>
            {button(`More like ${l.artist.name}`, "LOVE", { intent: "LIKE_ARTIST" })}
            {button(`Not ${l.artist.name}`, "DIFFERENT_ARTIST", { intent: "NOT_THIS_ARTIST" })}
          </div>
        </>
      ) : (
        <div className="tp-listen__fallback">
          {l.artist ? (
            <p>
              <a href={searchUrl(l.artist.name)} target="_blank" rel="noopener noreferrer">
                Search for {l.artist.name} on YouTube
              </a>{" "}
              (results there aren’t checked by TasteProbe).
            </p>
          ) : null}
          <button type="button" className="tp-btn tp-btn--ink tp-btn--sm" disabled={busy} onClick={() => onListen()}>
            Try the next artist
          </button>
        </div>
      )}

      {l.history.length && l.status !== "finished" ? (
        <details className="tp-listen__history">
          <summary>Heard so far ({l.history.length})</summary>
          <ol>
            {l.history.map((h, i) => (
              <li key={`${h.videoId}-${i}`}>
                {h.title} · {h.artistName}
                {h.feedback === "love" ? " · loved" : h.feedback === "not_for_me" ? " · not for me" : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
