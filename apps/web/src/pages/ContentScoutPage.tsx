import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CONTENT_PROJECT_RESEARCH_MODES,
  CONTENT_PROJECT_TARGETS,
  SOURCE_BACKFILL_WINDOWS_DAYS,
  type ContentScoutCleanupPreview,
  type ContentProjectResearchMode,
  type ContentProjectTarget,
} from "@chief-of-staff-demo/shared";
import { api, errorMessage, type ContentScoutState } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

type View = "shortlist" | "sources" | "brand" | "settings";

const VIEWS: { id: View; label: string }[] = [
  { id: "shortlist", label: "Shortlist" },
  { id: "sources", label: "Sources" },
  { id: "brand", label: "Brand Profile" },
  { id: "settings", label: "Settings & Health" },
];

async function waitForRun(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = await api.getRun(runId);
    if (["blocked", "done", "skipped"].includes(run.status)) return;
    if (run.status === "failed") {
      throw new Error(run.failureHint ?? "The Content Scout Run failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Content Scout is still working. Open the Intake Run to follow its progress.");
}

export function ContentScoutPage() {
  useTitle("Content Scout");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [view, setView] = useState<View>("shortlist");
  const [state, setState] = useState<ContentScoutState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedBeforeBusy = useRef<HTMLButtonElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.contentScout());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
      setNotice(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      selectedBeforeBusy.current?.focus();
      selectedBeforeBusy.current = null;
    }
  };

  /* The loading branch must mirror the loaded header's structure exactly: the
     h1 that usePageFocus focuses is nested under `.page-header > div` once the
     state arrives, and a bare h1 here would sit at a different reconciliation
     position, so React would replace the focused node with a fresh one and
     silently drop focus onto <body> (WCAG 2.4.3 / 4.1.3 — the swap Settings
     survives by reusing the same heading node). */
  if (!state) {
    return (
      <section className="page content-scout">
        <div className="page-header">
          <div>
            <h1 ref={headingRef} tabIndex={-1}>
              Content Scout
            </h1>
            <p role="status" className={error ? "field-error" : "muted"}>
              {error ?? "Loading Content Scout…"}
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page content-scout">
      <div className="page-header">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>
            Content Scout
          </h1>
          <p className="muted">
            Public Source Targets become a ranked shortlist; selecting an Opportunity starts one
            governed Content Project in the Content Engine.
          </p>
        </div>
        <button
          className="primary"
          type="button"
          aria-disabled={busy}
          onClick={(event) => {
            if (busy) return;
            selectedBeforeBusy.current = event.currentTarget;
            void act(async () => {
              const { runId } = await api.runContentScout();
              await waitForRun(runId);
            }, "The ranked shortlist is ready for your decision.");
          }}
        >
          {busy ? "Working…" : "Scout now"}
        </button>
      </div>

      <nav className="subnav" aria-label="Content Scout views">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={view === item.id}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div aria-live="polite" aria-atomic="true">
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="banner banner-ok" role="status">
            {notice}
          </div>
        )}
      </div>

      {state.health.warnings.length > 0 && (
        <div className="banner banner-warn" role="status">
          <span>
            Collection is degraded:{" "}
            {state.health.warnings
              .map((warning) => `${warning.adapterId} ${warning.outcome.replaceAll("_", " ")}`)
              .join("; ")}
            .
          </span>
          {state.health.runId && <Link to={`/runs/${state.health.runId}`}>Open diagnostics</Link>}
        </div>
      )}

      {view === "shortlist" && (
        <ShortlistView
          state={state}
          busy={busy}
          act={act}
          retainFocus={(button) => {
            selectedBeforeBusy.current = button;
          }}
        />
      )}
      {view === "sources" && (
        <SourcesView
          state={state}
          busy={busy}
          act={act}
          retainFocus={(button) => {
            selectedBeforeBusy.current = button;
          }}
        />
      )}
      {view === "brand" && (
        <BrandView
          state={state}
          busy={busy}
          act={act}
          retainFocus={(button) => {
            selectedBeforeBusy.current = button;
          }}
        />
      )}
      {view === "settings" && (
        <SettingsView
          state={state}
          busy={busy}
          act={act}
          retainFocus={(button) => {
            selectedBeforeBusy.current = button;
          }}
        />
      )}
    </section>
  );
}

function ShortlistView({
  state,
  busy,
  act,
  retainFocus,
}: {
  state: ContentScoutState;
  busy: boolean;
  act: (action: () => Promise<unknown>, message: string) => Promise<void>;
  retainFocus: (button: HTMLButtonElement) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [objective, setObjective] = useState("educate");
  const [customObjective, setCustomObjective] = useState("");
  const [audience, setAudience] = useState("");
  const [targets, setTargets] = useState<ContentProjectTarget[]>([]);
  const [researchMode, setResearchMode] = useState<ContentProjectResearchMode>(
    "existing-workspace-evidence",
  );
  const [started, setStarted] = useState<
    { opportunityId: string; projectId: string; created: boolean }[]
  >([]);
  const shortlist = state.shortlist;
  useEffect(() => {
    setSelected([]);
    setStarted([]);
  }, [shortlist?.runId]);
  const resolvedObjective = objective === "custom" ? customObjective.trim() : objective;
  const canStart =
    selected.length > 0 &&
    resolvedObjective.length > 0 &&
    audience.trim().length > 0 &&
    targets.length > 0;
  if (!shortlist) {
    return (
      <div className="card">
        <h2>No shortlist yet</h2>
        <p className="muted">
          Accept a Brand Profile, add an approved Source Target, then choose Scout now.
        </p>
      </div>
    );
  }
  const ready = shortlist.opportunities.filter((opportunity) => opportunity.state === "ready");
  return (
    <section aria-labelledby="shortlist-heading">
      <h2 id="shortlist-heading">Ranked shortlist</h2>
      <p className="muted">
        Select one to three Ready opportunities. The Intake Run remains durably blocked until you
        decide.
      </p>
      {ready.length === 0 ? (
        <div className="card">
          <p>No Ready opportunities remain in this shortlist.</p>
        </div>
      ) : (
        ready.map((opportunity) => (
          <article className="card" key={opportunity.id}>
            <label className="opportunity-card">
              <input
                type="checkbox"
                checked={selected.includes(opportunity.id)}
                disabled={!selected.includes(opportunity.id) && selected.length === 3}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, opportunity.id]
                      : current.filter((id) => id !== opportunity.id),
                  )
                }
              />
              <span>
                <strong>{opportunity.title}</strong>
                <span className="opportunity-meta">
                  {opportunity.angle.replaceAll("_", " ")} ·{" "}
                  {Math.round(opportunity.confidence * 100)}% confidence
                </span>
                {opportunity.earlyFollowUp && (
                  <>
                    <span className="status-badge status-attention">
                      Early follow-up ·{" "}
                      {opportunity.earlyFollowUp.kind === "different_angle"
                        ? "different angle"
                        : "material development"}
                    </span>
                    <span className="muted">{opportunity.earlyFollowUp.explanation}</span>
                  </>
                )}
                <span>{opportunity.explanation}</span>
                <span className="muted">{opportunity.urgency}</span>
              </span>
            </label>
            <div className="toolbar source-links">
              {opportunity.sourceUrls.map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  Source
                </a>
              ))}
              <button
                type="button"
                onClick={(event) => {
                  retainFocus(event.currentTarget);
                  void act(
                    () =>
                      api.decideContentOpportunity(
                        shortlist.runId,
                        opportunity.id,
                        "dismiss_angle",
                      ),
                    "The angle was dismissed and enters a seven-day cooldown.",
                  );
                }}
              >
                Dismiss this angle
              </button>
              <button
                type="button"
                onClick={(event) => {
                  retainFocus(event.currentTarget);
                  void act(
                    () =>
                      api.decideContentOpportunity(shortlist.runId, opportunity.id, "not_relevant"),
                    "The opportunity was marked Not relevant.",
                  );
                }}
              >
                Not relevant
              </button>
              <button
                type="button"
                onClick={(event) => {
                  retainFocus(event.currentTarget);
                  void act(
                    () =>
                      api.decideContentOpportunity(
                        shortlist.runId,
                        opportunity.id,
                        "already_covered",
                      ),
                    "The opportunity was marked Already covered.",
                  );
                }}
              >
                Already covered
              </button>
            </div>
          </article>
        ))
      )}
      {started.length > 0 && (
        <div className="card">
          <h3>Projects started</h3>
          <ul>
            {started.map((entry) => (
              <li key={entry.opportunityId}>
                <code>{entry.projectId}</code>
                {entry.created ? "" : " (already existed)"}
              </li>
            ))}
          </ul>
          <p className="muted">
            The Projects hold the Opportunity relationship and still require evidence review, an
            approved Outline Brief, and every other Content Engine gate before generation.
          </p>
        </div>
      )}
      {selected.length > 0 && (
        <div className="card">
          <h3>
            Start {selected.length === 1 ? "a" : selected.length} Content Project
            {selected.length === 1 ? "" : "s"}
          </h3>
          <p className="muted">
            Each selected Opportunity becomes exactly one governed Content Project. Nothing is
            generated here: the Project still requires author, audience, objective, evidence,
            targets, Brand Voice, and an approved Outline Brief.
          </p>
          <div className="form-grid">
            <label className="field">
              Objective
              <select value={objective} onChange={(event) => setObjective(event.target.value)}>
                <option value="educate">Educate</option>
                <option value="provoke discussion">Provoke discussion</option>
                <option value="establish authority">Establish authority</option>
                <option value="drive a specific action">Drive a specific action</option>
                <option value="custom">Custom…</option>
              </select>
            </label>
            {objective === "custom" && (
              <label className="field">
                Custom objective
                <input
                  value={customObjective}
                  onChange={(event) => setCustomObjective(event.target.value)}
                  required
                />
              </label>
            )}
            <label className="field">
              Intended audience
              <input
                value={audience}
                onChange={(event) => setAudience(event.target.value)}
                required
              />
            </label>
            <fieldset>
              <legend>Publication targets</legend>
              {CONTENT_PROJECT_TARGETS.map((target) => (
                <label className="checkbox-label" key={target}>
                  <input
                    type="checkbox"
                    checked={targets.includes(target)}
                    onChange={(event) =>
                      setTargets((current) =>
                        event.target.checked
                          ? [...current, target]
                          : current.filter((candidate) => candidate !== target),
                      )
                    }
                  />
                  {target.replaceAll("-", " ")}
                </label>
              ))}
            </fieldset>
            <label className="field">
              Research mode
              <select
                value={researchMode}
                onChange={(event) =>
                  setResearchMode(event.target.value as ContentProjectResearchMode)
                }
              >
                {CONTENT_PROJECT_RESEARCH_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode.replaceAll("-", " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
      <div className="toolbar">
        <button
          type="button"
          className="primary"
          aria-disabled={busy || !canStart}
          onClick={(event) => {
            if (busy || !canStart) return;
            retainFocus(event.currentTarget);
            void act(async () => {
              const response = await api.selectContentScout(shortlist.runId, selected, {
                objective: resolvedObjective,
                audience,
                targets,
                researchMode,
              });
              setStarted(response.projects);
              await waitForRun(shortlist.runId);
            }, "The selected Opportunities started their Content Projects.");
          }}
        >
          {busy
            ? "Working…"
            : `Start ${selected.length === 1 ? "Project" : `${selected.length} Projects`}`}
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={(event) => {
            if (busy) return;
            retainFocus(event.currentTarget);
            void act(() => api.skipContentScout(shortlist.runId), "The shortlist was skipped.");
          }}
        >
          Skip shortlist
        </button>
        <Link to={`/runs/${shortlist.runId}`}>Open Intake Run</Link>
      </div>
    </section>
  );
}

function SourcesView({ state, busy, act, retainFocus }: ViewProps) {
  const configurable = state.adapters.filter((adapter) => adapter.state !== "coming_later");
  const [adapterId, setAdapterId] = useState(configurable[0]?.id ?? "rss");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  return (
    <section aria-labelledby="sources-heading">
      <div className="page-header">
        <div>
          <h2 id="sources-heading">Approved Source Targets</h2>
          <p className="muted">Suggestions never collect until you approve them.</p>
        </div>
        <button
          type="button"
          aria-disabled={busy}
          onClick={(event) => {
            if (busy) return;
            retainFocus(event.currentTarget);
            void act(async () => {
              const { runId } = await api.runSourceDiscovery();
              await waitForRun(runId);
            }, "Source Discovery finished.");
          }}
        >
          {busy ? "Discovering…" : "Discover sources"}
        </button>
      </div>
      <form
        className="card form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const button =
            event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
          if (button) retainFocus(button);
          void act(
            () => api.addContentSource({ adapterId, label, url }),
            "Source Target approved.",
          ).then(() => {
            setLabel("");
            setUrl("");
          });
        }}
      >
        <label className="field">
          Adapter
          <select
            aria-label="Source Adapter"
            value={adapterId}
            onChange={(event) => setAdapterId(event.target.value)}
          >
            {configurable.map((adapter) => (
              <option key={adapter.id} value={adapter.id}>
                {adapter.id} — {adapter.state}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Name
          <input value={label} onChange={(event) => setLabel(event.target.value)} required />
        </label>
        <label className="field">
          Recurring public URL
          <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required />
        </label>
        <button className="primary" type="submit" aria-disabled={busy}>
          {busy ? "Saving…" : "Approve source"}
        </button>
      </form>
      <div className="adapter-strip" aria-label="Adapter health">
        {state.adapters.map((adapter) => (
          <span key={adapter.id} className="status-badge status-source">
            {adapter.id}: {adapter.state}
          </span>
        ))}
      </div>
      {state.sourceTargets.length === 0 ? (
        <p className="muted">No Source Targets approved yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Adapter</th>
                <th>Collection</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {state.sourceTargets.map((target) => (
                <tr key={target.id}>
                  <td>
                    <strong>{target.label}</strong>
                    <br />
                    <a href={target.url} target="_blank" rel="noreferrer">
                      {target.url}
                    </a>
                  </td>
                  <td>{target.adapterId}</td>
                  <td>
                    {target.lastSuccessfulAt
                      ? `Last completed ${new Date(target.lastSuccessfulAt).toLocaleString()}`
                      : "Not collected yet"}
                  </td>
                  <td>
                    <div className="toolbar">
                      <button
                        type="button"
                        onClick={(event) => {
                          retainFocus(event.currentTarget);
                          void act(
                            () =>
                              api.setContentSourceState(
                                target.id,
                                target.state === "active" ? "archived" : "active",
                              ),
                            target.state === "active"
                              ? "Source archived; its history was preserved."
                              : "Source restored.",
                          );
                        }}
                      >
                        {target.state === "active" ? "Archive" : "Restore"}
                      </button>
                      {target.state === "active" &&
                        SOURCE_BACKFILL_WINDOWS_DAYS.map((windowDays) => {
                          const supported = (
                            state.adapters.find((adapter) => adapter.id === target.adapterId)
                              ?.backfillWindowsDays ?? []
                          ).includes(windowDays);
                          return (
                            <button
                              key={windowDays}
                              type="button"
                              aria-disabled={busy || !supported}
                              title={
                                supported
                                  ? `Collect up to ${windowDays} days of history for this Source Target.`
                                  : `The ${target.adapterId} Source Adapter does not support a ${windowDays}-day backfill.`
                              }
                              onClick={(event) => {
                                if (busy || !supported) return;
                                retainFocus(event.currentTarget);
                                void act(async () => {
                                  const { runId } = await api.backfillContentSource(
                                    target.id,
                                    windowDays,
                                  );
                                  await waitForRun(runId);
                                }, `${windowDays}-day backfill finished.`);
                              }}
                            >
                              {windowDays}-day backfill
                            </button>
                          );
                        })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Source Suggestions</h2>
      {state.sourceSuggestions.filter((suggestion) => suggestion.state !== "approved").length ===
      0 ? (
        <p className="muted">No suggestions awaiting a decision.</p>
      ) : (
        state.sourceSuggestions
          .filter((suggestion) => suggestion.state !== "approved")
          .map((suggestion) => (
            <article className="card" key={suggestion.id}>
              <div className="card-heading">
                <div>
                  <h3>{suggestion.label}</h3>
                  <a href={suggestion.url} target="_blank" rel="noreferrer">
                    {suggestion.url}
                  </a>
                </div>
                <span className="status-badge status-source">{suggestion.state}</span>
              </div>
              <p>{suggestion.discoveredBecause}</p>
              <p className="muted">{suggestion.similarityFactors.join(" · ")}</p>
              {suggestion.evidenceUrls.length > 0 && (
                <p className="muted">
                  Evidence:{" "}
                  {suggestion.evidenceUrls.map((evidenceUrl, index) => (
                    <span key={evidenceUrl}>
                      {index > 0 ? " · " : ""}
                      <a href={evidenceUrl} target="_blank" rel="noreferrer">
                        {evidenceUrl}
                      </a>
                    </span>
                  ))}
                </p>
              )}
              <div className="toolbar">
                {suggestion.state === "proposed" ? (
                  <>
                    <button
                      className="primary"
                      type="button"
                      onClick={(event) => {
                        retainFocus(event.currentTarget);
                        void act(
                          () => api.decideSourceSuggestion(suggestion.id, "approved"),
                          "Suggestion approved as a Source Target.",
                        );
                      }}
                    >
                      Approve source
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        retainFocus(event.currentTarget);
                        void act(
                          () =>
                            api.decideSourceSuggestion(
                              suggestion.id,
                              "dismissed",
                              "Dismissed in Sources",
                            ),
                          "Suggestion dismissed and remembered.",
                        );
                      }}
                    >
                      Dismiss
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => {
                      retainFocus(event.currentTarget);
                      void act(
                        () => api.decideSourceSuggestion(suggestion.id, "proposed"),
                        "Suggestion restored for review.",
                      );
                    }}
                  >
                    Restore suggestion
                  </button>
                )}
              </div>
            </article>
          ))
      )}
    </section>
  );
}

function BrandView({ state, busy, act, retainFocus }: ViewProps) {
  const [websiteUrl, setWebsiteUrl] = useState(state.brandProfile?.sourceScan.websiteUrl ?? "");
  const [markdown, setMarkdown] = useState(
    state.brandProfile?.markdown ??
      "# Brand Profile\n\n## Positioning\n\n## Audience\n\n## Voice\n\n## Avoided subjects\n",
  );
  const revision = state.brandProfile;
  const proposal = state.brandProfileProposal;
  const [includedUrls, setIncludedUrls] = useState<string[]>([]);
  const [acceptedSections, setAcceptedSections] = useState<string[]>([]);
  useEffect(() => {
    if (!proposal) return;
    setIncludedUrls(proposal.pages.filter((page) => page.included).map((page) => page.url));
    setAcceptedSections(
      proposal.sectionDiffs
        .filter((diff) => diff.status !== "unchanged" && diff.status !== "conflicting")
        .map((diff) => diff.section),
    );
  }, [proposal]);
  return (
    <section aria-labelledby="brand-heading">
      <h2 id="brand-heading">Brand Profile</h2>
      <p className="muted">
        Start with a bounded same-origin scan (25 pages, depth two), review its evidence, then
        accept only the sections you want. No scan changes the current profile.
      </p>
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const button =
            event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
          if (button) retainFocus(button);
          void act(async () => {
            const { runId } = await api.scanBrandProfile(websiteUrl);
            await waitForRun(runId);
          }, "Brand Profile proposal is ready for review.");
        }}
      >
        <label className="field">
          Company website URL
          <input
            type="url"
            value={websiteUrl}
            onChange={(event) => setWebsiteUrl(event.target.value)}
            required
          />
        </label>
        <button className="primary" type="submit" aria-disabled={busy}>
          {busy ? "Scanning…" : revision ? "Rescan website" : "Scan website"}
        </button>
      </form>

      {proposal && (
        <section className="card" aria-labelledby="proposal-heading">
          <h3 id="proposal-heading">Review website evidence</h3>
          <p className="muted">
            Excluded defaults stay visible and can be included before acceptance.
          </p>
          <div className="profile-pages">
            {proposal.pages.map((page) => (
              <label key={page.url} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={includedUrls.includes(page.url)}
                  onChange={(event) =>
                    setIncludedUrls((current) =>
                      event.target.checked
                        ? [...current, page.url]
                        : current.filter((url) => url !== page.url),
                    )
                  }
                />
                <span>
                  <strong>{page.title}</strong>
                  <br />
                  <span className="muted">
                    Depth {page.depth} · {page.url}
                    {page.exclusionReason ? ` · ${page.exclusionReason}` : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <h3>Section-by-section proposal</h3>
          {proposal.sectionDiffs.map((diff) => (
            <details className="disclosure" key={diff.section}>
              <summary>
                <label onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={acceptedSections.includes(diff.section)}
                    onChange={(event) =>
                      setAcceptedSections((current) =>
                        event.target.checked
                          ? [...current, diff.section]
                          : current.filter((section) => section !== diff.section),
                      )
                    }
                  />{" "}
                  Accept {diff.section}
                </label>{" "}
                <span
                  className={`status-badge ${diff.status === "conflicting" ? "status-attention" : "status-source"}`}
                >
                  {diff.status.replaceAll("_", " ")}
                </span>
              </summary>
              <div className="profile-diff">
                <div>
                  <strong>Current</strong>
                  <p>{diff.currentValue || "No accepted value"}</p>
                </div>
                <div>
                  <strong>Website proposal</strong>
                  <p>
                    {diff.proposedValue ||
                      "No new website value; accepting this will not delete the current value."}
                  </p>
                </div>
              </div>
            </details>
          ))}
          <button
            className="primary"
            type="button"
            aria-disabled={busy || acceptedSections.length === 0}
            onClick={(event) => {
              if (busy || acceptedSections.length === 0) return;
              retainFocus(event.currentTarget);
              void act(
                () =>
                  api.acceptBrandProfileProposal(proposal.id, {
                    acceptedSections,
                    includedUrls,
                    excludedUrls: proposal.pages
                      .map((page) => page.url)
                      .filter((url) => !includedUrls.includes(url)),
                    note: revision
                      ? "Accepted website rescan changes"
                      : "Initial accepted website proposal",
                  }),
                "Brand Profile proposal accepted as a new immutable revision.",
              );
            }}
          >
            Accept selected sections
          </button>
        </section>
      )}

      <h2>{revision ? "Edit current revision" : "Or author manually"}</h2>
      <p className="muted">
        Each manual acceptance also creates a new immutable Markdown revision.
      </p>
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const button =
            event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
          if (button) retainFocus(button);
          void act(
            () =>
              api.saveBrandProfile({
                markdown,
                websiteUrl,
                includedUrls: [websiteUrl],
                excludedUrls: [],
                note: revision ? "Manual revision" : "Initial accepted profile",
              }),
            "Brand Profile revision accepted.",
          );
        }}
      >
        <label className="field">
          Website used as evidence
          <input
            type="url"
            value={websiteUrl}
            onChange={(event) => setWebsiteUrl(event.target.value)}
            required
          />
        </label>
        <label className="field">
          Accepted Markdown
          <textarea
            rows={18}
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            required
          />
        </label>
        <button className="primary" type="submit" aria-disabled={busy}>
          {busy ? "Saving…" : revision ? "Accept new revision" : "Accept Brand Profile"}
        </button>
      </form>
      {revision && (
        <p className="muted">
          Current revision {revision.id}, accepted {new Date(revision.createdAt).toLocaleString()}.
        </p>
      )}
    </section>
  );
}

function SettingsView({ state, busy, act, retainFocus }: ViewProps) {
  const [cleanupPreview, setCleanupPreview] = useState<ContentScoutCleanupPreview | null>(null);
  const initial = state.settings ?? {
    timeZone: "UTC",
    dailyTime: "08:00",
    weeklyDiscoveryDay: 1,
    weeklyDiscoveryTime: "09:00",
    shortlistSize: 5,
    canaryIntervalHours: 12,
    canaryDisabledAdapters: [],
  };
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [dailyTime, setDailyTime] = useState(initial.dailyTime);
  const [weeklyDiscoveryDay, setWeeklyDiscoveryDay] = useState(initial.weeklyDiscoveryDay);
  const [weeklyDiscoveryTime, setWeeklyDiscoveryTime] = useState(initial.weeklyDiscoveryTime);
  const [shortlistSize, setShortlistSize] = useState(initial.shortlistSize);
  const [canaryIntervalHours, setCanaryIntervalHours] = useState(initial.canaryIntervalHours);
  const [canaryDisabledAdapters, setCanaryDisabledAdapters] = useState<string[]>(
    initial.canaryDisabledAdapters,
  );
  const available = useMemo(
    () => state.adapters.filter((adapter) => adapter.state === "available").length,
    [state.adapters],
  );
  return (
    <section aria-labelledby="health-heading">
      <h2 id="health-heading">Settings & Health</h2>
      <div className="health-grid">
        <div className="card">
          <h3>Collection schedule</h3>
          <p>
            <strong>{available}</strong> Available adapters
          </p>
          <p className="muted">
            Experimental evidence is labeled; Coming later adapters cannot be configured.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const button =
                event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
              if (button) retainFocus(button);
              void act(
                () =>
                  api.saveContentScoutSchedule({
                    timeZone,
                    dailyTime,
                    weeklyDiscoveryDay,
                    weeklyDiscoveryTime,
                    shortlistSize,
                    canaryIntervalHours,
                    canaryDisabledAdapters,
                  }),
                "Content Scout schedule saved.",
              );
            }}
          >
            <label className="field">
              IANA time zone
              <input
                value={timeZone}
                onChange={(event) => setTimeZone(event.target.value)}
                required
              />
            </label>
            <div className="form-grid">
              <label className="field">
                Daily Intake time
                <input
                  type="time"
                  value={dailyTime}
                  onChange={(event) => setDailyTime(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                Shortlist size
                <input
                  type="number"
                  min={3}
                  max={10}
                  value={shortlistSize}
                  onChange={(event) => setShortlistSize(Number(event.target.value))}
                  required
                />
              </label>
              <label className="field">
                Canary interval (hours)
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={canaryIntervalHours}
                  onChange={(event) => setCanaryIntervalHours(Number(event.target.value))}
                  required
                />
              </label>
              <label className="field">
                Discovery weekday
                <select
                  value={weeklyDiscoveryDay}
                  onChange={(event) => setWeeklyDiscoveryDay(Number(event.target.value))}
                >
                  {[
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                    "Sunday",
                  ].map((day, index) => (
                    <option key={day} value={index + 1}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Discovery time
                <input
                  type="time"
                  value={weeklyDiscoveryTime}
                  onChange={(event) => setWeeklyDiscoveryTime(event.target.value)}
                  required
                />
              </label>
            </div>
            <fieldset className="field">
              <legend>Canary targets contacted</legend>
              <p className="muted">
                Canary batches contact these public services to prove each adapter still works. The
                first batch only runs when you ask for it; after that it repeats on the interval
                above. Clear an adapter to stop contacting its targets entirely.
              </p>
              {state.adapters
                .filter((adapter) => adapter.canaryTargets.length > 0)
                .map((adapter) => (
                  <label key={adapter.id} className="field-inline">
                    <input
                      type="checkbox"
                      checked={!canaryDisabledAdapters.includes(adapter.id)}
                      onChange={(event) =>
                        setCanaryDisabledAdapters((current) =>
                          event.target.checked
                            ? current.filter((id) => id !== adapter.id)
                            : [...current, adapter.id],
                        )
                      }
                    />
                    {adapter.id} ({adapter.canaryTargets.length} targets)
                  </label>
                ))}
            </fieldset>
            <button className="primary" type="submit" aria-disabled={busy}>
              Save schedule
            </button>
          </form>
          <p className="muted">
            Last daily period: {state.schedule.lastSuccessfulIntakePeriod ?? "never"}
            <br />
            Last discovery period: {state.schedule.lastSuccessfulDiscoveryPeriod ?? "never"}
          </p>
        </div>
        <div className="card">
          <h3>Storage & retention</h3>
          <dl className="receipt-grid">
            {(
              [
                ["Durable records", state.storage.categories.durableRecords],
                ["Sanitized diagnostics", state.storage.categories.sanitizedDiagnostics],
                ["Temporary media", state.storage.categories.temporaryMedia],
                [
                  "Retained evidence transcripts",
                  state.storage.categories.retainedEvidenceTranscripts,
                ],
              ] as const
            ).map(([label, category]) => (
              <div className="receipt-row" key={label}>
                <dt>{label}</dt>
                <dd>
                  {formatBytes(category.bytes)} in {category.files} file
                  {category.files === 1 ? "" : "s"}
                </dd>
              </div>
            ))}
          </dl>
          <p className="muted">
            Cleanup covers only sanitized diagnostics older than 30 days and failed temporary media
            older than 24 hours. Brand Profiles, source history, Run receipts, Content Packs, and
            evidence transcripts remain.
          </p>
          <div className="toolbar">
            <button
              type="button"
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) return;
                retainFocus(event.currentTarget);
                void act(async () => {
                  setCleanupPreview(await api.previewContentScoutCleanup());
                }, "Temporary-data cleanup preview is ready.");
              }}
            >
              Preview temporary cleanup
            </button>
            {cleanupPreview && cleanupPreview.files > 0 && (
              <button
                className="danger"
                type="button"
                aria-disabled={busy}
                onClick={(event) => {
                  if (busy) return;
                  retainFocus(event.currentTarget);
                  void act(async () => {
                    await api.cleanupContentScoutTemporaryData();
                    setCleanupPreview(null);
                  }, "Expired temporary data deleted. Durable records and evidence were preserved.");
                }}
              >
                Delete {cleanupPreview.files} expired temporary file
                {cleanupPreview.files === 1 ? "" : "s"}
              </button>
            )}
          </div>
          {cleanupPreview && (
            <div className="banner banner-warn" role="status">
              {cleanupPreview.files === 0
                ? "Nothing is eligible for temporary-data cleanup."
                : `${cleanupPreview.files} scoped temporary file${cleanupPreview.files === 1 ? "" : "s"} (${formatBytes(cleanupPreview.bytes)}) will be deleted. Durable records and evidence transcripts are excluded.`}
            </div>
          )}
        </div>
        <div className="card">
          <h3>Adapter release receipts</h3>
          <p className="muted">
            Representative public canary Source Targets run on schedule outside merge CI using the
            normal diagnostic contract. Results persist by adapter version, target, capability,
            route, and time. Promotion requires repeated successful canaries, not one sample; a
            canary failure never fails CI and never hides behind a legitimate empty result.
          </p>
          {state.adapters.length === 0 ? (
            <p>No adapters configured.</p>
          ) : (
            <ul className="not-done-list">
              {state.adapters.map((adapter) => {
                const health = state.canary.health.find((entry) => entry.adapterId === adapter.id);
                return (
                  <li key={adapter.id}>
                    <strong>{adapter.id}</strong>: {adapter.state} · {adapter.version}
                    {adapter.promotionEligible
                      ? " · promotion eligible"
                      : " · not promotion eligible"}
                    {health?.degraded ? " · degraded" : " · healthy"}
                    <br />
                    <span className="muted">
                      Canary targets ({adapter.canaryTargets.length}):{" "}
                      {adapter.canaryTargets.map((target) => target.label).join(", ") || "none"}
                    </span>
                    {health && (
                      <>
                        <br />
                        <span className="muted">
                          Recent canary outcomes:{" "}
                          {health.evidence.recentOutcomes.join(", ") || "none"} · required{" "}
                          {health.evidence.requiredSuccesses} successes for promotion (version{" "}
                          {health.evidence.version}) · success count {health.evidence.successCount}
                        </span>
                        <br />
                        <span className="muted">
                          Last success: {health.lastSuccessAt ?? "never"} · last failure:{" "}
                          {health.lastFailureAt ?? "never"}
                        </span>
                        {health.recentReceipts.length > 0 && (
                          <ul>
                            {health.recentReceipts.slice(0, 3).map((receipt) => (
                              <li key={`${receipt.target.url}:${receipt.checkedAt}`}>
                                {receipt.target.label} — {receipt.outcome} · {receipt.route} ·{" "}
                                {receipt.capability} · {receipt.itemsFound} items ·{" "}
                                {new Date(receipt.checkedAt).toLocaleString()}
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted">Canary receipts shown: {state.canary.receipts.length} recent</p>
          <div className="toolbar">
            <button
              type="button"
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) return;
                retainFocus(event.currentTarget);
                void act(
                  () => api.runCanaries(),
                  "Canary batch finished. Health reflects the latest receipts.",
                );
              }}
            >
              Run canaries now
            </button>
          </div>
        </div>
        <div className="card">
          <h3>External runtimes</h3>
          <p className="muted">
            These command capabilities are checked inside the same production runtime that runs
            Source Adapters.
          </p>
          {state.runtimeCapabilities.length === 0 ? (
            <p>No external runtime inspection is configured.</p>
          ) : (
            <ul className="not-done-list">
              {state.runtimeCapabilities.map((capability) => (
                <li key={capability.id}>
                  <strong>{capability.id}</strong>: {runtimeStateLabel(capability.state)}
                  {capability.version ? ` — ${capability.version}` : ""}
                  {capability.pinnedVersion ? ` (pinned ${capability.pinnedVersion})` : ""}
                  {capability.requiredBy.length > 0
                    ? `; used by ${capability.requiredBy.join(", ")}`
                    : ""}
                  {capability.diagnostic.causeChain.length > 0
                    ? `. ${capability.diagnostic.causeChain.join(" → ")}`
                    : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h3>LinkedIn evidence gate</h3>
          <p>
            Adapter <strong>linkedin</strong>:{" "}
            <span className="status-badge status-source">coming_later</span>
          </p>
          <p className="muted">
            LinkedIn stays Coming later unless a clean anonymous public browser route proves a
            useful Source Item contract through repeated canaries across{" "}
            {state.linkedinEvidenceGate.requiredTargets} representative targets ×{" "}
            {state.linkedinEvidenceGate.repeatsPerTarget} repeats on{" "}
            {state.adapters.find((adapter) => adapter.id === "linkedin")?.version ??
              "linkedin-public-browser-v1"}
            .
          </p>
          <p>
            Gate:{" "}
            <strong>
              {state.linkedinEvidenceGate.passed
                ? "Passed — explicit human promotion still required"
                : "Unmet — remains Coming later"}
            </strong>
            {" · checked "}
            {new Date(state.linkedinEvidenceGate.checkedAt).toLocaleString()}
          </p>
          {!state.linkedinEvidenceGate.passed && state.linkedinEvidenceGate.reason && (
            <p className="field-error" role="status">
              {state.linkedinEvidenceGate.reason}
            </p>
          )}
          {state.linkedinEvidenceGate.passed && (
            <p className="banner banner-ok" role="status">
              Evidence gate passed. Promotion does not happen silently; a reviewable change is still
              required to make LinkedIn Available or Experimental.
            </p>
          )}
          <p className="muted">
            Canary uses a clean public browser with no login, imported cookies, shared identity,
            CAPTCHA bypass, or proxy evasion. Blocked access, login walls, empty shells, and
            response-shape changes count as failed evidence, not successful empty.
          </p>
          <details>
            <summary>
              Representative targets ({state.linkedinEvidenceGate.representativeTargets.length})
            </summary>
            <ul>
              {state.linkedinEvidenceGate.representativeTargets.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          </details>
          {state.linkedinEvidenceGate.evidence.length > 0 && (
            <details>
              <summary>
                Recent canary evidence ({state.linkedinEvidenceGate.evidence.length})
              </summary>
              <ul>
                {state.linkedinEvidenceGate.evidence.slice(0, 12).map((entry, index) => (
                  <li key={`${entry.targetUrl}-${index}`}>
                    {entry.targetUrl} → {entry.outcome.replaceAll("_", " ")} · {entry.itemsFound}{" "}
                    item
                    {entry.itemsFound === 1 ? "" : "s"}
                    {entry.hasUsefulItem ? " (useful)" : ""} ·{" "}
                    {new Date(entry.observedAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function runtimeStateLabel(state: "available" | "unavailable" | "unsupported"): string {
  if (state === "available") return "Available";
  if (state === "unavailable") return "Unavailable";
  return "Unsupported";
}

interface ViewProps {
  state: ContentScoutState;
  busy: boolean;
  act: (action: () => Promise<unknown>, message: string) => Promise<void>;
  retainFocus: (button: HTMLButtonElement) => void;
}
