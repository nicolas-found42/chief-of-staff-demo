import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_SERVICE_URL,
  type CalendarEvent,
  type CalendarEvents,
  type ProfileConfig,
} from "@chief-of-staff/contracts";
import { ApiClient, ApiError, isProtocolCompatible, type ConfigResponse } from "../api/client";

interface SetupProps {
  client: ApiClient;
  onPaired: () => void;
  onServiceInfo: (info: { version: string; protocol: number } | null) => void;
}

export function SetupPage({ client, onPaired, onServiceInfo }: SetupProps) {
  const [serviceUrl, setServiceUrl] = useState(client.getBaseUrl() || DEFAULT_SERVICE_URL);
  const [checking, setChecking] = useState(false);
  const [connection, setConnection] = useState<"idle" | "connected" | "unreachable" | "incompatible">("idle");
  const [health, setHealth] = useState<Awaited<ReturnType<ApiClient["health"]>> | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [pairing, setPairing] = useState<"idle" | "paired" | "invalid" | "error">("idle");
  const [pairError, setPairError] = useState("");
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState("");
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [focusAreasText, setFocusAreasText] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [calendar, setCalendar] = useState<CalendarEvents | null>(null);
  const [calendarSaveState, setCalendarSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [newEvent, setNewEvent] = useState<Omit<CalendarEvent, "id">>({
    start: "",
    end: "",
    summary: "",
    status: "busy",
  });

  const refreshConfig = useCallback(async () => {
    try {
      const value = await client.getConfig();
      setConfig(value);
      setProfile(value.profile);
      setFocusAreasText(value.profile.focusAreas.join("\n"));
      setCalendar(value.calendar);
      setConfigError("");
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error));
    }
  }, [client]);

  const checkConnection = async (): Promise<void> => {
    setChecking(true);
    setConnection("idle");
    client.setBaseUrl(serviceUrl);
    client.clearToken();
    setPairing("idle");
    setConfig(null);
    try {
      const value = await client.health();
      setHealth(value);
      if (!isProtocolCompatible(value)) {
        setConnection("incompatible");
        onServiceInfo({ version: value.serviceVersion, protocol: value.protocolVersion });
      } else {
        setConnection("connected");
        onServiceInfo({ version: value.serviceVersion, protocol: value.protocolVersion });
      }
    } catch {
      setConnection("unreachable");
      onServiceInfo(null);
    } finally {
      setChecking(false);
    }
  };

  const doPair = async (): Promise<void> => {
    setPairing("idle");
    setPairError("");
    try {
      await client.pair(pairingCode.trim());
      setPairing("paired");
      onPaired();
      await refreshConfig();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 400)) {
        setPairing("invalid");
      } else {
        setPairing("error");
        setPairError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const saveProfile = async (): Promise<void> => {
    if (!profile) {
      return;
    }
    setSaveState("saving");
    try {
      const next: ProfileConfig = {
        ...profile,
        focusAreas: focusAreasText
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      };
      await client.putProfile(next);
      setProfile(next);
      setSaveState("saved");
      await refreshConfig();
    } catch (error) {
      setSaveState("error");
      setConfigError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveCalendar = async (): Promise<void> => {
    if (!calendar) {
      return;
    }
    setCalendarSaveState("saving");
    try {
      await client.putCalendar(calendar);
      setCalendarSaveState("saved");
      await refreshConfig();
    } catch (error) {
      setCalendarSaveState("error");
      setConfigError(error instanceof Error ? error.message : String(error));
    }
  };

  const addEvent = (): void => {
    if (!calendar || !newEvent.start || !newEvent.end) {
      return;
    }
    const event: CalendarEvent = {
      id: `event-${Date.now()}`,
      ...newEvent,
    };
    setCalendar({ ...calendar, events: [...calendar.events, event] });
    setNewEvent({ start: "", end: "", summary: "", status: "busy" });
  };

  const removeEvent = (id: string): void => {
    if (!calendar) {
      return;
    }
    setCalendar({ ...calendar, events: calendar.events.filter((e) => e.id !== id) });
  };

  useEffect(() => {
    if (pairing === "paired") {
      void refreshConfig();
    }
  }, [pairing, refreshConfig]);

  return (
    <section className="page" aria-labelledby="setup-heading">
      <h1 id="setup-heading">Setup</h1>
      <p>
        This hosted page is only the user interface. The workflow runs on a
        local companion service on your own machine; start it first, then
        connect from here. Live runs send transcript-derived content and
        prompts to OpenRouter and the model provider selected by OpenRouter.
        No other application data is sent remotely.
      </p>

      <div className="card">
        <h2>1. Connect to the local service</h2>
        <div className="field-row">
          <label htmlFor="service-url">Service URL</label>
          <input
            id="service-url"
            aria-label="Service URL"
            type="text"
            value={serviceUrl}
            onChange={(e) => setServiceUrl(e.target.value)}
            spellCheck={false}
          />
          <button type="button" onClick={() => void checkConnection()} disabled={checking}>
            {checking ? "Checking…" : "Check connection"}
          </button>
        </div>
        <p data-testid="connection-status" aria-live="polite">
          {connection === "connected" && health ? (
            <span className="ok">
              connected — service {health.serviceVersion}, protocol {health.protocolVersion}
            </span>
          ) : connection === "incompatible" ? (
            <span className="bad">
              incompatible protocol: this UI requires protocol 1; update either the UI or the
              service before pairing
            </span>
          ) : connection === "unreachable" ? (
            <span className="bad">
              unreachable. The service is not responding at that address. In Chrome and Edge,
              allow "Local network access" when prompted; in Firefox and Safari, check that the
              service is running and the address is correct. You can also open the offline
              fallback served by the service itself:{" "}
              <code data-testid="offline-fallback">http://127.0.0.1:4317/</code>
            </span>
          ) : (
            <span className="muted">not checked yet</span>
          )}
        </p>
        {connection === "connected" && pairing !== "paired" && (
          <div className="field-row">
            <label htmlFor="pairing-code">Pairing code</label>
            <input
              id="pairing-code"
              aria-label="Pairing code"
              type="text"
              inputMode="numeric"
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value)}
            />
            <button type="button" onClick={() => void doPair()}>
              Pair with service
            </button>
          </div>
        )}
        <p data-testid="pairing-status" aria-live="polite">
          {pairing === "paired" && <span className="ok">paired</span>}
          {pairing === "invalid" && (
            <span className="bad">pairing code invalid or expired — check the service console</span>
          )}
          {pairing === "error" && <span className="bad">{pairError}</span>}
        </p>
      </div>

      {pairing === "paired" && config && (
        <>
          <div className="card">
            <h2>2. Readiness</h2>
            <ul className="checklist">
              <li className={config.readiness.profileValid ? "ok" : "bad"}>
                Profile configuration {config.readiness.profileValid ? "valid" : "missing"}
              </li>
              <li className={config.readiness.modelsValid ? "ok" : "bad"}>
                Model configuration {config.readiness.modelsValid ? "valid" : "invalid"}
              </li>
              <li className={config.readiness.calendarValid ? "ok" : "bad"}>
                Calendar schema {config.readiness.calendarValid ? "valid" : "invalid"}
              </li>
              <li className={config.readiness.definitionValid ? "ok" : "bad"}>
                Workflow definition {config.readiness.definitionValid ? "valid" : "invalid"}
              </li>
              <li className={config.readiness.workspaceWriteable ? "ok" : "bad"}>
                Workspace {config.readiness.workspaceWriteable ? "writeable" : "not writeable"}
              </li>
              <li className={config.readiness.openRouterConfigured ? "ok" : "bad"}>
                OpenRouter key {config.readiness.openRouterConfigured ? "configured" : "not configured"}
              </li>
            </ul>
            {config.readiness.errors.length > 0 && (
              <ul className="error-list">
                {config.readiness.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>3. Profile</h2>
            {profile && (
              <div className="form-grid">
                <label htmlFor="profile-name">Your name</label>
                <input
                  id="profile-name"
                  aria-label="Your name"
                  value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                />
                <label htmlFor="profile-title">Your title</label>
                <input
                  id="profile-title"
                  aria-label="Your title"
                  value={profile.title}
                  onChange={(e) => setProfile({ ...profile, title: e.target.value })}
                />
                <label htmlFor="profile-company">Your company</label>
                <input
                  id="profile-company"
                  aria-label="Your company"
                  value={profile.company}
                  onChange={(e) => setProfile({ ...profile, company: e.target.value })}
                />
                <label htmlFor="profile-style">Writing style</label>
                <textarea
                  id="profile-style"
                  aria-label="Writing style"
                  rows={2}
                  value={profile.writingStyle}
                  onChange={(e) => setProfile({ ...profile, writingStyle: e.target.value })}
                />
                <label htmlFor="profile-focus">Key focus areas (one per line)</label>
                <textarea
                  id="profile-focus"
                  aria-label="Key focus areas"
                  rows={4}
                  value={focusAreasText}
                  onChange={(e) => setFocusAreasText(e.target.value)}
                />
                <div>
                  <button type="button" onClick={() => void saveProfile()} disabled={saveState === "saving"}>
                    {saveState === "saving" ? "Saving…" : "Save profile"}
                  </button>
                  {saveState === "saved" && (
                    <span className="ok" aria-live="polite">
                      {" "}
                      saved
                    </span>
                  )}
                </div>
              </div>
            )}
            {configError && <p className="bad">{configError}</p>}
          </div>

          <div className="card">
            <h2>4. Models</h2>
            <p className="muted">
              Model configuration is locked in version 1: provider{" "}
              <code>{config.models.provider}</code>, model <code>{config.models.model}</code>.
              The OpenRouter API key never passes through this UI.
            </p>
          </div>

          <div className="card">
            <h2>5. Calendar</h2>
            {calendar && (
              <>
                <div className="field-row">
                  <label htmlFor="calendar-timezone">Timezone</label>
                  <input
                    id="calendar-timezone"
                    aria-label="Calendar timezone"
                    value={calendar.timezone}
                    onChange={(e) => setCalendar({ ...calendar, timezone: e.target.value })}
                  />
                </div>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Start</th>
                      <th scope="col">End</th>
                      <th scope="col">Summary</th>
                      <th scope="col">Status</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calendar.events.map((event) => (
                      <tr key={event.id}>
                        <td>{event.start}</td>
                        <td>{event.end}</td>
                        <td>{event.summary}</td>
                        <td>{event.status}</td>
                        <td>
                          <button type="button" onClick={() => removeEvent(event.id)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="field-row">
                  <input
                    aria-label="New event start"
                    placeholder="Start (ISO)"
                    value={newEvent.start}
                    onChange={(e) => setNewEvent({ ...newEvent, start: e.target.value })}
                  />
                  <input
                    aria-label="New event end"
                    placeholder="End (ISO)"
                    value={newEvent.end}
                    onChange={(e) => setNewEvent({ ...newEvent, end: e.target.value })}
                  />
                  <input
                    aria-label="New event summary"
                    placeholder="Summary"
                    value={newEvent.summary}
                    onChange={(e) => setNewEvent({ ...newEvent, summary: e.target.value })}
                  />
                  <select
                    aria-label="New event status"
                    value={newEvent.status}
                    onChange={(e) =>
                      setNewEvent({ ...newEvent, status: e.target.value as CalendarEvent["status"] })
                    }
                  >
                    <option value="busy">busy</option>
                    <option value="tentative">tentative</option>
                    <option value="free">free</option>
                  </select>
                  <button type="button" onClick={addEvent}>
                    Add event
                  </button>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => void saveCalendar()}
                    disabled={calendarSaveState === "saving"}
                  >
                    {calendarSaveState === "saving" ? "Saving…" : "Save calendar"}
                  </button>
                  {calendarSaveState === "saved" && (
                    <span className="ok" aria-live="polite">
                      {" "}
                      saved
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
