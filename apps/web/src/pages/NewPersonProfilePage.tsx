import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage } from "../client";
import { peopleApi, type PeopleClient } from "../clients/people";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * Explicit manual creation (spec #117): the one form that mints a canonical
 * Profile with its auditable first revision. Identity inputs are validated by
 * the Workspace interface; the form names the problem when they fail.
 */
export function NewPersonProfilePage({ client = peopleApi }: { client?: PeopleClient }) {
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

  async function acceptLookup(event?: React.FormEvent) {
    event?.preventDefault();
    if (lookupBusy) return;
    if (identifier.trim() === "") {
      /* The same refusal the Workspace interface gives, answered here so an
         empty field never costs a round trip — and so the button's announced
         availability can match what it actually does (audit F14). */
      setLookupError("Enter an email address or a profile URL to search for.");
      return;
    }
    setLookupBusy(true);
    setLookupError(null);
    try {
      const accepted = await client.acceptPersonProfileLookup(identifier);
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
      const created = await client.createPersonProfile(input);
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
        yourself. The Profile is saved immediately. Automatic background research starts once
        workspace research is ready.
      </p>

      <div className="card">
        <h2>Find by email or profile URL</h2>
        <p className="muted">
          An email address or a profile address — <code>linkedin.com/in/someone</code> — is searched
          automatically. A matching existing Profile is reused; otherwise a new Profile is created.
          Once workspace research is ready, research fills its dossier as sources are found.
          Uncertain information remains labeled.
        </p>
        {/* A form, so Enter in the field submits the same handler the button
            runs — the most natural keyboard action used to do nothing at all
            (audit F11). It is a sibling of the manual-entry form below, never
            nested inside it. */}
        <form onSubmit={(event) => void acceptLookup(event)}>
          <div className="field-row">
            <label htmlFor="profile-identifier">Email or profile URL</label>
            <input
              id="profile-identifier"
              value={identifier}
              autoComplete="off"
              placeholder="someone@example.com or linkedin.com/in/someone"
              onChange={(event) => setIdentifier(event.target.value)}
            />
            {/* Announced availability matches what activation does: the
                control stays operable on an empty field and explains the
                problem, rather than reporting itself disabled and then
                acting anyway (audit F14). */}
            <button type="submit" className="action-button" aria-disabled={lookupBusy}>
              {lookupBusy ? "Adding…" : "Add and research"}
            </button>
          </div>
        </form>
        {lookupError && (
          <p className="banner-error" role="alert">
            {lookupError}
          </p>
        )}
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
