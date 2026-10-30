import { VinylDisc } from "./VinylDisc";

/**
 * S9.13 landing artwork (original, decorative). A printed record sleeve — the
 * Passport — with the signature record drawn halfway out, stamped with the cultural
 * starting points a journey can begin from. No real artists, covers or data shown.
 */

function Stamp({ label, sub, rotate, tone }: { label: string; sub: string; rotate: number; tone: string }) {
  return (
    <svg className="sp-heroart__stamp" viewBox="0 0 120 120" style={{ transform: `rotate(${rotate}deg)`, color: tone }} aria-hidden="true" focusable="false">
      <defs>
        <path id={`s-${label}`} d="M60 60 m-40 0 a40 40 0 1 1 80 0 a40 40 0 1 1 -80 0" />
      </defs>
      <circle cx="60" cy="60" r="54" fill="none" stroke="currentColor" strokeWidth="2.4" strokeDasharray="1 0" />
      <circle cx="60" cy="60" r="47" fill="none" stroke="currentColor" strokeWidth="1" />
      <text fill="currentColor" fontSize="9.5" fontFamily="var(--font-sans), sans-serif" fontWeight="600" letterSpacing="3">
        <textPath href={`#s-${label}`} startOffset="0">
          TASTEPROBE · SOUND PASSPORT ·
        </textPath>
      </text>
      <text x="60" y="58" textAnchor="middle" fill="currentColor" fontSize="17" fontFamily="var(--font-serif), serif" fontStyle="italic">
        {label}
      </text>
      <text x="60" y="74" textAnchor="middle" fill="currentColor" fontSize="7.5" fontFamily="var(--font-sans), sans-serif" letterSpacing="2.2">
        {sub}
      </text>
    </svg>
  );
}

export function PassportHeroArt() {
  return (
    <div className="sp-heroart" aria-hidden="true">
      <div className="sp-heroart__record">
        <VinylDisc state="idle" seed="hero-sound-passport" artist="Your next favourite artist" title="Side A · from something you love" size="hero" tonearm={false} />
      </div>
      <div className="sp-heroart__sleeve">
        <p className="sp-heroart__brand">TasteProbe</p>
        <p className="sp-heroart__title">
          Sound
          <br />
          Passport
        </p>
        <p className="sp-heroart__meta">A listening journey · Side A</p>
        <ol className="sp-heroart__tracks">
          <li>
            <span>01</span> A film you love
          </li>
          <li>
            <span>02</span> Artists Qloo connects
          </li>
          <li>
            <span>03</span> Verified recordings
          </li>
          <li>
            <span>04</span> The ones you keep
          </li>
        </ol>
        <div className="sp-heroart__stamps">
          <Stamp label="Film" sub="START" rotate={-12} tone="#c9573f" />
          <Stamp label="Music" sub="ARRIVAL" rotate={9} tone="#2f3a5c" />
        </div>
      </div>
    </div>
  );
}
