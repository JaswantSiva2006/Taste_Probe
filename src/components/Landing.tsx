"use client";

import type { FormEvent } from "react";
import type { EntitySummary, ProviderMode, PublicDomainPair } from "@/lib/contracts";
import { lookOf, sourceChoices, targetChoices, withArticle } from "@/lib/ui/domains";
import { DomainGlyph } from "./DomainGlyph";
import { ArrowRight, Check, PassportIcon, Refresh, Search, Spark, Stamp } from "./Icons";
import { ProjectorArt } from "./ProjectorArt";
import { PassportHeroArt } from "./music/PassportHeroArt";

export type Capabilities = { status: "loading" } | { status: "error" } | { status: "ready"; pairs: PublicDomainPair[] };

type Props = {
  mode: ProviderMode | null;
  capabilities: Capabilities;
  onRetryCapabilities: () => void;
  target: string | null;
  onTarget: (domain: string) => void;
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
  /** S9.13 Sound Passport entry points. */
  onStartMusic: () => void;
  onOpenPassport: () => void;
  passportCount: number;
};

const joinOr = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

export function Landing(p: Props) {
  const pairs = p.capabilities.status === "ready" ? p.capabilities.pairs : [];
  const targets = targetChoices(pairs);
  const sources = sourceChoices(pairs, p.target);
  const target = targets.find((t) => t.domain === p.target) ?? null;
  const source = sources.find((s) => s.domain === p.source) ?? null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    p.onSearch();
  };
  const startLabel = p.starting
    ? p.mode === "mock"
      ? `Loading the sample ${target?.pluralLabel ?? "picks"}…`
      : `Asking Qloo for ${target?.pluralLabel ?? "picks"}…`
    : p.selected
      ? `Begin with ${p.selected.name}`
      : `Pick your ${source?.label ?? "anchor"} above`;

  const musicOffered = targets.some((t) => t.domain === "music_artist");
  return (
    <>
      <section className="sp-hero" aria-labelledby="tp-hero-title">
        <div className="sp-hero__copy">
          <p className="sp-hero__eyebrow">
            TasteProbe <span aria-hidden="true">/</span> Sound Passport
          </p>
          <h1 className="sp-hero__title" id="tp-hero-title" tabIndex={-1}>
            Discover music <em>beyond your world.</em>
          </h1>
          <p className="sp-hero__lede">Start with something you love. Hear something you never knew you’d love.</p>
          <p className="sp-hero__body">
            Name a film you love. Qloo finds the music artists connected to it, and TasteProbe plays a real, verified recording of each through YouTube’s own player. Keep the ones that move you in your Sound Passport.
          </p>
          <div className="sp-hero__actions">
            <button type="button" className="sp-btn sp-btn--primary sp-btn--lg" onClick={p.onStartMusic} disabled={p.busy || (p.capabilities.status === "ready" && !musicOffered)}>
              Start exploring <ArrowRight size={18} />
            </button>
            <a className="sp-btn sp-btn--quiet sp-btn--lg" href="#tp-how">
              How it works
            </a>
            <a className="sp-hero__other" href="#tp-plan">
              Explore other cultures <ArrowRight size={14} />
            </a>
          </div>
          {p.passportCount ? (
            <button type="button" className="sp-hero__passport" onClick={p.onOpenPassport}>
              <PassportIcon size={16} /> Your Sound Passport holds {p.passportCount} recording{p.passportCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>
        <div className="sp-hero__art">
          <PassportHeroArt />
        </div>
      </section>

      <section className="tp-how sp-how" id="tp-how" aria-labelledby="tp-how-title">
        <h2 className="tp-how__title" id="tp-how-title">
          How it works
        </h2>
        <ol className="tp-how__steps">
          <li>
            <Spark size={28} />
            <h3>Start somewhere familiar</h3>
            <p>Pick the exact film you love from Qloo’s catalogue. Nothing is guessed, and one starting point is enough.</p>
          </li>
          <li>
            <Search size={28} />
            <h3>Hear something unexpected</h3>
            <p>Qloo suggests connected artists. TasteProbe plays verified recordings you can love, pass on, or swap for another song or artist.</p>
          </li>
          <li>
            <Stamp size={28} />
            <h3>Keep what moves you</h3>
            <p>Save the exact recordings you choose. Your Sound Passport stays on this device: no account, no playlist.</p>
          </li>
        </ol>
      </section>

      <section className="tp-hero tp-plan" id="tp-plan" aria-labelledby="tp-plan-title">
        <div className="tp-hero__copy">
          <p className="tp-hero__kicker">Choose your journey</p>
          <h2 className="tp-hero__title tp-plan__title" id="tp-plan-title">
            Love something?
            <em>Discover what comes next.</em>
          </h2>
          <p className="tp-hero__lede">
            Listen your way into music artists, or explore other cultures: choose a world, pick something you already love, and TasteProbe asks Qloo where your taste leads, with up to three sharp questions along the way.
          </p>

          <form className="tp-journey" onSubmit={submit} aria-label="Plan your exploration">
            {/* Step 1: destination, from the server's enabled pairs only */}
            <fieldset className="tp-step" aria-describedby="tp-step1-help">
              <legend className="tp-step__legend">
                <span className="tp-step__num" aria-hidden="true">
                  1
                </span>
                What would you like to explore?
              </legend>
              <p className="tp-sr" id="tp-step1-help">
                Only journeys TasteProbe has verified end to end are listed.
              </p>
              {p.capabilities.status === "loading" ? (
                <p className="tp-step__status" role="status">
                  <Refresh size={16} className="tp-spin" /> Loading verified journeys…
                </p>
              ) : null}
              {p.capabilities.status === "error" ? (
                <div className="tp-step__status tp-step__status--error" role="alert">
                  <span>We couldn’t load the available worlds, so nothing can be chosen yet.</span>
                  <button type="button" className="tp-btn tp-btn--ghost tp-btn--sm" onClick={p.onRetryCapabilities}>
                    <Refresh size={16} /> Try again
                  </button>
                </div>
              ) : null}
              {p.capabilities.status === "ready" && targets.length === 0 ? (
                <p className="tp-step__status" role="status">
                  No journeys are enabled on this server right now.
                </p>
              ) : null}
              {targets.length ? (
                <div className="tp-worlds">
                  {targets.map((t) => {
                    const on = t.domain === p.target;
                    const from = sourceChoices(pairs, t.domain).map((s) => withArticle(s.label));
                    return (
                      <label key={t.domain} className={`tp-world${on ? " is-on" : ""}`}>
                        <input
                          type="radio"
                          name="tp-target"
                          value={t.domain}
                          className="tp-world__input"
                          checked={on}
                          disabled={p.busy}
                          onChange={() => p.onTarget(t.domain)}
                        />
                        <span className="tp-world__glyph" aria-hidden="true">
                          <DomainGlyph glyph={lookOf(t.domain).glyph} size={30} />
                        </span>
                        <span className="tp-world__name">{t.label}</span>
                        <span className="tp-world__from">Start from {joinOr(from)}</span>
                        <span className="tp-world__state" aria-hidden="true">
                          {on ? (
                            <>
                              <Check size={14} /> Chosen
                            </>
                          ) : (
                            "Choose"
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </fieldset>

            {/* Step 2: familiar anchor, filtered by the chosen destination */}
            {target ? (
              <fieldset className="tp-step tp-step--anchor" key={target.domain}>
                <legend className="tp-step__legend">
                  <span className="tp-step__num" aria-hidden="true">
                    2
                  </span>
                  What do you already love?
                </legend>
                <div className="tp-sources">
                  {sources.map((s) => {
                    const on = s.domain === p.source;
                    return (
                      <label key={s.domain} className={`tp-chip${on ? " is-on" : ""}`}>
                        <input
                          type="radio"
                          name="tp-source"
                          value={s.domain}
                          className="tp-chip__input"
                          checked={on}
                          disabled={p.busy}
                          onChange={() => p.onSource(s.domain)}
                        />
                        <DomainGlyph glyph={lookOf(s.domain).glyph} size={18} />
                        <span>{withArticle(s.label)}</span>
                        {on ? <Check size={14} className="tp-chip__check" /> : null}
                      </label>
                    );
                  })}
                </div>

                {source ? (
                  <div className="tp-search">
                    <label className="tp-search__label" htmlFor="tp-anchor">
                      Name {withArticle(source.label)} you love
                    </label>
                    <div className="tp-search__row">
                      <input
                        id="tp-anchor"
                        className="tp-search__input"
                        value={p.query}
                        onChange={(e) => p.onQuery(e.target.value)}
                        placeholder={`Search for ${withArticle(source.label)}`}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={200}
                      />
                      <button type="submit" className="tp-btn tp-btn--amber" disabled={p.busy || !p.query.trim()}>
                        <Search size={18} />
                        <span>{p.searching ? "Searching…" : "Find it"}</span>
                      </button>
                    </div>
                  </div>
                ) : null}
              </fieldset>
            ) : null}
          </form>

          <div className="tp-results" aria-live="polite" aria-busy={p.searching}>
            {source && p.results && p.results.length === 0 ? (
              <p className="tp-results__empty">
                No {source.pluralLabel} matched “{p.searchedFor}”. Try the original name, or fewer words.
              </p>
            ) : null}
            {source && p.results && p.results.length > 0 ? (
              <>
                <p className="tp-results__prompt" id="tp-results-prompt">
                  {p.results.length === 1 ? "Is this the one?" : `${p.results.length} matches. Which one do you mean?`}
                </p>
                <ul className="tp-tickets" aria-labelledby="tp-results-prompt">
                  {p.results.map((r) => {
                    const on = p.selected?.entityId === r.entityId;
                    return (
                      <li key={r.entityId}>
                        <button type="button" className="tp-ticket" aria-pressed={on} disabled={p.busy} onClick={() => p.onSelect(r)}>
                          <span className="tp-ticket__stub" aria-hidden="true">
                            <DomainGlyph glyph={lookOf(r.entityType).glyph} size={20} />
                          </span>
                          <span className="tp-ticket__body">
                            <span className="tp-ticket__title">{r.name}</span>
                            <span className="tp-ticket__meta">
                              {source.label[0]!.toUpperCase() + source.label.slice(1)}
                              {r.year ? ` · ${r.year}` : ""} · {r.provenance === "mock" ? "synthetic fixture" : "Qloo"}
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
                <button type="button" className="tp-btn tp-btn--amber tp-btn--wide" disabled={!p.canStart || p.busy} onClick={p.onStart}>
                  <span>{startLabel}</span>
                  {!p.starting ? <ArrowRight size={18} /> : null}
                </button>
                {target ? (
                  <p className="tp-results__hint">
                    Next: {p.mode === "mock" ? `synthetic sample ${target.pluralLabel}` : `real ${target.pluralLabel} from Qloo`}, up to three questions, then one
                    place to start.
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        <div className="tp-hero__art">
          <ProjectorArt className="tp-projector" />
        </div>
      </section>

    </>
  );
}
