"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtistIntent, DiscoveryView, ListeningAction } from "@/lib/contracts";
import { resolvePath } from "@/lib/ui/presentation";
import { EntityArt } from "../EntityArt";
import {
  AnotherSong,
  ArrowRight,
  DifferentArtist,
  Excerpt,
  ExternalLink,
  FullTrack,
  Heart,
  NotForMe,
  PassportIcon,
  Pause,
  Play,
  Refresh,
  Replay,
  Rewind10,
  SkipBack,
  SkipForward,
  Stamp,
} from "../Icons";
import { VinylDisc, type VinylState } from "./VinylDisc";
import { clock, rangeLabel } from "@/lib/ui/preview-guard";
import { YouTubePlayer, type PlaybackState, type PlayerHandle, type PlayerPhase } from "./YouTubePlayer";

/**
 * S9.13 Listening Stage — the music journey's main event.
 * Layers kept honest and visible: Qloo suggested the ARTIST, TasteProbe picked a
 * VERIFIED RECORDING (YouTube, official player), the USER decides what to keep.
 * Server actions use the S9.12 routes unchanged; transport uses supported IFrame API
 * calls only. The vinyl follows the real player phase; it never stands in for it.
 */

type Props = {
  view: DiscoveryView;
  busy: boolean;
  pending: boolean;
  passportCount: number;
  onListen: (artistId?: string, videoId?: string) => void;
  onAction: (action: ListeningAction, intent?: ArtistIntent) => void;
  onOpenPassport: () => void;
};

const SELECTION_COPY: Record<string, string> = {
  GEMINI: "TasteProbe’s agent chose this from {n} verified recordings, using only your reactions and answers. It hasn’t heard the music.",
  DETERMINISTIC: "The first verified recording of this artist you haven’t heard yet.",
  SINGLE_OPTION: "The only verified recording TasteProbe has for this artist so far.",
  USER_REPLAY: "Back to a recording you heard earlier.",
};

const NOTICE_COPY: Record<string, string> = {
  only_one_verified_song: "This artist has one verified recording so far, so there’s no other song to offer yet. Try a different artist.",
  no_other_unheard_song: "You’ve heard every other verified recording of this artist. Try a different artist.",
  no_other_artist: "There’s no other artist with a verified recording left in this exploration.",
  no_verified_song_in_next_artists: "The next few artists don’t have a verified recording yet. Try again to keep looking.",
  skipped_artist_without_verified_song: "Skipped an artist who doesn’t have a verified recording yet.",
  already_saved: "Already in your Sound Passport.",
  all_recordings_disliked: "You passed on every verified recording of this artist.",
};

const searchUrl = (name: string) => `https://www.youtube.com/results?${new URLSearchParams({ search_query: name.slice(0, 120) })}`;

function vinylState(phase: PlayerPhase | null, previewEnded = false): VinylState {
  if (previewEnded) return "idle";
  if (phase === "playing") return "playing";
  if (phase === "paused") return "paused";
  if (phase === "buffering") return "buffering";
  if (phase === "failed") return "failed";
  return "idle";
}

export function ListeningStage({ view, busy, pending, passportCount, onListen, onAction, onOpenPassport }: Props) {
  const l = view.listening;
  const player = useRef<PlayerHandle>(null);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const phase = playback?.phase ?? null;
  const [confirm, setConfirm] = useState<{ key: string; text: string } | null>(null);
  const lastAction = useRef<{ action: ListeningAction; intent?: ArtistIntent; revision: number } | null>(null);
  const onPlayback = useCallback((s: PlaybackState) => setPlayback(s), []);

  // Truthful confirmation: shown only once the server's new state has arrived.
  useEffect(() => {
    const a = lastAction.current;
    if (!a || !l || view.revision === a.revision) return;
    lastAction.current = null;
    const text =
      a.action === "LOVE" && a.intent === "LIKE_ARTIST" ? `Noted: more like ${l.artist?.name ?? "this artist"}. That steers which artists come next.`
      : a.action === "LOVE" ? "Loved. Remembered for this recording only."
      : l.notice === "saved" ? "Stamped into your Sound Passport."
      : null;
    if (text) setConfirm({ key: `${view.revision}`, text });
  }, [view.revision, l]);

  const act = (action: ListeningAction, intent?: ArtistIntent) => {
    lastAction.current = { action, intent, revision: view.revision };
    setConfirm(null);
    onAction(action, intent);
  };

  const recs = view.recommendations;
  const path = resolvePath(view);
  const lead = path?.featured[0]?.rec ?? recs[0];
  const artistRec = l?.artist ? recs.find((r) => r.candidate.entityId === l.artist!.entityId) : undefined;
  const why =
    path?.featured.find((f) => f.item.recommendationEntityId === l?.artist?.entityId)?.item.explanation.text ??
    (l?.artist ? `Qloo returned ${l.artist.name} among music artists connected to “${view.seed.name}”.` : null);

  // ---------------------------------------------------------------- before listening
  if (!l) {
    const others = recs.filter((r) => r.candidate.entityId !== lead?.candidate.entityId).slice(0, 4);
    return (
      <section className="sp-stage sp-stage--intro tp-listen" aria-labelledby="tp-listen-title" aria-busy={pending}>
        <Journey seed={view.seed.name} artist={lead?.candidate.name} recording={null} />
        <div className="sp-intro">
          <div className="sp-intro__disc">
            <VinylDisc state="idle" seed={lead?.candidate.entityId ?? view.seed.entityId} artist={lead?.candidate.name ?? "Sound Passport"} title={`From ${view.seed.name}`} size="lg" />
          </div>
          <div className="sp-intro__copy">
            <p className="sp-kicker">Ready for your first listen</p>
            <h2 className="sp-intro__title" id="tp-listen-title" tabIndex={-1}>
              {lead ? (
                <>
                  Start with <em>{lead.candidate.name}</em>
                </>
              ) : (
                "Start listening"
              )}
            </h2>
            <p className="sp-intro__lede">
              Qloo found these artists from <strong>{view.seed.name}</strong>. TasteProbe plays a verified recording of each through YouTube’s own player. Love it, pass on it, or keep what moves you.
            </p>
            <div className="sp-intro__actions">
              <button type="button" className="sp-btn sp-btn--primary" disabled={busy || !lead} onClick={() => onListen(lead?.candidate.entityId)}>
                <Play size={18} /> Begin listening
              </button>
              {passportCount ? (
                <button type="button" className="sp-btn sp-btn--quiet" onClick={onOpenPassport}>
                  <PassportIcon size={18} /> Your Passport · {passportCount}
                </button>
              ) : null}
            </div>
            {others.length ? (
              <div className="sp-intro__others">
                <p className="sp-label">Or begin with</p>
                <ul>
                  {others.map((r) => (
                    <li key={r.candidate.entityId}>
                      <button type="button" className="sp-chip" disabled={busy} onClick={() => onListen(r.candidate.entityId)} aria-label={`Begin listening with ${r.candidate.name}`}>
                        {r.candidate.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
        <p className="tp-sr" role="status" aria-live="polite">
          {pending ? "Finding a verified recording…" : ""}
        </p>
      </section>
    );
  }

  // ---------------------------------------------------------------- finished
  if (l.status === "finished") {
    return (
      <section className="sp-stage sp-stage--done tp-listen" aria-labelledby="tp-listen-title">
        <div className="sp-done">
          <div className="sp-done__disc">
            <VinylDisc state="idle" seed={view.seed.entityId} artist={view.seed.name} title="Session complete" size="md" tonearm={false} />
          </div>
          <div>
            <p className="sp-kicker">Listening session complete</p>
            <h2 className="sp-done__title" id="tp-listen-title" tabIndex={-1}>
              {l.saved.length ? `${l.saved.length} recording${l.saved.length === 1 ? "" : "s"} kept from ${view.seed.name}.` : `A listen through ${view.seed.name}.`}
            </h2>
            <p className="sp-done__lede">
              You heard {l.history.length} recording{l.history.length === 1 ? "" : "s"} from {l.artistsVisited} artist{l.artistsVisited === 1 ? "" : "s"}.{" "}
              {l.saved.length ? "Everything you saved is in your Sound Passport on this device." : "Nothing was saved, and that’s fine: not every listen has to be a keeper."}
            </p>
            <div className="sp-intro__actions">
              <button type="button" className="sp-btn sp-btn--primary" onClick={onOpenPassport}>
                <PassportIcon size={18} /> Open your Sound Passport
              </button>
              <button type="button" className="sp-btn sp-btn--quiet" disabled={busy} onClick={() => onListen()}>
                Keep listening
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // ---------------------------------------------------------------- no verified recording
  if (!l.video || !l.artist) {
    return (
      <section className="sp-stage tp-listen" aria-labelledby="tp-listen-title" aria-busy={pending}>
        <Journey seed={view.seed.name} artist={l.artist?.name} recording={null} />
        <div className="sp-empty">
          <VinylDisc state="failed" seed={l.artist?.entityId ?? "none"} artist={l.artist?.name ?? "—"} size="sm" tonearm={false} />
          <div>
            <h2 className="sp-empty__title" id="tp-listen-title" tabIndex={-1}>
              We couldn’t verify a recording for {l.artist?.name ?? "this artist"}
            </h2>
            <p>This doesn’t mean their music is unavailable. We couldn’t confirm a playable YouTube recording belongs to this artist. Try another artist here, or look for their music on YouTube.</p>
            <div className="sp-intro__actions">
              <button type="button" className="sp-btn sp-btn--primary" disabled={busy} onClick={() => onListen()}>
                <DifferentArtist size={18} /> Try the next artist
              </button>
              {l.artist ? (
                <a className="sp-btn sp-btn--quiet" href={searchUrl(l.artist.name)} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={16} /> Find their music on YouTube
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    );
  }

  // ---------------------------------------------------------------- listening
  const video = l.video;
  const artist = l.artist;
  const playing = phase === "playing" || phase === "buffering";
  const canTransport = phase !== null && phase !== "loading" && phase !== "failed";
  const songNumber = l.history.filter((h) => h.artistId === artist.entityId).length;
  const savedHere = l.saved.some((s) => s.video.videoId === video.videoId);
  const loved = l.currentFeedback === "love";
  const passed = l.currentFeedback === "not_for_me";
  const prev = [...l.history].reverse().find((h) => h.videoId !== video.videoId);
  const selection = l.selection ? SELECTION_COPY[l.selection.mode]?.replace("{n}", String(l.selection.eligibleCount)) : null;
  const preview = l.preview && l.preview.videoId === video.videoId ? l.preview : null;
  const mode = playback?.mode ?? (preview ? "preview" : "full");
  const previewEnded = Boolean(playback?.previewEnded);
  const notice = l.notice ? NOTICE_COPY[l.notice] : null;

  return (
    <section className="sp-stage tp-listen" aria-labelledby="tp-listen-title" aria-busy={pending}>
      <Journey seed={view.seed.name} artist={artist.name} recording={video.title} />
      <div className="sp-stage__grid">
        <div className="sp-stage__main">
          <div className="sp-now" key={video.videoId}>
            <p className="sp-kicker">
              Now listening · artist {Math.max(1, l.artistsVisited)} · recording {Math.max(1, songNumber)}
            </p>
            <h2 className="sp-now__title" id="tp-listen-title" tabIndex={-1}>
              {video.title}
            </h2>
            <p className="sp-now__artist">
              <span className="sp-now__name">{artist.name}</span>
              <span className="sp-now__source">
                via {video.channelTitle} on YouTube
              </span>
            </p>
            {selection ? <p className="sp-now__how">{selection}</p> : null}
          </div>

          <div className="sp-screen">
            <YouTubePlayer
              key={video.videoId}
              controlsRef={player}
              onPlayback={onPlayback}
              artistName={artist.name}
              videos={[{ ...video }]}
              preview={preview ? { startSeconds: preview.startSeconds, endSeconds: preview.endSeconds } : null}
              fallbackUrl={searchUrl(artist.name)}
              fallbackLabel={`Search for ${artist.name} on YouTube`}
            />
          </div>

          <ListenModes
            preview={preview}
            durationSeconds={video.durationSeconds ?? null}
            mode={mode}
            previewEnded={previewEnded}
            phase={phase}
            disabled={!canTransport}
            onPreview={() => player.current?.playPreview()}
            onFull={() => player.current?.playFull()}
          />

          <div className="sp-transport" role="group" aria-label="Playback">
            <button type="button" className="sp-tbtn" disabled={busy || !prev} onClick={() => prev && onListen(prev.artistId, prev.videoId)} aria-label={prev ? `Previous recording: ${prev.title}` : "No previous recording"} title="Previous recording">
              <SkipBack size={22} />
            </button>
            <button type="button" className="sp-tbtn" disabled={!canTransport || phase === "ready"} onClick={() => player.current?.rewind(10)} aria-label="Back 10 seconds" title="Back 10 seconds">
              <Rewind10 size={24} />
            </button>
            <button type="button" className="sp-tbtn sp-tbtn--play" disabled={!canTransport} onClick={() => player.current?.toggle()} aria-label={playing ? "Pause" : phase === "paused" && !previewEnded ? "Resume" : mode === "preview" ? "Play preview" : "Play"}>
              {playing ? <Pause size={26} /> : <Play size={26} />}
            </button>
            <button type="button" className="sp-tbtn" disabled={!canTransport} onClick={() => player.current?.replay()} aria-label={mode === "preview" ? "Replay the preview" : "Replay from the start"} title={mode === "preview" ? "Replay the preview" : "Replay from the start"}>
              <Replay size={24} />
            </button>
            <button type="button" className="sp-tbtn" disabled={busy} onClick={() => act("NEXT")} aria-label="Next recording (no rating)" title="Next recording">
              <SkipForward size={22} />
            </button>
            <span className="sp-transport__state" aria-hidden="true">
              {previewEnded ? "Preview finished" : phase === "playing" ? (mode === "preview" ? "Previewing" : "Playing") : phase === "paused" ? "Paused" : phase === "buffering" ? "Loading…" : phase === "failed" ? "Unavailable" : phase === "ended" ? "Ended" : "Ready"}
            </span>
            <a className="sp-transport__yt" href={video.watchUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} /> Open on YouTube
            </a>
          </div>

          <div className="sp-react" role="group" aria-label={`Your reaction to ${video.title}`}>
            <button type="button" className="sp-react__btn sp-react__btn--love" aria-pressed={loved} disabled={busy} onClick={() => act("LOVE")}>
              <Heart size={20} filled={loved} /> {loved ? "Loved" : "Love"}
            </button>
            <button type="button" className="sp-react__btn" aria-pressed={passed} disabled={busy} onClick={() => act("NOT_FOR_ME")}>
              <NotForMe size={20} /> Not for me
            </button>
            <button type="button" className="sp-react__btn sp-react__btn--save" aria-pressed={savedHere} disabled={busy || savedHere} onClick={() => act("SAVE")}>
              <Stamp size={20} /> {savedHere ? "In your Passport" : "Save to Passport"}
            </button>
          </div>

          {l.notice === "recording_disliked_choose_next" ? (
            <div className="sp-followup" role="status">
              <p>
                <strong>Not this one — no problem.</strong> That’s about this recording only, not {artist.name}.
              </p>
              <div className="sp-followup__actions">
                <button type="button" className="sp-chip" disabled={busy} onClick={() => act("ANOTHER_SONG")}>
                  Another {artist.name} song
                </button>
                <button type="button" className="sp-chip" disabled={busy} onClick={() => act("DIFFERENT_ARTIST")}>
                  A different artist
                </button>
                <button type="button" className="sp-chip sp-chip--quiet" disabled={busy} onClick={() => act("NEXT")}>
                  Not sure — just keep going
                </button>
              </div>
            </div>
          ) : null}

          <p className="sp-feedback" role="status" aria-live="polite">
            {pending ? <span className="sp-feedback__pending"><Refresh size={14} className="tp-spin" /> Updating…</span> : confirm ? <span key={confirm.key} className="sp-feedback__ok">{confirm.text}</span> : notice ? <span>{notice}</span> : null}
          </p>

          <div className="sp-move" role="group" aria-label="Where next">
            <button type="button" className="sp-move__btn" disabled={busy} onClick={() => act("ANOTHER_SONG")}>
              <AnotherSong size={22} />
              <span>
                <strong>Another song</strong>
                <small>by {artist.name}</small>
              </span>
            </button>
            <button type="button" className="sp-move__btn" disabled={busy} onClick={() => act("DIFFERENT_ARTIST")}>
              <DifferentArtist size={22} />
              <span>
                <strong>Different artist</strong>
                <small>from your {view.seed.name} journey</small>
              </span>
            </button>
          </div>
        </div>

        <aside className="sp-stage__side" aria-label="About this listen">
          <div className="sp-deck">
            <VinylDisc key={video.videoId} state={vinylState(phase, previewEnded)} seed={artist.entityId} artist={artist.name} title={video.title} size="lg" />
          </div>

          <div className="sp-artist">
            <div className="sp-artist__head">
              {artistRec ? (
                <EntityArt id={artistRec.candidate.entityId} name={artistRec.candidate.name} domain="music_artist" imageUrl={artistRec.candidate.imageUrl} size="sm" />
              ) : null}
              <div>
                <p className="sp-label">Artist suggested by Qloo</p>
                <p className="sp-artist__name">{artist.name}</p>
              </div>
            </div>
            {why ? (
              <details className="sp-why">
                <summary>Why this artist?</summary>
                <p>{why}</p>
                <p className="sp-why__note">Qloo suggested the artist; TasteProbe picked this verified recording; you decide what to keep.</p>
              </details>
            ) : null}
            <div className="sp-artist__intent" role="group" aria-label={`Tell TasteProbe about ${artist.name} as an artist`}>
              <button type="button" className="sp-chip" disabled={busy} onClick={() => act("LOVE", "LIKE_ARTIST")}>
                More like this artist
              </button>
              <button type="button" className="sp-chip sp-chip--quiet" disabled={busy} onClick={() => act("DIFFERENT_ARTIST", "NOT_THIS_ARTIST")}>
                Not this artist
              </button>
            </div>
          </div>

          <div className="sp-ledger">
            <button type="button" className="sp-ledger__passport" onClick={onOpenPassport}>
              <PassportIcon size={20} />
              <span>
                <strong>{passportCount}</strong> in your Sound Passport
              </span>
              <ArrowRight size={16} />
            </button>
            <p className="sp-ledger__meta">
              {l.history.length} heard · {l.artistsVisited} artist{l.artistsVisited === 1 ? "" : "s"} · from {view.seed.name}
            </p>
            {l.history.length > 1 ? (
              <details className="sp-history">
                <summary>Heard so far</summary>
                <ol>
                  {l.history.map((h, i) => (
                    <li key={`${h.videoId}-${i}`}>
                      <span>{h.title}</span> <small>{h.artistName}{h.feedback === "love" ? " · loved" : h.feedback === "not_for_me" ? " · passed" : ""}</small>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            <button type="button" className="sp-btn sp-btn--quiet sp-btn--block" disabled={busy} onClick={() => act("FINISH")}>
              Finish listening
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}

/** From your starting point → Qloo's artist → the verified recording. Real names only. */
function Journey({ seed, artist, recording }: { seed: string; artist?: string; recording: string | null }) {
  return (
    <ol className="sp-journey" aria-label="Your listening journey">
      <li>
        <span className="sp-journey__k">From</span>
        <span className="sp-journey__v">{seed}</span>
      </li>
      <li data-on={artist ? "true" : "false"}>
        <span className="sp-journey__k">Qloo’s artist</span>
        <span className="sp-journey__v">{artist ?? "—"}</span>
      </li>
      <li data-on={recording ? "true" : "false"}>
        <span className="sp-journey__k">Verified recording</span>
        <span className="sp-journey__v">{recording ?? "Not chosen yet"}</span>
      </li>
    </ol>
  );
}

/**
 * S9.15 Preview / Full. Truthful labels only: "Quick preview" is a timed excerpt with no
 * claim about the music; "Featured preview" is a window a person reviewed. Switching
 * modes is local playback only: it never reaches the server and is never feedback.
 */
function ListenModes({
  preview,
  durationSeconds,
  mode,
  previewEnded,
  phase,
  disabled,
  onPreview,
  onFull,
}: {
  preview: NonNullable<DiscoveryView["listening"]>["preview"];
  durationSeconds: number | null;
  mode: "preview" | "full";
  previewEnded: boolean;
  phase: PlayerPhase | null;
  disabled: boolean;
  onPreview: () => void;
  onFull: () => void;
}) {
  const full = durationSeconds ? clock(durationSeconds) : null;
  if (!preview) {
    return (
      <div className="sp-modes sp-modes--single">
        <p className="sp-modes__note">
          <FullTrack size={18} /> Full recording{full ? ` · ${full}` : ""}
          <span>{durationSeconds && durationSeconds < 45 ? "Short enough to hear in full, so there’s no separate preview." : "No verified length for a preview, so it plays in full."}</span>
        </p>
      </div>
    );
  }
  const range = rangeLabel(preview);
  const featured = preview.sourceKind === "REVIEWED_SEGMENT";
  const live = phase === "playing" || phase === "buffering";
  return (
    <div className="sp-modes" role="group" aria-label="How to listen" data-mode={mode}>
      <button type="button" className="sp-mode" aria-pressed={mode === "preview"} disabled={disabled} onClick={onPreview} data-live={mode === "preview" && live ? "true" : "false"}>
        <Excerpt size={20} />
        <span>
          <strong>{previewEnded ? "Replay preview" : "Hear preview"}</strong>
          <small>
            {preview.label} · <span className="sp-mono">{range}</span>
          </small>
        </span>
      </button>
      <button type="button" className="sp-mode" aria-pressed={mode === "full"} disabled={disabled} onClick={onFull} data-live={mode === "full" && live ? "true" : "false"}>
        <FullTrack size={20} />
        <span>
          <strong>Listen in full</strong>
          <small>
            Whole recording{full ? <> · <span className="sp-mono">{full}</span></> : null}
          </small>
        </span>
      </button>
      <p className="sp-modes__note">
        {featured ? "Featured preview: a window a person listened to and approved." : "Quick preview: a 30-second excerpt chosen by timing, not by listening. It isn’t a highlight."}
      </p>
    </div>
  );
}
