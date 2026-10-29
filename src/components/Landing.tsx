"use client";

import type { FormEvent } from "react";
import type { EntitySummary, ProviderMode } from "@/lib/contracts";
import { ArrowRight, Reel, Search, Shelf, Spark } from "./Icons";
import { ProjectorArt } from "./ProjectorArt";

type Props = {
  mode: ProviderMode | null;
  query: string;
  onQuery: (q: string) => void;
  onSearch: () => void;
  searching: boolean;
  searchedFor: string | null;
  results: EntitySummary[] | null;
  selected: EntitySummary | null;
  onSelect: (e: EntitySummary) => void;
  onStart: () => void;
  starting: boolean;
  busy: boolean;
};

export function Landing(p: Props) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    p.onSearch();
  };
  const startLabel = p.starting
    ? p.mode === "mock"
      ? "Loading the sample shelf…"
      : "Asking Qloo for books…"
    : p.selected
      ? `Begin with ${p.selected.name}`
      : "Pick your film above";

  return (
    <>
      <section className="tp-hero" aria-labelledby="tp-hero-title">
        <div className="tp-hero__copy">
          <h1 className="tp-hero__title" id="tp-hero-title">
            Start with a film you love.
            <em>Leave with books you didn’t know you’d love.</em>
          </h1>
          <p className="tp-hero__lede">
            Name one film. TasteProbe asks Qloo which books share its taste, then asks you up to three sharp questions to
            tune the shelf to you.
          </p>

          <form className="tp-search" role="search" onSubmit={submit}>
            <label className="tp-search__label" htmlFor="tp-film">
              Now showing
            </label>
            <div className="tp-search__row">
              <input
                id="tp-film"
                className="tp-search__input"
                value={p.query}
                onChange={(e) => p.onQuery(e.target.value)}
                placeholder="A film you love, e.g. Interstellar"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
              />
              <button type="submit" className="tp-btn tp-btn--amber" disabled={p.busy || !p.query.trim()}>
                <Search size={18} />
                <span>{p.searching ? "Searching…" : "Find the film"}</span>
              </button>
            </div>
          </form>

          <div className="tp-results" aria-live="polite" aria-busy={p.searching}>
            {p.results && p.results.length === 0 ? (
              <p className="tp-results__empty">
                No films matched “{p.searchedFor}”. Try the original title, or fewer words.
              </p>
            ) : null}
            {p.results && p.results.length > 0 ? (
              <>
                <p className="tp-results__prompt" id="tp-results-prompt">
                  {p.results.length === 1 ? "Is this the one?" : `${p.results.length} films match. Which one do you mean?`}
                </p>
                <ul className="tp-tickets" aria-labelledby="tp-results-prompt">
                  {p.results.map((r) => {
                    const on = p.selected?.entityId === r.entityId;
                    return (
                      <li key={r.entityId}>
                        <button
                          type="button"
                          className="tp-ticket"
                          aria-pressed={on}
                          disabled={p.busy}
                          onClick={() => p.onSelect(r)}
                        >
                          <span className="tp-ticket__stub" aria-hidden="true">
                            <Reel size={20} />
                          </span>
                          <span className="tp-ticket__body">
                            <span className="tp-ticket__title">{r.name}</span>
                            <span className="tp-ticket__meta">
                              Film{r.year ? ` · ${r.year}` : ""} · {r.provenance === "mock" ? "synthetic fixture" : "Qloo"}
                              <span className="tp-ticket__id"> · ID …{r.entityId.slice(-6)}</span>
                            </span>
                          </span>
                          <span className="tp-ticket__state" aria-hidden="true">
                            {on ? "Selected" : "Select"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <button type="button" className="tp-btn tp-btn--amber tp-btn--wide" disabled={!p.selected || p.busy} onClick={p.onStart}>
                  <span>{startLabel}</span>
                  {!p.starting ? <ArrowRight size={18} /> : null}
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="tp-hero__art">
          <ProjectorArt className="tp-projector" />
        </div>
      </section>

      <section className="tp-how" aria-labelledby="tp-how-title">
        <h2 className="tp-how__title" id="tp-how-title">
          How a screening works
        </h2>
        <ol className="tp-how__steps">
          <li>
            <Reel size={28} />
            <h3>One film</h3>
            <p>You pick the exact film, so nothing is guessed.</p>
          </li>
          <li>
            <Spark size={28} />
            <h3>Up to three questions</h3>
            <p>Each one is chosen because your answer could reorder the shelf. Skip any you’re unsure about.</p>
          </li>
          <li>
            <Shelf size={28} />
            <h3>Up to five books</h3>
            <p>Real Qloo recommendations, reordered by what you told it, never by guesses about you.</p>
          </li>
        </ol>
      </section>
    </>
  );
}
