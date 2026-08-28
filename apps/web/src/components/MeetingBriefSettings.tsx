import { useEffect, useState } from "react";
import type {
  GoogleStatus,
  GuestProfileCheckResult,
  GuestProfileStatus,
  HubSpotSetupCheck,
  HubSpotStatus,
  SetupCheck,
} from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";

interface RelayStatus {
  installationId: string | null;
  relayBaseUrl: string | null;
  relayHealth: "ok" | "unreachable" | "not_configured";
  channels: Array<{ channelId: string; expiration: string | null; resourceId: string | null }>;
  lastWakeUpAt: string | null;
  hasSecret: boolean;
}

export function MeetingBriefSettings({
  googleStatus,
  googleCheck,
}: {
  googleStatus: GoogleStatus | null;
  googleCheck: SetupCheck | null;
}) {
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [relayBaseUrl, setRelayBaseUrl] = useState("");
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [internalDomains, setInternalDomains] = useState("");
  const [domainsBusy, setDomainsBusy] = useState(false);
  const [domainsNotice, setDomainsNotice] = useState<string | null>(null);
  const [hubSpotStatus, setHubSpotStatus] = useState<HubSpotStatus | null>(null);
  const [hubSpotToken, setHubSpotToken] = useState("");
  const [hubSpotBusy, setHubSpotBusy] = useState(false);
  const [hubSpotError, setHubSpotError] = useState<string | null>(null);
  const [hubSpotCheck, setHubSpotCheck] = useState<HubSpotSetupCheck | null>(null);
  const [checkingHubSpot, setCheckingHubSpot] = useState(false);
  const [profileStatus, setProfileStatus] = useState<GuestProfileStatus | null>(null);
  const [profileEndpoint, setProfileEndpoint] = useState("");
  const [profileKey, setProfileKey] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileCheck, setProfileCheck] = useState<GuestProfileCheckResult | null>(null);
  const [checkingProfile, setCheckingProfile] = useState(false);

  const refreshRelay = async () => {
    try {
      const status = await api.relayStatus();
      setRelayStatus(status);
      if (status.relayBaseUrl) setRelayBaseUrl(status.relayBaseUrl);
    } catch (error) {
      setRelayError(errorMessage(error));
    }
  };

  const refreshHubSpot = async () => {
    try {
      setHubSpotStatus(await api.hubspotStatus());
    } catch (error) {
      setHubSpotError(errorMessage(error));
    }
  };

  const refreshProfile = async () => {
    try {
      setProfileStatus(await api.guestProfileStatus());
    } catch (error) {
      setProfileError(errorMessage(error));
    }
  };

  useEffect(() => {
    void refreshRelay();
    void refreshHubSpot();
    void refreshProfile();
    void api
      .meetingBriefConfig()
      .then((config) => setInternalDomains(config.internalDomains.join(", ")))
      .catch((error: unknown) => setDomainsNotice(errorMessage(error)));
  }, []);

  const runRelayAction = async (action: () => Promise<unknown>) => {
    if (relayBusy) return;
    setRelayBusy(true);
    setRelayError(null);
    try {
      await action();
      await refreshRelay();
    } catch (error) {
      setRelayError(errorMessage(error));
    } finally {
      setRelayBusy(false);
    }
  };

  const saveDomains = async () => {
    if (domainsBusy) return;
    setDomainsBusy(true);
    setDomainsNotice(null);
    try {
      const domains = internalDomains
        .split(/[\n,]/)
        .map((domain) => domain.trim())
        .filter(Boolean);
      const result = await api.saveMeetingBriefConfig({ internalDomains: domains });
      setInternalDomains(result.internalDomains.join(", "));
      setDomainsNotice("Internal domains saved.");
    } catch (error) {
      setDomainsNotice(errorMessage(error));
    } finally {
      setDomainsBusy(false);
    }
  };

  const connectHubSpot = async () => {
    if (hubSpotBusy) return;
    setHubSpotBusy(true);
    setHubSpotError(null);
    try {
      setHubSpotStatus(await api.hubspotConnect(hubSpotToken.trim()));
      setHubSpotToken("");
    } catch (error) {
      setHubSpotError(errorMessage(error));
    } finally {
      setHubSpotBusy(false);
    }
  };

  const disconnectHubSpot = async () => {
    if (hubSpotBusy) return;
    setHubSpotBusy(true);
    setHubSpotError(null);
    setHubSpotCheck(null);
    try {
      setHubSpotStatus(await api.hubspotDisconnect());
    } catch (error) {
      setHubSpotError(errorMessage(error));
    } finally {
      setHubSpotBusy(false);
    }
  };

  const checkHubSpot = async () => {
    if (checkingHubSpot) return;
    setCheckingHubSpot(true);
    setHubSpotError(null);
    try {
      setHubSpotCheck(await api.hubspotCheck());
      await refreshHubSpot();
    } catch (error) {
      setHubSpotError(errorMessage(error));
    } finally {
      setCheckingHubSpot(false);
    }
  };

  const connectProfile = async () => {
    if (profileBusy) return;
    setProfileBusy(true);
    setProfileError(null);
    try {
      setProfileStatus(await api.guestProfileConnect(profileEndpoint.trim(), profileKey.trim()));
      setProfileKey("");
    } catch (error) {
      setProfileError(errorMessage(error));
    } finally {
      setProfileBusy(false);
    }
  };

  const disconnectProfile = async () => {
    if (profileBusy) return;
    setProfileBusy(true);
    setProfileError(null);
    setProfileCheck(null);
    try {
      setProfileStatus(await api.guestProfileDisconnect());
    } catch (error) {
      setProfileError(errorMessage(error));
    } finally {
      setProfileBusy(false);
    }
  };

  const checkProfile = async () => {
    if (checkingProfile) return;
    setCheckingProfile(true);
    setProfileError(null);
    try {
      setProfileCheck(await api.guestProfileCheck());
      await refreshProfile();
    } catch (error) {
      setProfileError(errorMessage(error));
    } finally {
      setCheckingProfile(false);
    }
  };

  return (
    <>
      <section className="settings-section" aria-labelledby="section-relay">
        <h2 id="section-relay">Calendar Relay</h2>
        <div className="card">
          <p className="muted">
            Opaque calendar wake-up relay (ADR-0031). Stores only installation, channel, message,
            expiry and ack metadata.
          </p>
          {relayStatus ? (
            <div className="field-grid">
              <p>
                <strong>Installation:</strong> {relayStatus.installationId ?? "— not registered"}
              </p>
              <p>
                <strong>Relay URL:</strong> {relayStatus.relayBaseUrl ?? "—"}
              </p>
              <p>
                <strong>Relay health:</strong> {relayStatus.relayHealth}
              </p>
              <p>
                <strong>Channels:</strong> {relayStatus.channels.length}
                {relayStatus.channels.length > 0
                  ? ` — ${relayStatus.channels.map((channel) => channel.channelId).join(", ")}`
                  : ""}
              </p>
              <p>
                <strong>Last wake-up:</strong> {relayStatus.lastWakeUpAt ?? "— none yet"}
              </p>
              <p className="muted">Secrets are kept in Workspace and never shown here.</p>
            </div>
          ) : (
            <p className="muted" role="status">
              Loading relay status…
            </p>
          )}
          <div className="field">
            <label htmlFor="relay-base-url">Public relay base URL</label>
            <input
              id="relay-base-url"
              type="url"
              value={relayBaseUrl}
              onChange={(event) => setRelayBaseUrl(event.target.value)}
              placeholder="https://relay.example.com"
            />
            <p className="muted field-hint">
              Use the stable public HTTPS URL of the separately deployed relay so Google can reach
              its /google/push callback.
            </p>
          </div>
          {relayError ? (
            <p className="field-error" role="alert">
              {relayError}
            </p>
          ) : null}
          <div className="field-row">
            <button
              type="button"
              className="action-button"
              onClick={() =>
                void runRelayAction(() => api.relayInstall(relayBaseUrl.trim() || undefined))
              }
              aria-disabled={relayBusy}
            >
              {relayBusy ? "Working…" : "Register / Update relay"}
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void runRelayAction(() => api.relayPoll())}
              aria-disabled={relayBusy}
            >
              Poll now
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void refreshRelay()}
              aria-disabled={relayBusy}
            >
              Refresh status
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="section-meeting-brief">
        <h2 id="section-meeting-brief">Meeting Brief Generator</h2>
        <div className="card" role="group" aria-labelledby="group-meeting-brief-domains">
          <h3 id="group-meeting-brief-domains">Internal Domains</h3>
          <p className="muted">
            Email domains belonging to your organization. Attendees from these domains are not
            treated as External Guests. Consumer domains remain external and are never employer
            evidence.
          </p>
          <div className="field">
            <label htmlFor="meeting-brief-domains">
              Internal Domains (comma or newline separated)
            </label>
            <input
              id="meeting-brief-domains"
              value={internalDomains}
              onChange={(event) => setInternalDomains(event.target.value)}
              placeholder="example.com, internal.example.org"
              aria-describedby="meeting-brief-domains-hint"
            />
            <p id="meeting-brief-domains-hint" className="muted field-hint">
              Saved domains are normalized to lower case and duplicates are removed.
            </p>
          </div>
          {domainsNotice ? <p role="status">{domainsNotice}</p> : null}
          <button
            type="button"
            className="action-button"
            onClick={() => void saveDomains()}
            aria-disabled={domainsBusy}
          >
            {domainsBusy ? "Saving…" : "Save domains"}
          </button>
        </div>

        <div className="card" role="group" aria-labelledby="group-hubspot">
          <h3 id="group-hubspot">HubSpot CRM</h3>
          <p className="muted">
            Per-user private-app token for read-only contacts, companies, and deals. Status exposes
            only a redacted hint.
          </p>
          {hubSpotStatus ? (
            <p role="status">
              <strong>Status:</strong> {hubSpotStatus.state}
              {hubSpotStatus.tokenHint ? ` (${hubSpotStatus.tokenHint})` : ""}
              {hubSpotStatus.lastVerifiedAt
                ? ` — last verified ${hubSpotStatus.lastVerifiedAt}`
                : ""}
            </p>
          ) : (
            <p className="muted" role="status">
              Loading HubSpot status…
            </p>
          )}
          <div className="field">
            <label htmlFor="hubspot-token">HubSpot private-app token</label>
            <input
              id="hubspot-token"
              type="password"
              value={hubSpotToken}
              onChange={(event) => setHubSpotToken(event.target.value)}
              placeholder="pat-na1-..."
              autoComplete="off"
            />
            <p className="muted field-hint">
              Required scopes: crm.objects.contacts.read, crm.objects.companies.read, and
              crm.objects.deals.read.
            </p>
          </div>
          {hubSpotError ? (
            <p className="field-error" role="alert">
              {hubSpotError}
            </p>
          ) : null}
          <div className="field-row">
            <button
              type="button"
              className="action-button"
              onClick={() => void connectHubSpot()}
              disabled={hubSpotToken.trim() === ""}
              aria-disabled={hubSpotBusy}
            >
              {hubSpotBusy ? "Connecting…" : "Connect HubSpot"}
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void disconnectHubSpot()}
              disabled={hubSpotStatus?.state === "unconfigured"}
              aria-disabled={hubSpotBusy}
            >
              Disconnect
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void checkHubSpot()}
              disabled={hubSpotStatus?.state === "unconfigured"}
              aria-disabled={checkingHubSpot}
            >
              {checkingHubSpot ? "Checking…" : "Check my setup"}
            </button>
          </div>
          {hubSpotCheck ? (
            <div className="banner" role="status">
              <p>
                <strong>Probe:</strong> {hubSpotCheck.state} — {hubSpotCheck.detail}
              </p>
              {hubSpotCheck.items.length > 0 ? (
                <ul>
                  {hubSpotCheck.items.map((item) => (
                    <li key={item.label}>
                      {item.label}: {item.ok ? "ok" : "failed"} — {item.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="muted">Checked at {hubSpotCheck.checkedAt}</p>
            </div>
          ) : null}
        </div>

        <div className="card" role="group" aria-labelledby="group-guest-profile">
          <h3 id="group-guest-profile">Guest Profile</h3>
          <p className="muted">
            Per-user provider for current role and background. Status exposes only a redacted key
            hint.
          </p>
          {profileStatus ? (
            <p role="status">
              <strong>Status:</strong> {profileStatus.state}
              {profileStatus.endpoint ? ` · ${profileStatus.endpoint}` : ""}
              {profileStatus.apiKeyHint ? ` (${profileStatus.apiKeyHint})` : ""}
              {profileStatus.lastVerifiedAt
                ? ` — last verified ${profileStatus.lastVerifiedAt}`
                : ""}
            </p>
          ) : (
            <p className="muted" role="status">
              Loading Guest Profile status…
            </p>
          )}
          <div className="field">
            <label htmlFor="guest-profile-endpoint">Guest Profile endpoint</label>
            <input
              id="guest-profile-endpoint"
              type="url"
              value={profileEndpoint}
              onChange={(event) => setProfileEndpoint(event.target.value)}
              placeholder="https://profile.example/api"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="guest-profile-key">Guest Profile API key</label>
            <input
              id="guest-profile-key"
              type="password"
              value={profileKey}
              onChange={(event) => setProfileKey(event.target.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
            <p className="muted field-hint">
              Provider supplies current employer evidence; no imported browser session or CAPTCHA
              bypass.
            </p>
          </div>
          {profileError ? (
            <p className="field-error" role="alert">
              {profileError}
            </p>
          ) : null}
          <div className="field-row">
            <button
              type="button"
              className="action-button"
              onClick={() => void connectProfile()}
              disabled={profileEndpoint.trim() === ""}
              aria-disabled={profileBusy}
            >
              {profileBusy ? "Connecting…" : "Connect Guest Profile"}
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void disconnectProfile()}
              disabled={profileStatus?.state === "unconfigured"}
              aria-disabled={profileBusy}
            >
              Disconnect
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void checkProfile()}
              disabled={profileStatus?.state === "unconfigured"}
              aria-disabled={checkingProfile}
            >
              {checkingProfile ? "Checking…" : "Check my setup"}
            </button>
          </div>
          {profileCheck ? (
            <div className="banner" role="status">
              <p>
                <strong>Probe:</strong> {profileCheck.state} — {profileCheck.detail}
              </p>
              <p className="muted">Checked at {profileCheck.checkedAt}</p>
            </div>
          ) : null}
        </div>

        <div className="card" role="group" aria-labelledby="group-google-meeting-brief">
          <h3 id="group-google-meeting-brief">Google — Calendar, Gmail, Drive</h3>
          <p className="muted">
            Required scopes: calendar.readonly, gmail.readonly, gmail.send, gmail.compose, and
            drive. Use Check my setup in the Google card above to verify scopes and API enablement.
          </p>
          <p role="status" className="muted">
            Google: {googleStatus?.state ?? "loading"}{" "}
            {googleStatus?.email ? `as ${googleStatus.email}` : ""}
          </p>
          {googleCheck ? (
            <ul>
              {googleCheck.items.map((item) => (
                <li key={item.label}>
                  {item.label}: {item.ok ? "ok" : "failed"} — {item.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Run Check my setup above to see per-surface results.</p>
          )}
        </div>
        <div className="card" role="group" aria-labelledby="group-relay-summary">
          <h3 id="group-relay-summary">Calendar Relay (opaque)</h3>
          <p className="muted">
            Relay stores no Calendar credentials or event data. Relay health:{" "}
            {relayStatus?.relayHealth ?? "loading"}
            {relayStatus?.lastWakeUpAt
              ? ` · last wake-up ${relayStatus.lastWakeUpAt}`
              : " · no wake-up yet"}
            .
          </p>
        </div>
      </section>
    </>
  );
}
