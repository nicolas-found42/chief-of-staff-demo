import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { PersonProfile, PersonProfileMatchConfidence } from "@chief-of-staff-demo/shared";

import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

const CONFIDENCE_LABELS: Record<PersonProfileMatchConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

function described(profile: PersonProfile): string {
  return [profile.fullName, profile.role, profile.currentEmployer]
    .filter((value) => value !== null)
    .join(" — ");
}

/**
 * The stable Profile detail route (spec #117 IA, /people/:profileId). It shows
 * the current facts, identity signals, sites, publications, evidence with
 * provenance and confidence, enrichment diagnostics, and the revision history;
 * any exact historical revision is one click away and clearly marked as
 * superseded.
 */
export function PersonProfileDetailPage() {
  const { profileId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const revisionParam = searchParams.get("revision");
  const viewRevision = revisionParam === null ? null : Number(revisionParam);

  const [current, setCurrent] = useState<PersonProfile | null>(null);
  const [viewed, setViewed] = useState<PersonProfile | null>(null);
  const [revisions, setRevisions] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const focusRef = usePageFocus<HTMLHeadingElement>();

  useTitle(viewed?.fullName ?? current?.fullName ?? "Person Profile");

  useEffect(() => {
    let cancelled = false;
    /* Each .then body is its own closure, so every check reads the flag fresh
       rather than a narrowed snapshot taken before the awaits. */
    void api
      .personProfile(profileId)
      .then((profile) => {
        if (cancelled) return;
        setCurrent(profile);
        setError(null);
        return api.personProfileRevisions(profileId).then((history) => {
          if (cancelled) return;
          setRevisions(history.map((p) => p.revision));
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(() => {
    let cancelled = false;
    if (viewRevision === null || Number.isNaN(viewRevision)) {
      setViewed(null);
      return;
    }
    async function loadRevision() {
      try {
        const profile = await api.personProfileRevision(profileId, viewRevision!);
        if (!cancelled) setViewed(profile);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    }
    void loadRevision();
    return () => {
      cancelled = true;
    };
  }, [profileId, viewRevision]);

  const backToCurrent = useCallback(() => {
    setSearchParams({});
  }, [setSearchParams]);

  if (error) {
    return (
      <>
        <h1 ref={focusRef} tabIndex={-1}>
          Person Profile
        </h1>
        <p className="banner-error" role="alert">
          {error} — <Link to="/people">back to the list</Link>.
        </p>
      </>
    );
  }
  if (!current) {
    return <p className="muted">Loading…</p>;
  }

  const profile = viewed ?? current;
  const isHistorical = viewed !== null && viewed.revision !== current.revision;
  const signals: string[] = [
    ...profile.emails,
    ...Object.entries(profile.handles).flatMap(([platform, values]) =>
      values.map((value) => `${platform}: ${value}`),
    ),
    ...profile.profileUrls,
    ...profile.employerHints,
  ];

  return (
    <>
      <h1 ref={focusRef} tabIndex={-1}>
        {profile.fullName ?? "(unnamed)"}
      </h1>
      {profile.archivedAt && (
        <p className="status-badge" role="status">
          Archived
        </p>
      )}
      {isHistorical && (
        <p className="banner-error" role="alert">
          Viewing revision {viewed.revision} exactly as it was recorded.{" "}
          <button type="button" className="linklike" onClick={backToCurrent}>
            Back to the current revision ({current.revision})
          </button>
        </p>
      )}
      <p className="muted">{described(profile) || "No resolved facts yet."}</p>

      <div className="card">
        <h2>Current facts</h2>
        <dl>
          <dt>Full name</dt>
          <dd>{profile.fullName ?? "—"}</dd>
          <dt>Primary email</dt>
          <dd>{profile.primaryEmail ?? "—"}</dd>
          <dt>Role</dt>
          <dd>{profile.role ?? "—"}</dd>
          <dt>Current employer</dt>
          <dd>{profile.currentEmployer ?? "—"}</dd>
          <dt>Background</dt>
          <dd>{profile.background ?? "—"}</dd>
        </dl>
      </div>

      <div className="card">
        <h2>Identity signals</h2>
        {signals.length === 0 ? (
          <p className="muted">No identity signals recorded.</p>
        ) : (
          <ul>
            {signals.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Sites</h2>
        {profile.websites.length === 0 &&
        profile.feeds.length === 0 &&
        profile.socialProfiles.length === 0 ? (
          <p className="muted">No sites recorded.</p>
        ) : (
          <>
            {profile.websites.length > 0 && (
              <ul>
                {profile.websites.map((url) => (
                  <li key={url}>
                    <a href={url}>{url}</a>
                  </li>
                ))}
              </ul>
            )}
            {profile.feeds.length > 0 && (
              <ul>
                {profile.feeds.map((feed) => (
                  <li key={feed.url}>
                    <a href={feed.url}>{feed.title ?? feed.url}</a> (feed)
                  </li>
                ))}
              </ul>
            )}
            {profile.socialProfiles.length > 0 && (
              <ul>
                {profile.socialProfiles.map((social) => (
                  <li key={social.url}>
                    <a href={social.url}>{social.handle ?? social.platform}</a> ({social.platform})
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Publications</h2>
        {profile.publications.length === 0 ? (
          <p className="muted">No publications recorded.</p>
        ) : (
          <ul>
            {profile.publications.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong> — {item.summary}
                <br />
                <span className="muted">
                  Source: <a href={item.url}>{item.url}</a>
                  {item.publishedAt ? ` · published ${item.publishedAt.slice(0, 10)}` : ""} ·{" "}
                  {CONFIDENCE_LABELS[item.matchConfidence]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Evidence</h2>
        {profile.evidence.length === 0 ? (
          <p className="muted">No evidence recorded.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Title</th>
                  <th scope="col">Claims</th>
                  <th scope="col">Provenance</th>
                  <th scope="col">Match confidence</th>
                  <th scope="col">Observed</th>
                </tr>
              </thead>
              <tbody>
                {profile.evidence.map((item) => (
                  <tr key={item.id}>
                    <td>{item.kind}</td>
                    <td>{item.title}</td>
                    <td>
                      {[
                        item.claims.fullName,
                        item.claims.role,
                        item.claims.currentEmployer,
                        item.claims.background,
                      ]
                        .filter((claim) => claim !== undefined)
                        .join(" · ") || "—"}
                    </td>
                    <td>
                      {item.source}:{" "}
                      <a href={item.url} rel="noreferrer">
                        {item.url}
                      </a>
                    </td>
                    <td>{CONFIDENCE_LABELS[item.matchConfidence]}</td>
                    <td>{item.observedAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Diagnostics</h2>
        {profile.sourceDiagnostics.length === 0 ? (
          <p className="muted">No enrichment diagnostics recorded.</p>
        ) : (
          <ul>
            {profile.sourceDiagnostics.map((diagnostic) => (
              <li key={`${diagnostic.source}-${diagnostic.status}`}>
                {diagnostic.source}: {diagnostic.status} — {diagnostic.detail}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Revision history</h2>
        <ul>
          {revisions.map((revision) => (
            <li key={revision}>
              {/* Every row opens the exact recorded revision, the current one
                  included: reading what was true then is always one click. */}
              <button
                type="button"
                className="linklike"
                onClick={() => setSearchParams({ revision: String(revision) })}
              >
                Revision {revision}
                {revision === current.revision ? " (current)" : ""}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
