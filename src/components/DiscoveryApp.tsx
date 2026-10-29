"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiClientError } from "@/lib/api-client";
import type { DiscoveryView, EntitySummary, EntityType, PreferenceResponse, ProviderMode } from "@/lib/contracts";
import { isOfferedPair, sourceChoices, targetChoices } from "@/lib/ui/domains";
import { createNameBook, friendlyError, type FriendlyError } from "@/lib/ui/presentation";
import { Refresh, Reel } from "./Icons";
import { Landing, type Capabilities } from "./Landing";
import { Programme } from "./Programme";
import { Workspace } from "./Workspace";

type Pending = null | "search" | "start" | "answer" | "finish";
type ShownError = FriendlyError & { code: string; requestId?: string; retry?: () => void };

/**
 * State machine (derived from the server contracts):
 *   capabilities: loading → ready | error (retry)
 *   onboarding:   target → source (filtered by target) → search → explicit selection → start
 *   discovery:    view.status === "asking"  (answer → revision+1, or finish)
 *   finale:       view.status === "finished" (Discovery Path), restart → onboarding
 * Every transition is a real API response; the browser never decides availability.
 */
export function DiscoveryApp() {
  const [mode, setMode] = useState<ProviderMode | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities>({ status: "loading" });
  const [chosenTarget, setTarget] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [results, setResults] = useState<EntitySummary[] | null>(null);
  const [selected, setSelected] = useState<EntitySummary | null>(null);
  const [view, setView] = useState<DiscoveryView | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [pendingResponse, setPendingResponse] = useState<PreferenceResponse | null>(null);
  const [error, setError] = useState<ShownError | null>(null);
  const names = useRef(createNameBook()).current;
  const errorRef = useRef<HTMLDivElement>(null);

  const pairs = useMemo(() => (capabilities.status === "ready" ? capabilities.pairs : []), [capabilities]);
  // With a single destination there is nothing to choose; the anchor step opens directly.
  const targets = targetChoices(pairs);
  const target = chosenTarget ?? (targets.length === 1 ? targets[0]!.domain : null);

  const fetchCapabilities = useCallback(() => {
    api.health().then(
      (r) => {
        setMode(r.mode);
        // An older server without the projection offers nothing rather than guessed pairs.
        setCapabilities({ status: "ready", pairs: r.data.capabilities?.pairs ?? [] });
      },
      () => {
        setMode(null);
        setCapabilities({ status: "error" });
      },
    );
  }, []);

  useEffect(fetchCapabilities, [fetchCapabilities]);

  function retryCapabilities() {
    setCapabilities({ status: "loading" });
    fetchCapabilities();
  }

  // Move focus to the new primary heading whenever the exploration advances.
  useEffect(() => {
    if (!view) return;
    const el = document.getElementById(view.status === "finished" ? "tp-programme-title" : "tp-question");
    el?.focus({ preventScroll: false });
  }, [view?.sessionId, view?.revision, view?.status, view]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const labels = () => {
    const t = targetChoices(pairs).find((c) => c.domain === (view?.targetType ?? target));
    const s = sourceChoices(pairs, t?.domain ?? null).find((c) => c.domain === (view?.seed.entityType ?? source));
    return { targetLabel: t?.pluralLabel, sourceLabel: s?.label };
  };

  async function run<T>(kind: Pending, fn: () => Promise<{ data: T; mode: ProviderMode }>, onOk: (data: T) => void, retry: () => void) {
    setPending(kind);
    setError(null);
    try {
      const r = await fn();
      setMode(r.mode);
      onOk(r.data);
    } catch (e) {
      const code = e instanceof ApiClientError ? e.code : "UNKNOWN";
      const friendly = friendlyError(code, labels());
      // Retry is always a user click; nothing here re-sends automatically (429 included).
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

  function chooseTarget(domain: string) {
    setTarget(domain);
    const allowed = sourceChoices(pairs, domain);
    // Keep the anchor only if the new destination still allows it; a lone option is pre-chosen.
    const keep = source && allowed.some((s) => s.domain === source) ? source : allowed.length === 1 ? allowed[0]!.domain : null;
    if (keep !== source) {
      setSource(keep);
      setResults(null);
      setSelected(null);
      setSearchedFor(null);
    }
    setError(null);
  }

  function chooseSource(domain: string) {
    if (domain === source) return;
    setSource(domain);
    setResults(null);
    setSelected(null);
    setSearchedFor(null);
    setError(null);
    requestAnimationFrame(() => document.getElementById("tp-anchor")?.focus());
  }

  function search() {
    const q = query.trim();
    if (!q || !source) return;
    const type = source as EntityType;
    setSelected(null);
    void run(
      "search",
      () => api.search(q, type),
      (d) => {
        setSearchedFor(q);
        setResults(d.results);
      },
      search,
    );
  }

  const canStart = Boolean(selected && isOfferedPair(pairs, source, target) && selected.entityType === source);

  function start() {
    if (!selected || !canStart) return;
    const anchor = selected;
    const input = {
      entityQuery: anchor.name,
      sourceType: source as EntityType,
      targetType: target as EntityType,
      maxQuestions: 3 as const,
      selectedEntityId: anchor.entityId,
    };
    void run("start", () => api.start(input), accept, start);
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

  /** Back to the start: a new world (default) or the same world with a new anchor. */
  function restart(keepWorld = false) {
    setView(null);
    setError(null);
    setSelected(null);
    setResults(null);
    setSearchedFor(null);
    setQuery("");
    if (!keepWorld) {
      setTarget(null);
      setSource(null);
    }
    requestAnimationFrame(() => {
      const focus = keepWorld ? document.getElementById("tp-anchor") : document.querySelector<HTMLInputElement>('input[name="tp-target"]');
      (focus ?? document.getElementById("tp-hero-title"))?.focus();
    });
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
          <strong>Demo data.</strong> Mock mode: every title, tag and score is a synthetic fixture. No Qloo or Gemini calls are made.
        </div>
      ) : null}

      <header className="tp-top">
        <button type="button" className="tp-brand" onClick={() => restart()} disabled={busy} aria-label="TasteProbe, start a new exploration">
          <Reel size={22} />
          <span>TasteProbe</span>
        </button>
        <span className="tp-top__mode">
          {mode === "live" ? "Live · Qloo + Gemini" : mode === "mock" ? "Mock mode" : capabilities.status === "error" ? "Offline" : "Connecting…"}
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
                <button type="button" className="tp-btn tp-btn--amber tp-btn--sm" onClick={() => restart(true)}>
                  Start again
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
            capabilities={capabilities}
            onRetryCapabilities={retryCapabilities}
            target={target}
            onTarget={chooseTarget}
            source={source}
            onSource={chooseSource}
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
            canStart={canStart}
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
        {phase === "finale" && view ? <Programme view={view} names={names} onRestart={() => restart()} onNewAnchor={() => restart(true)} /> : null}
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
