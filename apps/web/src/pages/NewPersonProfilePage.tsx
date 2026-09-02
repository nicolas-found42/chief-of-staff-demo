import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage, type PersonProfileLookup } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * What the public-web search proposed, before anything is written. Evidence is
 * shown with the confidence it matched at, because that is what the person is
 * being asked to judge — a medium-confidence name match is exactly the case
 * where accepting blind would mint the wrong Profile.
 */
function LookupProposal({
  lookup,
  busy,
  onAccept,
}: {
  lookup: PersonProfileLookup;
  busy: boolean;
  onAccept: () => Promise<void>;
}) {
  const { profile } = lookup;
  const failures = profile.sourceDiagnostics.filter((diagnostic) => diagnostic.status === "failed");
  return (
    <section className="card" aria-label="Search proposal">
      <h3>Proposed Profile</h3>
      {lookup.existing && (
        <p role="status">
          A Profile with this identity already exists — accepting adds the new evidence to it as a
          further revision.
        </p>
      )}
      <dl>
        <dt>Name</dt>
        <dd>{profile.fullName ?? "— none found"}</dd>
        <dt>Email</dt>
        <dd>{profile.primaryEmail ?? "—"}</dd>
        <dt>Role</dt>
        <dd>{profile.role ?? "—"}</dd>
        <dt>Current employer</dt>
        <dd>{profile.currentEmployer ?? "—"}</dd>
      </dl>
      {failures.length > 0 && (
        <p role="status">
          {failures.length} source{failures.length === 1 ? "" : "s"} failed:{" "}
          {failures.map((diagnostic) => diagnostic.detail).join("; ")}
        </p>
      )}
      {profile.evidence.length === 0 ? (
        <p className="muted">
          No public evidence matched that identifier. Accepting would create a Profile holding only
          what you typed — the manual form below does the same thing more directly.
        </p>
      ) : (
        <>
          <p className="muted">
            {profile.evidence.length} evidence item
            {profile.evidence.length === 1 ? "" : "s"} matched.
          </p>
          <ul className="setup-check-list">
            {profile.evidence.slice(0, 12).map((item) => (
              <li key={item.id}>
                <a href={item.url} target="_blank" rel="noreferrer noopener">
                  {item.title || item.url}
                </a>{" "}
                <span className={item.matchConfidence === "high" ? "ok" : "muted"}>
                  {item.matchConfidence} confidence
                </span>
                <span className="muted"> · {item.kind}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        className="action-button primary"
        onClick={() => void onAccept()}
        aria-disabled={busy}
      >
        {busy ? "Creating…" : "Accept and create Profile"}
      </button>
    </section>
  );
}

/**
 * Explicit manual creation (spec #117): the one form that mints a canonical
 * Profile with its auditable first revision. Identity inputs are validated by
 * the Workspace interface; the form names the problem when they fail.
 */
export function NewPersonProfilePage() {
  useTitle("New Person Profile");
  const focusRef = usePageFocus<HTMLHeadingElement>();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [primaryEmail, setPrimaryEmail] = useState("");
  const [role, setRole] = useState("");
  const [currentEmployer, setCurrentEmployer] = useState("");
  const [background, setBackground] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<PersonProfileLookup | null>(null);

  async function runLookup() {
    if (lookupBusy) return;
    setLookupBusy(true);
    setLookupError(null);
    setProposal(null);
    try {
      setProposal(await api.lookupPersonProfile(identifier));
    } catch (err) {
      setLookupError(errorMessage(err));
    } finally {
      setLookupBusy(false);
    }
  }

  async function acceptLookup() {
    if (lookupBusy) return;
    setLookupBusy(true);
    setLookupError(null);
    try {
      const accepted = await api.acceptPersonProfileLookup(identifier);
      void navigate(`/people/${encodeURIComponent(accepted.profile.id)}`);
    } catch (err) {
      setLookupError(errorMessage(err));
      setLookupBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const name = fullName.trim();
    const email = primaryEmail.trim();
    if (!name && !email) {
      setError("A Person Profile needs at least a full name or an email address.");
      return;
    }
    setBusy(true);
    try {
      const input: {
        fullName?: string;
        primaryEmail?: string;
        role?: string;
        currentEmployer?: string;
        background?: string;
      } = {};
      if (name) input.fullName = name;
      if (email) input.primaryEmail = email;
      const submissionRole = role.trim();
      if (submissionRole) input.role = submissionRole;
      const submissionEmployer = currentEmployer.trim();
      if (submissionEmployer) input.currentEmployer = submissionEmployer;
      const submissionBackground = background.trim();
      if (submissionBackground) input.background = submissionBackground;
      const created = await api.createPersonProfile(input);
      void navigate(`/people/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h1 ref={focusRef} tabIndex={-1}>
        New Person Profile
      </h1>
      <p className="muted">
        Start from an identifier and let the public web fill the Profile in, or enter the facts
        yourself. Manual creation is explicit: it records what you type as the Profile's first
        revision, and runs no external enrichment.
      </p>

      <div className="card">
        <h2>Find by email or profile URL</h2>
        <p className="muted">
          An email address or a profile address — <code>linkedin.com/in/someone</code> — is searched
          against the public web, and what comes back is a proposal. Nothing is saved until you
          accept it. The address is a search term only: no page is signed into, and no LinkedIn
          session is used.
        </p>
        <div className="field-row">
          <label htmlFor="profile-identifier">Email or profile URL</label>
          <input
            id="profile-identifier"
            value={identifier}
            autoComplete="off"
            placeholder="someone@example.com or linkedin.com/in/someone"
            onChange={(event) => setIdentifier(event.target.value)}
          />
          <button
            type="button"
            className="action-button"
            onClick={() => void runLookup()}
            aria-disabled={lookupBusy || identifier.trim() === ""}
          >
            {lookupBusy ? "Searching…" : "Search"}
          </button>
        </div>
        {lookupError && (
          <p className="banner-error" role="alert">
            {lookupError}
          </p>
        )}
        {proposal && <LookupProposal lookup={proposal} busy={lookupBusy} onAccept={acceptLookup} />}
      </div>
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <div className="card">
          <h2>Identity</h2>
          <div className="field-row">
            <label htmlFor="profile-full-name">Full name</label>
            <input
              id="profile-full-name"
              value={fullName}
              autoComplete="off"
              onChange={(event) => setFullName(event.target.value)}
            />
          </div>
          <div className="field-row">
            <label htmlFor="profile-email">Primary email</label>
            <input
              id="profile-email"
              type="email"
              value={primaryEmail}
              autoComplete="off"
              onChange={(event) => setPrimaryEmail(event.target.value)}
            />
          </div>
          <h2>Known facts</h2>
          <div className="field-row">
            <label htmlFor="profile-role">Role</label>
            <input
              id="profile-role"
              value={role}
              autoComplete="off"
              onChange={(event) => setRole(event.target.value)}
            />
          </div>
          <div className="field-row">
            <label htmlFor="profile-employer">Current employer</label>
            <input
              id="profile-employer"
              value={currentEmployer}
              autoComplete="off"
              onChange={(event) => setCurrentEmployer(event.target.value)}
            />
          </div>
          <div className="field-row">
            <label htmlFor="profile-background">Background</label>
            <textarea
              id="profile-background"
              rows={3}
              value={background}
              onChange={(event) => setBackground(event.target.value)}
            />
          </div>
          <div className="field-row">
            <button type="submit" className="primary" aria-disabled={busy}>
              {busy ? "Creating…" : "Create profile"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
