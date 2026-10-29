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
 *
 * S9.5: live image hosts can take seconds. While an image is loading the typeset
 * board (without the "no image" caption, which would be false) sits under it, and
 * the image fades in on load, so a slow host never shows an empty frame.
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
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const { title } = splitTitle(name);
  const { shape, glyph } = lookOf(domain);
  const hasImage = Boolean(imageUrl) && state !== "failed";
  const noImage = !hasImage;
  const noun = domain === "book" ? "cover" : "image";
  return (
    <div className={`tp-art tp-art--${size} tp-art--${shape}`} data-art-state={hasImage ? state : "none"}>
      {state !== "loaded" ? (
        <div
          className={`tp-art__board tp-art__board--${glyph}`}
          style={{ ["--cloth" as string]: clothFor(id) }}
          role={noImage ? "img" : undefined}
          aria-label={noImage ? `${title}: no ${noun} from Qloo` : undefined}
          aria-hidden={noImage ? undefined : true}
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
          {noImage ? (
            <span className="tp-art__note" aria-hidden="true">
              {domain === "book" ? "No cover from Qloo" : "No image from Qloo"}
            </span>
          ) : null}
        </div>
      ) : null}
      {hasImage ? (
        // Qloo image hosts vary, so a plain <img> with reserved dimensions is used.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="tp-art__img"
          src={imageUrl}
          alt={artAlt(domain, title)}
          width={shape === "square" ? 240 : 200}
          height={shape === "square" ? 240 : 300}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      ) : null}
    </div>
  );
}
