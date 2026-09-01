import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

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
        Manual creation is explicit: it records the facts you enter as the Profile's first revision,
        and runs no external enrichment.
      </p>
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
