import { useEffect, useState } from "react";
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
  read(id: string): Promise<DossierView>;
  source(id: string, sourceId: string): Promise<PersonSourceDocument>;
  history(id: string): Promise<PersonRelationshipRecord[]>;
  analysis(id: string): Promise<PersonDossierAnalysis | null>;
  research(id: string): Promise<unknown>;
  detach(id: string, sourceId: string): Promise<unknown>;
  settings(): Promise<PersonResearchStatus>;
  configure(settings: Partial<PersonResearchSettings>): Promise<unknown>;
}
const api: DossierClient = {
  read: (id) => request(`/api/people/${encodeURIComponent(id)}/dossier`),
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
  const [view, setView] = useState<DossierView | null>(null);
  const [tab, setTab] = useState<keyof typeof tabs>("overview");
  const [source, setSource] = useState<{ document: PersonSourceDocument; quote: string } | null>(
    null,
  );
  const [analysis, setAnalysis] = useState<PersonDossierAnalysis | null>(null);
  const [history, setHistory] = useState<PersonRelationshipRecord[]>([]);
  const [settings, setSettings] = useState<PersonResearchStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const data = await client.read(profileId);
        if (live) setView(data);
        if (data.dossier) {
          const analysis = await client.analysis(profileId);
          if (live) setAnalysis(analysis);
        }
      } catch (error) {
        if (live) setError(errorMessage(error));
      }
    };
    void refresh();
    const sourceId = new URLSearchParams(window.location.search).get("source");
    if (sourceId)
      void client
        .source(profileId, sourceId)
        .then((document) => {
          if (live) {
            setSource({ document, quote: "" });
            setTab("sources");
          }
        })
        .catch((error) => {
          if (live) setError(errorMessage(error));
        });
    const timer = setInterval(() => void refresh(), 4000);
    void client
      .history(profileId)
      .then((records) => {
        if (live) setHistory(records);
      })
      .catch((error) => {
        if (live) setError(errorMessage(error));
      });
    void client
      .settings()
      .then((value) => {
        if (live) setSettings(value);
      })
      .catch((error) => {
        if (live) setError(errorMessage(error));
      });
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [profileId, client]);
  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      setSettings(await client.settings());
      setView(await client.read(profileId));
      setError("");
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function inspect(sourceId: string, quote: string) {
    try {
      setSource({ document: await client.source(profileId, sourceId), quote });
    } catch (error) {
      setError(errorMessage(error));
    }
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
  const claim = (item: PersonClaim) => (
    <article className="card" key={item.id}>
      <p>{item.statement}</p>
      <p className="muted">
        {item.status} · {item.nature} · {item.effectiveFrom ?? "Date unknown"}
        {item.effectiveTo ? ` to ${item.effectiveTo}` : ""}
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
      <div className="card">
        <p role="status">
          <strong>
            {settings?.settings.paused
              ? "Workspace research paused"
              : view?.research
                ? states[view.research.state]
                : "Preparing automatic research"}
          </strong>{" "}
          · {view?.research?.sources ?? 0} sources processed · {claims.length} retained claims
        </p>
        <p className="muted">
          {view?.research?.detail ?? "Sources will populate this dossier automatically."}
        </p>
        <button type="button" onClick={() => void act(() => client.research(profileId))}>
          Prioritise research
        </button>{" "}
        <details>
          <summary>Research settings</summary>
          {settings && (
            <>
              <p>
                {settings.usedCalls} / {settings.settings.dailyCalls} research operations today. A
                search operation can contact several providers. This is an operation allowance, not
                a monetary cap.
              </p>
              <button
                type="button"
                onClick={() =>
                  void act(() => client.configure({ paused: !settings.settings.paused }))
                }
              >
                {settings.settings.paused ? "Resume research" : "Pause research"}
              </button>
              {(
                [
                  "dailyCalls",
                  "profileCalls",
                  "concurrency",
                  "profileMilliseconds",
                  "refreshHours",
                ] as const
              ).map((key) => (
                <label key={key} style={{ display: "block", marginTop: 12 }}>
                  {
                    {
                      dailyCalls: "Daily operations",
                      profileCalls: "Operations per Profile",
                      concurrency: "Concurrent Profiles",
                      profileMilliseconds: "Time per Profile (milliseconds)",
                      refreshHours: "Current facts refresh (hours)",
                    }[key]
                  }{" "}
                  <input
                    type="number"
                    min={1}
                    value={settings.settings[key]}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        settings: { ...settings.settings, [key]: Number(event.target.value) },
                      })
                    }
                  />
                </label>
              ))}
              <button
                type="button"
                onClick={() =>
                  void act(() =>
                    /* Limits only: sending the whole settings object back would
                       re-assert `paused` and cancel in-flight research that this
                       edit never touched (#207). */
                    client.configure({
                      dailyCalls: settings.settings.dailyCalls,
                      profileCalls: settings.settings.profileCalls,
                      concurrency: settings.settings.concurrency,
                      profileMilliseconds: settings.settings.profileMilliseconds,
                      refreshHours: settings.settings.refreshHours,
                    }),
                  )
                }
              >
                Save research limits
              </button>
            </>
          )}
        </details>
      </div>
      {error && (
        <p role="alert" className="banner-error">
          {error}
        </p>
      )}
      {!!view?.research?.diagnostics?.length && (
        <details className="card">
          <summary>Source and identity diagnostics</summary>
          {view.research.diagnostics.map((diagnostic, index) => (
            <p key={index}>
              {diagnostic.url} · {diagnostic.stage}: {diagnostic.reason}
            </p>
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
      <div id="dossier-panel" role="tabpanel" aria-labelledby={`dossier-tab-${tab}`}>
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
          history.length ? (
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
            <article className="card" key={work.id}>
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
        <section className="card" aria-label="Retained source">
          <button type="button" onClick={() => setSource(null)}>
            Close source
          </button>
          <button
            type="button"
            onClick={() =>
              void act(async () => {
                await client.detach(profileId, source.document.id);
                setSource(null);
              })
            }
          >
            Remove wrong-person attribution
          </button>
          <h3>{source.document.title}</h3>
          <p>
            {source.document.author ?? "Author unknown"} · Published{" "}
            {source.document.publishedAt ?? "date unknown"} · Retrieved{" "}
            {source.document.retrievedAt}
          </p>
          <p>
            {source.document.sourceClass} · {source.document.completeness} ·{" "}
            {source.document.access} · Source family {source.document.family}
          </p>
          <p>{source.document.url}</p>
          <blockquote>{source.quote}</blockquote>
          <details open>
            <summary>Retained text</summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: 600,
                overflow: "auto",
              }}
            >
              {source.quote
                ? source.document.text.split(source.quote).map((part, i) => (
                    <span key={i}>
                      {i > 0 && <mark>{source.quote}</mark>}
                      {part}
                    </span>
                  ))
                : source.document.text}
            </pre>
          </details>
        </section>
      )}
    </section>
  );
}
