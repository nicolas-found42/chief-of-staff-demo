import type { GoogleStatus, SetupCheck } from "@chief-of-staff-demo/shared";
import { Link } from "react-router-dom";

/**
 * The Workspace-owned half of Google setup. The installation operator supplies
 * one OAuth client; this card only lets the Workspace owner authenticate and
 * grant consent, so no client ID, client secret, or JSON credential field can
 * reappear in the Workspace UI.
 */
export interface GoogleConnectProps {
  status: GoogleStatus | null;
  installationConfigured: boolean;
  onSignIn: () => void;
  onDisconnect: () => void;
  onCheck: () => void;
  check: SetupCheck | null;
  signingIn: boolean;
  disconnecting: boolean;
  checking: boolean;
}

export function GoogleConnect({
  status,
  installationConfigured,
  onSignIn,
  onDisconnect,
  onCheck,
  check,
  signingIn,
  disconnecting,
  checking,
}: GoogleConnectProps) {
  if (!status) {
    return (
      <p className="muted" role="status">
        Checking the Google connection…
      </p>
    );
  }

  const stateLabel = {
    unconfigured: "Not configured",
    disconnected: "Ready for owner consent",
    connected: "Connected",
    expired: "Consent needs renewal",
  }[status.state];

  return (
    <div className="google-connect-card">
      <p className="connection-summary" role="status">
        <span className={status.state === "connected" ? "ok" : "muted"}>{stateLabel}</span>
        {status.email ? ` as ${status.email}` : ""}
      </p>
      {!installationConfigured && (
        <p id="google-installation-missing">
          The installation Google OAuth client is not configured.{" "}
          <Link className="text-link" to="/onboarding?goal=meetings">
            Open Guided Setup
          </Link>{" "}
          to provision it; this Workspace will then ask each owner to consent explicitly.
        </p>
      )}
      {status.state === "connected" ? (
        <>
          <p>
            Google is connected for this Workspace owner. Refresh tokens and connection identity
            stay in this Workspace and are never shared with another Workspace.
          </p>
          <div className="field-row">
            <button type="button" onClick={onCheck} disabled={checking}>
              {checking ? "Checking…" : "Check my setup"}
            </button>
            <button type="button" onClick={onDisconnect} disabled={disconnecting}>
              {disconnecting ? "Disconnecting…" : "Disconnect Google"}
            </button>
          </div>
        </>
      ) : installationConfigured ? (
        <>
          <p>
            The installation client is ready. Sign in with the Google account that owns this
            Workspace and grant the requested Drive, Gmail, Calendar, and optional Tasks access.
          </p>
          <div className="field-row">
            <button type="button" className="action-button" onClick={onSignIn} disabled={signingIn}>
              {signingIn ? "Opening Google…" : "Sign in with Google"}
            </button>
            {status.state !== "unconfigured" ? (
              <button type="button" onClick={onCheck} disabled={checking}>
                {checking ? "Checking…" : "Check my setup"}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {check ? (
        <div className="setup-check-results" aria-label="Google setup checks">
          {check.items.map((item) => (
            <p key={item.label} className={item.ok ? "ok" : "field-error"}>
              {item.label}: {item.detail}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
