"use client";

import { domainLabel, type DiscoveryView, type RankedRecommendation } from "@/lib/contracts";
import { splitTitle } from "@/lib/ui/presentation";
import {
  answeredCount,
  BASIS_LABEL,
  closesAt,
  continueBlockedCopy,
  finishLine,
  resolvePath,
  ROLE_LABEL,
  type NameBook,
  type ResolvedPathItem,
} from "@/lib/ui/presentation";
import { ArrowRight, Check, Cross, Refresh } from "./Icons";
import { ResultCard } from "./ResultShelf";
import { TasteNotes } from "./Workspace";

type ActionKind = "reject" | "accept" | "continue";

type Props = {
  view: DiscoveryView;
  names: NameBook;
  pending: ActionKind | null;
  busy: boolean;
  onReject: (entityId: string) => void;
  onAccept: (entityId: string) => void;
  onContinue: () => void;
  onRestart: () => void;
  onNewAnchor: () => void;
};

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
 * S9.7 per-pick actions. "I'll try this" (primary) records an intention; "Not for me"
 * (secondary) withdraws only this pick. Names are unique per card for assistive tech.
 */
function PickActions({ rec, busy, onAccept, onReject, size = "md" }: { rec: RankedRecommendation; busy: boolean; onAccept: Props["onAccept"]; onReject: Props["onReject"]; size?: "md" | "sm" }) {
  const title = splitTitle(rec.candidate.name).title;
  const sm = size === "sm" ? " tp-btn--sm" : "";
  return (
    <div className={`tp-pick-actions tp-pick-actions--${size}`}>
      <button type="button" className={`tp-btn tp-btn--ink-solid${sm}`} disabled={busy} aria-label={`I’ll try this: ${title}`} onClick={() => onAccept(rec.candidate.entityId)}>
        <Check size={size === "sm" ? 16 : 18} />
        <span>I’ll try this</span>
      </button>
      <button type="button" className={`tp-btn tp-btn--ink${sm}`} disabled={busy} aria-label={`Not for me: ${title}`} onClick={() => onReject(rec.candidate.entityId)}>
        <Cross size={size === "sm" ? 16 : 18} />
        <span>Not for me</span>
      </button>
    </div>
  );
}

const PENDING_COPY: Record<ActionKind, string> = {
  accept: "Saving your choice…",
  reject: "Updating your picks…",
  continue: "Opening the next round…",
};

/**
 * The finale: a printed programme titled "Your way in". START HERE is the backend's
 * first featured role; supporting roles follow in backend order. Nothing is re-ranked,
 * invented or linked out. From S9.7 the programme is also where an exploration
 * continues: accept, reject a pick, or keep exploring in the same exploration.
 */
export function Programme(p: Props) {
  const { view, names } = p;
  const ex = view.exploration;
  if (ex?.status === "accepted") return <AcceptedProgramme {...p} />;
  const plural = domainLabel(view.targetType, true);
  const sourceNoun = domainLabel(view.seed.entityType);
  const answered = answeredCount(view);
  const isMock = view.recommendations.some((r) => r.candidate.evidence.source === "mock");
  const path = resolvePath(view);
  const [lead, ...support] = path?.featured ?? [];
  const others = path ? path.others : view.recommendations.slice(1);
  const fallbackTop = !path ? view.recommendations[0] : undefined;
  const actionable = Boolean(ex); // older servers have no feedback endpoints
  const blocked = continueBlockedCopy(view);

  return (
    <article className="tp-programme" aria-labelledby="tp-programme-title" aria-busy={p.busy}>
      <header className="tp-programme__head">
        <p className="tp-programme__kicker">
          Your way in{ex ? <span className="tp-round"> · Round {ex.round}</span> : null}
        </p>
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

      <p className="tp-sr" role="status" aria-live="polite">
        {p.pending ? PENDING_COPY[p.pending] : ""}
      </p>

      {lead ? (
        <section className="tp-start" aria-labelledby="tp-start-label">
          <p className="tp-start__label" id="tp-start-label" tabIndex={-1}>
            {ROLE_LABEL[lead.item.role]}
          </p>
          <ResultCard item={lead.rec} names={names} hasPrevious={false} featured showRank={false} />
          <div className="tp-start__actions">
            <Why entry={lead} summary="Why this starting point?" />
            {actionable ? (
              <div className="tp-start__intent">
                <PickActions rec={lead.rec} busy={p.busy} onAccept={p.onAccept} onReject={p.onReject} />
                <p className="tp-start__note">“I’ll try this” saves it as your starting point; it doesn’t mean you’ve tried it. “Not for me” sets aside only this {domainLabel(view.targetType)}.</p>
              </div>
            ) : null}
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
                {actionable ? <PickActions rec={entry.rec} busy={p.busy} onAccept={p.onAccept} onReject={p.onReject} size="sm" /> : null}
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
                {actionable ? <PickActions rec={item} busy={p.busy} onAccept={p.onAccept} onReject={p.onReject} size="sm" /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ex ? (
        <section className="tp-continue" aria-labelledby="tp-continue-title">
          <div>
            <h2 className="tp-continue__title" id="tp-continue-title">
              Not quite there?
            </h2>
            {blocked ? (
              <p className="tp-continue__body tp-continue__body--blocked">{blocked}</p>
            ) : (
              <p className="tp-continue__body">
                Keep exploring and TasteProbe carries everything you’ve told it into round {ex.round + 1}: up to three new questions, none repeated. Nothing is set aside unless you say “Not for me”.
              </p>
            )}
            <p className="tp-continue__meta">
              This exploration stays open until {closesAt(ex.expiresAt)}; after that, start a new one.
            </p>
          </div>
          <button type="button" className="tp-btn tp-btn--amber tp-continue__btn" disabled={!ex.canContinue || p.busy} onClick={p.onContinue}>
            {p.pending === "continue" ? <Refresh size={18} className="tp-spin" /> : null}
            <span>{p.pending === "continue" ? "Opening the next round…" : "Keep exploring"}</span>
            {p.pending === "continue" ? null : <ArrowRight size={18} />}
          </button>
        </section>
      ) : null}

      <footer className="tp-programme__foot">
        <TasteNotes view={view} names={names} title="What you told us" empty="No preferences were confirmed, so nothing was assumed about you." />
        <div className="tp-programme__restart">
          <button type="button" className="tp-btn tp-btn--ghost" onClick={p.onRestart} disabled={p.busy}>
            Explore another world
          </button>
          <button type="button" className="tp-btn tp-btn--ghost" onClick={p.onNewAnchor} disabled={p.busy}>
            Try another {sourceNoun}
          </button>
        </div>
      </footer>
    </article>
  );
}

/** Completed state: the user chose a starting point. An intention, never a claim of consumption. */
function AcceptedProgramme({ view, names, onRestart, onNewAnchor }: Props) {
  const ex = view.exploration!;
  const chosen = view.recommendations.find((r) => r.candidate.entityId === ex.acceptedEntityId);
  const path = resolvePath(view);
  const why = path?.featured.find((f) => f.item.recommendationEntityId === ex.acceptedEntityId);
  const noun = domainLabel(view.targetType);
  const title = chosen ? splitTitle(chosen.candidate.name).title : null;
  const rounds = ex.round === 1 ? "one round" : `${ex.round} rounds`;
  const questions = ex.totalQuestionsAsked === 1 ? "1 question" : `${ex.totalQuestionsAsked} questions`;
  return (
    <article className="tp-programme tp-programme--accepted" aria-labelledby="tp-programme-title">
      <header className="tp-programme__head">
        <p className="tp-programme__kicker">Your starting point</p>
        <h1 className="tp-programme__title" id="tp-programme-title" tabIndex={-1}>
          {title ? (
            <>
              You’ll start with <em>{title}</em>.
            </>
          ) : (
            <>Your starting point is saved.</>
          )}
        </h1>
        <p className="tp-programme__sub">
          Saved as the {noun} you plan to try next, found from <em>{view.seed.name}</em> over {rounds} and {questions}. TasteProbe records only your intention; nothing is marked as finished.
        </p>
      </header>
      {chosen ? (
        <section className="tp-start tp-start--accepted" aria-label="Chosen starting point">
          <p className="tp-start__label tp-start__label--chosen">
            <Check size={14} /> On your list to try
          </p>
          <ResultCard item={chosen} names={names} hasPrevious={false} featured showRank={false} />
          {why ? (
            <div className="tp-start__actions">
              <Why entry={why} summary="Why this starting point?" />
            </div>
          ) : null}
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
            Try another {domainLabel(view.seed.entityType)}
          </button>
        </div>
      </footer>
    </article>
  );
}
