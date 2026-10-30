"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { ResolvedVideo } from "@/lib/contracts";
import { GUARD_INTERVAL_MS, isPlayableWindow, previewTick, rewindTarget, type PreviewWindow } from "@/lib/ui/preview-guard";

/**
 * Official YouTube IFrame player (S9.9, external transport S9.13, previews S9.15).
 * - One visible player per mount; the parent remounts it (key) per recording, and the
 *   iframe is destroyed on unmount, so a previous recording (and any preview timer
 *   attached to it) can never keep running.
 * - Nothing plays until the user presses a control; videos are only cued on load.
 * - Native YouTube controls, branding and ads stay intact; every app control sits
 *   outside the embed.
 * - Preview: the server-validated window is cued/loaded with startSeconds/endSeconds.
 *   Because endSeconds stops applying after any seek, a guard samples the player's
 *   own clock while it plays (see preview-guard.ts). A native scrub outside the window
 *   switches to full listening instead of fighting the listener.
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
export type ListenMode = "preview" | "full";
/** What the transport needs to render honestly. `previewEnded`: the window was heard to its end. */
export type PlaybackState = { phase: PlayerPhase; mode: ListenMode; previewEnded: boolean };

/** YouTube's documented onError codes. */
export function errorCopy(code: number): string {
  if (code === 2) return "the video ID was rejected";
  if (code === 5) return "the browser's HTML5 player failed";
  if (code === 100) return "the video was removed or made private";
  if (code === 101 || code === 150 || code === 153) return "the owner doesn't allow it to play here";
  return `YouTube reported error ${code}`;
}

const STATE_PHASE: Record<number, PlayerPhase> = { [-1]: "ready", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "ready" };

type Props = {
  artistName: string;
  /** Primary first, then reviewed alternates for the same artist. */
  videos: ResolvedVideo[];
  /** S9.15 server-validated window of videos[0]; null = full playback only. */
  preview: PreviewWindow | null;
  fallbackUrl: string;
  fallbackLabel: string;
  onPlayback?: (s: PlaybackState) => void;
  controlsRef?: Ref<PlayerHandle>;
};

/** External transport. Every method is a supported YouTube IFrame Player API call. */
export type PlayerHandle = {
  toggle(): void;
  /** Replays the current mode: the preview window, or the recording from the start. */
  replay(): void;
  rewind(seconds: number): void;
  playPreview(): void;
  playFull(): void;
};

export function YouTubePlayer({ artistName, videos, preview, fallbackUrl, fallbackLabel, onPlayback, controlsRef }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const indexRef = useRef(0);
  // Terminal failure: later state events (e.g. from stopVideo) must not revive the player.
  const failedRef = useRef(false);
  /** Increments on every load; a guard tick from an older load is ignored. */
  const loadGen = useRef(0);
  const loadedAt = useRef(0);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<PlayerPhase>("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState<string | null>(null);
  const [reported, setReported] = useState<{ id?: string; title?: string; author?: string }>({});
  const [previewEnded, setPreviewEnded] = useState(false);

  const video = videos[Math.min(index, videos.length - 1)]!;
  // A preview applies only to the recording it was validated for (the primary), inside its duration.
  const windowOk = index === 0 && isPlayableWindow(preview, video.durationSeconds);
  const win = windowOk ? preview : null;
  const [mode, setMode] = useState<ListenMode>(win ? "preview" : "full");
  const modeRef = useRef<ListenMode>(mode);
  const winStart = win?.startSeconds;
  const winEnd = win?.endSeconds;
  const winRef = useRef(win);
  useEffect(() => {
    winRef.current = winStart === undefined || winEnd === undefined ? null : { startSeconds: winStart, endSeconds: winEnd };
  }, [winStart, winEnd]);

  const switchMode = (m: ListenMode) => {
    modeRef.current = m;
    setMode(m);
  };

  const handleError = useCallback(
    (code: number) => {
      const player = playerRef.current;
      loadGen.current += 1;
      try {
        player?.stopVideo();
      } catch {}
      const next = indexRef.current + 1;
      if (player && next < videos.length) {
        indexRef.current = next;
        setIndex(next);
        modeRef.current = "full";
        setMode("full");
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
              // Cue (never play) the preview window, so even YouTube's own play button starts it bounded.
              const w = winRef.current;
              // Controls enable on YouTube's CUED event for that cue, so a quick first press can't race it.
              if (w && modeRef.current === "preview") {
                loadedAt.current = performance.now();
                playerRef.current?.cueVideoById({ videoId: videos[0]!.videoId, startSeconds: w.startSeconds, endSeconds: w.endSeconds });
                return;
              }
              setPhase("ready");
            },
            onStateChange: (e: { data: number }) => {
              if (cancelled || failedRef.current) return;
              const p = playerRef.current;
              const next = STATE_PHASE[e.data] ?? "ready";
              // YouTube enforces endSeconds by ending playback: in preview mode that is the preview's end, not the recording's.
              if (e.data === 0 && modeRef.current === "preview") setPreviewEnded(true);
              if (e.data === 1) setPreviewEnded(false);
              setPhase(next);
              if (e.data === 1 && p) {
                const data = p.getVideoData?.() ?? {};
                setReported({ id: data.video_id, title: data.title, author: data.author });
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
      loadGen.current += 1;
      try {
        playerRef.current?.destroy();
      } catch {}
      playerRef.current = null;
      host.replaceChildren();
    };
    // Mounted once per recording (the parent keys this component); alternates switch inside the same player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onPlayback?.({ phase, mode, previewEnded });
  }, [phase, mode, previewEnded, onPlayback]);

  // Preview boundary guard: runs only while a preview is PLAYING, on the player's own clock.
  useEffect(() => {
    if (phase !== "playing" || mode !== "preview" || winStart === undefined || winEnd === undefined) return;
    const bounds = { startSeconds: winStart, endSeconds: winEnd };
    const gen = loadGen.current;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p || gen !== loadGen.current) return window.clearInterval(id);
      const decision = previewTick(p.getCurrentTime(), bounds, performance.now() - loadedAt.current);
      if (decision === "stop") {
        p.pauseVideo();
        setPreviewEnded(true);
      } else if (decision === "exit_to_full") {
        switchMode("full");
        setNotice("You moved outside the preview, so the full recording is playing now.");
      }
    }, GUARD_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [phase, mode, winStart, winEnd]);

  // Publishes the playback position for tests and assistive diagnostics (no re-render).
  useEffect(() => {
    if (phase !== "playing") return;
    const id = window.setInterval(() => {
      const t = playerRef.current?.getCurrentTime();
      if (rootRef.current && typeof t === "number") rootRef.current.dataset.currentTime = t.toFixed(2);
    }, 500);
    return () => window.clearInterval(id);
  }, [phase]);

  /** Loads the current recording in a mode. Always a direct result of a user's press. */
  const start = (m: ListenMode) => {
    const p = playerRef.current;
    if (!p) return;
    const w = m === "preview" ? winRef.current : null;
    loadGen.current += 1;
    loadedAt.current = performance.now();
    switchMode(w ? "preview" : "full");
    setPreviewEnded(false);
    setNotice(null);
    if (w) p.loadVideoById({ videoId: video.videoId, startSeconds: w.startSeconds, endSeconds: w.endSeconds });
    else p.loadVideoById({ videoId: video.videoId, startSeconds: 0 }); // full: no end bound, never truncated
  };

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (phase === "playing" || phase === "buffering") p.pauseVideo();
    else if (phase === "paused" && !previewEnded) p.playVideo();
    else start(modeRef.current);
  };

  useImperativeHandle(controlsRef, () => ({
    toggle: togglePlay,
    replay: () => start(modeRef.current),
    rewind: (seconds: number) => {
      const p = playerRef.current;
      if (!p || (phase !== "playing" && phase !== "paused" && phase !== "buffering")) return;
      p.seekTo(rewindTarget(p.getCurrentTime(), seconds, modeRef.current === "preview" ? winRef.current : null), true);
    },
    playPreview: () => start("preview"),
    playFull: () => start("full"),
  }));

  const status =
    phase === "loading" ? "Loading the YouTube player…"
    : phase === "failed" ? exhausted ?? "This video can’t play here."
    : previewEnded ? "Preview finished. Replay it, or listen in full."
    : phase === "playing" ? `Playing${mode === "preview" ? " preview" : ""}: ${video.title} · ${video.channelTitle}`
    : phase === "buffering" ? "Loading the video…"
    : phase === "paused" ? "Paused."
    : phase === "ended" ? "Finished. Replay, or choose another recording."
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
      data-preview-start={win?.startSeconds ?? ""}
      data-preview-end={win?.endSeconds ?? ""}
      data-preview-ended={previewEnded ? "true" : "false"}
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
      <p className="tp-sr" role="status" aria-live="polite">
        {notice ?? status}
      </p>
      {notice && phase !== "failed" ? <p className="sp-player__notice">{notice}</p> : null}
    </div>
  );
}
