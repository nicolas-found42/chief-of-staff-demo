import { PersonSourceInspector } from "./PersonSourceInspector";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PersonClaim,
  PersonDossier,
  PersonResearchJob,
  PersonResearchSettings,
  PersonResearchStatus,
  PersonSourceDocument,
  PersonRelationshipRecord,
  PersonDossierAnalysis,
} from "@chief-of-staff-demo/shared";
import { request, errorMessage } from "../client";

interface DossierView {
  dossier: PersonDossier | null;
  research: PersonResearchJob | null;
}
export interface DossierClient {
  read(id: string, revision?: number): Promise<DossierView>;
  source(id: string, sourceId: string): Promise<PersonSourceDocument>;
  history(id: string): Promise<PersonRelationshipRecord[]>;
  analysis(id: string): Promise<PersonDossierAnalysis | null>;
  research(id: string): Promise<unknown>;
  detach(id: string, sourceId: string): Promise<unknown>;
  settings(): Promise<PersonResearchStatus>;
  configure(settings: Partial<PersonResearchSettings>): Promise<unknown>;
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
const states = {
  queued: "Queued",
  researching: "Researching",
  paused: "Paused by limit",
  incomplete: "Incomplete scope",
  unavailable: "Sources unavailable",
  interrupted: "Research interrupted",
  empty: "No matched evidence found",
  current: "Current within completed scope",
};

export function PersonDossierPanel({
  profileId,
  client = api,
}: {
  profileId: string;
  client?: DossierClient;
}) {
  const [revision, setRevision] = useState<number | undefined>(() => {
    const value = Number(new URLSearchParams(window.location.search).get("dossierRevision"));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  });
  const [latestRevision, setLatestRevision] = useState(0);
  const [view, setView] = useState<DossierView | null>(null);
  const [tab, setTab] = useState<keyof typeof tabs>("overview");
  const [source, setSource] = useState<{ id: string; quote: string } | null>(null);
  const [analysis, setAnalysis] = useState<PersonDossierAnalysis | null>(null);
  const [history, setHistory] = useState<PersonRelationshipRecord[]>([]);
  const editingSettings = useRef(false);
  const settingsEditRevision = useRef(0);
  const [settings, setSettings] = useState<PersonResearchStatus | null>(null);
  const [readError, setReadError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [actionError, setActionError] = useState("");
  const readGeneration = useRef(0);
  const reading = useRef(false);
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
      setLatestRevision(current.dossier?.revision ?? 0);
      const data = revision === undefined ? current : await client.read(profileId, revision);
      if (generation !== readGeneration.current) return;
      setView(data);
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
  }, [profileId, client, revision]);
  const invalidatePending = useCallback(() => {
    ++readGeneration.current;
    ++lifecycle.current;
  }, []);
  useEffect(() => {
    // Never label the last revision's claims as the newly selected revision.
    setView(null);
    setAnalysis(null);
    setReadError("");
    void refresh();
    const timer = setInterval(() => {
      if (!reading.current) void refresh();
    }, 4000);
    return () => {
      invalidatePending();
      clearInterval(timer);
    };
  }, [refresh, invalidatePending]);
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
    setSource(id ? { id, quote: "" } : null);
    if (id) setTab("sources");
  }, [profileId]);

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
      if (generation === lifecycle.current) setActionError(errorMessage(error));
    }
  }
  function inspect(id: string, quote: string) {
    setSource({ id, quote });
  }
  const dossier = view?.dossier;
  const claims = dossier?.claims ?? [];
  const activeClaims = claims.filter((c) => c.status !== "superseded");
  const section = dossier?.sections.find((s) => s.key === tab);
  const displayed =
    tab === "overview" ? activeClaims.slice(0, 8) : activeClaims.filter((c) => c.section === tab);
  const citations = (record: { claimIds: string[] }) =>
    record.claimIds.flatMap((id) => claims.find((c) => c.id === id)?.citations ?? []);
  const evidence = (record: { claimIds: string[] }) =>
    citations(record).map((citation, index) => (
      <button
        type="button"
        className="linklike"
        key={`${citation.sourceId}-${index}`}
        onClick={() => void inspect(citation.sourceId, citation.quote)}
      >
        Evidence {index + 1}
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
          className="linklike"
          type="button"
          key={index}
          onClick={() => void inspect(citation.sourceId, citation.quote)}
        >
          Source {index + 1}
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
          Reading historical dossier revision {revision}. Source removal and privacy deletion may
          invalidate historical evidence.
        </p>
      )}
      <div className="card">
        <p role="status">
          <strong>
            {!view
              ? readError
                ? "Research status unavailable"
                : "Loading dossier"
              : settings?.settings.paused
                ? "Workspace research paused"
                : view.research
                  ? states[view.research.state]
                  : revision !== undefined
                    ? "Historical dossier"
                    : "No research status available"}
          </strong>{" "}
          {view && (
            <>
              · {view.research?.sources ?? 0} sources processed · {claims.length} retained claims
            </>
          )}
        </p>
        <p className="muted">
          {view?.research?.detail ??
            (!view
              ? readError
                ? "The dossier could not be loaded. Retrying automatically."
                : "Loading retained evidence and research status."
              : "Only retained, supported evidence appears in this dossier.")}
        </p>
        <button type="button" onClick={() => void act(() => client.research(profileId))}>
          Prioritise research
        </button>{" "}
        <details>
          <summary>Research settings</summary>
          {settings && (
            <>
              <p>
                Backfill:{" "}
                {
                  settings.jobs.filter(
                    (job) => !["queued", "researching", "paused"].includes(job.state),
                  ).length
                }{" "}
                of {settings.jobs.length} Profiles attempted;{" "}
                {settings.jobs.filter((job) => ["queued", "paused"].includes(job.state)).length}{" "}
                waiting. {settings.usedCalls} research requests today. Research continues while
                useful leads remain; individual requests and retries are bounded.
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
      {[actionError, readError, historyError].filter(Boolean).map((error, index) => (
        <p role="alert" className="banner-error" key={index}>
          {error}
        </p>
      ))}
      {!!view?.research?.diagnostics?.length && (
        <details className="card">
          <summary>Source and identity diagnostics</summary>
          <p className="muted">
            Showing {view.research.diagnostics.length} of{" "}
            {view.research.operation?.attempts.length ?? view.research.diagnostics.length} recorded
            attempts. The full history is kept with the research operation.
          </p>
          {view.research.diagnostics.map((attempt) => (
            <p key={attempt.id}>
              <strong>{attempt.code}</strong> · {attempt.stage} · attempt {attempt.attempt} ·{" "}
              {attempt.target}
              <br />
              {attempt.reason}
              {attempt.observed?.status ? ` (HTTP ${attempt.observed.status})` : ""}
              {attempt.impact ? ` ${attempt.impact}` : ""}
              {attempt.hypothesis ? ` Suspected, not established: ${attempt.hypothesis}` : ""}
            </p>
          ))}
        </details>
      )}
      {!!view?.research?.operation?.gaps.length && (
        <details className="card">
          <summary>What this research did not find</summary>
          {view.research.operation.gaps.map((gap, index) => (
            <p key={index}>{gap}</p>
          ))}
        </details>
      )}
      <div
        role="tablist"
        aria-label="Dossier sections"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBlock: 16 }}
      >
        {Object.entries(tabs).map(([key, label]) => (
          <button
            type="button"
            role="tab"
            id={`dossier-tab-${key}`}
            aria-controls="dossier-panel"
            aria-selected={key === tab}
            tabIndex={key === tab ? 0 : -1}
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
      <div id="dossier-panel" role="tabpanel" tabIndex={0} aria-labelledby={`dossier-tab-${tab}`}>
        <h2>{tabs[tab]}</h2>
        {section && (
          <>
            <p>{section.summary}</p>
            <p className="muted">
              {section.state} · Last researched {section.updatedAt ?? "not yet"}
            </p>
            {evidence(section)}
            {section.gaps.map((gap) => (
              <p className="muted" key={gap}>
                {gap}
              </p>
            ))}
          </>
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
      {source && (
        <PersonSourceInspector
          key={`${profileId}:${source.id}:${source.quote}`}
          profileId={profileId}
          sourceId={source.id}
          quote={source.quote}
          client={client}
          onClose={() => setSource(null)}
          onDetached={refresh}
        />
      )}
    </section>
  );
}
