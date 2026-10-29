"use client";

import { useState } from "react";
import { clothFor, splitTitle } from "@/lib/ui/presentation";

/**
 * Real Qloo artwork when provided (fixed 2:3 frame, no layout shift).
 * Otherwise an original cloth-bound board with the typeset title, explicitly
 * captioned as having no Qloo cover, so it never poses as genuine artwork.
 */
export function BookCover({
  id,
  name,
  imageUrl,
  size = "md",
  priority = false,
}: {
  id: string;
  name: string;
  imageUrl?: string;
  size?: "sm" | "md" | "lg";
  priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const { title } = splitTitle(name);
  const showImage = Boolean(imageUrl) && !failed;
  return (
    <div className={`tp-cover tp-cover--${size}`}>
      {showImage ? (
        // Qloo image hosts vary, so a plain <img> with reserved dimensions is used.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={`Cover of ${title}`}
          width={200}
          height={300}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="tp-cover__board" style={{ ["--cloth" as string]: clothFor(id) }} role="img" aria-label={`${title}: no cover image from Qloo`}>
          <span className="tp-cover__rule" aria-hidden="true" />
          <span className="tp-cover__title" aria-hidden="true">
            {title}
          </span>
          <span className="tp-cover__rule" aria-hidden="true" />
          <span className="tp-cover__note" aria-hidden="true">
            No cover from Qloo
          </span>
        </div>
      )}
    </div>
  );
}
