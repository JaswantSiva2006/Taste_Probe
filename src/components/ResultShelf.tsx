"use client";

import type { RankedRecommendation } from "@/lib/contracts";
import { lookOf } from "@/lib/ui/domains";
import { cleanDescription, displayTags, matchSummary, movementOf, splitTitle, type NameBook } from "@/lib/ui/presentation";
import { useFlip } from "@/lib/ui/useFlip";
import { EntityArt } from "./EntityArt";
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

/**
 * One verified recommendation of any domain. Only fields Qloo supplied are shown;
 * the artwork frame follows the domain so an artist never looks like a book.
 */
export function ResultCard({
  item,
  names,
  hasPrevious,
  featured = false,
  showRank = true,
}: {
  item: RankedRecommendation;
  names: NameBook;
  hasPrevious: boolean;
  featured?: boolean;
  showRank?: boolean;
}) {
  const { candidate } = item;
  const { title, series } = splitTitle(candidate.name);
  const tags = displayTags(item, featured ? 4 : 3);
  const why = matchSummary(item, names);
  const isMock = candidate.evidence.source === "mock";
  const description = cleanDescription(candidate.description);
  const { shape } = lookOf(candidate.entityType);
  return (
    <article className={`tp-card tp-card--${shape}${featured ? " tp-card--featured" : ""}`} aria-labelledby={`card-${candidate.entityId}`}>
      <div className="tp-card__media">
        <EntityArt
          id={candidate.entityId}
          name={candidate.name}
          domain={candidate.entityType}
          imageUrl={candidate.imageUrl}
          size={featured ? "lg" : "md"}
          priority={item.position <= 2}
        />
        {showRank ? (
          <span className="tp-card__rank" aria-label={`Position ${item.position}`}>
            {item.position}
          </span>
        ) : null}
      </div>
      <div className="tp-card__body">
        <div className="tp-card__meta">
          <MovementBadge item={item} hasPrevious={hasPrevious} />
          <span className={`tp-source${isMock ? " tp-source--mock" : ""}`}>{isMock ? "Synthetic fixture" : "via Qloo"}</span>
        </div>
        <h3 className="tp-card__title" id={`card-${candidate.entityId}`}>
          {title}
        </h3>
        {series ? <p className="tp-card__series">{series}</p> : null}
        {description ? <p className="tp-card__desc">{description}</p> : null}
        {why.boosted.length || why.lowered.length ? (
          <p className="tp-card__why">
            {why.boosted.length ? <span className="tp-why tp-why--up">Matches your yes to {why.boosted.join(", ")}</span> : null}
            {why.lowered.length ? <span className="tp-why tp-why--down">Lowered: {why.lowered.join(", ")}</span> : null}
          </p>
        ) : null}
        {tags.length ? (
          <ul className="tp-card__tags" aria-label="Qloo tags">
            {tags.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

/** The live list: FLIP-animated reordering keyed by Qloo entity ID. */
export function ResultShelf({ items, names, hasPrevious, label }: { items: RankedRecommendation[]; names: NameBook; hasPrevious: boolean; label: string }) {
  const order = items.map((i) => i.candidate.entityId);
  const bind = useFlip(order);
  return (
    <ol className="tp-shelf" aria-label={label}>
      {items.map((item) => (
        <li key={item.candidate.entityId} ref={bind(item.candidate.entityId)} className="tp-shelf__item">
          <ResultCard item={item} names={names} hasPrevious={hasPrevious} />
        </li>
      ))}
    </ol>
  );
}
