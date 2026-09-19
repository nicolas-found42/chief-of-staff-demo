import { useCallback, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
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
  const [identifierFullName, setIdentifierFullName] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  /* The same-name warning holds one pending creation until the owner decides;
     nothing is created or researched while it shows (UX audit F4). */
  const [duplicate, setDuplicate] = useState<PersonProfile | null>(null);
  const [heldCreation, setHeldCreation] = useState<"manual" | "lookup" | null>(null);

  /* One list read per mount backs every duplicate check. A read that fails
     answers "no match" rather than blocking creation: the warning is a
     courtesy, and the service still refuses an exact duplicate email. */
  const peopleCache = useRef<PersonProfile[] | null>(null);
  const findExistingByName = useCallback(
    async (name: string): Promise<PersonProfile | null> => {
      const target = name.trim().toLowerCase();
      if (!target) return null;
      if (peopleCache.current === null) {
        try {
          peopleCache.current = await client.people();
        } catch {
          return null;
        }
      }
      return (
        peopleCache.current.find(
          (profile) => !profile.archivedAt && profile.fullName?.trim().toLowerCase() === target,
        ) ?? null
      );
    },
    [client],
  );

  /** UX audit F4: a same-name match holds the pending creation behind an
      explicit confirmation instead of silently duplicating a person (and its
      research); answers true when the creation is now held. */
  const holdOnDuplicate = async (name: string, kind: "manual" | "lookup"): Promise<boolean> => {
    const existing = await findExistingByName(name);
    if (!existing) return false;
    setDuplicate(existing);
    setHeldCreation(kind);
    return true;
  };

  /* The confirmation names the identity it was shown for (CodeRabbit, PR
     #458): editing any identity field invalidates it, so "Create anyway" can
     only ever create the person the user actually confirmed. */
  const releaseHeldCreation = () => {
    setDuplicate(null);
    setHeldCreation(null);
  };

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
    if (await holdOnDuplicate(identifierFullName, "lookup")) {
      setLookupBusy(false);
      return;
    }
    await acceptIdentifierLookup();
  }

  async function acceptIdentifierLookup() {
    try {
      /* The name is optional but load-bearing: without one the server cannot
         attribute what it reads, and the Profile stays "(unnamed)" after
         research (UX audit F5). */
      const accepted = await client.acceptPersonProfileLookup(
        identifier,
        identifierFullName.trim() || undefined,
      );
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
    if (await holdOnDuplicate(name, "manual")) {
      setBusy(false);
      return;
    }
    await createProfile();
  }

  async function createProfile() {
    const name = fullName.trim();
    const email = primaryEmail.trim();
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

  /** Runs the creation the same-name warning held back (UX audit F4); the
      worker assumes its busy flag is already set, like the submit paths. */
  async function createAnyway() {
    const action = heldCreation;
    setDuplicate(null);
    setHeldCreation(null);
    if (action === "manual") {
      setBusy(true);
      await createProfile();
    } else if (action === "lookup") {
      setLookupBusy(true);
      await acceptIdentifierLookup();
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
        workspace research is ready:
      </p>
      {/* The chain was invisible here, so a beginner who did the natural thing
          got a Profile that silently never researched (UX audit F2). Guidance,
          not a gate: both forms below stay usable throughout. */}
      <ol className="muted">
        <li>
          Add a model provider key in{" "}
          <Link to="/settings#group-provider">Settings → Extraction provider</Link>.
        </li>
        <li>
          Create a Person Profile for yourself, using the email your Google account is connected
          with.
        </li>
        <li>Confirm your Profile in Settings → Owner Profile.</li>
      </ol>

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
              onChange={(event) => {
                setIdentifier(event.target.value);
                /* A refusal about what was typed is stale the moment it
                   changes (UX audit F13). */
                setLookupError(null);
                releaseHeldCreation();
              }}
            />
          </div>
          {/* Research attributes nothing without a name, and this card is the
              path the page recommends first (UX audit F5). */}
          <div className="field-row">
            <label htmlFor="profile-identifier-name">
              Full name (helps research know who this is)
            </label>
            <input
              id="profile-identifier-name"
              value={identifierFullName}
              autoComplete="off"
              onChange={(event) => {
                setIdentifierFullName(event.target.value);
                releaseHeldCreation();
              }}
            />
          </div>
          <div className="field-row">
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
      {duplicate && (
        <div className="card banner-warn" role="alert">
          <p>
            A profile named <strong>{duplicate.fullName ?? "(unnamed)"}</strong> already exists.
          </p>
          <div className="field-row">
            <Link className="action-button" to={`/people/${encodeURIComponent(duplicate.id)}`}>
              Open the existing profile
            </Link>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy || lookupBusy}
              onClick={() => void createAnyway()}
            >
              Create anyway
            </button>
          </div>
        </div>
      )}
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
              onChange={(event) => {
                setFullName(event.target.value);
                releaseHeldCreation();
              }}
            />
          </div>
          <div className="field-row">
            <label htmlFor="profile-email">Primary email</label>
            <input
              id="profile-email"
              type="email"
              value={primaryEmail}
              autoComplete="off"
              onChange={(event) => {
                setPrimaryEmail(event.target.value);
                releaseHeldCreation();
              }}
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
