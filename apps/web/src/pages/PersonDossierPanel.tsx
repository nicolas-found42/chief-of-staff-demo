import {
  PersonResearchReadinessSchema,
  personOverviewClaims,
  summarizePersonClaims,
} from "@chief-of-staff-demo/shared";
import { EvidenceDate } from "./EvidenceDate";
import { PersonSourceInspector } from "./PersonSourceInspector";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PersonClaim,
  PersonProfile,
  PersonResearchEnqueueDecision,
  PersonDossier,
  PersonResearchProfileSummary,
  PersonResearchReadiness,
  PersonResearchSettings,
  PersonResearchAggregateStatus,
  PersonResearchDiagnosticsPage,
  PersonSourceDocument,
  PersonRelationshipRecord,
  PersonDossierAnalysis,
} from "@chief-of-staff-demo/shared";
import { ApiError, request, errorMessage } from "../client";

interface DossierView {
  profile?: PersonProfile;
  readiness?: PersonResearchReadiness;
  researchDecision?: PersonResearchEnqueueDecision;
  dossier: PersonDossier | null;
  /**
   * The bounded per-profile summary (issue #418, T5), not the whole
   * PersonResearchJob the dossier response used to embed (#417 F4).
   */
  research: PersonResearchProfileSummary | null;
}
export interface DossierClient {
  read(id: string, revision?: number): Promise<DossierView>;
  source(id: string, sourceId: string): Promise<PersonSourceDocument>;
  history(id: string): Promise<PersonRelationshipRecord[]>;
  analysis(id: string): Promise<PersonDossierAnalysis | null>;
  research(id: string): Promise<unknown>;
  detach(id: string, sourceId: string): Promise<unknown>;
  settings(): Promise<PersonResearchAggregateStatus & { readiness?: PersonResearchReadiness }>;
  configure(settings: Partial<PersonResearchSettings>): Promise<unknown>;
  /**
   * The bounded per-profile summary a normal poll reads (issue #418, T9,
   * spec §7): side-effect-free, never enqueues. Distinct from `read`, whose
   * dossier route retains its own intentional "viewed" scheduling nudge
   * (spec §7) and is not something routine polling should repeat every
   * cycle.
   */
  summary(id: string): Promise<PersonResearchProfileSummary | null>;
  /** Paged, source-free attempt history, fetched only on explicit demand. */
  diagnostics(id: string, cursor?: string): Promise<PersonResearchDiagnosticsPage | null>;
}
const api: DossierClient = {
  read: async (id, revision) =>
    revision === undefined
      ? request(`/api/people/${encodeURIComponent(id)}/dossier`)
      : {
          dossier: await request<PersonDossier>(
            `/api/people/${encodeURIComponent(id)}/dossier/revisions/${revision}`,
          ),
          research: null,
        },
  source: (id, sourceId) =>
    request(`/api/people/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}`),
  analysis: (id) => request(`/api/people/${encodeURIComponent(id)}/dossier-analysis`),
  history: (id) => request(`/api/people/${encodeURIComponent(id)}/relationship-history`),
  research: (id) => request(`/api/people/${encodeURIComponent(id)}/research`, { method: "POST" }),
  detach: (id, sourceId) =>
    request(
      `/api/people/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}/detach`,
      { method: "POST" },
    ),
  settings: () => request("/api/people/research/status"),
  configure: (settings) =>
    request("/api/people/research/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    }),
  summary: async (id) =>
    (
      await request<{ summary: PersonResearchProfileSummary | null }>(
        `/api/people/${encodeURIComponent(id)}/research/summary`,
      )
    ).summary,
  diagnostics: (id, cursor) =>
    request(
      `/api/people/${encodeURIComponent(id)}/research/diagnostics${
        cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    ),
};
const tabs = {
  overview: "Overview",
  career: "Career",
  work: "Body of work",
  expertise: "Expertise",
  ideas: "Writing & ideas",
  connections: "People & organisations",
  recognition: "Recognition",
  context: "Current context",
  history: "Relationship history",
  sources: "Sources",
};
/**
 * Copy for the pipeline-level readiness states (issue #418, T3/T9, spec §7).
 * `initializing` and `setup-required` read distinctly on purpose: a
 * transient identity refresh must never tell an owner to repeat completed
 * onboarding (#417 F7).
 */
function readinessSurface(readiness: PersonResearchReadiness): { title: string; detail: string } {
  switch (readiness.reason) {
    case "workspace-initializing":
      return {
        title: "Confirming workspace setup",
        detail:
          "The workspace is still starting up. This is temporary, not evidence that setup is missing.",
      };
    case "owner-identity-unresolved":
      return {
        title: "Confirming workspace setup",
        detail:
          "Confirming the connected owner identity. This is temporary, not evidence that setup is missing.",
      };
    case "provider-not-configured":
      return {
        title: "Research setup required",
        detail: "No model provider is configured for automatic research yet.",
      };
    case "owner-not-confirmed":
      return {
        title: "Research setup required",
        detail: "An owner has not yet confirmed workspace setup for automatic research.",
      };
    case "mock-provider-inactive":
      return {
        title: "Research disabled",
        detail:
          "Automatic research is disabled because the configured model provider is not a production provider.",
      };
    case "administratively-paused":
      return {
        title: "Workspace research paused",
        detail: "An owner paused automatic research for the workspace.",
      };
    default:
      return { title: "Research ready", detail: "" };
  }
}

/**
 * Copy for one Profile's job state, once the pipeline itself is ready (issue
 * #418, T9, spec §7). Never reads `research.stage` or `research.decisive` as
 * this operation's own outcome while `state === "researching"`: T5 left both
 * carrying the PREVIOUS settled operation's values mid-run (see task-graph.md
 * "Open finding from T5"), and doing so here would reproduce F5 on the
 * client. Live progress is built only from the always-current counters
 * (`calls`, `sources`) and the job's own in-progress detail.
 */
function jobStateSurface(research: PersonResearchProfileSummary): {
  title: string;
  detail: string;
} {
  const decisive =
    research.state === "researching" || research.decisive?.classification === "unknown"
      ? undefined
      : research.decisive;
  switch (research.state) {
    case "queued":
      return { title: "Queued for research", detail: research.detail };
    case "researching":
      return {
        title: "Researching",
        detail: `${research.calls} model ${research.calls === 1 ? "call" : "calls"} · source totals are available when this operation settles.`,
      };
    case "paused":
      return {
        title: "Waiting for capacity",
        detail: "Research is queued but waiting for available concurrency.",
      };
    case "interrupted":
      return { title: "Research interrupted", detail: decisive?.reason ?? research.detail };
    case "incomplete":
      return {
        title: "Research paused at a safety limit",
        detail: decisive?.reason ?? research.detail,
      };
    case "unavailable":
      return { title: "Sources unavailable", detail: decisive?.reason ?? research.detail };
    case "empty":
      /* Honest empty-answer copy (#417 F2, spec §7): a model that returned
         no usable answer is never rendered as "nothing was found", and a
         legitimate validated no-supported-facts result reads differently
         from both. Wording comes only from the decisive classification's
         own facts, never from matching against a message. */
      if (decisive?.classification === "no-usable-model-answer")
        return { title: "No usable extraction answer", detail: decisive.reason };
      if (decisive?.classification === "no-supported-facts")
        return { title: "No supported facts found", detail: decisive.reason };
      if (decisive?.classification === "grounding-or-subject-withheld")
        return { title: "Evidence withheld pending subject match", detail: decisive.reason };
      return { title: "No matched evidence found", detail: research.detail };
    case "current":
      return { title: "Current within completed scope", detail: research.detail };
  }
}

/** The single status surface to render for one Profile's research (issue #418, T9). */
function researchSurface(research: PersonResearchProfileSummary | null): {
  title: string;
  detail: string;
  nextAction?: PersonResearchProfileSummary["readiness"]["nextAction"];
} | null {
  if (!research) return null;
  if (research.readiness.state !== "ready") {
    const { title, detail } = readinessSurface(research.readiness);
    return {
      title,
      detail,
      ...(research.readiness.nextAction ? { nextAction: research.readiness.nextAction } : {}),
    };
  }
  return jobStateSurface(research);
}

export function PersonDossierPanel({
  profileId,
  client = api,
  onProfile,
}: {
  profileId: string;
  client?: DossierClient;
  onProfile?: (profile: PersonProfile) => void;
}) {
  const [revision, setRevision] = useState<number | undefined>(() => {
    const value = Number(new URLSearchParams(window.location.search).get("dossierRevision"));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  });
  const [latestRevision, setLatestRevision] = useState(0);
  const [view, setView] = useState<DossierView | null>(null);
  const [tab, setTab] = useState<keyof typeof tabs>("overview");
  const tabStrip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ before: false, after: false });
  const measureTabs = useCallback(() => {
    const strip = tabStrip.current;
    if (!strip) return;
    const before = strip.scrollLeft > 1;
    const after = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    setOverflow((previous) =>
      previous.before === before && previous.after === after ? previous : { before, after },
    );
  }, []);
  useEffect(() => {
    measureTabs();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureTabs);
    if (tabStrip.current) observer?.observe(tabStrip.current);
    window.addEventListener("resize", measureTabs);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureTabs);
    };
  }, [measureTabs]);
  useEffect(() => {
    const selected = tabStrip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (selected && typeof selected.scrollIntoView === "function")
      selected.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  const scrollTabs = (direction: number) => {
    const strip = tabStrip.current;
    strip?.scrollBy({ left: direction * strip.clientWidth * 0.75, behavior: "smooth" });
  };

  const [source, setSource] = useState<{
    id: string;
    quote: string;
    profileId: string;
    revision: number | undefined;
    attributedWhenOpened: boolean;
  } | null>(null);
  const [analysis, setAnalysis] = useState<PersonDossierAnalysis | null>(null);
  const [currentSources, setCurrentSources] = useState<{ profileId: string; ids: string[] } | null>(
    null,
  );
  const [history, setHistory] = useState<PersonRelationshipRecord[]>([]);
  const editingSettings = useRef(false);
  const settingsEditRevision = useRef(0);
  const [settings, setSettings] = useState<
    (PersonResearchAggregateStatus & { readiness?: PersonResearchReadiness }) | null
  >(null);
  const [readError, setReadError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [actionError, setActionError] = useState("");
  const [correctionNotice, setCorrectionNotice] = useState("");
  /** Paged full attempt history, fetched only on explicit demand (issue #418, T9, spec §7). */
  const [diagnosticsPage, setDiagnosticsPage] = useState<PersonResearchDiagnosticsPage | null>(
    null,
  );
  const [diagnosticsError, setDiagnosticsError] = useState("");
  const readGeneration = useRef(0);
  const reading = useRef(false);
  const polling = useRef(false);
  const viewRef = useRef<DossierView | null>(null);
  /**
   * The last-seen live counters (issue #418, T9): what the bounded summary
   * poll compares against to notice forward progress or a settled/live
   * transition. The summary never carries retained content, so noticing a
   * change here is what triggers a full, reactive dossier re-read — it is
   * not itself the recurring poll.
   */
  const progressOf = (research: PersonResearchProfileSummary | null) =>
    research
      ? {
          state: research.state,
          calls: research.calls,
          sources: research.sources,
          attempts: research.attempts,
          currentOperationId: research.currentOperationId,
          operationRevision: research.operationRevision,
        }
      : null;
  const lastProgress = useRef<ReturnType<typeof progressOf>>(null);
  const progressEqual = (a: ReturnType<typeof progressOf>, b: ReturnType<typeof progressOf>) =>
    a === b ||
    (!!a &&
      !!b &&
      a.state === b.state &&
      a.calls === b.calls &&
      a.sources === b.sources &&
      a.attempts === b.attempts &&
      a.currentOperationId === b.currentOperationId &&
      a.operationRevision === b.operationRevision);
  const lifecycle = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current;
    reading.current = true;
    try {
      const [current, progress] = await Promise.all([client.read(profileId), client.settings()]);
      if (generation !== readGeneration.current) return;
      setSettings((previous) =>
        editingSettings.current && previous
          ? {
              ...progress,
              settings: {
                ...progress.settings,
                concurrency: previous.settings.concurrency,
                refreshHours: previous.settings.refreshHours,
                historicalRefreshHours: previous.settings.historicalRefreshHours,
              },
            }
          : progress,
      );
      if (current.profile) onProfile?.(current.profile);
      setLatestRevision(current.dossier?.revision ?? 0);
      setCurrentSources({ profileId, ids: current.dossier?.sourceIds ?? [] });
      const data = revision === undefined ? current : await client.read(profileId, revision);
      if (generation !== readGeneration.current) return;
      setView(data);
      lastProgress.current = progressOf(data.research);
      const nextAnalysis =
        data.dossier && revision === undefined ? await client.analysis(profileId) : null;
      if (generation !== readGeneration.current) return;
      setAnalysis(nextAnalysis);
      setReadError("");
    } catch (error) {
      if (generation === readGeneration.current) setReadError(errorMessage(error));
    } finally {
      if (generation === readGeneration.current) reading.current = false;
    }
  }, [profileId, client, revision, onProfile]);
  /**
   * Normal polling reads only the bounded summary (issue #418, T9, spec §7;
   * #417 F4): side-effect-free, and it never enqueues. It never replaces the
   * dossier route's own initial/action reads, which intentionally retain
   * their "viewed" scheduling nudge (spec §7) — this is what keeps that
   * nudge from firing every four seconds instead of on genuine reads. When
   * the live counters show forward progress, or the job settles into a new
   * state, that is a signal the dossier may have new published content the
   * summary itself never carries — so this triggers one reactive full
   * refresh rather than embedding retained content in the poll itself.
   */
  const pollResearch = useCallback(async () => {
    const generation = readGeneration.current;
    try {
      const summary = await client.summary(profileId);
      if (generation !== readGeneration.current) return;
      if (!summary) {
        const status = await client.settings();
        if (generation !== readGeneration.current) return;
        setView((current) =>
          current && status.readiness ? { ...current, readiness: status.readiness } : current,
        );
      }
      const progress = progressOf(summary);
      if (!progressEqual(progress, lastProgress.current)) {
        lastProgress.current = progress;
        await refresh();
        return;
      }
      setView((current) => (current ? { ...current, research: summary } : current));
    } catch {
      /* A side-effect-free status poll failing does not overwrite the
         primary read error; the next full refresh reports a persistent
         problem honestly instead. */
    }
  }, [profileId, client, refresh]);
  const invalidatePending = useCallback(() => {
    ++readGeneration.current;
    ++lifecycle.current;
  }, []);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    // Never label the last revision's claims as the newly selected revision.
    setView(null);
    setAnalysis(null);
    setCorrectionNotice("");
    setReadError("");
    setDiagnosticsPage(null);
    setDiagnosticsError("");
    lastProgress.current = null;
    void refresh();
    const timer = setInterval(() => {
      if (reading.current || polling.current) return;
      if (viewRef.current === null) {
        void refresh();
        return;
      }
      polling.current = true;
      void pollResearch().finally(() => {
        polling.current = false;
      });
    }, 4000);
    return () => {
      invalidatePending();
      clearInterval(timer);
    };
  }, [refresh, pollResearch, invalidatePending]);
  useEffect(() => {
    let live = true;
    setHistory([]);
    setHistoryLoaded(false);
    setHistoryError("");
    void client
      .history(profileId)
      .then((records) => {
        if (live) {
          setHistory(records);
          setHistoryLoaded(true);
        }
      })
      .catch((error) => {
        if (live) setHistoryError(errorMessage(error));
      });
    return () => {
      live = false;
    };
  }, [profileId, client, historyRetry]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("source");
    setSource(id ? { id, quote: "", profileId, revision, attributedWhenOpened: true } : null);
    if (id) setTab("sources");
  }, [profileId, revision]);

  useEffect(() => {
    if (
      source?.attributedWhenOpened &&
      currentSources?.profileId === source.profileId &&
      !currentSources.ids.includes(source.id)
    ) {
      setSource(null);
      setCorrectionNotice(
        "This source is no longer attributed to this Profile. Historical citations do not establish current attribution.",
      );
    }
  }, [currentSources, source]);

  async function act(action: () => Promise<unknown>, savesSettings = false) {
    const generation = lifecycle.current;
    const edits = settingsEditRevision.current;
    try {
      await action();
      if (generation !== lifecycle.current) return;
      // Research and pause actions do not discard unsaved scheduling changes.
      if (savesSettings && edits === settingsEditRevision.current) editingSettings.current = false;
      setActionError("");
      await refresh();
    } catch (error) {
      if (generation !== lifecycle.current) return;
      const parsed = PersonResearchReadinessSchema.safeParse(
        error instanceof ApiError &&
          error.body &&
          typeof error.body === "object" &&
          "readiness" in error.body
          ? error.body.readiness
          : undefined,
      );
      if (parsed.success) {
        setView((current) => (current ? { ...current, readiness: parsed.data } : current));
        setActionError("");
      } else setActionError(errorMessage(error));
    }
  }
  function inspect(id: string, quote: string) {
    setSource({
      id,
      quote,
      profileId,
      revision,
      attributedWhenOpened: currentSources?.ids.includes(id) ?? true,
    });
  }
  const readiness =
    view?.readiness ??
    (view?.researchDecision?.kind === "rejected-readiness"
      ? view.researchDecision.readiness
      : view?.research?.readiness);
  const surface =
    readiness && (readiness.state !== "ready" || !view?.research)
      ? {
          ...readinessSurface(readiness),
          ...(readiness.state === "ready"
            ? { detail: "Choose Prioritise research to start research for this saved Profile." }
            : {}),
          nextAction: readiness.nextAction,
        }
      : researchSurface(view?.research ?? null);
  const dossier = view?.dossier;
  const claims = dossier?.claims ?? [];
  const activeClaims = claims.filter((c) => c.status !== "superseded");
  const section = dossier?.sections.find((s) => s.key === tab);
  const overviewClaims = personOverviewClaims(activeClaims);
  const displayed =
    tab === "overview"
      ? overviewClaims.filter(
          (c) =>
            !c.statement.includes("Education — Institution unknown") &&
            !c.statement.startsWith("Unresolved source fragment:"),
        )
      : activeClaims.filter((c) => c.section === tab);
  const citations = (record: { claimIds: string[] }) =>
    record.claimIds.flatMap((id) => claims.find((c) => c.id === id)?.citations ?? []);
  const evidence = (record: { claimIds: string[] }) =>
    citations(record).map((citation, index) => (
      <button
        type="button"
        className="linklike dossier-citation"
        key={`${citation.sourceId}-${index}`}
        onClick={() => void inspect(citation.sourceId, citation.quote)}
      >
        Evidence {index + 1}: “
        {citation.quote.trim().replace(/\s+/g, " ").length > 180
          ? `${citation.quote.trim().replace(/\s+/g, " ").slice(0, 180)}…`
          : citation.quote}
        ”
      </button>
    ));
  /* A claim grounded in archived material is evidence about the capture date
     and nothing after it (#253). The reader sees the claim, not the retained
     source behind it, so the date is stated here rather than left to the
     source inspector — a past role read as a present one is the whole risk. */
  const capturedAt = (item: PersonClaim) =>
    item.citations.find((citation) => citation.capturedAt)?.capturedAt?.slice(0, 10) ?? null;
  const claim = (item: PersonClaim) => (
    <article className="card" key={item.id} id={`claim-${item.id}`}>
      <p>{item.statement}</p>
      <p className="muted">
        {item.status} · {item.nature} · {item.effectiveFrom ?? "Date unknown"}
        {item.effectiveTo ? ` to ${item.effectiveTo}` : ""}
        {capturedAt(item) ? ` · archived capture ${capturedAt(item)}` : ""}
      </p>
      {item.citations.map((citation, index) => (
        <button
          className="linklike dossier-citation"
          type="button"
          key={index}
          onClick={() => void inspect(citation.sourceId, citation.quote)}
        >
          Source {index + 1}: “
          {citation.quote.trim().replace(/\s+/g, " ").length > 180
            ? `${citation.quote.trim().replace(/\s+/g, " ").slice(0, 180)}…`
            : citation.quote}
          ”
        </button>
      ))}
      {item.changeReason && <p>{item.changeReason}</p>}
    </article>
  );
  return (
    <section aria-label="Person dossier">
      {latestRevision > 0 && (
        <label>
          Dossier revision{" "}
          <select
            aria-label="Dossier revision"
            value={revision ?? "current"}
            onChange={(event) => {
              setRevision(
                event.target.value === "current" ? undefined : Number(event.target.value),
              );
              setAnalysis(null);
              setSource(null);
            }}
          >
            <option value="current">Current</option>
            {Array.from({ length: latestRevision }, (_, index) => index + 1)
              .reverse()
              .map((value) => (
                <option key={value} value={value}>
                  Revision {value}
                </option>
              ))}
          </select>
        </label>
      )}
      {revision !== undefined && (
        <p role="status">
          Reading historical dossier revision {revision}. This records earlier evidence, not current
          attribution. Corrected sources may be unavailable; privacy deletion can remove evidence.
        </p>
      )}
      <div className="card">
        <p role="status">
          <strong>
            {!view
              ? readError
                ? "Research status unavailable"
                : "Loading dossier"
              : surface
                ? surface.title
                : settings?.settings.paused
                  ? "Workspace research paused"
                  : revision !== undefined
                    ? "Historical dossier"
                    : "No research status available"}
          </strong>{" "}
          {view && (
            <>
              · {dossier?.sourceIds.length ?? 0} retained sources · {claims.length} retained claims
            </>
          )}
        </p>
        <p className="muted">
          {!view
            ? readError
              ? "The dossier could not be loaded. Retrying automatically."
              : "Loading retained evidence and research status."
            : (surface?.detail ??
              (settings?.settings.paused
                ? "An owner paused automatic research for the workspace."
                : "Only retained, supported evidence appears in this dossier."))}
        </p>
        {surface?.nextAction && (
          <p>
            <a href={surface.nextAction.href}>{surface.nextAction.label}</a>
          </p>
        )}
        <button type="button" onClick={() => void act(() => client.research(profileId))}>
          Prioritise research
        </button>{" "}
        <details>
          <summary>Research settings</summary>
          {settings && (
            <>
              <p>
                Backfill:{" "}
                {settings.totalJobs -
                  (settings.byState.queued ?? 0) -
                  (settings.byState.researching ?? 0) -
                  (settings.byState.paused ?? 0)}{" "}
                of {settings.totalJobs} Profiles attempted;{" "}
                {(settings.byState.queued ?? 0) + (settings.byState.paused ?? 0)} waiting.{" "}
                {settings.usedCalls} research requests today. Research continues while useful leads
                remain; individual requests and retries are bounded.
              </p>
              <button
                type="button"
                onClick={() =>
                  void act(() => client.configure({ paused: !settings.settings.paused }))
                }
              >
                {settings.settings.paused ? "Resume research" : "Pause research"}
              </button>
              {(["concurrency", "refreshHours", "historicalRefreshHours"] as const).map((key) => (
                <label key={key} style={{ display: "block", marginTop: 12 }}>
                  {
                    {
                      concurrency: "Concurrent Profiles",
                      refreshHours: "Current facts refresh (hours)",
                      historicalRefreshHours: "Historical research refresh (hours)",
                    }[key]
                  }{" "}
                  <input
                    type="number"
                    min={1}
                    value={settings.settings[key] ?? 720}
                    onChange={(event) => {
                      editingSettings.current = true;
                      ++settingsEditRevision.current;
                      setSettings({
                        ...settings,
                        settings: { ...settings.settings, [key]: Number(event.target.value) },
                      });
                    }}
                  />
                </label>
              ))}
              <button
                type="button"
                onClick={() =>
                  void act(
                    () =>
                      /* Scheduling only: sending the whole settings object back would
                       re-assert `paused` and cancel in-flight research that this
                       edit never touched (#207). */
                      client.configure({
                        concurrency: settings.settings.concurrency,
                        refreshHours: settings.settings.refreshHours,
                        historicalRefreshHours: settings.settings.historicalRefreshHours ?? 720,
                      }),
                    true,
                  )
                }
              >
                Save research settings
              </button>
            </>
          )}
        </details>
      </div>
      {correctionNotice && <p role="status">{correctionNotice}</p>}
      {[actionError, readError, historyError].filter(Boolean).map((error, index) => (
        <p role="alert" className="banner-error" key={index}>
          {error}
        </p>
      ))}
      {/* A terminal conclusion superseded by the operation now current or in
          progress, kept as its own labeled history rather than erased (#417
          F5, issue #418, T9, spec §7): starting a new operation never
          presents this one as the new operation's own current failure. */}
      {view?.research?.previousConclusion && (
        <div className="card" aria-label="Previous research attempt">
          <p>
            <strong>Previous research attempt</strong> — concluded{" "}
            {view.research.previousConclusion.conclusion} on{" "}
            <EvidenceDate value={view.research.previousConclusion.finishedAt} />
          </p>
          <p className="muted">
            {view.research.previousConclusion.decisive?.reason ??
              view.research.previousConclusion.detail}
          </p>
        </div>
      )}
      {/* The bounded diagnostics digest (issue #418, T5) is what normal
          polling already carries; the full paged history is fetched only on
          explicit demand (spec §7), never automatically. */}
      {!!view?.research?.diagnostics.sample.length && (
        <details className="card">
          <summary>Source and identity diagnostics</summary>
          <p className="muted">
            Showing {diagnosticsPage?.entries.length ?? view.research.diagnostics.sample.length} of{" "}
            {view.research.diagnostics.totalAttempts} recorded attempts.
          </p>
          {(diagnosticsPage?.entries ?? view.research.diagnostics.sample).map((attempt, index) => (
            <p key={index}>
              <strong>{attempt.code}</strong> · {attempt.stage} · {attempt.outcome}
              <br />
              {attempt.reason}
            </p>
          ))}
          {diagnosticsError && (
            <p role="alert" className="banner-error">
              {diagnosticsError}
            </p>
          )}
          {(diagnosticsPage
            ? diagnosticsPage.nextCursor !== null
            : view.research.diagnostics.totalAttempts >
              view.research.diagnostics.sample.length) && (
            <button
              type="button"
              onClick={() =>
                void client
                  .diagnostics(profileId, diagnosticsPage?.nextCursor ?? undefined)
                  .then((page) => {
                    setDiagnosticsError("");
                    setDiagnosticsPage((previous) =>
                      page
                        ? { ...page, entries: [...(previous?.entries ?? []), ...page.entries] }
                        : previous,
                    );
                  })
                  .catch((error: unknown) => setDiagnosticsError(errorMessage(error)))
              }
            >
              {diagnosticsPage ? "Load more diagnostics" : "Load full diagnostic history"}
            </button>
          )}
        </details>
      )}
      {!!view?.research?.gaps?.length && (
        <details className="card">
          <summary>What this research did not find</summary>
          {view.research.gaps.map((gap, index) => (
            <p key={index}>{gap}</p>
          ))}
        </details>
      )}
      <div className="dossier-section-navigation">
        {(overflow.before || overflow.after) && (
          <button
            type="button"
            aria-label="Previous dossier sections"
            title="Previous sections"
            disabled={!overflow.before}
            onClick={() => scrollTabs(-1)}
          >
            ←
          </button>
        )}
        <div
          ref={tabStrip}
          onScroll={measureTabs}
          role="tablist"
          aria-label="Dossier sections"
          className="dossier-sections"
        >
          {Object.entries(tabs).map(([key, label]) => (
            <button
              type="button"
              role="tab"
              id={`dossier-tab-${key}`}
              aria-controls="dossier-panel"
              aria-selected={key === tab}
              tabIndex={key === tab ? 0 : -1}
              onFocus={(event) => {
                if (typeof event.currentTarget.scrollIntoView === "function")
                  event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
              }}
              onKeyDown={(event) => {
                const keys = Object.keys(tabs) as Array<keyof typeof tabs>;
                const index = keys.indexOf(key as keyof typeof tabs);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? keys.length - 1
                      : event.key === "ArrowRight"
                        ? (index + 1) % keys.length
                        : event.key === "ArrowLeft"
                          ? (index - 1 + keys.length) % keys.length
                          : null;
                if (next === null) return;
                event.preventDefault();
                setTab(keys[next]!);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`#dossier-tab-${keys[next]}`)
                  ?.focus();
              }}
              key={key}
              onClick={() => {
                setTab(key as keyof typeof tabs);
                setSource(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {(overflow.before || overflow.after) && (
          <button
            type="button"
            aria-label="More dossier sections"
            title="More sections"
            disabled={!overflow.after}
            onClick={() => scrollTabs(1)}
          >
            →
          </button>
        )}
      </div>
      <div id="dossier-panel" role="tabpanel" tabIndex={0} aria-labelledby={`dossier-tab-${tab}`}>
        <h2>{tabs[tab]}</h2>
        {section && (
          <>
            <p>
              {section.claimIds.length && dossier
                ? summarizePersonClaims(
                    tab === "overview"
                      ? overviewClaims
                      : section.claimIds.flatMap((id) =>
                          dossier.claims.filter((claim) => claim.id === id),
                        ),
                  )
                : section.summary}
            </p>
            <p className="muted">
              {section.state} · Last researched <EvidenceDate value={section.updatedAt} />
            </p>
            {evidence(tab === "overview" ? { claimIds: displayed.map((c) => c.id) } : section)}
            {section.gaps.map((gap) => (
              <p className="muted" key={gap}>
                {gap}
              </p>
            ))}
          </>
        )}
        {tab === "overview" &&
          activeClaims.some((c) => c.statement.startsWith("Unresolved source fragment:")) && (
            <details>
              <summary>Unresolved evidence</summary>
              {activeClaims
                .filter((c) => c.statement.startsWith("Unresolved source fragment:"))
                .map(claim)}
            </details>
          )}
        {tab === "history" ? (
          historyError ? (
            <div>
              <p>Relationship history could not be loaded. Its contents are unknown.</p>
              <button type="button" onClick={() => setHistoryRetry((retry) => retry + 1)}>
                Retry Relationship history
              </button>
            </div>
          ) : !historyLoaded ? (
            <p role="status">Loading Relationship history…</p>
          ) : history.length ? (
            history.map((item) => (
              <article className="card" key={`${item.kind}-${item.id}`}>
                <a href={item.href}>{item.title}</a>
                <p>
                  {item.kind} · {item.date ?? "Date unknown"}
                </p>
                <p>{item.detail}</p>
              </article>
            ))
          ) : (
            <p className="muted">
              No confirmed Workspace history yet. Public research remains available in the other
              tabs.
            </p>
          )
        ) : null}
        {tab === "work" && analysis && (
          <section>
            <h3>Observed activity</h3>
            <p className="muted">{analysis.scope}</p>
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Artifact kind</th>
                  <th>Observed count</th>
                </tr>
              </thead>
              <tbody>
                {analysis.activity.map((row) => (
                  <tr key={`${row.period}-${row.kind}`}>
                    <td>{row.period}</td>
                    <td>{row.kind}</td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {tab === "sources" && analysis && (
          <section className="card">
            <h3>Record quality</h3>
            <p>
              {analysis.quality.singleSourceClaims} of {analysis.quality.totalClaims} claims depend
              on a single source family. {analysis.quality.contestedClaims} contested;{" "}
              {analysis.quality.unknownClaims} unknown.
            </p>
            {Object.entries(analysis.quality.composition).map(([kind, count]) => (
              <p key={kind}>
                {kind}: supports {count} claims
              </p>
            ))}
          </section>
        )}
        {tab === "connections" &&
          analysis?.collaborations.map((person) => (
            <p key={person.counterparty}>
              {person.counterparty}: {person.distinctWorks} distinct documented shared work{" "}
              {person.distinctWorks > 1 ? "records — repeated collaboration" : "record"}
            </p>
          ))}
        {tab === "work" &&
          dossier?.works.map((work) => (
            <article className="card" key={work.id} id={`work-${work.id}`}>
              <h3>{work.title}</h3>
              <p>
                {work.kind} · {work.startedAt ?? "Start unknown"} — {work.endedAt ?? "End unknown"}
              </p>
              <p>
                <strong>Individual contribution:</strong>{" "}
                {work.contribution?.text ?? "The individual/team split is undocumented."}
              </p>
              <p>
                <strong>Team output:</strong> {work.teamContribution?.text ?? "Not documented."}
              </p>
              {work.authority.map((authority, i) => (
                <p key={i}>
                  {authority.role} {evidence(authority)}
                </p>
              ))}
              {work.scale.length ? (
                work.scale.map((scale, i) => (
                  <p key={i}>
                    {scale.value} {scale.unit} · {scale.scope} · {scale.date ?? "Date unknown"}{" "}
                    {evidence(scale)}
                  </p>
                ))
              ) : (
                <p className="muted">Operating scale is not documented.</p>
              )}
              {work.constraints.map((constraint, i) => (
                <p key={i}>
                  Constraint: {constraint.text} {evidence(constraint)}
                </p>
              ))}
              {work.outcomes.map((outcome, i) => (
                <p key={i}>
                  {outcome.unsuccessful ? "Unsuccessful outcome: " : "Outcome: "}
                  {outcome.text} · {outcome.date ?? "Date unknown"}
                  {outcome.afterDeparture ? " · After departure" : ""} {evidence(outcome)}
                </p>
              ))}
              {evidence(work)}
            </article>
          ))}
        {tab === "expertise" &&
          (["demonstrated", "claimed"] as const).map((support) => (
            <section key={support}>
              <h3>{support === "demonstrated" ? "Demonstrated in work" : "Stated capabilities"}</h3>
              {dossier?.expertise
                .filter((e) => e.support === support)
                .map((expertise, index) => (
                  <article className="card" key={index}>
                    <strong>{expertise.category}</strong>
                    <p>{expertise.originalWording}</p>
                    <p>
                      {expertise.workIds
                        .map((id) => dossier.works.find((w) => w.id === id)?.title)
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {evidence(expertise)}
                  </article>
                ))}
            </section>
          ))}
        {tab === "connections" &&
          dossier?.connections.map((connection) => (
            <article className="card" key={connection.id}>
              <h3>{connection.counterparty}</h3>
              <p>
                {connection.kind} · {connection.direction} · {connection.from ?? "Start unknown"} —{" "}
                {connection.to ?? "End unknown"}
              </p>
              <p>
                {connection.workIds
                  .map((id) => dossier.works.find((w) => w.id === id)?.title)
                  .filter(Boolean)
                  .join(" · ") || "No shared work documented"}
              </p>
              {evidence(connection)}
            </article>
          ))}
        {tab === "sources" ? (
          <>
            <p className="muted">
              Inspect the passages behind each statement. Retrieval dates describe collection, not
              when a fact became true. Repeated copies do not establish independent corroboration.
            </p>
            <ul>
              {(dossier?.sourceIds ?? []).map((sourceId, index) => (
                <li key={sourceId}>
                  <button type="button" onClick={() => void inspect(sourceId, "")}>
                    Inspect retained source {index + 1}
                  </button>
                </li>
              ))}
            </ul>
            {claims.map(claim)}
          </>
        ) : (
          tab !== "history" && displayed.map(claim)
        )}
        {tab !== "history" && tab !== "sources" && !displayed.length && !section && (
          <p className="muted">
            No supported account is available in this section yet. Missing evidence remains unknown.
          </p>
        )}
      </div>
      {source && source.profileId === profileId && source.revision === revision && (
        <PersonSourceInspector
          key={`${profileId}:${source.id}:${source.quote}`}
          profileId={profileId}
          sourceId={source.id}
          quote={source.quote}
          client={client}
          onClose={() => setSource(null)}
          onDetached={async () => {
            const generation = lifecycle.current;
            await refresh();
            if (generation !== lifecycle.current) return;
            setCorrectionNotice(
              "Attribution removed from this Profile. Historical revisions retain their recorded claims.",
            );
          }}
        />
      )}
    </section>
  );
}
