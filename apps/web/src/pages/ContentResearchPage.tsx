import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ContentResearchIndex,
  NamedPerson,
  PersonSuggestion,
  ResonanceScoredItem,
} from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

type PlatformFilter = "all" | "rss" | "youtube" | "reddit" | "hn" | "news" | "bluesky" | "mastodon";

const PLATFORM_OPTIONS: { value: PlatformFilter; label: string }[] = [
  { value: "all", label: "All platforms" },
  { value: "rss", label: "RSS" },
  { value: "youtube", label: "YouTube" },
  { value: "reddit", label: "Reddit" },
  { value: "hn", label: "HN" },
  { value: "news", label: "News" },
];

function formatHandleHints(person: NamedPerson): string {
  const hints: string[] = [];
  if (person.handleHints.blueskyDid) hints.push(`Bluesky ${person.handleHints.blueskyDid}`);
  if (person.handleHints.mastodon) hints.push(`Mastodon ${person.handleHints.mastodon}`);
  if (person.handleHints.youtubeChannelId)
    hints.push(`YouTube ${person.handleHints.youtubeChannelId}`);
  if (person.handleHints.hnUsername) hints.push(`HN ${person.handleHints.hnUsername}`);
  if (person.handleHints.blogRssHints.length > 0)
    hints.push(`RSS ${person.handleHints.blogRssHints.join(", ")}`);
  return hints.length > 0 ? hints.join(" · ") : "No handle hints";
}

function completenessSummary(item: ResonanceScoredItem): string {
  const parts = Object.entries(item.completeness)
    .filter(([, value]) => value && value !== "missing" && value !== "empty")
    .map(([key]) => key);
  return parts.length > 0 ? parts.join(", ") : "missing";
}

/**
 * Evidence from a feed is the URL that was fetched; evidence from an API is the
 * route that was called (`youtube.data.playlistItems.list`). Only the first can
 * be opened, so only the first is rendered as a link.
 */
function isOpenableEvidence(evidenceUrl: string): boolean {
  return /^https?:\/\//i.test(evidenceUrl);
}

export function ContentResearchPage() {
  useTitle("Content Research");
  const headingRef = usePageFocus<HTMLHeadingElement>();

  const [index, setIndex] = useState<ContentResearchIndex | null>(null);
  const [people, setPeople] = useState<NamedPerson[] | null>(null);
  const [suggestions, setSuggestions] = useState<PersonSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [showGated, setShowGated] = useState(false);
  const [expandedReports, setExpandedReports] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState("");
  const [newSite, setNewSite] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [idx, ppl, sug] = await Promise.all([
        api.contentResearchIndex(),
        api.contentResearchPeople(),
        api.contentResearchSuggestions(),
      ]);
      setIndex(idx);
      setPeople(ppl);
      setSuggestions(sug);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep selected person honest when the index changes.
  useEffect(() => {
    if (!index || index.byPerson.length === 0) return;
    if (selectedPersonId && index.byPerson.some((entry) => entry.personId === selectedPersonId))
      return;
    setSelectedPersonId(index.byPerson[0]!.personId);
  }, [index, selectedPersonId]);

  const currentPerson =
    index?.byPerson.find((entry) => entry.personId === selectedPersonId) ?? null;

  const gatedRuns = (index?.runs ?? []).filter((run) => run.status !== "done");

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
    }
  };

  const handleAddPerson = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      setAddError("Enter a name.");
      return;
    }
    const site = newSite.trim();
    if (site && !/^https?:\/\//i.test(site)) {
      setAddError("The site or feed address must start with http:// or https://.");
      return;
    }
    setAddError(null);
    /* The hint names where to look: a feed is watched directly, a site is asked
       for the feeds it declares. Without one, only the name-searched surfaces
       (Reddit, HN, News) can find this person. */
    await act(
      () => api.addContentResearchPerson(name, site ? { blogRssHints: [site] } : undefined),
      `Watching ${name}.`,
    );
    setNewName("");
    setNewSite("");
  };

  const toggleReport = (runId: string) => {
    setExpandedReports((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const toggleItem = (key: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!index || !people || !suggestions) {
    return (
      <section className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Content Research — what is resonating, for whom, and why
        </h1>
        <p role="status" className={error ? "field-error" : "muted"}>
          {error ?? "Loading Content Research…"}
        </p>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>
            Content Research — what is resonating, for whom, and why
          </h1>
          <p className="muted">
            Named people watched across RSS, YouTube, Reddit, HN and News — ranked by resonance
            against their own 90-day baseline.
          </p>
        </div>
      </div>

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

      {/* Controls */}
      <div className="toolbar" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
        <button
          type="button"
          className="primary"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => api.runContentResearch(), "Content Research run started.");
          }}
        >
          {busy ? "Working…" : "Run Now"}
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => api.backfillContentResearch(7), "Backfill 7d started.");
          }}
        >
          Backfill 7d
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => api.backfillContentResearch(30), "Backfill 30d started.");
          }}
        >
          Backfill 30d
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => api.backfillContentResearch(90), "Backfill 90d started.");
          }}
        >
          Backfill 90d
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => api.discoverContentResearchPeople(), "People discovery started.");
          }}
        >
          Discover Now
        </button>
        <label>
          Platform:{" "}
          <select
            value={platform}
            onChange={(event) => setPlatform(event.target.value as PlatformFilter)}
          >
            {PLATFORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Watchlist */}
      <section className="card" aria-labelledby="watchlist-heading">
        <h2 id="watchlist-heading">Watchlist — named people</h2>
        {people.length === 0 ? (
          <p className="muted">No one watched yet. Add a name below.</p>
        ) : (
          <ul>
            {people.map((person) => (
              <li key={person.id} style={{ marginBottom: "0.5rem" }}>
                <strong>{person.name}</strong>{" "}
                <span className="muted">· {formatHandleHints(person)}</span>{" "}
                <span className="muted">
                  · added {new Date(person.createdAt).toLocaleDateString()}
                </span>{" "}
                <button
                  type="button"
                  aria-disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    void act(
                      () => api.stopWatchingContentResearchPerson(person.id),
                      `No longer watching ${person.name}.`,
                    );
                  }}
                >
                  Stop watching
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={(event) => void handleAddPerson(event)} style={{ marginTop: "0.75rem" }}>
          <div className="field-row">
            <input
              aria-label="Person name"
              placeholder="Add person — e.g. Ada Lovelace"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <input
              aria-label="Site or feed address"
              placeholder="Site or feed — e.g. https://example.com"
              value={newSite}
              onChange={(event) => setNewSite(event.target.value)}
            />
            <button type="submit" aria-disabled={busy}>
              Add person
            </button>
          </div>
          {addError && (
            <p className="field-error" role="alert">
              {addError}
            </p>
          )}
          <p className="muted field-hint">
            People-first watchlist — no LinkedIn. The site or feed is optional: paste a feed to
            watch it directly, or a site and its declared feeds are discovered. Without one, only
            Reddit, HN and News are searched by name.
          </p>
        </form>
      </section>

      {/* Cross-Run index primary by Person */}
      {index.byPerson.length === 0 ? (
        <div className="card">
          <h2>Resonance index</h2>
          <p className="muted">
            No reports yet. Add people to the watchlist and choose Run Now — or wait for the daily
            08:00 scan.
          </p>
        </div>
      ) : (
        <>
          <nav className="sub-tabs" aria-label="People">
            {index.byPerson.map((entry) => (
              <button
                key={entry.personId}
                type="button"
                className="sub-tab"
                aria-current={entry.personId === currentPerson?.personId ? "true" : undefined}
                onClick={() => setSelectedPersonId(entry.personId)}
              >
                {entry.personName}
              </button>
            ))}
          </nav>

          {currentPerson && (
            <section className="card" aria-labelledby="person-heading">
              <h2 id="person-heading">{currentPerson.personName}</h2>
              {currentPerson.reports.length === 0 ? (
                <p className="muted">No reports for this person yet.</p>
              ) : (
                <>
                  {/* Simple textual sparkline: resonanceScoreMax over time */}
                  <p className="muted">
                    {currentPerson.reports.length} report
                    {currentPerson.reports.length === 1 ? "" : "s"} · latest resonance{" "}
                    {currentPerson.reports[0]!.resonanceScoreMax.toFixed(2)} · oldest{" "}
                    {currentPerson.reports[
                      currentPerson.reports.length - 1
                    ]!.resonanceScoreMax.toFixed(2)}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.35rem",
                      alignItems: "end",
                      marginBottom: "0.75rem",
                    }}
                  >
                    {[...currentPerson.reports]
                      .slice()
                      .reverse()
                      .map((report) => {
                        const max = Math.max(
                          ...currentPerson.reports.map((entry) => entry.resonanceScoreMax),
                          1,
                        );
                        const height = Math.max(
                          4,
                          Math.round((report.resonanceScoreMax / max) * 28),
                        );
                        return (
                          <span
                            key={report.runId}
                            title={`${report.generatedAt}: ${report.resonanceScoreMax.toFixed(2)}`}
                            style={{
                              width: "10px",
                              height: `${height}px`,
                              background: "var(--accent)",
                              borderRadius: "2px",
                              display: "inline-block",
                            }}
                          />
                        );
                      })}
                  </div>

                  {[...currentPerson.reports]
                    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
                    .map((report) => {
                      const filtered =
                        platform === "all"
                          ? report.items
                          : report.items.filter((item) => item.platform === platform);
                      const isOpen = expandedReports.has(report.runId);
                      return (
                        <details
                          key={report.runId}
                          className="disclosure"
                          open={isOpen}
                          onToggle={() => toggleReport(report.runId)}
                          style={{ marginBottom: "0.5rem" }}
                        >
                          <summary>
                            <Link
                              to={`/runs/${report.runId}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {new Date(report.generatedAt).toLocaleString()}
                            </Link>{" "}
                            · max resonance {report.resonanceScoreMax.toFixed(2)} ·{" "}
                            {filtered.length} item
                            {filtered.length === 1 ? "" : "s"}
                            {platform !== "all" ? ` · ${platform}` : ""} ·{" "}
                            {report.runId.slice(0, 8)}
                          </summary>
                          <div className="disclosure-body">
                            {filtered.length === 0 ? (
                              <p className="muted">No items for this platform in this report.</p>
                            ) : (
                              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                                {filtered
                                  .slice()
                                  .sort((a, b) => b.resonanceScore - a.resonanceScore)
                                  .map((item) => {
                                    const itemKey = `${report.runId}:${item.sourceItemId}`;
                                    const itemOpen = expandedItems.has(itemKey);
                                    return (
                                      <li
                                        key={item.sourceItemId}
                                        style={{
                                          borderBottom: "1px solid var(--line)",
                                          padding: "0.6rem 0",
                                        }}
                                      >
                                        <div
                                          style={{
                                            display: "flex",
                                            gap: "0.5rem",
                                            flexWrap: "wrap",
                                          }}
                                        >
                                          <span className="status-badge">{item.platform}</span>
                                          <span className="status-badge">
                                            resonance {item.resonanceScore.toFixed(2)}
                                          </span>
                                          <span className="muted">
                                            weighted {item.weightedCount}
                                          </span>
                                        </div>
                                        <div style={{ marginTop: "0.35rem" }}>
                                          <strong>{item.title ?? "(untitled)"}</strong>{" "}
                                          <a
                                            href={item.canonicalUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            open
                                          </a>
                                          {item.evidenceUrl &&
                                            item.evidenceUrl !== item.canonicalUrl && (
                                              <>
                                                {" · "}
                                                {isOpenableEvidence(item.evidenceUrl) ? (
                                                  <a
                                                    href={item.evidenceUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                  >
                                                    evidence
                                                  </a>
                                                ) : (
                                                  <span className="muted">
                                                    evidence: {item.evidenceUrl}
                                                  </span>
                                                )}
                                              </>
                                            )}
                                        </div>
                                        {item.hook && (
                                          <p style={{ margin: "0.25rem 0" }}>
                                            <em>{item.hook}</em>
                                            {item.evidenceQuote && (
                                              <span className="muted">
                                                {" "}
                                                — “{item.evidenceQuote}”
                                              </span>
                                            )}
                                          </p>
                                        )}
                                        <p
                                          className="muted"
                                          style={{ margin: "0.2rem 0", fontSize: "0.85rem" }}
                                        >
                                          completeness: {completenessSummary(item)} · counts:{" "}
                                          {Object.entries(item.counts)
                                            .filter(([, value]) => value !== undefined)
                                            .map(([key, value]) => `${key} ${value}`)
                                            .join(", ") || "none"}
                                          {item.publishedAt &&
                                            ` · published ${new Date(item.publishedAt).toLocaleDateString()}`}
                                        </p>
                                        <button
                                          type="button"
                                          className="linklike"
                                          aria-expanded={itemOpen}
                                          onClick={() => toggleItem(itemKey)}
                                        >
                                          {itemOpen ? "Hide detail" : "Show detail"}
                                        </button>
                                        {itemOpen && (
                                          <div
                                            style={{
                                              marginTop: "0.35rem",
                                              padding: "0.5rem",
                                              background: "var(--surface-alt)",
                                              borderRadius: "4px",
                                            }}
                                          >
                                            <dl className="receipt-grid">
                                              <div className="receipt-row">
                                                <dt>canonicalUrl</dt>
                                                <dd>
                                                  <a
                                                    href={item.canonicalUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                  >
                                                    {item.canonicalUrl}
                                                  </a>
                                                </dd>
                                              </div>
                                              {item.evidenceUrl && (
                                                <div className="receipt-row">
                                                  <dt>evidenceUrl</dt>
                                                  <dd>
                                                    {isOpenableEvidence(item.evidenceUrl) ? (
                                                      <a
                                                        href={item.evidenceUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                      >
                                                        {item.evidenceUrl}
                                                      </a>
                                                    ) : (
                                                      item.evidenceUrl
                                                    )}
                                                  </dd>
                                                </div>
                                              )}
                                              <div className="receipt-row">
                                                <dt>completeness</dt>
                                                <dd>
                                                  {Object.entries(item.completeness)
                                                    .map(([key, value]) => `${key}: ${value}`)
                                                    .join(" · ")}
                                                </dd>
                                              </div>
                                              <div className="receipt-row">
                                                <dt>sourceItemId</dt>
                                                <dd>{item.sourceItemId}</dd>
                                              </div>
                                            </dl>
                                          </div>
                                        )}
                                      </li>
                                    );
                                  })}
                              </ul>
                            )}
                          </div>
                        </details>
                      );
                    })}
                </>
              )}
            </section>
          )}
        </>
      )}

      {/* Collapsed gated/skipped Runs */}
      <section className="card" aria-labelledby="gated-heading">
        <h2 id="gated-heading">Gated / skipped Runs</h2>
        {gatedRuns.length === 0 ? (
          <p className="muted">No gated or skipped runs.</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowGated((value) => !value)}
              aria-expanded={showGated}
            >
              {showGated ? "Hide" : "Show"} {gatedRuns.length} run
              {gatedRuns.length === 1 ? "" : "s"}
            </button>
            {showGated && (
              <ul style={{ marginTop: "0.5rem" }}>
                {gatedRuns.map((run) => (
                  <li key={run.runId} style={{ marginBottom: "0.35rem" }}>
                    <Link to={`/runs/${run.runId}`}>{run.runId.slice(0, 8)}</Link>{" "}
                    <span className="status-badge status-skipped">{run.status}</span>{" "}
                    <span className="muted">{run.intake}</span> · {run.summary}
                    <span className="muted"> · {new Date(run.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* Suggestions */}
      <section className="card" aria-labelledby="suggestions-heading">
        <h2 id="suggestions-heading">People suggestions</h2>
        {suggestions.length === 0 ? (
          <p className="muted">
            No suggestions. Use Discover Now to propose people related to the brand.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {suggestions.map((suggestion) => (
              <li
                key={suggestion.id}
                style={{ borderBottom: "1px solid var(--line)", padding: "0.6rem 0" }}
              >
                <div
                  style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}
                >
                  <strong>{suggestion.name}</strong>
                  <span className="status-badge">{suggestion.state}</span>
                  <span className="muted">{suggestion.source}</span>
                </div>
                <p style={{ margin: "0.25rem 0" }}>{suggestion.reason}</p>
                <p className="muted" style={{ margin: "0.2rem 0", fontSize: "0.85rem" }}>
                  Relationship: {suggestion.relationshipToBrand}
                </p>
                {suggestion.supportingUrls.length > 0 && (
                  <p className="muted" style={{ margin: "0.2rem 0", fontSize: "0.85rem" }}>
                    Evidence:{" "}
                    {suggestion.supportingUrls.map((url, index) => (
                      <span key={url}>
                        {index > 0 ? " · " : ""}
                        <a href={url} target="_blank" rel="noreferrer">
                          {url}
                        </a>
                      </span>
                    ))}
                  </p>
                )}
                {suggestion.decisionReason && (
                  <p className="muted" style={{ fontSize: "0.85rem" }}>
                    Decision: {suggestion.decisionReason}
                  </p>
                )}
                <div className="toolbar" style={{ marginTop: "0.35rem" }}>
                  {suggestion.state === "pending" && (
                    <>
                      <button
                        type="button"
                        className="primary"
                        aria-disabled={busy}
                        onClick={() => {
                          if (busy) return;
                          void act(
                            () => api.decideContentResearchSuggestion(suggestion.id, "approved"),
                            `Approved ${suggestion.name}.`,
                          );
                        }}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        aria-disabled={busy}
                        onClick={() => {
                          if (busy) return;
                          void act(
                            () => api.decideContentResearchSuggestion(suggestion.id, "dismissed"),
                            `Dismissed ${suggestion.name}.`,
                          );
                        }}
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                  {suggestion.state === "dismissed" && (
                    <button
                      type="button"
                      aria-disabled={busy}
                      onClick={() => {
                        if (busy) return;
                        void act(
                          () => api.decideContentResearchSuggestion(suggestion.id, "restore"),
                          `Restored ${suggestion.name}.`,
                        );
                      }}
                    >
                      Restore
                    </button>
                  )}
                  {suggestion.state === "approved" && (
                    <span className="muted">Approved — now in watchlist.</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
