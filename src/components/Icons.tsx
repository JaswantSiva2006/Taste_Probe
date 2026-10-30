/** Original 1.5px stroke icon set (round caps). Decorative unless labelled by the caller. */
type IconProps = { className?: string; size?: number };

function Base({ className, size = 18, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12h13M13 6l6 6-6 6" />
  </Base>
);
export const ArrowUp = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 19V6M6 11l6-6 6 6" />
  </Base>
);
export const ArrowDown = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v13M6 13l6 6 6-6" />
  </Base>
);
export const Search = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Base>
);
export const Check = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Base>
);
export const Cross = (p: IconProps) => (
  <Base {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Base>
);
export const Refresh = (p: IconProps) => (
  <Base {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Base>
);
/** A film reel: progress pip and brand mark. */
export const Reel = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="12" cy="7" r="1.8" />
    <circle cx="16.75" cy="10.5" r="1.8" />
    <circle cx="14.9" cy="16" r="1.8" />
    <circle cx="9.1" cy="16" r="1.8" />
    <circle cx="7.25" cy="10.5" r="1.8" />
  </Base>
);
export const Shelf = (p: IconProps) => (
  <Base {...p}>
    <path d="M3.5 20h17" />
    <path d="M6 20V6.5M9.5 20V9M13 20V5M16.5 20l2.6-12.5" />
  </Base>
);
export const BookOpen = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 6.5c-2-1.6-4.6-2-7.5-1.5v13c2.9-.5 5.5-.1 7.5 1.5 2-1.6 4.6-2 7.5-1.5V5c-2.9-.5-5.5-.1-7.5 1.5z" />
    <path d="M12 6.5v13" />
  </Base>
);
/** A vinyl record: music artists. */
export const Vinyl = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="5.25" />
    <circle cx="12" cy="12" r="1.6" />
  </Base>
);
export const Screen = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="5.5" width="17" height="11.5" rx="1.5" />
    <path d="M9 20.5h6M12 17v3.5" />
  </Base>
);
export const Controller = (p: IconProps) => (
  <Base {...p}>
    <path d="M7.5 8h9a4 4 0 0 1 3.9 4.9l-.8 3.4a2.2 2.2 0 0 1-3.9.8L14.3 15H9.7l-1.4 2.1a2.2 2.2 0 0 1-3.9-.8l-.8-3.4A4 4 0 0 1 7.5 8z" />
    <path d="M8 10.5v3M6.5 12h3M15.5 11.5h.01M17 13h.01" />
  </Base>
);
export const Mic = (p: IconProps) => (
  <Base {...p}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
  </Base>
);
export const Spark = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6.6 6.6l2.2 2.2M15.2 15.2l2.2 2.2M17.4 6.6l-2.2 2.2M8.8 15.2l-2.2 2.2" />
  </Base>
);

/* ---------------------------------------------------------------- S9.13 listening set (same 1.5px family) */
export const Play = (p: IconProps) => (
  <Base {...p}>
    <path d="M8 5.5v13l10.5-6.5L8 5.5z" fill="currentColor" stroke="none" />
  </Base>
);
export const Pause = (p: IconProps) => (
  <Base {...p}>
    <rect x="6.5" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.9" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none" />
  </Base>
);
export const Rewind10 = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4" />
    <path d="M4.5 4.5v3.6h3.6" />
    <text x="12.2" y="15.2" fontSize="6.6" fontFamily="inherit" fontWeight="600" textAnchor="middle" fill="currentColor" stroke="none">10</text>
  </Base>
);
export const SkipBack = (p: IconProps) => (
  <Base {...p}>
    <path d="M17.5 6v12L9 12l8.5-6z" />
    <path d="M6.5 6v12" />
  </Base>
);
export const SkipForward = (p: IconProps) => (
  <Base {...p}>
    <path d="M6.5 6v12L15 12 6.5 6z" />
    <path d="M17.5 6v12" />
  </Base>
);
export const Replay = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12a7 7 0 1 0 2.05-4.95" />
    <path d="M5 5v4h4" />
    <path d="M10.6 9.6v4.8l3.8-2.4-3.8-2.4z" fill="currentColor" stroke="none" />
  </Base>
);
export const Heart = ({ filled = false, ...p }: IconProps & { filled?: boolean }) => (
  <Base {...p}>
    <path d="M12 19.5s-7-4.3-7-9.3A4 4 0 0 1 12 7.6a4 4 0 0 1 7 2.6c0 5-7 9.3-7 9.3z" fill={filled ? "currentColor" : "none"} />
  </Base>
);
export const NotForMe = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="7.5" />
    <path d="M8.5 12h7" />
  </Base>
);
export const Stamp = (p: IconProps) => (
  <Base {...p}>
    <path d="M9.5 4.5h5l-1 6h-3l-1-6z" />
    <path d="M5 13.5h14v3H5z" />
    <path d="M7 19.5h10" />
  </Base>
);
export const AnotherSong = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 17.5V6.5l8-1.5v9" />
    <circle cx="7" cy="17.5" r="2" />
    <circle cx="15" cy="14" r="2" />
    <path d="M19.5 18.5l2-2-2-2" />
  </Base>
);
export const DifferentArtist = (p: IconProps) => (
  <Base {...p}>
    <circle cx="8.5" cy="8.5" r="3" />
    <path d="M3.5 19c.6-3 2.6-4.7 5-4.7s4.4 1.7 5 4.7" />
    <path d="M15 8h6M18.5 5.5 21 8l-2.5 2.5" />
  </Base>
);
export const ExternalLink = (p: IconProps) => (
  <Base {...p}>
    <path d="M13.5 5.5h5v5M18.5 5.5l-7 7" />
    <path d="M16.5 13.5v4a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5V9.5A1.5 1.5 0 0 1 7 8h4" />
  </Base>
);
export const PassportIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="5.5" y="3.5" width="13" height="17" rx="1.6" />
    <circle cx="12" cy="11" r="3.2" />
    <circle cx="12" cy="11" r="0.6" fill="currentColor" />
    <path d="M9 17h6" />
  </Base>
);

/* S9.15 source-selector and preview icons (same 1.5px family). */
export const Film = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 9.5h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M4 9.5l-.4-2.6a1.2 1.2 0 0 1 1-1.4l13.8-2a1.2 1.2 0 0 1 1.4 1l.4 2.6L4 9.5z" />
    <path d="M8.2 5.3l2.4 3.3M12.6 4.7l2.4 3.3" />
  </Base>
);
export const Note = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 17.5V6l10-2v11" />
    <circle cx="6.5" cy="17.5" r="2.5" />
    <circle cx="16.5" cy="15" r="2.5" />
  </Base>
);
export const Broadcast = (p: IconProps) => (
  <Base {...p}>
    <rect x="9.5" y="4" width="5" height="9" rx="2.5" />
    <path d="M7 10.5a5 5 0 0 0 10 0M12 15.5V20M9 20h6" />
    <path d="M4.5 7.5a8.5 8.5 0 0 0 0 6M19.5 7.5a8.5 8.5 0 0 1 0 6" />
  </Base>
);
/** A bounded excerpt: brackets around a play mark. */
export const Excerpt = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 5H4.5v14H7M17 5h2.5v14H17" />
    <path d="M10 9l5 3-5 3z" />
  </Base>
);
export const FullTrack = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 8h16M4 12h16M4 16h10" />
    <path d="M17 14.5l3.5 2-3.5 2z" />
  </Base>
);
