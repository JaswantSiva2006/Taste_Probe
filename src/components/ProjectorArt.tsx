/**
 * Signature visual (original SVG): a two-reel film projector throws an amber
 * beam across the room; it lands on, and lights, a shelf of book spines.
 * Film in, books out. Decorative: the headline carries the meaning.
 */

const SHELF_Y = 360;
const SPINES: Array<{ x: number; w: number; h: number; fill: string; tilt?: number; band?: string }> = [
  { x: 438, w: 22, h: 178, fill: "#5b2a2a", band: "#c9a25a" },
  { x: 462, w: 30, h: 204, fill: "#2f4a4a", band: "#e9d9b8" },
  { x: 494, w: 18, h: 156, fill: "#d9c7a4" },
  { x: 514, w: 26, h: 216, fill: "#6a5524", band: "#f2e8d6" },
  { x: 542, w: 20, h: 188, fill: "#23383f" },
  { x: 564, w: 34, h: 170, fill: "#8c3b2a", band: "#e9a43b" },
  { x: 600, w: 16, h: 198, fill: "#cdbb98" },
  { x: 624, w: 24, h: 182, fill: "#2d3550", tilt: 9, band: "#c9a25a" },
];
const BEAM = "238,184 664,92 664,358 238,198";

function ReelWheel({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r="27" fill="#211c16" stroke="#4a3f33" strokeWidth="2" />
      {[0, 72, 144, 216, 288].map((a) => (
        <circle key={a} cx={cx + 14 * Math.cos((a * Math.PI) / 180)} cy={cy + 14 * Math.sin((a * Math.PI) / 180)} r="6" fill="#14110e" />
      ))}
      <circle cx={cx} cy={cy} r="3.5" fill="#6b5d4b" />
    </g>
  );
}

export function ProjectorArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 680 420" role="presentation" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="tp-beam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffe2a3" stopOpacity="0.9" />
          <stop offset="0.4" stopColor="#e9a43b" stopOpacity="0.34" />
          <stop offset="0.82" stopColor="#e9a43b" stopOpacity="0.2" />
          <stop offset="1" stopColor="#e9a43b" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="tp-lens" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff6dc" />
          <stop offset="0.55" stopColor="#e9a43b" />
          <stop offset="1" stopColor="#5a3b12" />
        </radialGradient>
        <radialGradient id="tp-floor" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#e9a43b" stopOpacity="0.22" />
          <stop offset="1" stopColor="#e9a43b" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="tp-spine-shade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.3" />
          <stop offset="0.25" stopColor="#000" stopOpacity="0" />
          <stop offset="0.85" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.38" />
        </linearGradient>
        <clipPath id="tp-still">
          <rect x="40" y="248" width="112" height="78" rx="1.5" />
        </clipPath>
      </defs>

      {/* warm light pooling under the shelf */}
      <ellipse cx="548" cy="372" rx="150" ry="22" fill="url(#tp-floor)" />

      {/* the beam, behind the books */}
      <polygon className="tp-art-beam" points={BEAM} fill="url(#tp-beam)" />

      {/* projector: two reels over a body, lens facing the shelf */}
      <g className="tp-art-projector">
        <path d="M150 158 L196 132 L232 158" fill="none" stroke="#4a3f33" strokeWidth="2" />
        <ReelWheel cx={150} cy={136} />
        <ReelWheel cx={200} cy={124} />
        <rect x="130" y="160" width="96" height="58" rx="6" fill="#2a241d" stroke="#4a3f33" strokeWidth="1.5" />
        <rect x="142" y="172" width="40" height="5" rx="2.5" fill="#14110e" />
        <rect x="142" y="182" width="28" height="5" rx="2.5" fill="#14110e" />
        <rect x="222" y="178" width="12" height="26" rx="3" fill="#3a3026" />
        <circle cx="238" cy="191" r="11" fill="url(#tp-lens)" />
        <path d="M148 218 L140 252 M210 218 L218 252" stroke="#3a3026" strokeWidth="3" strokeLinecap="round" />
      </g>

      {/* a frame of the film being shown: a vast planet rising, one small figure */}
      <g className="tp-art-strip">
        <rect x="26" y="232" width="140" height="110" rx="3" fill="#0b0a08" stroke="#3a3228" strokeWidth="1.5" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <g key={i}>
            <rect x={34 + i * 22} y="237" width="12" height="7" rx="1.5" fill="#2a241d" />
            <rect x={34 + i * 22} y="330" width="12" height="7" rx="1.5" fill="#2a241d" />
          </g>
        ))}
        <g clipPath="url(#tp-still)">
          <rect x="40" y="248" width="112" height="78" fill="#120f0c" />
          <circle cx="110" cy="352" r="70" fill="#e9a43b" opacity="0.88" />
          <circle cx="110" cy="352" r="70" fill="none" stroke="#fff3d1" strokeOpacity="0.5" strokeWidth="1" />
          <ellipse cx="110" cy="300" rx="96" ry="9" fill="none" stroke="#f2e8d6" strokeOpacity="0.35" strokeWidth="1" />
          <path d="M40 318 H152 V326 H40 Z" fill="#0b0a08" />
          <circle cx="62" cy="304" r="2.6" fill="#0b0a08" />
          <rect x="60.2" y="306.5" width="3.6" height="11.5" rx="1.5" fill="#0b0a08" />
          {[
            [52, 258],
            [74, 266],
            [134, 256],
            [146, 270],
            [96, 262],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="0.9" fill="#f2e8d6" opacity="0.7" />
          ))}
        </g>
      </g>

      {/* bookshelf */}
      <g className="tp-art-shelf">
        {SPINES.map((s, i) => (
          <g key={i} transform={s.tilt ? `rotate(${s.tilt} ${s.x + s.w} ${SHELF_Y})` : undefined}>
            <rect x={s.x} y={SHELF_Y - s.h} width={s.w} height={s.h} rx="1.5" fill={s.fill} />
            <rect x={s.x} y={SHELF_Y - s.h} width={s.w} height={s.h} rx="1.5" fill="url(#tp-spine-shade)" />
            {s.band ? (
              <>
                <rect x={s.x + 2} y={SHELF_Y - s.h + 18} width={s.w - 4} height="2" fill={s.band} opacity="0.85" />
                <rect x={s.x + 2} y={SHELF_Y - 26} width={s.w - 4} height="2" fill={s.band} opacity="0.85" />
              </>
            ) : null}
            <rect x={s.x + s.w / 2 - 1.5} y={SHELF_Y - s.h + 34} width="3" height={Math.max(28, s.h * 0.34)} rx="1.5" fill="#f2e8d6" opacity="0.22" />
          </g>
        ))}
        <rect x="420" y={SHELF_Y} width="246" height="10" fill="#3a3026" />
        <rect x="420" y={SHELF_Y + 10} width="246" height="5" fill="#0b0a08" opacity="0.8" />
      </g>

      {/* the same beam over the books: light falls only where the beam lands */}
      <polygon points={BEAM} fill="#ffd98a" opacity="0.13" style={{ mixBlendMode: "screen" }} />

      {/* static dust motes in the light */}
      <g fill="#fff3d1">
        {[
          [300, 178, 1.4, 0.55],
          [352, 202, 1.1, 0.4],
          [392, 160, 1.6, 0.35],
          [452, 228, 1.2, 0.45],
          [334, 220, 0.9, 0.5],
          [418, 270, 1.3, 0.3],
        ].map(([x, y, r, o], i) => (
          <circle key={i} cx={x} cy={y} r={r} opacity={o} />
        ))}
      </g>
    </svg>
  );
}
