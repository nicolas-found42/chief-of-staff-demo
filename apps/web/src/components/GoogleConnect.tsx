import { useState } from "react";
import type { GoogleStatus, SetupCheck } from "@chief-of-staff-demo/shared";

/**
 * The Google connection, as four states rather than a pair of credential fields
 * and a button that fails until they are right. Google requires every person to
 * register their own OAuth client — there is no client this app can ship, since
 * the repository is public and a committed client secret would be revoked — so
 * the console work cannot be removed. It can only be spelled out here, next to
 * the exact strings it needs, instead of in a README the user has to hold in
 * their head while tabbing through a console.
 *
 * Two things decide what this card shows, and they are not the same thing:
 * `state` is where the connection stands now, and `lastConnectedAt` is whether
 * the console work has *ever* landed. Someone whose first sign-in failed is
 * `disconnected` exactly like someone who signed out on purpose, and only the
 * second of those has finished with the steps.
 */
export interface GoogleConnectProps {
  /** null while the first status request is in flight. */
  status: GoogleStatus | null;
  clientId: string;
  clientSecret: string;
  /** Hint line for the stored secret, so a blank field never reads as unset. */
  secretHint: string;
  onChange: (field: "clientId" | "clientSecret", value: string) => void;
  /** Saves the credentials, then sends the browser to Google's consent screen. */
  onSignIn: () => void;
  onDisconnect: () => void;
  /** Asks Google what is missing. Person-initiated only (ADR-0008). */
  onCheck: () => void;
  /** The last answer Google gave, or null if nobody has asked yet. */
  check: SetupCheck | null;
  /** Reads the client JSON the console offers, so no secret is retyped. */
  onClientJson: (file: File) => void;
  /** What came of the last JSON the user picked. */
  jsonNotice: string | null;
  signingIn: boolean;
  disconnecting: boolean;
  checking: boolean;
}

/**
 * Google renamed and split this console: the consent screen is now the Google
 * Auth Platform, and what used to be one page is Branding, Audience and Data
 * Access. On a project that has never been configured all three show the same
 * "not configured yet" wall, so the flow below sends people to one wizard
 * rather than to three pages that do not exist yet.
 */
const CONSOLE = {
  projectCreate: "https://console.cloud.google.com/projectcreate",
  tasksApi: "https://console.cloud.google.com/apis/library/tasks.googleapis.com",
  gmailApi: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  authPlatform: "https://console.cloud.google.com/auth/branding",
  audience: "https://console.cloud.google.com/auth/audience",
  dataAccess: "https://console.cloud.google.com/auth/scopes",
  clients: "https://console.cloud.google.com/auth/clients",
};

/**
 * Which kind of Google account is signing in. It is not cosmetic: a Workspace
 * account can set the consent screen to Internal, which removes the test-user
 * list, the unverified-app warning and the weekly expiry outright. A personal
 * account has Internal greyed out and must take all three. The step list
 * differs, so it is chosen before the steps rather than explained inside them.
 *
 * Defaults to `personal`, the path that works for everyone: a Workspace user
 * following it gets more friction than necessary, whereas a personal-account
 * user following the Workspace path reaches a greyed-out radio and stops.
 */
type Audience = "workspace" | "personal";

/** Whole days: the expiry is an estimate, and worth no more precision than that. */
function daysAgo(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/** Date without a time, for the same reason. */
const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/**
 * One fact, and a prediction only when there is one to make. `expiresAbout` is
 * null until Google has actually refused this grant once, because an Internal
 * consent screen never expires and guessing otherwise would announce a weekly
 * event that never happens. So the fact stands alone until the app has evidence.
 */
function expiryNote(status: GoogleStatus): string | null {
  if (!status.lastConnectedAt) {
    return null;
  }
  const days = daysAgo(status.lastConnectedAt);
  const signedIn =
    days <= 0 ? "You signed in today" : days === 1 ? "You signed in yesterday" : `You signed in ${days} days ago`;
  if (!status.expiresAbout) {
    return `${signedIn}.`;
  }
  const due = new Date(status.expiresAbout);
  if (due.getTime() <= Date.now()) {
    return `${signedIn}, so Google may ask you to sign in again at any time.`;
  }
  return `${signedIn}, so Google will probably ask again around ${DAY.format(due)}.`;
}

/** Google's "G", from their sign-in branding. Decorative: the label carries it. */
function GoogleMark() {
  return (
    <svg className="google-mark" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86a5.36 5.36 0 0 1-5.03-3.7H.96v2.34A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58A8.6 8.6 0 0 0 9 0 9 9 0 0 0 .96 4.94l3.01 2.34A5.36 5.36 0 0 1 9 3.58Z"
      />
    </svg>
  );
}

export function GoogleConnect(props: GoogleConnectProps) {
  const { status, signingIn, disconnecting, checking } = props;
  /* Names what was copied rather than saying "Copied!", so the announcement is
     still unambiguous when three buttons on the page all say Copy (WCAG 4.1.3). */
  const [copied, setCopied] = useState<string | null>(null);
  const [audience, setAudience] = useState<Audience>("personal");

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied(null);
    }
  };

  if (!status) {
    return (
      <p className="muted" role="status">
        Checking the Google connection…
      </p>
    );
  }

  const workspace = audience === "workspace";

  /* The console work has landed at least once. Not the same as being connected:
     a sign-out and a first attempt that failed are both `disconnected`, and only
     one of them still needs the steps.

     `connected` and `expired` count on their own, because both mean a refresh
     token is held and a token can only exist if a sign-in once succeeded. That
     also carries a workspace written before `lastConnectedAt` existed, where the
     stamp is null but the setup plainly is not — the timestamp is only load-
     bearing for `disconnected`, which is the one state that proves nothing. */
  const setupDone =
    status.lastConnectedAt !== null || status.state === "connected" || status.state === "expired";

  /* Deliberately not `button.primary`: Google's sign-in branding puts the
     four-colour mark on white or on their own blue, and the app accent is
     neither. The mark is emphasis enough. */
  const signInButton = (label: string) => (
    <button
      type="button"
      className="google-signin"
      onClick={props.onSignIn}
      aria-disabled={signingIn}
    >
      <GoogleMark />
      {signingIn ? "Signing in…" : label}
    </button>
  );

  const copyButton = (label: string, value: string) => (
    <button type="button" className="copy-button" onClick={() => void copy(label, value)}>
      Copy <span className="visually-hidden">{label}</span>
    </button>
  );

  const credentialFields = (
    <div className="form-grid">
      <div className="field">
        <label htmlFor="google-client-id">OAuth client ID</label>
        <input
          id="google-client-id"
          value={props.clientId}
          autoComplete="off"
          spellCheck={false}
          placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"
          onChange={(event) => props.onChange("clientId", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="google-client-secret">OAuth client secret</label>
        <input
          id="google-client-secret"
          aria-describedby="google-client-secret-hint"
          type="password"
          value={props.clientSecret}
          autoComplete="off"
          onChange={(event) => props.onChange("clientSecret", event.target.value)}
        />
        <p id="google-client-secret-hint" className="muted field-hint">
          {props.secretHint}
        </p>
      </div>
    </div>
  );

  /* The console shows the secret once and offers a JSON download of it. Reading
     that file here spares the one irreversible piece of transcription in the
     whole flow. Parsed in the browser and never uploaded: the two values land in
     the fields above, and the file itself goes nowhere. */
  const clientJsonField = (
    <div className="field">
      <label htmlFor="google-client-json">…or load the JSON the console gave you</label>
      <input
        id="google-client-json"
        type="file"
        accept="application/json,.json"
        aria-describedby="google-client-json-hint"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            props.onClientJson(file);
          }
          /* Cleared so picking the same file twice fires again. */
          event.target.value = "";
        }}
      />
      <p id="google-client-json-hint" className="muted field-hint">
        {props.jsonNotice ??
          "Reads the client ID and secret out of the file and fills the fields above. The file is not uploaded or stored."}
      </p>
    </div>
  );

  const audienceChoice = (
    <fieldset className="audience-choice">
      <legend>Which Google account will you sign in with?</legend>
      <label>
        <input
          type="radio"
          name="google-audience"
          value="personal"
          checked={!workspace}
          onChange={() => setAudience("personal")}
        />
        A personal account (<code>@gmail.com</code>)
      </label>
      <label>
        <input
          type="radio"
          name="google-audience"
          value="workspace"
          checked={workspace}
          onChange={() => setAudience("workspace")}
        />
        A work account (<code>you@yourcompany.com</code>)
      </label>
      <p className="muted field-hint">
        {workspace
          ? "A work account can set the consent screen to Internal, which removes the test-user list, the unverified-app warning and the weekly sign-in. One step shorter."
          : "A personal account cannot use Internal — Google greys it out — so the consent screen stays External and Google asks you to sign in again about weekly."}
      </p>
    </fieldset>
  );

  /* One list, rendered whether or not the steps are the main event, so they are
     never unreachable: open for someone who has never got through them, behind a
     summary for someone changing an OAuth client they already have. */
  const setupSteps = (
    <>
      {audienceChoice}
      <ol className="setup-steps">
        <li>
          <p className="setup-step-title">Create or choose a Google Cloud project.</p>
          <p className="setup-links">
            <a className="step-link" href={CONSOLE.projectCreate} target="_blank" rel="noreferrer">
              Create a project
            </a>
          </p>
          <p className="muted field-hint">
            Google puts every app inside a project. After creating one, <strong>check the project
            name in the console's top bar</strong> — the console does not switch to a project it has
            just created, and every step below has to happen in the same one.
            {workspace ? " On a work account you will also see an Organization field; leave it as it is." : ""}
          </p>
        </li>

        <li>
          <p className="setup-step-title">Turn on the two APIs this app calls.</p>
          <p className="setup-links">
            <a className="step-link" href={CONSOLE.tasksApi} target="_blank" rel="noreferrer">
              Enable the Tasks API
            </a>
            <a className="step-link" href={CONSOLE.gmailApi} target="_blank" rel="noreferrer">
              Enable the Gmail API
            </a>
          </p>
          <p className="muted field-hint">
            Do this before the scopes step below — that list only offers scopes for APIs that are
            already on. Afterwards the console offers a <strong>Create credentials</strong> button:
            ignore it, the client comes from a later step.
          </p>
        </li>

        <li>
          <p className="setup-step-title">Set up the Google Auth Platform.</p>
          <p className="setup-links">
            <a className="step-link" href={CONSOLE.authPlatform} target="_blank" rel="noreferrer">
              Open the Google Auth Platform
            </a>
          </p>
          <p className="muted field-hint">
            The page reads <em>Google Auth Platform not configured yet</em> — click{" "}
            <strong>Get started</strong>. Four short stages: an app name and your email; then{" "}
            <strong>Audience</strong>, where you choose{" "}
            <strong>{workspace ? "Internal" : "External"}</strong>; then a contact email; then tick
            the policy box, press <strong>Continue</strong>, and press <strong>Create</strong>.
          </p>
          <p className="muted field-hint">
            {workspace
              ? "Internal is what makes your list one step shorter — it needs no test users and no verification."
              : "If the contact stage turns red just after you type the address, press Next again."}
          </p>
        </li>

        {!workspace && (
          <li>
            <p className="setup-step-title">Add yourself as a test user.</p>
            <p className="setup-links">
              <a className="step-link" href={CONSOLE.audience} target="_blank" rel="noreferrer">
                Open Audience
              </a>
            </p>
            <p className="muted field-hint">
              Under <strong>Test users</strong> choose <strong>Add users</strong>, type the Google
              address you will sign in with, and <strong>Save</strong>. Miss this and the sign-in
              below fails with <em>Access blocked … Error 403: access_denied</em> and no way through
              the page — it is the one step with no recovery.
            </p>
          </li>
        )}

        <li>
          <p className="setup-step-title">Add both scopes under Data Access.</p>
          <p className="setup-links">
            <a className="step-link" href={CONSOLE.dataAccess} target="_blank" rel="noreferrer">
              Open Data Access
            </a>
          </p>
          <p className="muted field-hint">
            Choose <strong>Add or remove scopes</strong>, paste both of these into{" "}
            <strong>Manually add scopes</strong>, and press <strong>Add to table</strong> — the list
            runs to dozens of rows across several pages and neither of these is on the first one.
          </p>
          {status.scopes.map((scope) => (
            <p className="setup-copy" key={scope}>
              <code>{scope}</code>
              {copyButton(scope, scope)}
            </p>
          ))}
          <p className="muted field-hint">
            Then press <strong>Update</strong> in the panel, and <strong>Save</strong> on the page
            behind it. Both: the panel's Update alone leaves the change unsaved.
          </p>
        </li>

        <li>
          <p className="setup-step-title">Create an OAuth client.</p>
          <p className="setup-links">
            <a className="step-link" href={CONSOLE.clients} target="_blank" rel="noreferrer">
              Open Clients
            </a>
          </p>
          <p className="muted field-hint">
            <strong>Create client</strong>, then application type <strong>Web application</strong> —
            not Desktop app, even though this app runs on your machine. Add the string below under{" "}
            <strong>Authorized redirect URIs</strong>, which is the second of the two Add URI
            blocks; leave <strong>Authorized JavaScript origins</strong> empty. Google matches this
            character for character, and <code>http://</code> is correct here because it allows it
            for localhost.
          </p>
          <p className="setup-copy">
            <code>{status.redirectUri}</code>
            {copyButton("Redirect URI", status.redirectUri)}
          </p>
          <p className="muted field-hint">
            When you press Create, Google shows the client ID and secret{" "}
            <strong>once</strong>. Copy both now, or use <strong>Download JSON</strong> — the secret
            cannot be viewed again afterwards, and a lost one means creating another client.
          </p>
        </li>

        <li>
          <p className="setup-step-title">Paste the client ID and secret, then sign in.</p>
          {credentialFields}
          {clientJsonField}
          <p className="muted field-hint">
            {workspace
              ? "Leave both permissions ticked on Google's consent screen. Google calls the Gmail one “Manage drafts and send emails” because that is the permission's name; this app has no code that can send, and a test fails the build if any appears."
              : "Google will warn that it hasn't verified this app. Click Continue — the small link, not the Back to safety button. Leave both permissions ticked: Google calls the Gmail one “Manage drafts and send emails” because that is the permission's name; this app has no code that can send, and a test fails the build if any appears."}
          </p>
          <div className="field-row">{signInButton("Save and sign in with Google")}</div>
        </li>
      </ol>
    </>
  );

  /* Asking Google beats describing Google: a 403 names the missing API or the
     missing scope exactly, and unlike the steps above it cannot go stale when
     the console is reskinned (ADR-0008). */
  const setupCheck = (
    <div className="setup-check">
      <div className="field-row">
        <button type="button" onClick={props.onCheck} aria-disabled={checking}>
          {checking ? "Checking…" : "Check my setup"}
        </button>
        <span className="muted">Asks Google what is missing, and creates nothing.</span>
      </div>
      {props.check && (
        <div role="status">
          {props.check.items.length === 0 ? (
            <p className="muted">
              Nothing to ask Google yet — finish the steps and sign in, then check.
            </p>
          ) : (
            <ul className="setup-check-list">
              {props.check.items.map((item) => (
                <li key={item.label}>
                  <span className={item.ok ? "ok" : "bad"}>{item.ok ? "Working" : "Problem"}</span>{" "}
                  <strong>{item.label}</strong> — {item.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* One live region for every copy button, so the confirmation is announced
          without each button owning a status of its own. */}
      <p className="visually-hidden" role="status">
        {copied ? `${copied} copied to clipboard.` : ""}
      </p>

      {status.state === "connected" && (
        <>
          <div className="field-row">
            <span role="status">
              <span className="ok">Connected</span>
              {status.email ? ` as ${status.email}` : ""}
            </span>
            <button type="button" onClick={props.onDisconnect} aria-disabled={disconnecting}>
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
          {expiryNote(status) && <p className="muted">{expiryNote(status)}</p>}
          <p className="muted">
            Tasks go to the task list below; drafts land in Gmail Drafts and are never sent.
            Disconnect to sign in as a different account.
          </p>
        </>
      )}

      {status.state === "expired" && (
        <>
          <div className="banner banner-warn" role="status">
            <span>
              Google rejected the stored sign-in. Sign in again to keep creating tasks and drafts.
            </span>
          </div>
          <div className="field-row">{signInButton("Sign in with Google")}</div>
          <p className="muted">
            This is expected roughly weekly, and nothing is broken: while a consent screen's
            publishing status is <strong>Testing</strong>, Google expires its refresh token after
            seven days. Changing the account password voids it too, because the app holds a Gmail
            scope. A work account can avoid this entirely by setting the consent screen to Internal.
          </p>
        </>
      )}

      {status.state === "disconnected" && setupDone && (
        <>
          <div className="field-row">
            <span role="status">
              <span className="muted">Not connected</span>
            </span>
            {signInButton("Sign in with Google")}
          </div>
          <p className="muted">
            The OAuth client is registered — signing in is all that is left. The setup steps are
            below if you need to point the app at a different client.
          </p>
        </>
      )}

      {/* The steps used to appear only while the connection was `unconfigured`,
          which meant they vanished the moment a client id and secret were saved —
          including when the sign-in that followed failed, exactly when they were
          needed. `lastConnectedAt` is what actually answers "have these ever
          worked?", so it decides this instead of the state. */}
      {!setupDone && status.state === "unconfigured" && (
        <p role="status">
          <span className="muted">
            Not connected. Google has no way to let an app act on your account until you register an
            OAuth client for it — a one-time walk through its console, about fifteen minutes.
          </span>
        </p>
      )}

      {!setupDone && status.state !== "unconfigured" && (
        <div className="banner banner-warn" role="status">
          <span>
            The client ID and secret are saved, but no sign-in has succeeded yet. Work back through
            the steps below — the one that failed is still on this page.
          </span>
        </div>
      )}

      {setupDone ? (
        <details className="setup-details">
          <summary>Set up a different OAuth client</summary>
          {setupSteps}
        </details>
      ) : (
        setupSteps
      )}

      {setupCheck}
    </>
  );
}
