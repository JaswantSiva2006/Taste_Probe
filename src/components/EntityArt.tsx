"use client";

import { useState } from "react";
import { artAlt, lookOf } from "@/lib/ui/domains";
import { clothFor, splitTitle } from "@/lib/ui/presentation";
import { DomainGlyph } from "./DomainGlyph";

/**
 * Real Qloo artwork when provided, in a frame shaped for the domain (portrait for
 * books, films and shows; square for artists, games and podcasts) so there is no
 * layout shift. Otherwise an original typeset board, explicitly captioned as having
 * no image from Qloo, so it never poses as genuine artwork.
 */
export function EntityArt({
  id,
  name,
  domain,
  imageUrl,
  size = "md",
  priority = false,
}: {
  id: string;
  name: string;
  domain: string;
  imageUrl?: string;
  size?: "sm" | "md" | "lg";
  priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const { title } = splitTitle(name);
  const { shape, glyph } = lookOf(domain);
  const showImage = Boolean(imageUrl) && !failed;
  return (
    <div className={`tp-art tp-art--${size} tp-art--${shape}`}>
      {showImage ? (
        // Qloo image hosts vary, so a plain <img> with reserved dimensions is used.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={artAlt(domain, title)}
          width={shape === "square" ? 240 : 200}
          height={shape === "square" ? 240 : 300}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          className={`tp-art__board tp-art__board--${glyph}`}
          style={{ ["--cloth" as string]: clothFor(id) }}
          role="img"
          aria-label={`${title}: no ${domain === "book" ? "cover" : "image"} from Qloo`}
        >
          {glyph === "vinyl" ? <span className="tp-art__disc" aria-hidden="true" /> : null}
          {shape === "square" && glyph !== "vinyl" ? (
            <span className="tp-art__glyph" aria-hidden="true">
              <DomainGlyph glyph={glyph} size={28} />
            </span>
          ) : null}
          <span className="tp-art__rule" aria-hidden="true" />
          <span className="tp-art__title" aria-hidden="true">
            {title}
          </span>
          <span className="tp-art__rule" aria-hidden="true" />
          <span className="tp-art__note" aria-hidden="true">
            {domain === "book" ? "No cover from Qloo" : "No image from Qloo"}
          </span>
        </div>
      )}
    </div>
  );
}
