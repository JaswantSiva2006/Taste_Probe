"use client";

import type { DiscoveryView, PreferenceResponse, ProviderMode } from "@/lib/contracts";
import { questionCredit, tasteNotes, updateNotice, type NameBook } from "@/lib/ui/presentation";
import { BookShelf } from "./BookShelf";
import { Check, Cross, Reel, Refresh } from "./Icons";
import { Intertitle } from "./Intertitle";

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

export function TasteNotes({ view, names, title = "Your taste notes" }: { view: DiscoveryView; names: NameBook; title?: string }) {
  const notes = tasteNotes(view, names);
  return (
    <section className="tp-notes" aria-labelledby="tp-notes-title">
      <h2 className="tp-notes__title" id="tp-notes-title">
        {title}
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
        <p className="tp-notes__empty">Nothing confirmed yet. Answers you give will appear here.</p>
      )}
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

  return (
    <div className="tp-work">
      <header className="tp-strip">
        <div className="tp-strip__seed">
          <span className="tp-strip__label">Now screening</span>
          <span className="tp-strip__film">
            {view.seed.name}
            {view.seed.year ? <span className="tp-strip__year"> ({view.seed.year})</span> : null}
          </span>
        </div>
        <div className="tp-strip__progress">
          <Reels done={view.questionCount} total={view.maxQuestions} label={`Question ${view.questionCount} of ${view.maxQuestions}`} />
          <span className="tp-strip__left">
            {remaining === 0 ? "Final question" : `Up to ${remaining} more ${remaining === 1 ? "question" : "questions"}`}
          </span>
        </div>
        <button type="button" className="tp-btn tp-btn--ghost" onClick={onFinish} disabled={busy}>
          {pending === "finish" ? "Printing your programme…" : "End screening, show my books"}
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
                <Refresh size={16} className="tp-spin" /> Recording your answer and updating the shelf…
              </>
            ) : null}
          </p>
          {notice && !pending ? (
            // On narrow screens the shelf sits below the fold; surface the consequence here.
            <a className="tp-jump" href="#tp-shelf-title">
              <span>{notice.mechanism === "UNCHANGED" ? "Your shelf held steady" : "See how your shelf changed"}</span>
              <span aria-hidden="true">↓</span>
            </a>
          ) : null}
          <TasteNotes view={view} names={names} />
        </div>

        <section className="tp-work__shelf" aria-labelledby="tp-shelf-title">
          <div className="tp-shelf__head">
            <h2 className="tp-shelf__title" id="tp-shelf-title" tabIndex={-1}>
              Your shelf
            </h2>
            <span className="tp-shelf__count">{view.recommendations.length} books</span>
          </div>
          {view.degraded ? (
            <p className="tp-notice tp-notice--warn" role="status">
              Qloo didn’t respond to the refresh, so your current shelf was kept unchanged.
            </p>
          ) : null}
          {notice ? (
            <div className={`tp-notice tp-notice--${notice.mechanism.toLowerCase()}`} role="status" key={`${view.revision}`}>
              <strong>{notice.title}</strong>
              <span>{notice.detail}</span>
            </div>
          ) : (
            <p className="tp-shelf__intro">Qloo’s picks for fans of {view.seed.name}, best match first. Your answers reorder them.</p>
          )}
          <BookShelf items={view.recommendations} names={names} hasPrevious={Boolean(view.lastAnswer)} />
        </section>
      </div>
    </div>
  );
}
