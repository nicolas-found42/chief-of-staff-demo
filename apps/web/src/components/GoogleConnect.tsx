import { useState } from "react";
import type { GoogleStatus } from "@chief-of-staff-demo/shared";

/**
 * The Google connection, as four states rather than a pair of credential fields
 * and a button that fails until they are right. Google requires every person to
 * register their own OAuth client — there is no client this app can ship, since
 * the repository is public and a committed client secret would be revoked — so
 * the console work cannot be removed. It can only be spelled out here, next to
 * the exact strings it needs, instead of in a README the user has to hold in
 * their head while tabbing through a console.
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
  signingIn: boolean;
  disconnecting: boolean;
}

const CONSOLE = {
  tasksApi: "https://console.cloud.google.com/apis/library/tasks.googleapis.com",
  gmailApi: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  consent: "https://console.cloud.google.com/apis/credentials/consent",
  client: "https://console.cloud.google.com/apis/credentials/oauthclient",
};

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
  const { status, signingIn, disconnecting } = props;
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
            This is expected roughly weekly: while a consent screen's publishing status is
            <strong> Testing</strong>, Google expires its refresh token after seven days. Changing
            the account password voids it too, because the app holds a Gmail scope. Publishing the
            consent screen removes the seven-day limit, but Google requires app verification for
            Gmail scopes.
          </p>
        </>
      )}

      {status.state === "disconnected" && (
        <>
          <div className="field-row">
            <span role="status">
              <span className="muted">Not connected</span>
            </span>
            {signInButton("Sign in with Google")}
          </div>
          <details className="setup-details">
            <summary>Change the OAuth client</summary>
            <p className="muted">
              Redirect URI registered for this client: <code>{status.redirectUri}</code>
            </p>
            {credentialFields}
          </details>
        </>
      )}

      {status.state === "unconfigured" && (
        <>
          <p role="status">
            <span className="muted">
              Not connected. Google has no way to let an app act on your account until you register
              an OAuth client for it — four one-time steps, about five minutes.
            </span>
          </p>
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
                Create a project first if you have none — the console offers one on either page.
                Skipping this step is the one failure that appears only later, as a 403 on the first
                run.
              </p>
            </li>

            <li>
              <p className="setup-step-title">
                Configure the consent screen, and add yourself as a test user.
              </p>
              <p className="setup-links">
                <a className="step-link" href={CONSOLE.consent} target="_blank" rel="noreferrer">
                  Open the consent screen
                </a>
              </p>
              <p className="muted field-hint">
                Choose user type <strong>External</strong> — it is the only type that admits both
                Workspace and personal Google accounts — then add your own address under
                <strong> Test users</strong>. Google expires the sign-in every seven days while the
                app stays in Testing; this card says so when it happens, and signing in again is
                the whole fix.
              </p>
              <p className="muted field-hint">Add both scopes:</p>
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
                <a className="step-link" href={CONSOLE.client} target="_blank" rel="noreferrer">
                  Create the OAuth client
                </a>
              </p>
              <p className="muted field-hint">
                Add this exact string, port included, under{" "}
                <strong>Authorized redirect URIs</strong>. Google matches it character for
                character, and it is built from the port this server is listening on:
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
              <div className="field-row">{signInButton("Save and sign in with Google")}</div>
            </li>
          </ol>
        </>
      )}
    </>
  );
}
