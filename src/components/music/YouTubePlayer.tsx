"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { FeaturedMoment, ResolvedVideo } from "@/lib/contracts";

/**
 * S9.9 official YouTube IFrame player (adapted from the S9.8 prototype).
 * - One visible player per mount; the parent remounts it (key) per artist, and the
 *   iframe is destroyed on unmount, so a previous artist can never keep playing.
 * - Nothing plays until the user presses a control; videos are only cued on load.
 * - Native YouTube controls, branding and ads stay intact; every app control sits
 *   outside the embed.
 * - Player errors stop the player, then try the next reviewed video for the same
 *   artist, then fall back to an honest YouTube link. The artist is never replaced.
 */

/* Minimal typing of the parts of the IFrame API we use. */
type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  loadVideoById(o: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoData?(): { video_id?: string; title?: string; author?: string };
  destroy(): void;
};
type YTNamespace = {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer;
  PlayerState: { UNSTARTED: -1; ENDED: 0; PLAYING: 1; PAUSED: 2; BUFFERING: 3; CUED: 5 };
};
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API = "https://www.youtube.com/iframe_api";
let apiPromise: Promise<YTNamespace> | null = null;

/** Loads the official IFrame API once per page. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = IFRAME_API;
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      script.remove();
      reject(new Error("iframe_api_failed"));
    };
    document.head.append(script);
  });
  return apiPromise;
}

export type PlayerPhase = "loading" | "ready" | "buffering" | "playing" | "paused" | "ended" | "failed";
type Mode = "full" | "moment";

/** YouTube's documented onError codes. */
export function errorCopy(code: number): string {
  if (code === 2) return "the video ID was rejected";
  if (code === 5) return "the browser's HTML5 player failed";
  if (code === 100) return "the video was removed or made private";
  if (code === 101 || code === 150 || code === 153) return "the owner doesn't allow it to play here";
  return `YouTube reported error ${code}`;
}

const STATE_PHASE: Record<number, PlayerPhase> = { [-1]: "ready", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "ready" };

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

type Props = {
  artistName: string;
  /** Primary first, then reviewed alternates for the same artist. */
  videos: ResolvedVideo[];
  moment: FeaturedMoment | null;
  fallbackUrl: string;
  fallbackLabel: string;
  /** S9.13: the stage renders its own transport outside the embed; the frame and fallback stay. */
  bare?: boolean;
  /** S9.13: real player phase changes (from the IFrame API), e.g. to drive the vinyl. */
  onPhase?: (phase: PlayerPhase) => void;
  /** S9.13: supported IFrame API controls for an external transport. */
  controlsRef?: Ref<PlayerHandle>;
};

/** External transport. Every method is a supported YouTube IFrame Player API call. */
export type PlayerHandle = { toggle(): void; replay(): void; rewind(seconds: number): void };

export function YouTubePlayer({ artistName, videos, moment, fallbackUrl, fallbackLabel, bare = false, onPhase, controlsRef }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const indexRef = useRef(0);
  const modeRef = useRef<Mode>("full");
  // Terminal failure: later state events (e.g. from stopVideo) must not revive the player.
  const failedRef = useRef(false);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<PlayerPhase>("loading");
  const [mode, setMode] = useState<Mode>("full");
  const [notice, setNotice] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [reported, setReported] = useState<{ id?: string; title?: string; author?: string }>({});

  const video = videos[Math.min(index, videos.length - 1)]!;
  // A moment applies only to the video it was reviewed on, inside its real duration.
  const momentOk = Boolean(moment && moment.videoId === video.videoId && (duration === null || moment.endSeconds <= duration));

  const handleError = useCallback(
    (code: number) => {
      const player = playerRef.current;
      try {
        player?.stopVideo();
      } catch {}
      const next = indexRef.current + 1;
      if (player && next < videos.length) {
        indexRef.current = next;
        setIndex(next);
        setDuration(null);
        player.cueVideoById({ videoId: videos[next]!.videoId });
        setNotice(`That video can’t play here (${errorCopy(code)}). Switched to another reviewed video by ${artistName}: press Play.`);
        setPhase("ready");
        return;
      }
      failedRef.current = true;
      setPhase("failed");
      setExhausted(`This video can’t play here: ${errorCopy(code)}.`);
    },
    [artistName, videos],
  );

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    const mountPoint = document.createElement("div");
    host.replaceChildren(mountPoint);
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        playerRef.current = new YT.Player(mountPoint, {
          videoId: videos[0]!.videoId,
          host: "https://www.youtube.com",
          width: "100%",
          height: "100%",
          playerVars: { controls: 1, playsinline: 1, rel: 0, origin: window.location.origin },
          events: {
            onReady: () => {
              if (cancelled || failedRef.current) return;
              setPhase("ready");
              const d = playerRef.current?.getDuration();
              if (d && d > 0) setDuration(d);
            },
            onStateChange: (e: { data: number }) => {
              if (cancelled || failedRef.current) return;
              const p = playerRef.current;
              setPhase(STATE_PHASE[e.data] ?? "ready");
              if (e.data === 1 && p) {
                const data = p.getVideoData?.() ?? {};
                setReported({ id: data.video_id, title: data.title, author: data.author });
                const d = p.getDuration();
                if (d > 0) setDuration(d);
                setNotice(null);
              }
            },
            onError: (e: { data: number }) => {
              if (!cancelled) handleError(e.data);
            },
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setPhase("failed");
        setExhausted("The YouTube player could not load (network or content blocker).");
      });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {}
      playerRef.current = null;
      host.replaceChildren();
    };
    // Mounted once per artist (the parent keys this component); alternates switch inside the same player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onPhase?.(phase);
  }, [phase, onPhase]);

  // Publishes the playback position for tests and assistive diagnostics (no re-render).
  useEffect(() => {
    if (phase !== "playing") return;
    const id = window.setInterval(() => {
      const t = playerRef.current?.getCurrentTime();
      if (rootRef.current && typeof t === "number") rootRef.current.dataset.currentTime = t.toFixed(2);
    }, 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const start = (m: Mode) => {
    const p = playerRef.current;
    if (!p) return;
    modeRef.current = m;
    setMode(m);
    setNotice(null);
    if (m === "moment" && moment && momentOk) {
      p.loadVideoById({ videoId: video.videoId, startSeconds: moment.startSeconds, endSeconds: moment.endSeconds });
    } else {
      p.loadVideoById({ videoId: video.videoId, startSeconds: 0 });
    }
  };

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (phase === "playing" || phase === "buffering") p.pauseVideo();
    else if (phase === "paused") p.playVideo();
    else start("full");
  };

  useImperativeHandle(controlsRef, () => ({
    toggle: togglePlay,
    replay: () => start(modeRef.current),
    rewind: (seconds: number) => {
      const p = playerRef.current;
      if (!p || (phase !== "playing" && phase !== "paused" && phase !== "buffering")) return;
      p.seekTo(Math.max(0, p.getCurrentTime() - seconds), true);
    },
  }));

  const ready = phase !== "loading" && phase !== "failed";
  const playing = phase === "playing" || phase === "buffering";
  const momentLabel = moment ? `${clock(moment.startSeconds)}–${clock(moment.endSeconds)}` : "";

  const status =
    phase === "loading" ? "Loading the YouTube player…"
    : phase === "failed" ? exhausted ?? "This video can’t play here."
    : phase === "playing" ? `Playing${mode === "moment" ? ` ${momentLabel}` : ""}: ${video.title} · ${video.channelTitle}`
    : phase === "buffering" ? "Loading the video…"
    : phase === "paused" ? "Paused."
    : phase === "ended" ? (mode === "moment" ? "That was the moment. Replay it, or play the whole track." : "Finished. Replay, or choose another artist.")
    : "Ready. Nothing plays until you press Play.";

  return (
    <div
      ref={rootRef}
      className="tp-player"
      data-player-phase={phase}
      data-video-id={video.videoId}
      data-reported-video-id={reported.id ?? ""}
      data-reported-title={reported.title ?? ""}
      data-reported-channel={reported.author ?? ""}
      data-mode={mode}
    >
      {phase === "failed" ? (
        <div className="tp-player__fallback" role="alert">
          <p className="tp-player__fallback-title">{exhausted}</p>
          <p>
            {artistName} is still a verified pick from Qloo. You can{" "}
            <a href={video.watchUrl} target="_blank" rel="noopener noreferrer">
              open “{video.title}” on YouTube
            </a>{" "}
            or{" "}
            <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">
              {fallbackLabel.charAt(0).toLowerCase() + fallbackLabel.slice(1)}
            </a>
            , or listen to another artist below.
          </p>
        </div>
      ) : null}
      {/* The embed itself: visible, 16:9, never covered by app UI. Hidden only after a terminal failure. */}
      <div className="tp-player__frame" hidden={phase === "failed"}>
        <div ref={hostRef} className="tp-player__host" />
      </div>
      {bare ? null : (
      <>
      <p className="tp-player__credit">
        <span className="tp-player__track">{video.title}</span>
        <span className="tp-player__channel">
          {video.channelTitle} · on YouTube{index > 0 ? " · reviewed alternate" : ""}
        </span>
      </p>
      <div className="tp-player__controls" role="group" aria-label={`Playback for ${artistName}`}>
        <button type="button" className="tp-btn tp-btn--ink-solid tp-btn--sm" disabled={!ready} onClick={togglePlay}>
          {playing ? "Pause" : phase === "paused" ? "Resume" : "Play"}
        </button>
        {moment && momentOk ? (
          <button type="button" className="tp-btn tp-btn--ink tp-btn--sm" disabled={!ready} onClick={() => start("moment")}>
            {moment.status === "APPROVED" ? `Play featured moment ${momentLabel}` : `Preview unreviewed moment ${momentLabel}`}
          </button>
        ) : null}
        <button type="button" className="tp-btn tp-btn--ink tp-btn--sm" disabled={!ready || phase === "ready"} onClick={() => start(modeRef.current)}>
          Replay
        </button>
        <a className="tp-btn tp-btn--ghost tp-btn--sm" href={video.watchUrl} target="_blank" rel="noopener noreferrer">
          Open on YouTube
        </a>
      </div>
      {moment && momentOk && moment.status === "PENDING_REVIEW" ? (
        <p className="tp-player__review">Review mode: this moment has not been approved by a listener and is never shown to the public.</p>
      ) : null}
      </>
      )}
      <p className={bare ? "tp-sr" : "tp-player__status"} role="status" aria-live="polite">
        {notice ?? status}
      </p>
    </div>
  );
}
