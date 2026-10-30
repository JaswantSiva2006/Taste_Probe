"use client";

import type { FormEvent } from "react";
import type { EntitySummary, ProviderMode, PublicDomainPair } from "@/lib/contracts";
import { lookOf, sourceChoices, startingPointOf } from "@/lib/ui/domains";
import { DomainGlyph } from "./DomainGlyph";
import { ArrowRight, Check, PassportIcon, Refresh, Search, Spark, Stamp } from "./Icons";
import { PassportHeroArt } from "./music/PassportHeroArt";

export type Capabilities = { status: "loading" } | { status: "error" } | { status: "ready"; pairs: PublicDomainPair[] };

type Props = {
  mode: ProviderMode | null;
  capabilities: Capabilities;
  onRetryCapabilities: () => void;
  /** S9.15: always the music destination when the server offers it; never chosen by the user. */
  target: string | null;
  source: string | null;
  onSource: (domain: string) => void;
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
  canStart: boolean;
  busy: boolean;
  onStartMusic: () => void;
  onOpenPassport: () => void;
  passportCount: number;
};

/**
 * S9.15 music-first landing. One decision before searching: the starting point.
 * Music is always the destination. The five starting points are the server's
 * enabled music sources (the capability projection), never a hard-coded list,
 * and nothing is preselected.
 */
export function Landing(p: Props) {
  const pairs = p.capabilities.status === "ready" ? p.capabilities.pairs : [];
  const sources = sourceChoices(pairs, p.target);
  const source = sources.find((s) => s.domain === p.source) ?? null;
  const copy = source ? startingPointOf(source.domain, source.label) : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    p.onSearch();
  };
  const startLabel = p.starting
    ? p.mode === "mock"
      ? "Loading the sample artists…"
      : "Finding connected artists…"
    : p.selected
      ? `Discover music from ${p.selected.name}`
      : "Choose one to continue";

  return (
    <>
      <section className="ah-hero" aria-labelledby="tp-hero-title">
        <div className="ah-hero__copy">
          <p className="ah-eyebrow">
            TasteProbe <span aria-hidden="true">/</span> Sound Passport
          </p>
          <h1 className="ah-hero__title" id="tp-hero-title" tabIndex={-1}>
            Your taste travels.
          </h1>
          <p className="ah-hero__sub">Discover music from the things you love.</p>
          <p className="ah-hero__body">Start with a film, artist, show, game or podcast you love. We’ll help you find music you might never have found otherwise.</p>
          <div className="ah-hero__actions">
            <button type="button" className="sp-btn sp-btn--primary sp-btn--lg" onClick={p.onStartMusic} disabled={p.busy || (p.capabilities.status === "ready" && !p.target)}>
              Start discovering <ArrowRight size={18} />
            </button>
            <button type="button" className="sp-btn sp-btn--quiet sp-btn--lg" onClick={p.onOpenPassport}>
              <PassportIcon size={18} /> View my Sound Passport{p.passportCount ? ` · ${p.passportCount}` : ""}
            </button>
          </div>
        </div>
        <div className="ah-hero__art">
          <PassportHeroArt />
        </div>
      </section>

      <section className="ah-start" id="tp-plan" aria-labelledby="tp-plan-title">
        <form className="ah-start__panel" onSubmit={submit} aria-label="Discover music">
          <fieldset className="ah-sources">
            <legend className="ah-start__title" id="tp-plan-title">
              <span className="ah-step" aria-hidden="true">
                01
              </span>
              What’s your starting point?
            </legend>
            {p.capabilities.status === "loading" ? (
              <p className="ah-status" role="status">
                <Refresh size={16} className="tp-spin" /> Loading starting points…
              </p>
            ) : null}
            {p.capabilities.status === "error" ? (
              <div className="ah-status ah-status--error" role="alert">
                <span>We couldn’t load the starting points, so nothing can be chosen yet.</span>
                <button type="button" className="sp-btn sp-btn--quiet" onClick={p.onRetryCapabilities}>
                  <Refresh size={16} /> Try again
                </button>
              </div>
            ) : null}
            {p.capabilities.status === "ready" && sources.length === 0 ? (
              <p className="ah-status" role="status">
                Music discovery isn’t available on this server right now.
              </p>
            ) : null}
            {sources.length ? (
              <div className="ah-inputs">
                {sources.map((s, i) => {
                  const on = s.domain === p.source;
                  const sp = startingPointOf(s.domain, s.label);
                  return (
                    <label key={s.domain} className={`ah-input${on ? " is-on" : ""}`} style={{ "--i": i } as React.CSSProperties}>
                      <input type="radio" name="tp-source" value={s.domain} className="ah-input__radio" checked={on} disabled={p.busy} onChange={() => p.onSource(s.domain)} />
                      <span className="ah-input__led" aria-hidden="true" />
                      <span className="ah-input__glyph" aria-hidden="true">
                        <DomainGlyph glyph={lookOf(s.domain).glyph} size={26} />
                      </span>
                      <span className="ah-input__name">{sp.short}</span>
                      <span className="ah-input__state" aria-hidden="true">
                        {on ? (
                          <>
                            <Check size={13} /> Selected
                          </>
                        ) : (
                          `Input ${String(i + 1).padStart(2, "0")}`
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </fieldset>

          <div className={`ah-search${source ? " is-open" : ""}`}>
            <label className="ah-start__title ah-search__label" htmlFor="tp-anchor">
              <span className="ah-step" aria-hidden="true">
                02
              </span>
              {copy ? copy.prompt : "Search for something you love"}
            </label>
            <div className="ah-search__row">
              <Search size={20} className="ah-search__icon" />
              <input
                id="tp-anchor"
                className="ah-search__input"
                value={p.query}
                onChange={(e) => p.onQuery(e.target.value)}
                placeholder={copy ? copy.placeholder : "Choose a starting point first"}
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                disabled={!source}
                aria-describedby="tp-search-hint"
              />
              <button type="submit" className="sp-btn sp-btn--primary" disabled={!source || p.busy || !p.query.trim()}>
                {p.searching ? "Searching…" : "Search"}
              </button>
            </div>
            <p className="ah-search__hint" id="tp-search-hint">
              {source ? (p.mode === "mock" ? "Demo mode: results are synthetic fixtures." : "Results come from Qloo’s catalogue. Pick the exact one you mean.") : "Pick one of the starting points above to search."}
            </p>

            <div className="ah-results" aria-live="polite" aria-busy={p.searching}>
              {source && p.results && p.results.length === 0 ? (
                <p className="ah-results__empty">
                  Nothing matched “{p.searchedFor}”. Try the original title, or fewer words.
                </p>
              ) : null}
              {source && p.results && p.results.length > 0 ? (
                <>
                  <p className="ah-results__prompt" id="tp-results-prompt">
                    {p.results.length === 1 ? "Is this the one?" : `${p.results.length} matches. Which one do you mean?`}
                  </p>
                  <ul className="ah-results__list" aria-labelledby="tp-results-prompt">
                    {p.results.map((r, i) => {
                      const on = p.selected?.entityId === r.entityId;
                      return (
                        <li key={r.entityId} style={{ "--i": i } as React.CSSProperties}>
                          <button type="button" className="ah-result" aria-pressed={on} disabled={p.busy} onClick={() => p.onSelect(r)}>
                            <span className="ah-result__glyph" aria-hidden="true">
                              <DomainGlyph glyph={lookOf(r.entityType).glyph} size={20} />
                            </span>
                            <span className="ah-result__body">
                              <span className="ah-result__title">{r.name}</span>
                              <span className="ah-result__meta">
                                {startingPointOf(source.domain, source.label).short}
                                {r.year ? ` · ${r.year}` : ""} · {r.provenance === "mock" ? "synthetic fixture" : "Qloo"} · ID …{r.entityId.slice(-6)}
                              </span>
                            </span>
                            <span className="ah-result__state" aria-hidden="true">
                              {on ? <Check size={16} /> : null}
                              {on ? "Selected" : "Select"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <button type="button" className="sp-btn sp-btn--primary sp-btn--lg sp-btn--block ah-discover" disabled={!p.canStart || p.busy} onClick={p.onStart}>
                    <span>{startLabel}</span>
                    {!p.starting ? <ArrowRight size={18} /> : <Refresh size={18} className="tp-spin" />}
                  </button>
                  <p className="ah-results__next">
                    Next: {p.mode === "mock" ? "synthetic sample artists" : "music artists Qloo connects to it"}, up to three quick questions, then your first listen.
                  </p>
                </>
              ) : null}
            </div>
          </div>
        </form>
      </section>

      <section className="ah-how" id="tp-how" aria-labelledby="tp-how-title">
        <h2 className="ah-how__title" id="tp-how-title">
          How it works
        </h2>
        <ol className="ah-how__steps">
          <li>
            <Spark size={24} />
            <h3>Start somewhere familiar</h3>
            <p>Pick the exact film, artist, show, game or podcast from Qloo’s catalogue. One is enough.</p>
          </li>
          <li>
            <Search size={24} />
            <h3>Hear something new</h3>
            <p>Qloo connects it to music artists. TasteProbe plays verified recordings with YouTube’s own player: a short preview first, or the whole song.</p>
          </li>
          <li>
            <Stamp size={24} />
            <h3>Keep what moves you</h3>
            <p>Save the exact recordings you love. Your Sound Passport stays on this device: no account, no playlist.</p>
          </li>
        </ol>
      </section>
    </>
  );
}
