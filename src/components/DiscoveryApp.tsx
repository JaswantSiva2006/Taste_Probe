"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, ApiClientError } from "@/lib/api-client";
import type { DiscoveryView, EntitySummary, PreferenceResponse, ProviderMode } from "@/lib/contracts";
import { RecommendationList } from "./RecommendationList";

type Pending = null | "search" | "start" | "answer" | "finish";

const RESPONSE_LABELS: Record<PreferenceResponse, string> = {
  like: "Yes, more of this",
  dislike: "No, less of this",
  prefer_a: "Prefer the first",
  prefer_b: "Prefer the second",
  both: "Both",
  neither: "Neither",
  unknown: "Not sure / skip",
};

const FINISH_TEXT = {
  user_finished: "You finished early.",
  question_budget_exhausted: "All questions answered.",
  stable_recommendations: "No further question could change the ranking.",
} as const;

function errorText(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.message} (${error.code}${error.requestId ? `, request ${error.requestId}` : ""})`;
  }
  return "Something went wrong.";
}

function MockNotice({ mode }: { mode: ProviderMode | null }) {
  if (mode === "live") {
    return (
      <div className="rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
        Live mode is configured, but live Qloo integration is not implemented yet; requests will fail
        until it is. Run <code>npm run dev:mock</code> to use synthetic data.
      </div>
    );
  }
  return (
    <div role="note" className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
      <strong>MOCK DATA.</strong> Every entity, recommendation, tag and score shown here is a synthetic
      fixture. Nothing is fetched from Qloo, and the question agent is a deterministic mock (no Gemini).
    </div>
  );
}

export function DiscoveryApp() {
  const [mode, setMode] = useState<ProviderMode | null>(null);
  const [query, setQuery] = useState("Interstellar");
  const [results, setResults] = useState<EntitySummary[] | null>(null);
  const [selected, setSelected] = useState<EntitySummary | null>(null);
  const [view, setView] = useState<DiscoveryView | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(
      (r) => setMode(r.mode),
      (e: unknown) => setError(errorText(e)),
    );
  }, []);

  async function run<T>(kind: Pending, fn: () => Promise<{ data: T; mode: ProviderMode }>, onOk: (data: T) => void) {
    setPending(kind);
    setError(null);
    try {
      const r = await fn();
      setMode(r.mode);
      onOk(r.data);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  }

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setSelected(null);
    setView(null);
    void run("search", () => api.search(query, "movie"), (d) => setResults(d.results));
  };

  const onStart = () => {
    if (!selected) return;
    void run(
      "start",
      () =>
        api.start({
          entityQuery: selected.name,
          sourceType: "movie",
          targetType: "book",
          maxQuestions: 3,
          selectedEntityId: selected.entityId,
        }),
      setView,
    );
  };

  const onAnswer = (response: PreferenceResponse) => {
    if (!view?.currentQuestion) return;
    const { sessionToken } = view;
    const { questionId } = view.currentQuestion;
    void run("answer", () => api.answer(sessionToken, questionId, response), setView);
  };

  const onFinish = () => {
    if (!view) return;
    const { sessionToken } = view;
    void run("finish", () => api.finish(sessionToken), setView);
  };

  const reset = () => {
    setView(null);
    setSelected(null);
    setResults(null);
    setError(null);
  };

  const busy = pending !== null;
  const btn =
    "rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold">TasteProbe</h1>
        <p className="text-sm text-slate-500">
          Start from a favourite movie, answer up to 3 questions, and watch the book shortlist adapt.
        </p>
      </header>

      <MockNotice mode={mode} />

      {error && (
        <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
          {error}
        </div>
      )}

      {!view && (
        <section className="space-y-3">
          <form onSubmit={onSearch} className="flex gap-2">
            <label htmlFor="q" className="sr-only">
              Movie title
            </label>
            <input
              id="q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a movie, e.g. Interstellar"
              className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900"
            />
            <button type="submit" disabled={busy || !query.trim()} className={`${btn} bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900`}>
              {pending === "search" ? "Searching…" : "Search"}
            </button>
          </form>

          {results && results.length === 0 && <p className="text-sm text-slate-500">No matching movies.</p>}
          {results && results.length > 0 && (
            <ul className="space-y-2">
              {results.map((r) => (
                <li key={r.entityId}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setSelected(r)}
                    aria-pressed={selected?.entityId === r.entityId}
                    className={`w-full rounded-lg border p-3 text-left text-sm ${
                      selected?.entityId === r.entityId
                        ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950"
                        : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
                    }`}
                  >
                    <span className="font-medium">{r.name}</span>
                    {r.year && <span className="text-slate-500"> ({r.year})</span>}
                    <span className="ml-2 text-xs uppercase text-slate-400">
                      {r.entityType} · {r.provenance === "mock" ? "mock" : "qloo"} · {r.entityId}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button type="button" onClick={onStart} disabled={busy || !selected} className={`${btn} bg-indigo-600 text-white`}>
            {pending === "start" ? "Starting discovery…" : selected ? `Find books for “${selected.name}”` : "Select a movie to start"}
          </button>
        </section>
      )}

      {view && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p>
              Seed: <strong>{view.seed.name}</strong> → {view.targetType}s
            </p>
            <p className="text-slate-500">
              Questions {view.questionCount}/{view.maxQuestions} · Qloo calls {view.usage.qlooCallCount}/
              {view.usage.maxQlooCalls}
            </p>
          </div>

          {view.status === "asking" && view.currentQuestion && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950">
              <p className="text-xs font-semibold uppercase text-indigo-700 dark:text-indigo-300">
                Question {view.questionCount} of {view.maxQuestions}
              </p>
              <p className="mt-1 font-medium">{view.currentQuestion.text}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {view.currentQuestion.allowedResponses.map((r) => (
                  <button
                    key={r}
                    type="button"
                    disabled={busy}
                    onClick={() => onAnswer(r)}
                    className={`${btn} border border-indigo-300 bg-white text-indigo-900 dark:bg-slate-900 dark:text-indigo-100`}
                  >
                    {RESPONSE_LABELS[r]}
                  </button>
                ))}
                <button type="button" disabled={busy} onClick={onFinish} className={`${btn} ml-auto bg-slate-200 text-slate-900`}>
                  {pending === "finish" ? "Finishing…" : "Finish now"}
                </button>
              </div>
              {pending === "answer" && <p className="mt-2 text-xs text-slate-500">Submitting answer…</p>}
            </div>
          )}

          {view.lastAnswer && view.status === "asking" && (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Last answer: <strong>{RESPONSE_LABELS[view.lastAnswer.response]}</strong>.{" "}
              {view.rankingChanged
                ? "The ranking changed — arrows show how far each book moved."
                : "The ranking did not change."}
            </p>
          )}

          {view.status === "finished" && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
              <strong>Final recommendations.</strong> {view.finishReason ? FINISH_TEXT[view.finishReason] : ""}
            </div>
          )}

          <h2 className="text-lg font-semibold">
            {view.status === "finished" ? `Top ${view.recommendations.length} books` : "Current shortlist"}
          </h2>
          <RecommendationList items={view.recommendations} />

          <button type="button" onClick={reset} disabled={busy} className={`${btn} bg-slate-200 text-slate-900`}>
            Start over
          </button>
        </section>
      )}
    </main>
  );
}
