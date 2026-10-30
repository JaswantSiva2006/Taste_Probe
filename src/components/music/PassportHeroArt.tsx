import { VinylDisc } from "./VinylDisc";

/**
 * S9.15 landing artwork, "Many roads, one record" (original SVG/CSS, decorative).
 * A record sleeve whose print is a single idea: five fine lines, one per starting
 * point TasteProbe accepts, converge into one coral line that runs into the record
 * sliding out of the sleeve. Music is the dominant object and the destination; the
 * starting points are small type on the print. No real artists, covers or data.
 * The record slides out once on load and then stays still: it never suggests playback.
 */

const ORIGINS = ["FILM", "ARTIST", "TV", "GAME", "PODCAST"] as const;
const Y = [118, 159, 200, 241, 282];

export function PassportHeroArt() {
  return (
    <div className="ah-art" aria-hidden="true">
      <div className="ah-art__light" />
      <div className="ah-art__record">
        <VinylDisc state="idle" seed="hero-afterhours" artist="Sound Passport" title="Side A · your next listen" size="hero" tonearm={false} labelStock={0} />
      </div>
      <div className="ah-art__sleeve">
        <svg viewBox="0 0 400 400" className="ah-art__print" focusable="false">
          <text x="34" y="52" className="ah-art__mono">
            TASTEPROBE · SOUND PASSPORT · SIDE A
          </text>
          {ORIGINS.map((o, i) => (
            <g key={o}>
              <text x="34" y={Y[i]! + 3.5} className="ah-art__origin">
                {o}
              </text>
              <circle cx="112" cy={Y[i]} r="2.6" className="ah-art__dot" />
              <path d={`M112 ${Y[i]} C 175 ${Y[i]}, 190 200, 226 200`} className="ah-art__road" style={{ animationDelay: `${0.25 + i * 0.08}s` }} />
            </g>
          ))}
          <circle cx="226" cy="200" r="4.5" className="ah-art__node" />
          <path d="M226 200 H400" className="ah-art__route" />
          <text x="34" y="338" className="ah-art__title">
            Many roads,
          </text>
          <text x="34" y="368" className="ah-art__title">
            one record.
          </text>
          
        </svg>
      </div>
    </div>
  );
}
