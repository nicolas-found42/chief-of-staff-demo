import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  PersonProfile,
  PersonProfileInvalidation,
  PersonProfileMatchConfidence,
} from "@chief-of-staff-demo/shared";

import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

const CONFIDENCE_LABELS: Record<PersonProfileMatchConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const REPAIR_LABELS: Record<PersonProfileInvalidation["kind"], string> = {
  correction: "Correction",
  merge: "Merge",
  "evidence-detached": "Evidence detached",
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

  /* Identity repair (ticket #121): the owner's repair decisions. Every action
     goes through the product API, appends a revision, and refreshes the
     history; nothing here rewrites what was already recorded. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [correction, setCorrection] = useState({
    fullName: "",
    primaryEmail: "",
    role: "",
    currentEmployer: "",
    background: "",
    note: "",
  });
  const [mergeForm, setMergeForm] = useState({
    duplicateId: "",
    fullName: "",
    primaryEmail: "",
    role: "",
    currentEmployer: "",
    background: "",
    note: "",
  });
  const [detachForm, setDetachForm] = useState({ evidenceId: "", toProfileId: "", note: "" });

  const runRepair = useCallback(
    async (apply: () => Promise<PersonProfile>) => {
      setBusy(true);
      setActionError(null);
      try {
        setCurrent(await apply());
        const history = await api.personProfileRevisions(profileId);
        setRevisions(history.map((profile) => profile.revision));
      } catch (err) {
        setActionError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [profileId],
  );

  const submitCorrection = (event: FormEvent) => {
    event.preventDefault();
    const stated = {
      ...(correction.fullName.trim() === "" ? {} : { fullName: correction.fullName }),
      ...(correction.primaryEmail.trim() === "" ? {} : { primaryEmail: correction.primaryEmail }),
      ...(correction.role.trim() === "" ? {} : { role: correction.role }),
      ...(correction.currentEmployer.trim() === ""
        ? {}
        : { currentEmployer: correction.currentEmployer }),
      ...(correction.background.trim() === "" ? {} : { background: correction.background }),
      ...(correction.note.trim() === "" ? {} : { note: correction.note }),
    };
    void runRepair(() => api.correctPersonProfile(profileId, stated));
  };

  const submitMerge = (event: FormEvent) => {
    event.preventDefault();
    void runRepair(() =>
      api.mergePersonProfile(profileId, {
        duplicateId: mergeForm.duplicateId.trim(),
        resolutions: {
          ...(mergeForm.fullName.trim() === "" ? {} : { fullName: mergeForm.fullName }),
          ...(mergeForm.primaryEmail.trim() === "" ? {} : { primaryEmail: mergeForm.primaryEmail }),
          ...(mergeForm.role.trim() === "" ? {} : { role: mergeForm.role }),
          ...(mergeForm.currentEmployer.trim() === ""
            ? {}
            : { currentEmployer: mergeForm.currentEmployer }),
          ...(mergeForm.background.trim() === "" ? {} : { background: mergeForm.background }),
        },
        ...(mergeForm.note.trim() === "" ? {} : { note: mergeForm.note }),
      }),
    );
  };

  const submitDetach = (event: FormEvent) => {
    event.preventDefault();
    void runRepair(async () => {
      const split = await api.detachPersonEvidence(profileId, {
        evidenceId: detachForm.evidenceId,
        ...(detachForm.toProfileId.trim() === "" ? {} : { toProfileId: detachForm.toProfileId }),
        ...(detachForm.note.trim() === "" ? {} : { note: detachForm.note }),
      });
      return split.from;
    });
  };

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
  const detachableEvidence = [...current.publications, ...current.mentions, ...current.evidence];
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
      {current.mergedInto && (
        <p className="banner-error" role="alert">
          This Profile was merged into{" "}
          <Link to={`/people/${current.mergedInto}`}>another Profile</Link>. It holds no current
          identity of its own; its revisions remain readable below.
        </p>
      )}
      {actionError && (
        <p className="banner-error" role="alert">
          {actionError}
        </p>
      )}
      {isHistorical && (
        <p className="banner-error" role="alert">
          Viewing revision {viewed.revision} exactly as it was recorded.{" "}
          <button type="button" className="linklike" onClick={backToCurrent}>
            Back to the current revision ({current.revision})
          </button>
          {(current.invalidations ?? [])
            .filter((record) => record.affectedRevision === viewed.revision)
            .map((record) => (
              <span key={record.id}>
                {" "}
                This revision was later invalidated ({REPAIR_LABELS[record.kind].toLowerCase()}):
                {record.detail}
              </span>
            ))}
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

      {!current.mergedInto && (
        <div className="card">
          <h2>Correct facts</h2>
          <p className="muted">
            A correction appends a new revision; the superseded snapshot stays readable.
          </p>
          <form onSubmit={(event) => void submitCorrection(event)}>
            <div className="field-row">
              <label htmlFor="correct-full-name">Full name</label>
              <input
                id="correct-full-name"
                autoComplete="off"
                value={correction.fullName}
                onChange={(event) => setCorrection({ ...correction, fullName: event.target.value })}
              />
            </div>
            <div className="field-row">
              <label htmlFor="correct-primary-email">Primary email</label>
              <input
                id="correct-primary-email"
                type="email"
                autoComplete="off"
                value={correction.primaryEmail}
                onChange={(event) =>
                  setCorrection({ ...correction, primaryEmail: event.target.value })
                }
              />
            </div>
            <div className="field-row">
              <label htmlFor="correct-role">Role</label>
              <input
                id="correct-role"
                autoComplete="off"
                value={correction.role}
                onChange={(event) => setCorrection({ ...correction, role: event.target.value })}
              />
            </div>
            <div className="field-row">
              <label htmlFor="correct-employer">Current employer</label>
              <input
                id="correct-employer"
                autoComplete="off"
                value={correction.currentEmployer}
                onChange={(event) =>
                  setCorrection({ ...correction, currentEmployer: event.target.value })
                }
              />
            </div>
            <div className="field-row">
              <label htmlFor="correct-background">Background</label>
              <textarea
                id="correct-background"
                rows={3}
                value={correction.background}
                onChange={(event) =>
                  setCorrection({ ...correction, background: event.target.value })
                }
              />
            </div>
            <div className="field-row">
              <label htmlFor="correct-note">What was wrong?</label>
              <input
                id="correct-note"
                autoComplete="off"
                value={correction.note}
                onChange={(event) => setCorrection({ ...correction, note: event.target.value })}
              />
            </div>
            <div className="field-row">
              <button type="submit" className="primary" aria-disabled={busy}>
                {busy ? "Working…" : "Append correction"}
              </button>
            </div>
          </form>
        </div>
      )}

      {!current.mergedInto && (
        <div className="card">
          <h2>Merge a duplicate</h2>
          <p className="muted">
            Merges another Profile into this one through an audited decision; conflicting facts must
            be resolved explicitly and the duplicate stays readable as a redirect.
          </p>
          <form onSubmit={(event) => void submitMerge(event)}>
            <div className="field-row">
              <label htmlFor="merge-duplicate">Duplicate profile id</label>
              <input
                id="merge-duplicate"
                autoComplete="off"
                required
                value={mergeForm.duplicateId}
                onChange={(event) =>
                  setMergeForm({ ...mergeForm, duplicateId: event.target.value })
                }
              />
            </div>
            <div className="field-row">
              <label htmlFor="merge-full-name">Resolved full name</label>
              <input
                id="merge-full-name"
                autoComplete="off"
                value={mergeForm.fullName}
                onChange={(event) => setMergeForm({ ...mergeForm, fullName: event.target.value })}
              />
            </div>
            <div className="field-row">
              <label htmlFor="merge-primary-email">Resolved primary email</label>
              <input
                id="merge-primary-email"
                type="email"
                autoComplete="off"
                value={mergeForm.primaryEmail}
                onChange={(event) =>
                  setMergeForm({ ...mergeForm, primaryEmail: event.target.value })
                }
              />
            </div>
            <div className="field-row">
              <label htmlFor="merge-role">Resolved role</label>
              <input
                id="merge-role"
                autoComplete="off"
                value={mergeForm.role}
                onChange={(event) => setMergeForm({ ...mergeForm, role: event.target.value })}
              />
            </div>
            <div className="field-row">
              <label htmlFor="merge-employer">Resolved current employer</label>
              <input
                id="merge-employer"
                autoComplete="off"
                value={mergeForm.currentEmployer}
                onChange={(event) =>
                  setMergeForm({ ...mergeForm, currentEmployer: event.target.value })
                }
              />
            </div>
            <div className="field-row">
              <label htmlFor="merge-background">Resolved background</label>
              <textarea
                id="merge-background"
                rows={3}
                value={mergeForm.background}
                onChange={(event) => setMergeForm({ ...mergeForm, background: event.target.value })}
              />
            </div>
            <div className="field-row">
              <label htmlFor="merge-note">Merge note</label>
              <input
                id="merge-note"
                autoComplete="off"
                value={mergeForm.note}
                onChange={(event) => setMergeForm({ ...mergeForm, note: event.target.value })}
              />
            </div>
            <div className="field-row">
              <button type="submit" className="primary" aria-disabled={busy}>
                {busy ? "Working…" : "Merge profile"}
              </button>
            </div>
          </form>
        </div>
      )}

      {!current.mergedInto && detachableEvidence.length > 0 && (
        <div className="card">
          <h2>Detach evidence</h2>
          <p className="muted">
            Removes one evidence record from this Profile and marks the old attribution invalid;
            optionally re-attributes it to the correct Profile.
          </p>
          <form onSubmit={(event) => void submitDetach(event)}>
            <div className="field-row">
              <label htmlFor="detach-evidence">Evidence</label>
              <select
                id="detach-evidence"
                required
                value={detachForm.evidenceId}
                onChange={(event) =>
                  setDetachForm({ ...detachForm, evidenceId: event.target.value })
                }
              >
                <option value="">Choose evidence…</option>
                {detachableEvidence.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-row">
              <label htmlFor="detach-to">Move to profile id (optional)</label>
              <input
                id="detach-to"
                autoComplete="off"
                value={detachForm.toProfileId}
                onChange={(event) =>
                  setDetachForm({ ...detachForm, toProfileId: event.target.value })
                }
              />
            </div>
            <div className="field-row">
              <label htmlFor="detach-note">Detach note</label>
              <input
                id="detach-note"
                autoComplete="off"
                value={detachForm.note}
                onChange={(event) => setDetachForm({ ...detachForm, note: event.target.value })}
              />
            </div>
            <div className="field-row">
              <button type="submit" className="primary" aria-disabled={busy}>
                {busy ? "Working…" : "Detach evidence"}
              </button>
            </div>
          </form>
        </div>
      )}

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
        <h2>Identity repairs</h2>
        {(current.invalidations ?? []).length === 0 ? (
          <p className="muted">No corrections, merges, or detaches recorded.</p>
        ) : (
          <ul>
            {(current.invalidations ?? []).map((record) => (
              <li key={record.id}>
                <strong>{REPAIR_LABELS[record.kind]}</strong> — revision {record.affectedRevision}{" "}
                superseded · {record.detail}
                {record.mergedInto && (
                  <>
                    {" "}
                    · merged into{" "}
                    <Link to={`/people/${record.mergedInto}`}>{record.mergedInto}</Link>
                  </>
                )}
                {record.mergedFrom && (
                  <>
                    {" "}
                    · merged from{" "}
                    <Link to={`/people/${record.mergedFrom}`}>{record.mergedFrom}</Link>
                  </>
                )}
                {record.movedTo && (
                  <>
                    {" "}
                    · evidence moved to{" "}
                    <Link to={`/people/${record.movedTo}`}>{record.movedTo}</Link>
                  </>
                )}
                {record.movedFrom && (
                  <>
                    {" "}
                    · evidence re-attributed from{" "}
                    <Link to={`/people/${record.movedFrom}`}>{record.movedFrom}</Link>
                  </>
                )}
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
