"use client";

import { useState } from "react";
import { domainLabel, type DiscoveryView } from "@/lib/contracts";
import { answeredCount, BASIS_LABEL, finishLine, resolvePath, ROLE_LABEL, type NameBook, type ResolvedPathItem } from "@/lib/ui/presentation";
import { ArrowRight, Check } from "./Icons";
import { ResultCard } from "./ResultShelf";
import { TasteNotes } from "./Workspace";

/** The backend's grounded explanation, disclosed on demand. Text is shown verbatim. */
function Why({ entry, summary }: { entry: ResolvedPathItem; summary: string }) {
  const { kind, text } = entry.item.explanation;
  return (
    <details className="tp-whybox">
      <summary>
        <span>{summary}</span>
      </summary>
      <p className="tp-whybox__basis">{BASIS_LABEL[kind]}</p>
      <p className="tp-whybox__text">{text}</p>
    </details>
  );
}

/**
 * The finale: a printed programme titled "Your way in". START HERE is the
 * backend's first featured role; supporting roles follow in backend order. Nothing
 * is re-ranked, invented or linked out.
 */
export function Programme({
  view,
  names,
  onRestart,
  onNewAnchor,
}: {
  view: DiscoveryView;
  names: NameBook;
  onRestart: () => void;
  onNewAnchor: () => void;
}) {
  const [intended, setIntended] = useState(false);
  const plural = domainLabel(view.targetType, true);
  const sourceNoun = domainLabel(view.seed.entityType);
  const answered = answeredCount(view);
  const isMock = view.recommendations.some((r) => r.candidate.evidence.source === "mock");
  const path = resolvePath(view);
  const [lead, ...support] = path?.featured ?? [];
  const others = path ? path.others : view.recommendations.slice(1);
  const fallbackTop = !path ? view.recommendations[0] : undefined;

  return (
    <article className="tp-programme" aria-labelledby="tp-programme-title">
      <header className="tp-programme__head">
        <p className="tp-programme__kicker">Your way in</p>
        <h1 className="tp-programme__title" id="tp-programme-title" tabIndex={-1}>
          From <em>{view.seed.name}</em> into {plural}.
        </h1>
        <p className="tp-programme__sub">
          {finishLine(view)}{" "}
          {view.recommendations.length
            ? `${isMock ? "Every pick comes from the synthetic sample set" : "Every pick was returned by Qloo"}${answered > 0 ? ", ordered by what you told us" : ""}.`
            : ""}
        </p>
      </header>

      {lead ? (
        <section className="tp-start" aria-labelledby="tp-start-label">
          <p className="tp-start__label" id="tp-start-label">
            {ROLE_LABEL[lead.item.role]}
          </p>
          <ResultCard item={lead.rec} names={names} hasPrevious={false} featured showRank={false} />
          <div className="tp-start__actions">
            <Why entry={lead} summary="Why this starting point?" />
            <div className="tp-start__intent">
              <button type="button" className="tp-btn tp-btn--ink" aria-pressed={intended} onClick={() => setIntended((v) => !v)}>
                {intended ? <Check size={18} /> : null}
                <span>{intended ? "Marked: I’ll try this" : "I’ll try this"}</span>
              </button>
              <p className="tp-start__note" aria-live="polite">
                {intended ? "Noted for this visit only. Nothing is saved or sent." : "Marks your intention for this visit. Nothing is saved or sent."}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {fallbackTop ? (
        <section className="tp-start" aria-label="Top pick">
          <p className="tp-start__label">Top pick</p>
          <ResultCard item={fallbackTop} names={names} hasPrevious={false} featured showRank={false} />
        </section>
      ) : null}

      {!lead && !fallbackTop ? (
        <p className="tp-notice tp-notice--warn">Qloo returned no {plural} for this exploration, so there is nothing to list.</p>
      ) : null}

      {support.length ? (
        <section className="tp-path" aria-labelledby="tp-path-title">
          <h2 className="tp-programme__h2" id="tp-path-title">
            Where to go next
          </h2>
          <ol className="tp-path__list">
            {support.map((entry) => (
              <li key={entry.item.recommendationEntityId} className="tp-path__item">
                <p className="tp-path__role">{ROLE_LABEL[entry.item.role]}</p>
                <ResultCard item={entry.rec} names={names} hasPrevious={false} showRank={false} />
                <Why entry={entry} summary="Why this?" />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {others.length ? (
        <section className="tp-programme__list" aria-labelledby="tp-also-title">
          <h2 className="tp-programme__h2" id="tp-also-title">
            Other good starting points
          </h2>
          <ul className="tp-programme__books">
            {others.map((item) => (
              <li key={item.candidate.entityId}>
                <ResultCard item={item} names={names} hasPrevious={false} showRank={false} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="tp-programme__foot">
        <TasteNotes view={view} names={names} title="What you told us" empty="No preferences were confirmed, so nothing was assumed about you." />
        <div className="tp-programme__restart">
          <button type="button" className="tp-btn tp-btn--amber" onClick={onRestart}>
            <span>Explore another world</span>
            <ArrowRight size={18} />
          </button>
          <button type="button" className="tp-btn tp-btn--ghost" onClick={onNewAnchor}>
            Try another {sourceNoun}
          </button>
        </div>
      </footer>
    </article>
  );
}
