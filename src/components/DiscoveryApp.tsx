"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiClientError } from "@/lib/api-client";
import type { DiscoveryView, EntitySummary, PreferenceResponse, ProviderMode } from "@/lib/contracts";
import { createNameBook, friendlyError, type FriendlyError } from "@/lib/ui/presentation";
import { Refresh, Reel } from "./Icons";
import { Landing } from "./Landing";
import { Programme } from "./Programme";
import { Workspace } from "./Workspace";

type Pending = null | "search" | "start" | "answer" | "finish";
type ShownError = FriendlyError & { code: string; requestId?: string; retry?: () => void };

export function DiscoveryApp() {
  const [mode, setMode] = useState<ProviderMode | null>(null);
  const [query, setQuery] = useState("Interstellar");
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [results, setResults] = useState<EntitySummary[] | null>(null);
  const [selected, setSelected] = useState<EntitySummary | null>(null);
  const [view, setView] = useState<DiscoveryView | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [pendingResponse, setPendingResponse] = useState<PreferenceResponse | null>(null);
  const [error, setError] = useState<ShownError | null>(null);
  const names = useRef(createNameBook()).current;
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.health().then(
      (r) => setMode(r.mode),
      () => setMode(null),
    );
  }, []);

  // Move focus to the new primary heading whenever the screening advances.
  useEffect(() => {
    if (!view) return;
    const target = document.getElementById(view.status === "finished" ? "tp-programme-title" : "tp-question");
    target?.focus({ preventScroll: false });
  }, [view?.sessionId, view?.revision, view?.status, view]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function run<T>(kind: Pending, fn: () => Promise<{ data: T; mode: ProviderMode }>, onOk: (data: T) => void, retry: () => void) {
    setPending(kind);
    setError(null);
    try {
      const r = await fn();
      setMode(r.mode);
      onOk(r.data);
    } catch (e) {
      const code = e instanceof ApiClientError ? e.code : "UNKNOWN";
      const friendly = friendlyError(code);
      setError({ ...friendly, code, requestId: e instanceof ApiClientError ? e.requestId : undefined, retry: friendly.recovery === "retry" ? retry : undefined });
    } finally {
      setPending(null);
      setPendingResponse(null);
    }
  }

  const accept = (v: DiscoveryView) => {
    names.remember(v);
    setView(v);
  };

  function search() {
    const q = query.trim();
    if (!q) return;
    setSelected(null);
    void run(
      "search",
      () => api.search(q, "movie"),
      (d) => {
        setSearchedFor(q);
        setResults(d.results);
      },
      search,
    );
  }

  function start() {
    if (!selected) return;
    const film = selected;
    void run(
      "start",
      () => api.start({ entityQuery: film.name, sourceType: "movie", targetType: "book", maxQuestions: 3, selectedEntityId: film.entityId }),
      accept,
      start,
    );
  }

  function answer(response: PreferenceResponse) {
    if (!view?.currentQuestion) return;
    const { sessionToken } = view;
    const { questionId } = view.currentQuestion;
    setPendingResponse(response);
    const attempt = () => {
      setPendingResponse(response);
      void run("answer", () => api.answer(sessionToken, questionId, response), accept, attempt);
    };
    void run("answer", () => api.answer(sessionToken, questionId, response), accept, attempt);
  }

  function finish() {
    if (!view) return;
    const { sessionToken } = view;
    const attempt = () => void run("finish", () => api.finish(sessionToken), accept, attempt);
    attempt();
  }

  function restart() {
    setView(null);
    setError(null);
    setSelected(null);
    setResults(null);
    setSearchedFor(null);
    requestAnimationFrame(() => document.getElementById("tp-film")?.focus());
  }

  const busy = pending !== null;
  const phase = !view ? "landing" : view.status === "finished" ? "finale" : "discovery";

  return (
    <div className={`tp-app tp-app--${phase}`}>
      <a className="tp-skip" href="#tp-main">
        Skip to content
      </a>
      {mode === "mock" ? (
        <div className="tp-mockbar" role="note">
          <strong>Demo data.</strong> Mock mode: every film, book, tag and score is a synthetic fixture. No Qloo or Gemini calls are made.
        </div>
      ) : null}

      <header className="tp-top">
        <button type="button" className="tp-brand" onClick={restart} disabled={busy} aria-label="TasteProbe, start a new screening">
          <Reel size={22} />
          <span>TasteProbe</span>
        </button>
        <span className="tp-top__mode">
          {mode === "live" ? "Live · Qloo + Gemini" : mode === "mock" ? "Mock mode" : "Connecting…"}
        </span>
      </header>

      <main id="tp-main" className="tp-main">
        {error ? (
          <div className="tp-error" role="alert" tabIndex={-1} ref={errorRef}>
            <div>
              <strong>{error.title}.</strong> {error.body}
              {error.requestId ? <span className="tp-error__ref"> Reference {error.requestId.slice(0, 8)}.</span> : null}
            </div>
            <div className="tp-error__actions">
              {error.retry ? (
                <button type="button" className="tp-btn tp-btn--amber tp-btn--sm" onClick={error.retry} disabled={busy}>
                  <Refresh size={16} /> Try again
                </button>
              ) : null}
              {error.recovery === "restart" ? (
                <button type="button" className="tp-btn tp-btn--amber tp-btn--sm" onClick={restart}>
                  Start a new screening
                </button>
              ) : null}
              <button type="button" className="tp-btn tp-btn--ghost tp-btn--sm" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {phase === "landing" ? (
          <Landing
            mode={mode}
            query={query}
            onQuery={setQuery}
            onSearch={search}
            searching={pending === "search"}
            searchedFor={searchedFor}
            results={results}
            selected={selected}
            onSelect={setSelected}
            onStart={start}
            starting={pending === "start"}
            busy={busy}
          />
        ) : null}
        {phase === "discovery" && view ? (
          <Workspace
            view={view}
            names={names}
            mode={mode}
            pending={pending === "answer" || pending === "finish" ? pending : null}
            pendingResponse={pendingResponse}
            onAnswer={answer}
            onFinish={finish}
          />
        ) : null}
        {phase === "finale" && view ? <Programme view={view} names={names} onRestart={restart} /> : null}
      </main>

      <footer className="tp-foot">
        <p>
          {mode === "mock"
            ? "This demo runs on synthetic fixtures. The live build uses Qloo Insights for recommendations and Google Gemini to choose among optimizer-approved questions."
            : "Recommendations from Qloo Insights. Questions chosen by Google Gemini from options TasteProbe’s optimizer approves."}{" "}
          Built for the Qloo Agentic Hackathon.
        </p>
      </footer>
    </div>
  );
}
