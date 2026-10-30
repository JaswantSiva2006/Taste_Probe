"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiClientError } from "@/lib/api-client";
import type { ArtistIntent, DiscoveryView, EntitySummary, EntityType, ListeningAction, PreferenceResponse, ProviderMode } from "@/lib/contracts";
import { isOfferedPair, sourceChoices, targetChoices } from "@/lib/ui/domains";
import { createNameBook, friendlyError, type FriendlyError } from "@/lib/ui/presentation";
import { Refresh, Reel } from "./Icons";
import { Landing, type Capabilities } from "./Landing";
import { Programme } from "./Programme";
import { Workspace } from "./Workspace";

type Pending = null | "search" | "start" | "answer" | "finish" | "reject" | "accept" | "continue" | "listen";
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
  /** Synchronous in-flight guard: a second click can arrive before React re-renders the disabled buttons. */
  const inFlight = useRef(false);
  const lastAction = useRef<Pending>(null);

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
    // After "Not for me", focus the replacement START HERE instead of jumping to the page title.
    const afterReject = lastAction.current === "reject" && view.exploration?.status === "presenting";
    // A listening action keeps focus in the listening room (S9.12).
    const afterListen = lastAction.current === "listen" && view.listening;
    const id = view.status !== "finished" ? "tp-question" : afterListen ? "tp-listen-title" : afterReject ? "tp-start-label" : "tp-programme-title";
    (document.getElementById(id) ?? document.getElementById("tp-programme-title"))?.focus({ preventScroll: false });
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
    if (inFlight.current) return;
    inFlight.current = true;
    lastAction.current = kind;
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
      inFlight.current = false;
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

  /**
   * S9.7 exploration actions. Each uses the token of the view the user is looking at;
   * on success the server's new view (and token) replaces it. They are never retried
   * automatically: "Try again" is a user click with the same token, so if the first
   * attempt did reach the server the store's revision check answers 409 instead of
   * applying it twice.
   */
  function rejectPick(entityId: string) {
    if (!view) return;
    const { sessionToken } = view;
    const attempt = () => void run("reject", () => api.reject(sessionToken, entityId), accept, attempt);
    attempt();
  }

  function acceptPick(entityId: string) {
    if (!view) return;
    const { sessionToken } = view;
    const attempt = () => void run("accept", () => api.accept(sessionToken, entityId), accept, attempt);
    attempt();
  }

  /** S9.12: start or switch listening (server picks a verified recording). */
  function listen(artistId?: string) {
    if (!view) return;
    const { sessionToken } = view;
    const attempt = () => void run("listen", () => api.listen(sessionToken, artistId), accept, attempt);
    attempt();
  }

  /** S9.12: one listening action on the recording the server presented. */
  function listenAction(action: ListeningAction, artistIntent?: ArtistIntent) {
    const current = view?.listening;
    if (!view || !current?.artist || !current.video) return;
    const { sessionToken } = view;
    const { entityId } = current.artist;
    const { videoId } = current.video;
    const attempt = () => void run("listen", () => api.listeningFeedback(sessionToken, entityId, videoId, action, artistIntent), accept, attempt);
    attempt();
  }

  function keepExploring() {
    if (!view?.exploration?.canContinue) return;
    const { sessionToken } = view;
    const attempt = () => void run("continue", () => api.continue(sessionToken), accept, attempt);
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
        {phase === "finale" && view ? (
          <Programme
            view={view}
            names={names}
            pending={pending === "reject" || pending === "accept" || pending === "continue" || pending === "listen" ? pending : null}
            busy={busy}
            onReject={rejectPick}
            onAccept={acceptPick}
            onContinue={keepExploring}
            onListen={listen}
            onListenAction={listenAction}
            onRestart={() => restart()}
            onNewAnchor={() => restart(true)}
          />
        ) : null}
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
