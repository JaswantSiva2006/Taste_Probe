"use client";

import { domainLabel, type DiscoveryView, type PreferenceResponse, type ProviderMode } from "@/lib/contracts";
import { lookOf } from "@/lib/ui/domains";
import { historyAnswer, questionCredit, shortTitle, tasteNotes, updateNotice, type NameBook } from "@/lib/ui/presentation";
import { DomainGlyph } from "./DomainGlyph";
import { Check, Cross, Reel, Refresh } from "./Icons";
import { Intertitle } from "./Intertitle";
import { ResultShelf } from "./ResultShelf";

export function Reels({ done, total, label }: { done: number; total: number; label: string }) {
  return (
    <span className="tp-reels" role="img" aria-label={label}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`tp-reels__pip${i < done ? " is-on" : ""}`}>
          <Reel size={16} />
        </span>
      ))}
    </span>
  );
}

export function TasteNotes({
  view,
  names,
  title = "Your taste notes",
  empty = "Nothing confirmed yet. Answers you give will appear here.",
}: {
  view: DiscoveryView;
  names: NameBook;
  title?: string;
  empty?: string;
}) {
  // Picks set aside with "Not for me" are listed separately from answer-level preferences.
  const setAside = new Set(view.exploration?.rejectedRecommendationIds ?? []);
  const notes = tasteNotes(view, names).filter((n) => !(n.target === "entity" && n.kind === "passed" && setAside.has(n.id)));
  const history = view.exploration?.answerHistory ?? [];
  const rounds = view.exploration?.round ?? 1;
  return (
    <section className="tp-notes" aria-labelledby="tp-notes-title">
      <h2 className="tp-notes__title" id="tp-notes-title">
        {title}
        {view.exploration && rounds > 1 ? <span className="tp-notes__span"> · across {rounds} rounds</span> : null}
      </h2>
      {notes.length ? (
        <ul className="tp-notes__list">
          {notes.map((n) => (
            <li key={`${n.kind}-${n.id}`} className={`tp-note tp-note--${n.kind}`}>
              {n.kind === "liked" ? <Check size={14} /> : <Cross size={14} />}
              <span className="tp-sr">{n.kind === "liked" ? "Liked: " : "Passed on: "}</span>
              {n.label}
            </li>
          ))}
        </ul>
      ) : (
        <p className="tp-notes__empty">{empty}</p>
      )}
      {setAside.size ? (
        <div className="tp-notes__group">
          <h3 className="tp-notes__sub">Not for me</h3>
          <ul className="tp-notes__list">
            {[...setAside].map((id) => (
              <li key={id} className="tp-note tp-note--setaside">
                <Cross size={14} />
                <span className="tp-sr">Set aside: </span>
                {shortTitle(names.entity(id))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {history.length ? (
        <details className="tp-history">
          <summary>
            Your answers so far ({history.length})
          </summary>
          <ol className="tp-history__list">
            {history.map((h, i) => {
              const a = historyAnswer(h);
              return (
                <li key={`${h.questionId}-${i}`} className={`tp-history__item tp-history__item--${a.kind}`}>
                  <span className="tp-history__round">Round {h.round}</span>
                  <span className="tp-history__label">{h.label}</span>
                  <span className="tp-history__answer">{a.text}</span>
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

export function Workspace({
  view,
  names,
  mode,
  pending,
  pendingResponse,
  onAnswer,
  onFinish,
}: {
  view: DiscoveryView;
  names: NameBook;
  mode: ProviderMode | null;
  pending: "answer" | "finish" | null;
  pendingResponse: PreferenceResponse | null;
  onAnswer: (r: PreferenceResponse) => void;
  onFinish: () => void;
}) {
  const question = view.currentQuestion;
  const notice = updateNotice(view, names);
  const remaining = view.maxQuestions - view.questionCount;
  const busy = pending !== null;
  const plural = domainLabel(view.targetType, true);
  const count = view.recommendations.length;

  return (
    <div className="tp-work">
      <header className="tp-strip">
        <div className="tp-strip__seed">
          <span className="tp-strip__label">
            From {domainLabel(view.seed.entityType)} to {plural}
          </span>
          <span className="tp-strip__film">
            <span className="tp-strip__glyph" aria-hidden="true">
              <DomainGlyph glyph={lookOf(view.seed.entityType).glyph} size={20} />
            </span>
            {view.seed.name}
            {view.seed.year ? <span className="tp-strip__year"> ({view.seed.year})</span> : null}
          </span>
        </div>
        <div className="tp-strip__progress">
          {view.exploration ? <span className="tp-round-pill">Round {view.exploration.round}</span> : null}
          <Reels
            done={view.questionCount}
            total={view.maxQuestions}
            label={`${view.exploration ? `Round ${view.exploration.round}, ` : ""}question ${view.questionCount} of up to ${view.maxQuestions}`}
          />
          <span className="tp-strip__left">
            {remaining === 0 ? "Final question" : `Up to ${remaining} more ${remaining === 1 ? "question" : "questions"}`}
          </span>
        </div>
        <button type="button" className="tp-btn tp-btn--ghost" onClick={onFinish} disabled={busy}>
          {pending === "finish" ? "Preparing your way in…" : "Show my way in"}
        </button>
      </header>

      <div className="tp-work__grid">
        <div className="tp-work__stage">
          {question ? (
            <div className="tp-stage__q" key={question.questionId}>
              <Intertitle
                view={view}
                question={question}
                names={names}
                credit={questionCredit(view, mode)}
                pendingResponse={pendingResponse}
                disabled={busy}
                onAnswer={onAnswer}
              />
            </div>
          ) : null}
          <p className="tp-pending" role="status" aria-live="polite">
            {pending === "answer" ? (
              <>
                <Refresh size={16} className="tp-spin" /> Recording your answer and updating your {plural}…
              </>
            ) : null}
          </p>
          {notice && !pending ? (
            // On narrow screens the shelf sits below the fold; surface the consequence here.
            <a className="tp-jump" href="#tp-shelf-title">
              <span>{notice.mechanism === "UNCHANGED" ? "Your picks held steady" : `See how your ${plural} changed`}</span>
              <span aria-hidden="true">↓</span>
            </a>
          ) : null}
          <TasteNotes view={view} names={names} />
        </div>

        <section className="tp-work__shelf" aria-labelledby="tp-shelf-title">
          <div className="tp-shelf__head">
            <h2 className="tp-shelf__title" id="tp-shelf-title" tabIndex={-1}>
              Your {plural}
            </h2>
            <span className="tp-shelf__count">
              {count} {domainLabel(view.targetType, count !== 1)}
            </span>
          </div>
          {view.degraded ? (
            <p className="tp-notice tp-notice--warn" role="status">
              Qloo didn’t respond to the refresh, so your current {plural} were kept unchanged.
            </p>
          ) : null}
          {notice ? (
            <div className={`tp-notice tp-notice--${notice.mechanism.toLowerCase()}`} role="status" key={`${view.revision}`}>
              <strong>{notice.title}</strong>
              <span>{notice.detail}</span>
            </div>
          ) : (
            <p className="tp-shelf__intro">
              {view.recommendations.some((r) => r.candidate.evidence.source === "mock") ? "Synthetic sample" : "Qloo’s"} {plural} for fans of{" "}
              {view.seed.name}, best match first.{" "}
              {view.exploration && view.exploration.round > 1
                ? `Round ${view.exploration.round} starts from everything you’ve told us${
                    view.exploration.rejectedRecommendationIds.length ? "; picks you set aside are gone" : ""
                  }.`
                : "Your answers reorder them."}
            </p>
          )}
          <ResultShelf
            items={view.recommendations}
            names={names}
            // Movement is shown only for an answer given in this round (S9.7).
            hasPrevious={Boolean(view.lastAnswer) && (!view.exploration || (view.lastAnswer!.round ?? 1) === view.exploration.round)}
            label={`Recommended ${plural}, best match first`}
          />
        </section>
      </div>
    </div>
  );
}
