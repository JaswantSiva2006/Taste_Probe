import { useId } from "react";

/**
 * S9.13 signature record. Decorative only: never an audio source, never covers the
 * YouTube player. Rotation is pure CSS (33⅓ rpm) toggled by `state`, which the
 * listening stage takes from the real IFrame player phase:
 *   playing → turns and the tonearm rests on the record;
 *   paused → holds its exact angle (animation-play-state: paused);
 *   ready / buffering / failed → still, tonearm lifted;
 *   reduced motion → never turns.
 * The label carries verified text only (Qloo artist name, YouTube recording title).
 */

export type VinylState = "idle" | "playing" | "paused" | "buffering" | "failed";

/** Label stock, chosen deterministically from the artist ID — a print colour, not a claim about the music. */
const LABELS = [
  { paper: "#e9a43b", ink: "#1f160a" }, // valve amber
  { paper: "#c9573f", ink: "#fff3e6" }, // oxblood vermilion
  { paper: "#e8dcc3", ink: "#211a12" }, // ivory
  { paper: "#3f6f6a", ink: "#f2ece0" }, // patina teal
  { paper: "#2f3a5c", ink: "#f2ece0" }, // midnight
];
const labelFor = (seed: string) => LABELS[[...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % LABELS.length]!;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const GROOVES = Array.from({ length: 46 }, (_, i) => 76 + i * 2.55);
const TRACK_GAPS = [104, 131, 158, 176];

export function VinylDisc({
  state,
  seed,
  artist,
  title,
  size = "lg",
  tonearm = true,
}: {
  state: VinylState;
  seed: string;
  artist: string;
  title?: string;
  size?: "sm" | "md" | "lg" | "hero";
  tonearm?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const label = labelFor(seed);
  const spinning = state === "playing" || state === "paused";
  return (
    <div className={`sp-vinyl sp-vinyl--${size}`} data-state={state} aria-hidden="true">
      <div className="sp-vinyl__platter" />
      <div className="sp-vinyl__disc" data-spinning={spinning ? (state === "playing" ? "running" : "held") : "still"}>
        <svg viewBox="0 0 400 400" className="sp-vinyl__svg" focusable="false">
          <defs>
            <radialGradient id={`v${id}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#1c1a18" />
              <stop offset="62%" stopColor="#121110" />
              <stop offset="96%" stopColor="#0a0909" />
              <stop offset="100%" stopColor="#1d1b19" />
            </radialGradient>
            <path id={`top${id}`} d="M 200 200 m -46 0 a 46 46 0 1 1 92 0" />
            <path id={`bot${id}`} d="M 200 200 m -50 0 a 50 50 0 1 0 100 0" />
          </defs>
          <circle cx="200" cy="200" r="198" fill={`url(#v${id})`} />
          <circle cx="200" cy="200" r="197" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1.2" />
          {GROOVES.map((r, i) => (
            <circle key={r} cx="200" cy="200" r={r} fill="none" stroke={i % 3 === 0 ? "rgba(255,255,255,0.055)" : "rgba(255,255,255,0.028)"} strokeWidth="0.8" />
          ))}
          {TRACK_GAPS.map((r) => (
            <circle key={r} cx="200" cy="200" r={r} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="2.4" />
          ))}
          <circle cx="200" cy="200" r="70" fill="#0b0a0a" />
          {/* paper label */}
          <circle cx="200" cy="200" r="66" fill={label.paper} />
          <circle cx="200" cy="200" r="66" fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="1" />
          <circle cx="200" cy="200" r="58" fill="none" stroke={label.ink} strokeOpacity="0.28" strokeWidth="0.6" />
          <g className="sp-vinyl__label" fill={label.ink}>
            <text fontFamily="var(--font-sans), sans-serif" fontSize="8.2" fontWeight="600" letterSpacing="2.2">
              <textPath href={`#top${id}`} startOffset="50%" textAnchor="middle">
                {clip(artist.toUpperCase(), 26)}
              </textPath>
            </text>
            {title ? (
              <text fontFamily="var(--font-serif), serif" fontSize="9.5" fontStyle="italic">
                <textPath href={`#bot${id}`} startOffset="50%" textAnchor="middle">
                  {clip(title, 34)}
                </textPath>
              </text>
            ) : null}
            <text x="200" y="182" fontFamily="var(--font-sans), sans-serif" fontSize="5.2" letterSpacing="1.6" textAnchor="middle" opacity="0.78">
              TASTEPROBE
            </text>
            <text x="200" y="226" fontFamily="var(--font-sans), sans-serif" fontSize="5.2" letterSpacing="1.6" textAnchor="middle" opacity="0.78">
              SOUND PASSPORT · 33⅓
            </text>
          </g>
          <circle cx="200" cy="200" r="4.2" fill="#0b0a0a" />
          <circle cx="200" cy="200" r="4.2" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.6" />
        </svg>
      </div>
      {/* Fixed light: it does not rotate, so the record turns under it like a real platter. */}
      <div className="sp-vinyl__sheen" />
      {tonearm ? (
        <svg className="sp-vinyl__arm" viewBox="0 0 120 260" focusable="false">
          <circle cx="86" cy="26" r="18" fill="#2a2724" stroke="rgba(255,255,255,0.14)" />
          <circle cx="86" cy="26" r="7" fill="#d9cfbd" />
          <path d="M86 26 L92 168 L62 214" fill="none" stroke="#cfc6b6" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="48" y="206" width="26" height="15" rx="3" transform="rotate(-34 61 213)" fill="#e9a43b" />
        </svg>
      ) : null}
    </div>
  );
}
