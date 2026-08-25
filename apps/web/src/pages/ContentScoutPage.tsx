import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CONTENT_SCOUT_DRAFT_TARGETS_V1,
  type ContentDraft,
  type ContentPack,
} from "@chief-of-staff-demo/shared";
import { api, errorMessage, type ContentScoutState } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

type View = "shortlist" | "packs" | "sources" | "brand" | "settings";

const VIEWS: { id: View; label: string }[] = [
  { id: "shortlist", label: "Shortlist" },
  { id: "packs", label: "Content Packs" },
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

function packTargetIds(pack: ContentPack): Set<string> {
  return new Set(
    pack.draftIds.map((id) => {
      const marker = id.lastIndexOf(":v1");
      const prefix = marker === -1 ? id : id.slice(0, marker);
      return prefix.slice(prefix.lastIndexOf(":") + 1);
    }),
  );
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

  if (!state) {
    return (
      <section className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Content Scout
        </h1>
        <p role="status" className={error ? "field-error" : "muted"}>
          {error ?? "Loading Content Scout…"}
        </p>
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
            Public Source Targets become a ranked shortlist, then complete local and Notion drafts.
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
      {view === "packs" && <PacksView packs={state.contentPacks} />}
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
  const shortlist = state.shortlist;
  useEffect(() => setSelected([]), [shortlist?.runId]);
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
      <div className="toolbar">
        <button
          type="button"
          className="primary"
          aria-disabled={busy || selected.length === 0}
          onClick={(event) => {
            if (busy || selected.length === 0) return;
            retainFocus(event.currentTarget);
            void act(async () => {
              await api.selectContentScout(shortlist.runId, selected);
              await waitForRun(shortlist.runId);
            }, "The complete Content Pack is ready.");
          }}
        >
          {busy
            ? "Generating…"
            : `Generate ${selected.length || "selected"} pack${selected.length === 1 ? "" : "s"}`}
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

function PacksView({ packs }: { packs: ContentPack[] }) {
  const [open, setOpen] = useState<{ packId: string; targetId: string } | null>(null);
  const [loaded, setLoaded] = useState<{
    draft: ContentDraft;
    notionPage: { id: string; url: string } | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setLoaded(null);
    setError(null);
    api
      .contentDraft(open.packId, open.targetId)
      .then(setLoaded)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [open]);

  if (packs.length === 0) {
    return (
      <div className="card">
        <h2>No Content Packs yet</h2>
        <p className="muted">A pack appears after you choose a shortlist opportunity.</p>
      </div>
    );
  }
  return (
    <section aria-labelledby="packs-heading">
      <h2 id="packs-heading">Content Packs</h2>
      {packs.map((pack) => {
        const generated = packTargetIds(pack);
        return (
          <article className="card" key={pack.id}>
            <div className="pack-heading">
              <div>
                <h3>{pack.opportunityTitle}</h3>
                <p className="muted">
                  {pack.draftIds.length}/23 local drafts · {pack.notionPages.length}/23 Notion pages
                </p>
              </div>
              <span
                className={`status-badge ${pack.status === "complete" ? "status-done" : "status-attention"}`}
              >
                {pack.status}
              </span>
            </div>
            <div className="draft-grid">
              {CONTENT_SCOUT_DRAFT_TARGETS_V1.map((target) => (
                <button
                  type="button"
                  key={target.id}
                  disabled={!generated.has(target.id)}
                  onClick={() => setOpen({ packId: pack.id, targetId: target.id })}
                >
                  <span>{target.channel}</span>
                  <strong>{target.format}</strong>
                </button>
              ))}
            </div>
          </article>
        );
      })}
      {open && (
        <section className="card draft-reader" aria-labelledby="draft-heading">
          {error ? (
            <p className="field-error">{error}</p>
          ) : !loaded ? (
            <p className="muted">Loading draft…</p>
          ) : (
            <>
              <div className="pack-heading">
                <h3 id="draft-heading">
                  {loaded.draft.target.channel} — {loaded.draft.target.format}
                </h3>
                <button type="button" onClick={() => setOpen(null)}>
                  Close
                </button>
              </div>
              <pre tabIndex={0}>{loaded.draft.copy}</pre>
              <div className="toolbar">
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(loaded.draft.copy)}
                >
                  Copy draft
                </button>
                {loaded.notionPage && (
                  <a
                    className="action-button"
                    href={loaded.notionPage.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open editable Notion copy
                  </a>
                )}
              </div>
              <details>
                <summary>Production and evidence notes</summary>
                <ul>
                  {loaded.draft.productionNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
                <ul>
                  {loaded.draft.reviewNotes.map((note, index) => (
                    <li key={`${note.claim}-${index}`}>
                      <strong>{note.kind}:</strong> {note.claim}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </section>
      )}
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
              <div className="pack-heading">
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
  const [token, setToken] = useState("");
  const initial = state.settings ?? {
    timeZone: "UTC",
    dailyTime: "08:00",
    weeklyDiscoveryDay: 1,
    weeklyDiscoveryTime: "09:00",
    shortlistSize: 5,
    notion: {
      databaseId: "",
      dataSourceId: "",
      databaseUrl: "",
      mapping: {
        name: "Name",
        status: "Status",
        platform: "Platform",
        format: "Format",
        scheduledDate: "Scheduled date",
      },
    },
  };
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [dailyTime, setDailyTime] = useState(initial.dailyTime);
  const [weeklyDiscoveryDay, setWeeklyDiscoveryDay] = useState(initial.weeklyDiscoveryDay);
  const [weeklyDiscoveryTime, setWeeklyDiscoveryTime] = useState(initial.weeklyDiscoveryTime);
  const [shortlistSize, setShortlistSize] = useState(initial.shortlistSize);
  const [parentPageId, setParentPageId] = useState("");
  const [databaseId, setDatabaseId] = useState(initial.notion.databaseId);
  const [dataSourceId, setDataSourceId] = useState(initial.notion.dataSourceId);
  const [databaseUrl, setDatabaseUrl] = useState(initial.notion.databaseUrl);
  const [mapping, setMapping] = useState(initial.notion.mapping);
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
          <h3>Notion</h3>
          <p>
            Status: <strong>{state.notion.state}</strong>
            {state.notion.tokenHint ? ` (${state.notion.tokenHint})` : ""}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const button =
                event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
              if (button) retainFocus(button);
              void act(() => api.connectNotion(token), "Notion token verified and stored.").then(
                () => setToken(""),
              );
            }}
          >
            <label className="field">
              Internal-integration token
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required
              />
            </label>
            <div className="toolbar">
              <button className="primary" type="submit" aria-disabled={busy}>
                Verify and connect
              </button>
              {state.notion.state !== "unconfigured" && (
                <button
                  type="button"
                  onClick={(event) => {
                    retainFocus(event.currentTarget);
                    void act(() => api.disconnectNotion(), "Notion disconnected.");
                  }}
                >
                  Disconnect
                </button>
              )}
            </div>
          </form>
          {state.notion.state === "connected" && (
            <>
              <h4>Content calendar</h4>
              {initial.notion.databaseId && (
                <p className="banner banner-ok">
                  Calendar configured.{" "}
                  <a href={initial.notion.databaseUrl} target="_blank" rel="noreferrer">
                    Open in Notion
                  </a>
                </p>
              )}
              <details className="disclosure">
                <summary>Create the standard Content Scout calendar</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (busy) return;
                    const button =
                      event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
                    if (button) retainFocus(button);
                    void act(
                      () => api.configureNotionCalendar({ mode: "create", parentPageId }),
                      "Standard Notion content calendar created and selected.",
                    );
                  }}
                >
                  <label className="field">
                    Notion parent page ID
                    <input
                      value={parentPageId}
                      onChange={(event) => setParentPageId(event.target.value)}
                      required
                    />
                  </label>
                  <p className="field-hint muted">
                    Share this parent page with the same internal integration first.
                  </p>
                  <button className="primary" type="submit" aria-disabled={busy}>
                    Create standard calendar
                  </button>
                </form>
              </details>
              <details className="disclosure">
                <summary>Map an existing Notion calendar</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (busy) return;
                    const button =
                      event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
                    if (button) retainFocus(button);
                    void act(
                      () =>
                        api.configureNotionCalendar({
                          mode: "existing",
                          databaseId,
                          dataSourceId,
                          databaseUrl,
                          mapping,
                        }),
                      "Existing Notion calendar validated and selected without changing its schema.",
                    );
                  }}
                >
                  <div className="form-grid">
                    <label className="field">
                      Database ID
                      <input
                        value={databaseId}
                        onChange={(event) => setDatabaseId(event.target.value)}
                        required
                      />
                    </label>
                    <label className="field">
                      Data source ID
                      <input
                        value={dataSourceId}
                        onChange={(event) => setDataSourceId(event.target.value)}
                        required
                      />
                    </label>
                    <label className="field">
                      Database URL
                      <input
                        type="url"
                        value={databaseUrl}
                        onChange={(event) => setDatabaseUrl(event.target.value)}
                        required
                      />
                    </label>
                    {(["name", "status", "platform", "format", "scheduledDate"] as const).map(
                      (field) => (
                        <label className="field" key={field}>
                          {field === "scheduledDate"
                            ? "Scheduled date"
                            : field[0]!.toUpperCase() + field.slice(1)}{" "}
                          property
                          <input
                            value={mapping[field]}
                            onChange={(event) =>
                              setMapping((current) => ({ ...current, [field]: event.target.value }))
                            }
                            required
                          />
                        </label>
                      ),
                    )}
                  </div>
                  <button className="primary" type="submit" aria-disabled={busy}>
                    Validate and use calendar
                  </button>
                </form>
              </details>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

interface ViewProps {
  state: ContentScoutState;
  busy: boolean;
  act: (action: () => Promise<unknown>, message: string) => Promise<void>;
  retainFocus: (button: HTMLButtonElement) => void;
}
