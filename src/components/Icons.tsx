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
export const Spark = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6.6 6.6l2.2 2.2M15.2 15.2l2.2 2.2M17.4 6.6l-2.2 2.2M8.8 15.2l-2.2 2.2" />
  </Base>
);
