"use client";

import type { DiscoveryView, PreferenceResponse, Question } from "@/lib/contracts";
import { answerLabel, isSkip, splitTitle, type NameBook } from "@/lib/ui/presentation";
import { BookCover } from "./BookCover";

/**
 * The adaptive question as a silent-film intertitle. Keyed by question ID by the
 * parent, so each new question plays the iris-in reveal once.
 */
export function Intertitle({
  view,
  question,
  names,
  credit,
  pendingResponse,
  disabled,
  onAnswer,
}: {
  view: DiscoveryView;
  question: Question;
  names: NameBook;
  credit: string;
  pendingResponse: PreferenceResponse | null;
  disabled: boolean;
  onAnswer: (response: PreferenceResponse) => void;
}) {
  const primary = question.allowedResponses.filter((r) => !isSkip(r));
  const skips = question.allowedResponses.filter(isSkip);
  const pair =
    question.targetType === "entity"
      ? question.targetIds.map((id) => view.recommendations.find((r) => r.candidate.entityId === id)?.candidate ?? null)
      : [];
  const showPair = pair.length === 2 && Boolean(pair[0] && pair[1]);
  // Entity comparisons name both books in the approved wording; with the A/B panel
  // showing those titles, the heading shows the prompt and keeps the full text for AT.
  const prompt = showPair ? /^(.*?)\s*:\s*“/.exec(question.text)?.[1] : undefined;

  return (
    <section className="tp-intertitle" aria-labelledby="tp-question">
      <div className="tp-intertitle__card">
        <span className="tp-intertitle__corner tp-intertitle__corner--tl" aria-hidden="true" />
        <span className="tp-intertitle__corner tp-intertitle__corner--tr" aria-hidden="true" />
        <span className="tp-intertitle__corner tp-intertitle__corner--bl" aria-hidden="true" />
        <span className="tp-intertitle__corner tp-intertitle__corner--br" aria-hidden="true" />
        <p className="tp-intertitle__count">
          Question {view.questionCount} of {view.maxQuestions}
        </p>
        <h2 className="tp-intertitle__text" id="tp-question" tabIndex={-1}>
          {prompt ? (
            <>
              <span aria-hidden="true">{prompt}?</span>
              <span className="tp-sr">{question.text}</span>
            </>
          ) : (
            question.text
          )}
        </h2>
        {showPair ? (
          <div className="tp-versus">
            {pair.map((c, i) => (
              <figure key={c!.entityId} className="tp-versus__item">
                <BookCover id={c!.entityId} name={c!.name} imageUrl={c!.imageUrl} size="sm" />
                <figcaption>
                  <span className="tp-versus__letter">{i === 0 ? "Option A" : "Option B"}</span>
                  {splitTitle(c!.name).title}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : null}
        <p className="tp-intertitle__credit">{credit}</p>
      </div>

      <fieldset className="tp-answers" disabled={disabled}>
        <legend className="tp-sr">Your answer</legend>
        <div className={`tp-answers__primary tp-answers__primary--${primary.length}`}>
          {primary.map((r) => (
            <button
              key={r}
              type="button"
              className={`tp-answer tp-answer--${r}`}
              aria-pressed={pendingResponse === r}
              onClick={() => onAnswer(r)}
            >
              {answerLabel(r, question, names)}
            </button>
          ))}
        </div>
        {skips.map((r) => (
          <button key={r} type="button" className="tp-answer tp-answer--skip" aria-pressed={pendingResponse === r} onClick={() => onAnswer(r)}>
            {answerLabel(r, question, names)}
          </button>
        ))}
      </fieldset>
    </section>
  );
}
