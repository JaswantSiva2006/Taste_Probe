"use client";

import type { RankedRecommendation } from "@/lib/contracts";
import { cleanDescription, displayTags, matchSummary, movementOf, splitTitle, type NameBook } from "@/lib/ui/presentation";
import { useFlip } from "@/lib/ui/useFlip";
import { BookCover } from "./BookCover";
import { ArrowDown, ArrowUp } from "./Icons";

function MovementBadge({ item, hasPrevious }: { item: RankedRecommendation; hasPrevious: boolean }) {
  const m = movementOf(item, hasPrevious);
  if (m.kind === "new") return <span className="tp-move tp-move--new">New arrival</span>;
  if (m.kind === "up")
    return (
      <span className="tp-move tp-move--up">
        <ArrowUp size={14} /> Up {m.by}
      </span>
    );
  if (m.kind === "down")
    return (
      <span className="tp-move tp-move--down">
        <ArrowDown size={14} /> Down {m.by}
      </span>
    );
  return null;
}

export function BookCard({ item, names, hasPrevious, featured = false }: { item: RankedRecommendation; names: NameBook; hasPrevious: boolean; featured?: boolean }) {
  const { candidate } = item;
  const { title, series } = splitTitle(candidate.name);
  const tags = displayTags(item, featured ? 4 : 3);
  const why = matchSummary(item, names);
  const isMock = candidate.evidence.source === "mock";
  const description = cleanDescription(candidate.description);
  return (
    <article className={`tp-book${featured ? " tp-book--featured" : ""}`} aria-labelledby={`book-${candidate.entityId}`}>
      <div className="tp-book__media">
        <BookCover id={candidate.entityId} name={candidate.name} imageUrl={candidate.imageUrl} size={featured ? "lg" : "md"} priority={item.position <= 2} />
        <span className="tp-book__rank" aria-label={`Position ${item.position}`}>
          {item.position}
        </span>
      </div>
      <div className="tp-book__body">
        <div className="tp-book__meta">
          <MovementBadge item={item} hasPrevious={hasPrevious} />
          <span className={`tp-source${isMock ? " tp-source--mock" : ""}`}>{isMock ? "Synthetic fixture" : "via Qloo"}</span>
        </div>
        <h3 className="tp-book__title" id={`book-${candidate.entityId}`}>
          {title}
        </h3>
        {series ? <p className="tp-book__series">{series}</p> : null}
        {description ? <p className="tp-book__desc">{description}</p> : null}
        {why.boosted.length || why.lowered.length ? (
          <p className="tp-book__why">
            {why.boosted.length ? (
              <span className="tp-why tp-why--up">Matches your yes to {why.boosted.join(", ")}</span>
            ) : null}
            {why.lowered.length ? <span className="tp-why tp-why--down">Lowered: {why.lowered.join(", ")}</span> : null}
          </p>
        ) : null}
        {tags.length ? (
          <ul className="tp-book__tags" aria-label="Qloo tags">
            {tags.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

/** The live shelf: FLIP-animated reordering keyed by Qloo entity ID. */
export function BookShelf({ items, names, hasPrevious }: { items: RankedRecommendation[]; names: NameBook; hasPrevious: boolean }) {
  const order = items.map((i) => i.candidate.entityId);
  const bind = useFlip(order);
  return (
    <ol className="tp-shelf" aria-label="Recommended books, best match first">
      {items.map((item) => (
        <li key={item.candidate.entityId} ref={bind(item.candidate.entityId)} className="tp-shelf__item">
          <BookCard item={item} names={names} hasPrevious={hasPrevious} />
        </li>
      ))}
    </ol>
  );
}
