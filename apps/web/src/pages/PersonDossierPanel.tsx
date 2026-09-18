import {
  PersonResearchReadinessSchema,
  personOverviewClaims,
  summarizePersonClaims,
  type PersonSourceSummary,
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
  /** Bounded display facts (title, site, capture date) for the current retained sources. */
  sources(id: string): Promise<{ sources: PersonSourceSummary[] }>;
  history(id: string): Promise<PersonRelationshipRecord[]>;
  analysis(id: string): Promise<PersonDossierAnalysis | null>;
  research(id: string): Promise<unknown>;
  /** Stops queued or in-flight research for one Profile; retained evidence stays (UX audit F7). */
  cancel(id: string): Promise<{ cancelled: boolean }>;
  detach(id: string, sourceId: string): Promise<unknown>;
  settings: () => Promise<PersonResearchAggregateStatus & { readiness?: PersonResearchReadiness }>;
  configure(settings: Partial<PersonResearchSettings>): Promise<unknown>;
  /**
   * The bounded per-profile summary a normal poll reads (issue #418, T9,
   * spec §7): side-effect-free, never enqueues. Returns the route's whole
   * envelope: `summary` is null when no job exists yet, and `readiness` is
   * the pipeline's current readiness so a no-job poll still carries fresh
   * pipeline state (#417 F1) without a second aggregate status request.
   * Distinct from `read`, whose dossier route retains its own intentional
   * "viewed" scheduling nudge (spec §7) and is not something routine
   * polling should repeat every cycle.
   */
  summary(
    id: string,
  ): Promise<{ summary: PersonResearchProfileSummary | null; readiness: PersonResearchReadiness }>;
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
  sources: (id) =>
    request<{ sources: PersonSourceSummary[] }>(`/api/people/${encodeURIComponent(id)}/sources`),
  analysis: (id) => request(`/api/people/${encodeURIComponent(id)}/dossier-analysis`),
  history: (id) => request(`/api/people/${encodeURIComponent(id)}/relationship-history`),
  research: (id) => request(`/api/people/${encodeURIComponent(id)}/research`, { method: "POST" }),
  cancel: (id) =>
    request<{ cancelled: boolean }>(`/api/people/${encodeURIComponent(id)}/research/cancel`, {
      method: "POST",
    }),
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
  summary: (id) =>
    request<{ summary: PersonResearchProfileSummary | null; readiness: PersonResearchReadiness }>(
      `/api/people/${encodeURIComponent(id)}/research/summary`,
    ),
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
/* Human vocabulary for the storage tokens this panel renders (UX audit F10):
   a token with no entry renders its own key rather than disappearing, and the
   raw token stays in the DOM title for anyone diagnosing. */
const CLAIM_STATUS_LABELS: Record<string, string> = {
  supported: "Supported",
  claimed: "Claimed",
  contested: "Contested",
  unknown: "Unknown",
  stale: "Stale",
  superseded: "Superseded",
};
const CLAIM_NATURE_LABELS: Record<string, string> = {
  statement: "Statement",
  interpretation: "Interpretation",
};
const SECTION_STATE_LABELS: Record<string, string> = {
  unresearched: "Not yet researched",
  incomplete: "Incomplete",
  current: "Current",
  unavailable: "Unavailable",
};
/* The codes a reader meets most; the long tail renders its own key. */
const DIAGNOSTIC_CODE_LABELS: Record<string, string> = {
  "discovery-refused": "Search refused",
  "discovery-empty": "Search found no results",
  "connectivity-failed": "Could not reach the site",
  "dns-failed": "Site address could not be resolved",
  "tls-failed": "Secure connection failed",
  "request-timeout": "The site took too long to answer",
  "transport-failed": "The network request failed",
  "http-error": "The site answered with an error",
  "rate-limited": "The site limited the request rate",
  "login-required": "The page needs a sign-in",
  "challenge-page": "The page asked for a human check",
  "resource-unavailable": "No copy of this page was available",
  "robots-excluded": "The site asks search engines to keep out",
  "rendering-failed": "The page could not be rendered",
  "unsupported-format": "The document format is unsupported",
  "parser-failed": "The page could not be read",
  "document-empty": "The document held no readable text",
  "identity-unmatched": "Could not confirm this is the same person",
  "ambiguous-attribution": "The evidence matched more than one person",
  "off-subject-claim": "The passage was about someone else",
  "invalid-result-shape": "The extraction answer was unusable",
  "unknown-cause": "Reason not recorded",
};

const claimStatusLabel = (status: string): string => CLAIM_STATUS_LABELS[status] ?? status;
const claimNatureLabel = (nature: string): string => CLAIM_NATURE_LABELS[nature] ?? nature;
const sectionStateLabel = (state: string): string => SECTION_STATE_LABELS[state] ?? state;
const diagnosticCodeLabel = (code: string): string => DIAGNOSTIC_CODE_LABELS[code] ?? code;

/** The transport failed before the server could answer (client.ts rethrows a
    fetch rejection as ApiError 0): the app itself is down, not an endpoint
    (UX audit F1b). */
const isUnreachable = (error: unknown): boolean =>
  (error instanceof ApiError && error.status === 0) || error instanceof TypeError;

/** Elapsed research time in mm:ss form (UX audit F7a), e.g. "2m 14s". */
function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

/** The revision selector's options (UX audit F13): a Profile with hundreds of
    revisions otherwise offers indistinguishable "Revision N" options for its
    whole history. The newest 50 stay listed until the reader asks for the
    full history ("Show all"), and a revision older than that window is still
    included when it is the one selected, so the select keeps showing the
    truth rather than jumping to another revision's claims. */
const REVISION_WINDOW = 50;
function revisionOptions(latest: number, selected: number | undefined, all = false): number[] {
  const oldestListed = all ? 1 : Math.max(1, latest - REVISION_WINDOW + 1);
  const values = Array.from({ length: latest - oldestListed + 1 }, (_, index) => latest - index);
  if (selected !== undefined && selected < oldestListed) values.push(selected);
  return values;
}

/* Reading order within a section (UX audit F6): corroborated, uncontested
   facts lead; contested, unknown and unresolved fragments follow. The sort is
   stable, so the pipeline's own order carries within each tier. */
function rankForDisplay(claims: PersonClaim[]): PersonClaim[] {
  const tier = (claim: PersonClaim) =>
    claim.statement.startsWith("Unresolved source fragment:")
      ? 2
      : claim.status === "contested" || claim.status === "unknown"
        ? 1
        : 0;
  const corroborations = (claim: PersonClaim) =>
    new Set(claim.citations.map((citation) => citation.sourceId)).size;
  return claims
    .map((claim, index) => ({ claim, index }))
    .sort(
      (a, b) =>
        tier(a.claim) - tier(b.claim) ||
        corroborations(b.claim) - corroborations(a.claim) ||
        a.index - b.index,
    )
    .map((entry) => entry.claim);
}

/** A captured date in the same readable form EvidenceDate renders, or null
    when the capture time is unknown or not anchored to a day. */
function capturedDateLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  if (!dateOnly && !hasZone) return null;
  const parsed = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(parsed.getTime())) return null;
  if (dateOnly && parsed.toISOString().slice(0, 10) !== value) return null;
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

/** A citation's readable label (UX audit F6): the source's name, its site and
    the date it was captured — not a raw retained fragment. The quote itself
    stays in the opened inspector; the fallback caps the quote like the
    fragment buttons always did. */
function citationLabel(summary: PersonSourceSummary | undefined, fallback: string): string {
  const parts: string[] = [];
  const title = summary?.title.trim();
  if (title) parts.push(title.length > 70 ? `${title.slice(0, 70)}…` : title);
  else if (summary?.domain) parts.push(summary.domain);
  const captured = capturedDateLabel(summary?.capturedAt);
  if (captured) parts.push(captured);
  if (parts.length) return parts.join(" — ");
  return fallback.length > 180 ? `${fallback.slice(0, 180)}…` : fallback;
}
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
      /* The exact cure, not just the gate (UX audit F2): the connected email is
         what the owner profile must carry, and naming it is the difference
         between a beginner creating their own Profile and guessing. */
      return {
        title: "Research setup required",
        detail: readiness.ownerEmail
          ? `An owner has not yet confirmed workspace setup for automatic research. No Person Profile carries ${readiness.ownerEmail} yet. Create a Profile for yourself with that email under Person Profiles, then confirm it as the owner in Settings → Owner Profile.`
          : "An owner has not yet confirmed workspace setup for automatic research.",
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
      /* The same observed failure can settle a run interrupted rather than
         empty: the operation kept pending work. When the decisive
         classification names the usable-answer boundary, the truthful title
         is that fact (ReadinessAudit, #417 F2) — not a generic interruption
         label, and never a provider-downtime claim. */
      if (decisive?.classification === "no-usable-model-answer")
        return { title: "No usable extraction answer", detail: decisive.reason };
      return { title: "Research interrupted", detail: decisive?.reason ?? research.detail };
    case "incomplete":
      return {
        title: "Research paused at a safety limit",
        detail: decisive?.reason ?? research.detail,
      };
    case "unavailable": {
      /* A terminal conclusion with no way forward reads as a dead end (UX
         audit F7d): the honest next step belongs in the same detail. */
      const detail = decisive?.reason ?? research.detail;
      return {
        title: "Sources unavailable",
        detail: `${detail}${/[.!?]$/.test(detail) ? "" : "."} Choose Prioritise research to try again.`,
      };
    }
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
  /** Display facts for the retained sources, keyed by source id in render. */
  const [sourceFacts, setSourceFacts] = useState<PersonSourceSummary[]>([]);
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
  /**
   * The app itself is not answering (UX audit F1b): a read that failed at the
   * network level, as distinct from a request the server answered with an
   * error. While set, the last known job state is never presented as live.
   */
  const [unreachable, setUnreachable] = useState(false);
  const [showAllRevisions, setShowAllRevisions] = useState(false);
  /** Immediate acknowledgment for Prioritise research (UX audit F8). */
  const [startingResearch, setStartingResearch] = useState(false);
  /** Elapsed milliseconds of the operation now researching (UX audit F7a). */
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
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
      if (
        data.research?.currentOperationId !== viewRef.current?.research?.currentOperationId ||
        data.research?.operationRevision !== viewRef.current?.research?.operationRevision
      ) {
        setDiagnosticsPage(null);
        setDiagnosticsError("");
      }
      setView(data);
      lastProgress.current = progressOf(data.research);
      /* Citation labels come from the bounded display facts; a failed read
         degrades to the quote fallback rather than blocking the refresh. It
         follows the view commit so the extra roundtrip never delays the
         dossier update an interaction is waiting on — a delayed commit here
         is what broke the source inspector's focus return (the dialog's
         cleanup found its opener already detached). */
      const facts = await client.sources(profileId).catch(() => ({ sources: [] }));
      if (generation !== readGeneration.current) return;
      setSourceFacts(facts.sources);
      const nextAnalysis =
        data.dossier && revision === undefined ? await client.analysis(profileId) : null;
      if (generation !== readGeneration.current) return;
      setAnalysis(nextAnalysis);
      setReadError("");
      setUnreachable(false);
    } catch (error) {
      if (generation === readGeneration.current) {
        /* A network-level failure means the app is not answering at all (UX
           audit F1b): the stale state on screen must say so instead of
           looking live. A request the server answered keeps its own
           readError path. */
        if (isUnreachable(error)) setUnreachable(true);
        else {
          setUnreachable(false);
          setReadError(errorMessage(error));
        }
      }
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
      const envelope = await client.summary(profileId);
      if (generation !== readGeneration.current) return;
      // The app answered: whatever it said, it is reachable again (#F1b).
      setUnreachable(false);
      const summary = envelope.summary;
      /* No job yet: the envelope's own pipeline readiness is still fresh
         every cycle (#417 F1), so a blocked pipeline updates its surface
         without touching the dossier. */
      if (!summary)
        setView((current) => (current ? { ...current, readiness: envelope.readiness } : current));
      const progress = progressOf(summary);
      if (!progressEqual(progress, lastProgress.current)) {
        lastProgress.current = progress;
        await refresh();
        return;
      }
      setView((current) =>
        current
          ? { ...current, research: summary, ...(summary ? { readiness: summary.readiness } : {}) }
          : current,
      );
    } catch (error) {
      /* A side-effect-free status poll failing does not overwrite the
         primary read error; the next full refresh reports a persistent
         problem honestly instead. A network-level failure is the exception
         (UX audit F1b): it means the app itself is down, so the last known
         state must stop reading as live. */
      if (generation !== readGeneration.current) return;
      if (isUnreachable(error)) setUnreachable(true);
    }
  }, [profileId, client, refresh]);
  const invalidatePending = useCallback(() => {
    ++readGeneration.current;
    ++lifecycle.current;
  }, []);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  /* A live elapsed time is the one progress signal that cannot be stale (UX
     audit F7a): counters freeze while the browser source renderer works, but
     the clock still moves. One interval, restarted only when the operation
     itself changes — a new operation's start resets the label. */
  const researchingStartedAt =
    view?.research?.state === "researching" ? view.research.currentOperationStartedAt : undefined;
  useEffect(() => {
    const started = researchingStartedAt ? Date.parse(researchingStartedAt) : Number.NaN;
    if (Number.isNaN(started)) {
      setElapsedMs(null);
      return;
    }
    const tick = () => setElapsedMs(Math.max(0, Date.now() - started));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [researchingStartedAt]);
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
  /* The clock belongs to the researching surface's own line (UX audit F7a),
     where "no stage names" made waiting indistinguishable from working. */
  const elapsed =
    view?.research?.state === "researching" && elapsedMs !== null ? elapsedLabel(elapsedMs) : null;
  /* The whole-operation failure counts survive the display bound (#417 F9):
     `byCode` covers every attempt while `sample` may omit the kind entirely,
     so the aggregate renderer-failed count is read from there, never from
     the sample. Whether those sheds were renderer-busy saturation is only
     asserted from busy evidence actually recorded on attempts, using the
     full-ledger `rendererBusyReportedCount` when available. */
  const rendererFailed = view?.research?.diagnostics.byCode["rendering-failed"] ?? 0;
  const rendererBusyCount =
    view?.research?.diagnostics.rendererBusyReportedCount ??
    (view?.research?.diagnostics.sample ?? []).filter(
      (attempt) => attempt.code === "rendering-failed" && /busy/i.test(attempt.reason),
    ).length;
  const activeClaims = claims.filter((c) => c.status !== "superseded");
  const section = dossier?.sections.find((s) => s.key === tab);
  const overviewClaims = personOverviewClaims(activeClaims);
  const displayed =
    tab === "overview"
      ? rankForDisplay(
          overviewClaims.filter(
            (c) =>
              !c.statement.includes("Education — Institution unknown") &&
              !c.statement.startsWith("Unresolved source fragment:"),
          ),
        )
      : rankForDisplay(activeClaims.filter((c) => c.section === tab));
  const summaryById = new Map(sourceFacts.map((facts) => [facts.id, facts]));
  const citations = (record: { claimIds: string[] }) =>
    record.claimIds.flatMap((id) => claims.find((c) => c.id === id)?.citations ?? []);
  const quoteOf = (quote: string) => quote.trim().replace(/\s+/g, " ");
  const evidence = (record: { claimIds: string[] }) =>
    citations(record).map((citation, index) => {
      const quote = quoteOf(citation.quote);
      return (
        <button
          type="button"
          className="linklike dossier-citation"
          key={`${citation.sourceId}-${index}`}
          title={quote.length > 180 ? `${quote.slice(0, 180)}…` : quote}
          onClick={() => void inspect(citation.sourceId, citation.quote)}
        >
          Evidence {index + 1}: {citationLabel(summaryById.get(citation.sourceId), quote)}
        </button>
      );
    });
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
        {claimStatusLabel(item.status)} · {claimNatureLabel(item.nature)} ·{" "}
        {item.effectiveFrom ?? "Date unknown"}
        {item.effectiveTo ? ` to ${item.effectiveTo}` : ""}
        {capturedAt(item) ? ` · archived capture ${capturedAt(item)}` : ""}
      </p>
      {item.citations.map((citation, index) => {
        const quote = quoteOf(citation.quote);
        return (
          <button
            className="linklike dossier-citation"
            type="button"
            key={index}
            title={quote.length > 180 ? `${quote.slice(0, 180)}…` : quote}
            onClick={() => void inspect(citation.sourceId, citation.quote)}
          >
            Source {index + 1}: {citationLabel(summaryById.get(citation.sourceId), quote)}
          </button>
        );
      })}
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
            {latestRevision > REVISION_WINDOW && !showAllRevisions && (
              <option disabled>
                …{latestRevision - REVISION_WINDOW} older revisions not listed
              </option>
            )}
            {revisionOptions(latestRevision, revision, showAllRevisions).map((value) => (
              <option key={value} value={value}>
                Revision {value}
              </option>
            ))}
          </select>
        </label>
      )}
      {latestRevision > REVISION_WINDOW && !showAllRevisions && (
        <button type="button" className="linklike" onClick={() => setShowAllRevisions(true)}>
          Show all {latestRevision} revisions
        </button>
      )}
      {revision !== undefined && (
        <p role="status">
          Reading historical dossier revision {revision}. This records earlier evidence, not current
          attribution. Corrected sources may be unavailable; privacy deletion can remove evidence.
        </p>
      )}
      <div className="card">
        {/* The app itself is down (UX audit F1b): a stale "Researching" line
            must never keep reading as live, so the banner replaces the live
            surface and the last known state is labeled stale. */}
        {unreachable && (
          <p role="alert" className="banner-error">
            The app is not responding. Wait a moment and refresh; if it stays down, restart it with{" "}
            <code>docker compose up -d</code>.
          </p>
        )}
        <p role="status">
          <strong>
            {unreachable
              ? "App not responding"
              : !view
                ? readError
                  ? "Research status unavailable"
                  : "Loading dossier"
                : surface
                  ? elapsed === null
                    ? surface.title
                    : `${surface.title} · ${elapsed}`
                  : settings?.settings.paused
                    ? "Workspace research paused"
                    : revision !== undefined
                      ? "Historical dossier"
                      : "No research status available"}
          </strong>{" "}
          {view && !unreachable && (
            <>
              · {dossier?.sourceIds.length ?? 0} retained sources · {claims.length} retained claims
            </>
          )}
        </p>
        <p className="muted">
          {!view
            ? unreachable
              ? "The dossier could not be loaded while the app was not responding. Retrying automatically."
              : readError
                ? "The dossier could not be loaded. Retrying automatically."
                : "Loading retained evidence and research status."
            : unreachable
              ? `The last known state was ${surface?.title ?? "no research status"}. It is stale, not live.`
              : (surface?.detail ??
                (settings?.settings.paused
                  ? "An owner paused automatic research for the workspace."
                  : "Only retained evidence appears in this dossier."))}
        </p>
        {!unreachable && surface?.nextAction && (
          <p>
            <a href={surface.nextAction.href}>{surface.nextAction.label}</a>
          </p>
        )}
        {/* An identifier alone can leave the Profile unnamed (UX audit F5):
            nothing research finds can then be attributed to it, and the cure
            lives in this Profile's own maintenance. */}
        {view?.profile && view.profile.fullName === null && (
          <p className="muted">
            We could not tell who this Profile is about from the identifier alone. Add their full
            name under "Correct facts" in Profile maintenance on this page, then choose Prioritise
            research again.
          </p>
        )}
        <button
          type="button"
          disabled={startingResearch}
          onClick={() => {
            setStartingResearch(true);
            void act(() => client.research(profileId)).finally(() => setStartingResearch(false));
          }}
        >
          {startingResearch ? "Starting research…" : "Prioritise research"}
        </button>{" "}
        {(view?.research?.state === "queued" || view?.research?.state === "researching") && (
          <>
            <button type="button" onClick={() => void act(() => client.cancel(profileId))}>
              Stop research
            </button>{" "}
          </>
        )}
        {!unreachable &&
          (view?.research?.state === "queued" || view?.research?.state === "researching") && (
            <p className="muted">
              You can leave this page — research continues and everything found so far is kept.
            </p>
          )}
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
          explicit demand (spec §7), never automatically. Renderer failures
          recorded beyond the 8-entry sample still get their own surface
          (#417 F9), even when the sample carries none of them. */}
      {!!view?.research && (view.research.diagnostics.sample.length > 0 || rendererFailed > 0) && (
        <details className="card">
          <summary>Source and identity diagnostics</summary>
          <p className="muted">
            Showing {diagnosticsPage?.entries.length ?? view.research.diagnostics.sample.length} of{" "}
            {view.research.diagnostics.totalAttempts} recorded attempts.
          </p>
          {(diagnosticsPage?.entries ?? view.research.diagnostics.sample).map((attempt, index) => (
            <p key={index}>
              <strong title={attempt.code}>{diagnosticCodeLabel(attempt.code)}</strong> ·{" "}
              {attempt.stage} · {attempt.outcome}
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
              onClick={() => {
                const generation = readGeneration.current;
                void client
                  .diagnostics(profileId, diagnosticsPage?.nextCursor ?? undefined)
                  .then((page) => {
                    if (generation !== readGeneration.current) return;
                    setDiagnosticsError("");
                    setDiagnosticsPage((previous) => {
                      if (!page) return previous;
                      // A cursor from the previous operation cannot establish the new one's first page.
                      if (previous && previous.operationId !== page.operationId) return null;
                      return {
                        ...page,
                        entries: [...(previous?.entries ?? []), ...page.entries],
                      };
                    });
                  })
                  .catch((error: unknown) => {
                    if (generation === readGeneration.current)
                      setDiagnosticsError(errorMessage(error));
                  });
              }}
            >
              {diagnosticsPage ? "Load more diagnostics" : "Load full diagnostic history"}
            </button>
          )}
        </details>
      )}
      {/* The aggregate renderer-failure count is its own non-collapsible
          surface (#417 F9): saturation is claimed only from recorded
          renderer-busy evidence, otherwise the honest wording tells the user
          where the per-failure reasons live. */}
      {rendererFailed > 0 && (
        <p className="muted" aria-label="Renderer failure aggregate">
          {rendererFailed === 1
            ? "1 source read failed at rendering."
            : `${rendererFailed} source reads failed at rendering.`}{" "}
          {rendererBusyCount > 0
            ? `${rendererBusyCount === 1 ? "1 was" : `${rendererBusyCount} were`} shed because the browser source renderer was busy.`
            : "The bounded sample records no renderer-busy reason; the full diagnostic history below names each failure's recorded reason."}
        </p>
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
              {sectionStateLabel(section.state)} · Last researched{" "}
              <EvidenceDate value={section.updatedAt} />
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
                    {citationLabel(
                      summaryById.get(sourceId),
                      `Inspect retained source ${index + 1}`,
                    )}
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
          /* Plain language instead of storage vocabulary (UX audit F10). */
          <p className="muted">
            Nothing is documented here yet. Research has not found evidence for this section;
            missing evidence stays unknown rather than guessed.
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
