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
  signingIn: boolean;
  disconnecting: boolean;
  checking: boolean;
}

/**
 * Google renamed and split this console: the consent screen is now the Google
 * Auth Platform, and what used to be one page is Branding, Audience and Data
 * Access. One link per page, because a step that sends someone to the wrong
 * page is a step they cannot finish.
 */
const CONSOLE = {
  tasksApi: "https://console.cloud.google.com/apis/library/tasks.googleapis.com",
  gmailApi: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  branding: "https://console.cloud.google.com/auth/branding",
  audience: "https://console.cloud.google.com/auth/audience",
  dataAccess: "https://console.cloud.google.com/auth/scopes",
  clients: "https://console.cloud.google.com/auth/clients",
};

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
 * One fact and one prediction, with the prediction marked as one. A hard
 * countdown would read as a contract the app cannot honour: Google reports no
 * token lifetime, and a password change or a revoke ends the grant early.
 */
function expiryNote(status: GoogleStatus): string | null {
  if (!status.lastConnectedAt || !status.expiresAbout) {
    return null;
  }
  const days = daysAgo(status.lastConnectedAt);
  const signedIn =
    days <= 0 ? "You signed in today" : days === 1 ? "You signed in yesterday" : `You signed in ${days} days ago`;
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

  /* One list, rendered whether or not the steps are the main event, so they are
     never unreachable: open for someone who has never got through them, behind a
     summary for someone changing an OAuth client they already have. */
  const setupSteps = (
    <ol className="setup-steps">
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
          Create a project first if you have none — the console offers one on either page. Skipping
          this step is the one failure that appears only later, as a 403 on the first run.
        </p>
      </li>

      <li>
        <p className="setup-step-title">Name the app on the Branding page.</p>
        <p className="setup-links">
          <a className="step-link" href={CONSOLE.branding} target="_blank" rel="noreferrer">
            Open Branding
          </a>
        </p>
        <p className="muted field-hint">
          Any app name and your own email will do — you are the only person who will see this
          consent screen. Google will not let you create an OAuth client until this page is filled
          in.
        </p>
      </li>

      <li>
        <p className="setup-step-title">Set the audience to External, and add yourself as a test user.</p>
        <p className="setup-links">
          <a className="step-link" href={CONSOLE.audience} target="_blank" rel="noreferrer">
            Open Audience
          </a>
        </p>
        <p className="muted field-hint">
          Choose user type <strong>External</strong> — it is the only type that admits both
          Workspace and personal Google accounts — then add your own address under{" "}
          <strong>Test users</strong>. Google expires the sign-in every seven days while the app
          stays in Testing; this card says when that happens, and signing in again is the whole fix.
        </p>
      </li>

      <li>
        <p className="setup-step-title">Add both scopes under Data Access.</p>
        <p className="setup-links">
          <a className="step-link" href={CONSOLE.dataAccess} target="_blank" rel="noreferrer">
            Open Data Access
          </a>
        </p>
        <p className="muted field-hint">
          Use <strong>Add or remove scopes</strong>, and paste these rather than hunting for them in
          the list:
        </p>
        {status.scopes.map((scope) => (
          <p className="setup-copy" key={scope}>
            <code>{scope}</code>
            {copyButton(scope, scope)}
          </p>
        ))}
      </li>

      <li>
        <p className="setup-step-title">
          Create an OAuth client of type <strong>Web application</strong>.
        </p>
        <p className="setup-links">
          <a className="step-link" href={CONSOLE.clients} target="_blank" rel="noreferrer">
            Open Clients
          </a>
        </p>
        <p className="muted field-hint">
          Add this exact string, port included, under <strong>Authorized redirect URIs</strong>.
          Google matches it character for character, and it is built from the port this server is
          listening on:
        </p>
        <p className="setup-copy">
          <code>{status.redirectUri}</code>
          {copyButton("Redirect URI", status.redirectUri)}
        </p>
      </li>

      <li>
        <p className="setup-step-title">
          Paste the client ID and secret the console gave you, then sign in.
        </p>
        {credentialFields}
        <p className="muted field-hint">
          Google will warn that the app is not verified. That is expected for an app you registered
          yourself: choose <strong>Advanced</strong>, then <strong>Go to localhost (unsafe)</strong>.
        </p>
        <div className="field-row">{signInButton("Save and sign in with Google")}</div>
      </li>
    </ol>
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
            scope. Publishing the consent screen removes the seven-day limit, but Google requires app
            verification for Gmail scopes.
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
            OAuth client for it — six one-time steps, about ten minutes.
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
