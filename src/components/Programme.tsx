"use client";

import type { DiscoveryView } from "@/lib/contracts";
import { answeredCount, finishLine, type NameBook } from "@/lib/ui/presentation";
import { BookCard } from "./BookShelf";
import { ArrowRight } from "./Icons";
import { TasteNotes } from "./Workspace";

/** The finale: a printed programme for the screening. Top pick featured, the rest listed. */
export function Programme({ view, names, onRestart }: { view: DiscoveryView; names: NameBook; onRestart: () => void }) {
  const [top, ...rest] = view.recommendations;
  const answered = answeredCount(view);
  const isMock = view.recommendations.some((r) => r.candidate.evidence.source === "mock");
  return (
    <article className="tp-programme" aria-labelledby="tp-programme-title">
      <header className="tp-programme__head">
        <p className="tp-programme__kicker">A TasteProbe programme</p>
        <h1 className="tp-programme__title" id="tp-programme-title" tabIndex={-1}>
          After <em>{view.seed.name}</em>, read these.
        </h1>
        <p className="tp-programme__sub">
          {finishLine(view)}{" "}
          {view.recommendations.length === 0
            ? ""
            : `Here ${view.recommendations.length === 1 ? "is the top book" : `are the top ${view.recommendations.length}`} ${
                isMock ? "from the synthetic sample set" : "Qloo found"
              }${answered > 0 ? ", ordered by what you told us" : ""}.`}
        </p>
      </header>

      {top ? (
        <section className="tp-programme__feature" aria-label="Top pick">
          <p className="tp-programme__billing">Top billing</p>
          <BookCard item={top} names={names} hasPrevious={false} featured />
        </section>
      ) : (
        <p className="tp-notice tp-notice--warn">Qloo returned no books for this screening, so there is nothing to list.</p>
      )}

      {rest.length ? (
        <section className="tp-programme__list" aria-labelledby="tp-also-title">
          <h2 className="tp-programme__h2" id="tp-also-title">
            Also on the programme
          </h2>
          <ol className="tp-programme__books" start={2}>
            {rest.map((item) => (
              <li key={item.candidate.entityId}>
                <BookCard item={item} names={names} hasPrevious={false} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <footer className="tp-programme__foot">
        <TasteNotes view={view} names={names} title="What you told us" />
        <button type="button" className="tp-btn tp-btn--amber" onClick={onRestart}>
          <span>Start another screening</span>
          <ArrowRight size={18} />
        </button>
      </footer>
    </article>
  );
}
