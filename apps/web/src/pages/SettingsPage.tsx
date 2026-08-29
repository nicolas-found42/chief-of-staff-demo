import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  GuestProfileCheckResult,
  GuestProfileStatus,
  HubSpotSetupCheck,
  HubSpotStatus,
  ProviderId,
  SetupCheck,
} from "@chief-of-staff-demo/shared";
import { api, errorMessage, type ConfigPayload } from "../client";
import { GoogleConnect } from "../components/GoogleConnect";
import { SpreadsheetCard } from "../modules/youtube/SpreadsheetCard";
import { pickDriveFolder } from "../googlePicker";
import { useGoogleConnection } from "../useGoogleConnection";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

const PROVIDER_OPTIONS: { value: ProviderId; label: string }[] = [
  { value: "mock", label: "mock (test/demo — reads workspace/mock-result.json)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "gemini", label: "Google Gemini" },
  { value: "ollama", label: "Ollama (local model)" },
];

/** Compact one-word names for the settled-connection line (D11). */
const PROVIDER_SHORT: Record<ProviderId, string> = {
  mock: "Mock",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
  ollama: "Ollama",
};

/**
 * Where each provider issues API keys. Without this a beginner has to work out
 * which of a provider's several consoles holds them, from a Settings page that
 * only says "Provider API key". `ollama` and `mock` need no key, so they have
 * no entry and the line does not render.
 */
const PROVIDER_KEY_URLS: Partial<Record<ProviderId, string>> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  openrouter: "https://openrouter.ai/keys",
  gemini: "https://aistudio.google.com/apikey",
};

interface FormState {
  provider: ProviderId;
  model: string;
  apiKey: string;
  tasklistName: string;
  googleClientId: string;
  googleClientSecret: string;
  driveEnabled: boolean;
  driveFolderId: string;
  driveFolderName: string;
  /* Held as the raw string so clearing the field doesn't silently coerce to 0. */
  pollIntervalMinutes: string;
  ollamaBaseUrl: string;
}

export function SettingsPage() {
  useTitle("Settings");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [payload, setPayload] = useState<ConfigPayload | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [relayStatus, setRelayStatus] = useState<{
    installationId: string | null;
    relayBaseUrl: string | null;
    relayHealth: "ok" | "unreachable" | "not_configured";
    channels: Array<{ channelId: string; expiration: string | null; resourceId: string | null }>;
    lastWakeUpAt: string | null;
    hasSecret: boolean;
  } | null>(null);
  const [relayBaseUrlInput, setRelayBaseUrlInput] = useState("");
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [hubspotStatus, setHubspotStatus] = useState<HubSpotStatus | null>(null);
  const [hubspotTokenInput, setHubspotTokenInput] = useState("");
  const [hubspotBusy, setHubspotBusy] = useState(false);
  const [hubspotError, setHubspotError] = useState<string | null>(null);
  const [hubspotCheck, setHubspotCheck] = useState<HubSpotSetupCheck | null>(null);
  const [checkingHubspot, setCheckingHubspot] = useState(false);
  const [guestProfileStatus, setGuestProfileStatus] = useState<GuestProfileStatus | null>(null);
  const [guestProfileEndpointInput, setGuestProfileEndpointInput] = useState("");
  const [guestProfileKeyInput, setGuestProfileKeyInput] = useState("");
  const [guestProfileBusy, setGuestProfileBusy] = useState(false);
  const [guestProfileError, setGuestProfileError] = useState<string | null>(null);
  const [guestProfileCheck, setGuestProfileCheck] = useState<GuestProfileCheckResult | null>(null);
  const [checkingGuestProfile, setCheckingGuestProfile] = useState(false);
  const [meetingBriefInternalDomains, setMeetingBriefInternalDomains] = useState("");
  const [meetingBriefSaving, setMeetingBriefSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /* One flag per action, not one for the page: a shared flag marks controls
     aria-disabled during a request they have nothing to do with, so a screen
     reader reports them as unavailable when they are not (WCAG 4.1.2). */
  const [copiedCorrectUri, setCopiedCorrectUri] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [checkingGoogle, setCheckingGoogle] = useState(false);
  const [jsonNotice, setJsonNotice] = useState<string | null>(null);
  const [modelNotice, setModelNotice] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [googleCheck, setGoogleCheck] = useState<SetupCheck | null>(null);
  /* The connection is the Shell's, held once for the three surfaces that show
     it (ADR-0011). This card is the one that changes it, so it writes through
     the provider rather than keeping a copy that could disagree with the
     banner. */
  const { status: googleStatus, refresh: refreshGoogle } = useGoogleConnection();
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const load = async () => {
      try {
        const fetched = await api.getConfig();
        setPayload(fetched);
        setForm({
          provider: fetched.config.provider,
          model: fetched.config.model,
          apiKey: "",
          tasklistName: fetched.config.tasklistName,
          googleClientId: fetched.config.google.clientId,
          googleClientSecret: "",
          driveEnabled: fetched.config.drive.enabled,
          driveFolderId: fetched.config.drive.folderId,
          driveFolderName: fetched.config.drive.folderName,
          pollIntervalMinutes: String(fetched.config.drive.pollIntervalMinutes),
          ollamaBaseUrl: fetched.config.ollama.baseUrl,
        });
      } catch (err) {
        setError(errorMessage(err));
      }
    };
    void load();
  }, []);

  /* A save can change the connection — new client credentials leave it
     `disconnected` where it was `unconfigured` — so the stored status is stale
     the moment the config comes back. The provider has already asked once on
     mount, which is why this waits for a payload. */
  useEffect(() => {
    if (payload) {
      void refreshGoogle();
    }
  }, [payload, refreshGoogle]);

  useEffect(() => {
    const loadRelay = async () => {
      try {
        const status = await api.relayStatus();
        setRelayStatus(status);
        if (status.relayBaseUrl) setRelayBaseUrlInput(status.relayBaseUrl);
      } catch {
        // relay not configured yet — keep null
      }
    };
    void loadRelay();
  }, []);

  const refreshRelay = async () => {
    try {
      const status = await api.relayStatus();
      setRelayStatus(status);
      if (status.relayBaseUrl) setRelayBaseUrlInput(status.relayBaseUrl);
    } catch (err) {
      setRelayError(errorMessage(err));
    }
  };

  const installRelay = async () => {
    if (relayBusy) return;
    setRelayBusy(true);
    setRelayError(null);
    try {
      await api.relayInstall(relayBaseUrlInput.trim() || undefined);
      await refreshRelay();
    } catch (err) {
      setRelayError(errorMessage(err));
    } finally {
      setRelayBusy(false);
    }
  };

  const pollRelay = async () => {
    if (relayBusy) return;
    setRelayBusy(true);
    setRelayError(null);
    try {
      await api.relayPoll();
      await refreshRelay();
    } catch (err) {
      setRelayError(errorMessage(err));
    } finally {
      setRelayBusy(false);
    }
  };

  useEffect(() => {
    const loadHubspot = async () => {
      try {
        const status = await api.hubspotStatus();
        setHubspotStatus(status);
      } catch {
        // hubspot not configured yet
      }
      try {
        const cfg = await api.meetingBriefConfig();
        setMeetingBriefInternalDomains(cfg.internalDomains.join(", "));
        setHubspotStatus(cfg.hubspot);
      } catch {
        // meeting brief config not yet
      }
      try {
        const gp = await api.guestProfileStatus();
        setGuestProfileStatus(gp);
      } catch {
        // guest profile not configured yet
      }
    };
    void loadHubspot();
  }, []);

  const refreshGuestProfile = async () => {
    try {
      const status = await api.guestProfileStatus();
      setGuestProfileStatus(status);
    } catch (err) {
      setGuestProfileError(errorMessage(err));
    }
  };

  const refreshHubspot = async () => {
    try {
      const status = await api.hubspotStatus();
      setHubspotStatus(status);
    } catch (err) {
      setHubspotError(errorMessage(err));
    }
  };

  const connectHubspot = async () => {
    if (hubspotBusy) return;
    setHubspotBusy(true);
    setHubspotError(null);
    try {
      const status = await api.hubspotConnect(hubspotTokenInput.trim());
      setHubspotStatus(status);
      setHubspotTokenInput("");
    } catch (err) {
      setHubspotError(errorMessage(err));
    } finally {
      setHubspotBusy(false);
    }
  };

  const disconnectHubspot = async () => {
    if (hubspotBusy) return;
    setHubspotBusy(true);
    setHubspotError(null);
    setHubspotCheck(null);
    try {
      const status = await api.hubspotDisconnect();
      setHubspotStatus(status);
    } catch (err) {
      setHubspotError(errorMessage(err));
    } finally {
      setHubspotBusy(false);
    }
  };

  const checkHubspot = async () => {
    if (checkingHubspot) return;
    setCheckingHubspot(true);
    setHubspotError(null);
    try {
      const result = await api.hubspotCheck();
      setHubspotCheck(result);
      await refreshHubspot();
    } catch (err) {
      setHubspotError(errorMessage(err));
    } finally {
      setCheckingHubspot(false);
    }
  };

  const connectGuestProfile = async () => {
    if (guestProfileBusy) return;
    setGuestProfileBusy(true);
    setGuestProfileError(null);
    try {
      const status = await api.guestProfileConnect(
        guestProfileEndpointInput.trim(),
        guestProfileKeyInput.trim(),
      );
      setGuestProfileStatus(status);
      setGuestProfileKeyInput("");
    } catch (err) {
      setGuestProfileError(errorMessage(err));
    } finally {
      setGuestProfileBusy(false);
    }
  };

  const disconnectGuestProfile = async () => {
    if (guestProfileBusy) return;
    setGuestProfileBusy(true);
    setGuestProfileError(null);
    setGuestProfileCheck(null);
    try {
      const status = await api.guestProfileDisconnect();
      setGuestProfileStatus(status);
    } catch (err) {
      setGuestProfileError(errorMessage(err));
    } finally {
      setGuestProfileBusy(false);
    }
  };

  const checkGuestProfile = async () => {
    if (checkingGuestProfile) return;
    setCheckingGuestProfile(true);
    setGuestProfileError(null);
    try {
      const result = await api.guestProfileCheck();
      setGuestProfileCheck(result);
      await refreshGuestProfile();
    } catch (err) {
      setGuestProfileError(errorMessage(err));
    } finally {
      setCheckingGuestProfile(false);
    }
  };

  const saveMeetingBrief = async () => {
    if (meetingBriefSaving) return;
    setMeetingBriefSaving(true);
    setError(null);
    try {
      const domains = meetingBriefInternalDomains
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
      const result = await api.saveMeetingBriefConfig({ internalDomains: domains });
      setMeetingBriefInternalDomains(result.internalDomains.join(", "));
      setHubspotStatus(result.hubspot);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMeetingBriefSaving(false);
    }
  };
  if (!form || !payload) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Settings
        </h1>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : (
          <p className="muted" role="status">
            Loading…
          </p>
        )}
      </div>
    );
  }

  const googleBanner = searchParams.get("google");

  // Validated here rather than left to the browser's `min` attribute: a native
  // validation bubble is transient, unreadable a second time, and leaves the
  // field itself unmarked (WCAG 3.3.1).
  const pollRaw = form.pollIntervalMinutes.trim();
  const pollInvalid = !/^\d+$/.test(pollRaw) || Number(pollRaw) < 1;

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  const changeProvider = (provider: ProviderId) => {
    const defaults = payload.defaults;
    const previousDefault = Object.values(defaults).includes(form.model);
    const model = form.model === "" || previousDefault ? (defaults[provider] ?? "") : form.model;
    setForm((current) => (current ? { ...current, provider, model } : current));
    // Changing Provider rewrites a field the user did not touch. Sighted users
    // watch it happen; everyone else needs it said (WCAG 3.2.2).
    setModelNotice(
      model === form.model ? "" : model ? `Model changed to ${model}.` : "Model cleared.",
    );
    setSaved(false);
  };

  const save = async () => {
    if (saving) {
      return;
    }
    if (pollInvalid) {
      setError("Poll interval must be a whole number of minutes, 1 or more.");
      // Moving focus in the same frame the role="alert" mounts can cut the
      // announcement short; the next frame lets it start first (WCAG 3.3.1).
      requestAnimationFrame(() => document.getElementById("poll-interval")?.focus());
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const update: Record<string, unknown> = {
        provider: form.provider,
        model: form.model,
        tasklistName: form.tasklistName,
        google: { clientId: form.googleClientId },
        drive: {
          enabled: form.driveEnabled,
          folderId: form.driveFolderId,
          folderName: form.driveFolderName,
          pollIntervalMinutes: Number(form.pollIntervalMinutes),
        },
        ollama: { baseUrl: form.ollamaBaseUrl },
      };
      if (form.apiKey !== "") {
        update.apiKey = form.apiKey;
      }
      if (form.googleClientSecret !== "") {
        update.google = { clientId: form.googleClientId, clientSecret: form.googleClientSecret };
      }
      const savedPayload = await api.saveConfig(update);
      setPayload(savedPayload);
      setForm((current) =>
        current
          ? {
              ...current,
              provider: savedPayload.config.provider,
              model: savedPayload.config.model,
              tasklistName: savedPayload.config.tasklistName,
              googleClientId: savedPayload.config.google.clientId,
              driveEnabled: savedPayload.config.drive.enabled,
              driveFolderId: savedPayload.config.drive.folderId,
              driveFolderName: savedPayload.config.drive.folderName,
              pollIntervalMinutes: String(savedPayload.config.drive.pollIntervalMinutes),
              ollamaBaseUrl: savedPayload.config.ollama.baseUrl,
              apiKey: "",
              googleClientSecret: "",
            }
          : current,
      );
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  /* Saves the client credentials on its own rather than through the form-wide
     Save: signing in must not be blocked by an unrelated invalid field, and the
     server can only build the consent URL from credentials it has stored. On
     success the browser leaves for Google, so the busy flag is never cleared. */
  const signInGoogle = async () => {
    if (signingIn) {
      return;
    }
    setSigningIn(true);
    setError(null);
    try {
      setPayload(
        await api.saveConfig({
          google:
            form.googleClientSecret === ""
              ? { clientId: form.googleClientId }
              : { clientId: form.googleClientId, clientSecret: form.googleClientSecret },
        }),
      );
      const { authUrl } = await api.googleConnect();
      window.location.assign(authUrl);
    } catch (err) {
      setError(errorMessage(err));
      setSigningIn(false);
    }
  };

  const disconnectGoogle = async () => {
    if (disconnecting) {
      return;
    }
    setDisconnecting(true);
    setError(null);
    /* The old answer described a connection that no longer exists. */
    setGoogleCheck(null);
    try {
      await api.googleDisconnect();
      await refreshGoogle();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDisconnecting(false);
    }
  };

  /* The check can establish that the grant is dead, so the status it returns
     replaces the one on screen rather than sitting beside it. */
  const checkGoogle = async () => {
    if (checkingGoogle) {
      return;
    }
    setCheckingGoogle(true);
    setError(null);
    try {
      const result = await api.googleCheck();
      setGoogleCheck(result);
      await refreshGoogle();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCheckingGoogle(false);
    }
  };

  const syncDrive = async () => {
    if (syncing) {
      return;
    }
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      const { created } = await api.driveSync();
      setSyncResult(`Synced — ${created} new transcript(s) started.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  const chooseFolder = async () => {
    if (picking) return;
    setPickerError(null);
    setPicking(true);
    try {
      const { token } = await api.googlePickerToken();
      const picked = await pickDriveFolder(token);
      if (picked) {
        setField("driveFolderId", picked.id);
        setField("driveFolderName", picked.name);
      }
    } catch (err) {
      setPickerError(errorMessage(err));
    } finally {
      setPicking(false);
    }
  };

  // Persistent hint text rather than a placeholder: this is the instruction
  // that stops someone from wiping a stored secret, and placeholders vanish
  // on the first keystroke (3.3.2).
  const secretHint = (set: boolean, hint: string) =>
    set ? `Stored (${hint}). Leave blank to keep it.` : "No value stored yet.";

  const keyUrl = PROVIDER_KEY_URLS[form.provider];

  /**
   * Reads the client JSON the console offers on the one screen that shows the
   * secret. Parsed here and never sent anywhere: the file's only job is to get
   * two values into the fields, and transcribing a 35-character secret by hand
   * is the one irreversible mistake in the whole setup.
   */
  const loadClientJson = async (file: File) => {
    setJsonNotice(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setJsonNotice("That file is not valid JSON — pick the one the console downloaded.");
      return;
    }
    const web = (parsed as { web?: { client_id?: unknown; client_secret?: unknown } } | null)?.web;
    if (!web || typeof web.client_id !== "string" || typeof web.client_secret !== "string") {
      /* A Desktop app client arrives under `installed`, and a service-account
         key has neither shape. Both would store credentials that cannot work
         against this redirect URI, and would fail much later. */
      setJsonNotice(
        "That is not a Web application client. Create the client with application type Web application, then download its JSON.",
      );
      return;
    }
    setField("googleClientId", web.client_id);
    setField("googleClientSecret", web.client_secret);
    setJsonNotice("Client ID and secret read from the file. Press Save and sign in with Google.");
  };

  /* D11: two sections. Settled connections shrink to one line plus a Manage
     disclosure; fresh or broken things keep their full weight. */
  const googleSettled = googleStatus?.state === "connected";
  const providerNeedsKey = form.provider !== "mock" && form.provider !== "ollama";
  const providerSettled = !providerNeedsKey || payload.config.apiKey.set;

  const providerFields = (
    <>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="provider">Provider</label>
          <select
            id="provider"
            value={form.provider}
            onChange={(event) => changeProvider(event.target.value as ProviderId)}
          >
            {PROVIDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="model">Model</label>
          <input
            id="model"
            aria-describedby="model-hint"
            value={form.model}
            placeholder={payload.defaults[form.provider] || "model id"}
            onChange={(event) => setField("model", event.target.value)}
          />
          <p id="model-hint" className="muted field-hint">
            {payload.defaults[form.provider]
              ? `Default for this provider: ${payload.defaults[form.provider]}`
              : "Enter the model id to use."}
          </p>
          <p className="visually-hidden" role="status">
            {modelNotice}
          </p>
        </div>
        <div className="field">
          <label htmlFor="api-key">Provider API key</label>
          <input
            id="api-key"
            aria-describedby={keyUrl ? "api-key-hint api-key-source" : "api-key-hint"}
            type="password"
            value={form.apiKey}
            autoComplete="off"
            onChange={(event) => setField("apiKey", event.target.value)}
          />
          <p id="api-key-hint" className="muted field-hint">
            {secretHint(payload.config.apiKey.set, payload.config.apiKey.hint)}
          </p>
          {keyUrl && (
            <p id="api-key-source" className="muted field-hint">
              Sign in and create an API key at{" "}
              <a className="step-link" href={keyUrl} target="_blank" rel="noreferrer">
                {keyUrl.replace("https://", "")}
              </a>
            </p>
          )}
        </div>
      </div>
      {form.provider === "ollama" && (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ollama-base-url">Ollama base URL</label>
            <input
              id="ollama-base-url"
              aria-describedby="ollama-base-url-hint"
              value={form.ollamaBaseUrl}
              placeholder="http://127.0.0.1:11434"
              onChange={(event) => setField("ollamaBaseUrl", event.target.value)}
            />
            <p id="ollama-base-url-hint" className="muted field-hint">
              Where Ollama listens. Use http://host.docker.internal:11434 when this app runs in a
              container and Ollama runs on the host. No API key needed.
            </p>
          </div>
        </div>
      )}
      {form.provider === "mock" && (
        <p className="muted">
          Mock mode returns workspace/mock-result.json (or a skip stub when absent) — useful for
          demos and tests. No API key needed.
        </p>
      )}
    </>
  );

  /* The connection's own card — sign-in state, disconnect, client replacement,
     check — exactly as before, only sometimes behind Manage (D11). */
  const googleCard = (
    <GoogleConnect
      status={googleStatus}
      clientId={form.googleClientId}
      clientSecret={form.googleClientSecret}
      secretHint={secretHint(
        payload.config.google.clientSecret.set,
        payload.config.google.clientSecret.hint,
      )}
      onChange={(field, value) =>
        setField(field === "clientId" ? "googleClientId" : "googleClientSecret", value)
      }
      onSignIn={() => void signInGoogle()}
      onDisconnect={() => void disconnectGoogle()}
      onCheck={() => void checkGoogle()}
      check={googleCheck}
      onClientJson={(file) => void loadClientJson(file)}
      jsonNotice={jsonNotice}
      signingIn={signingIn}
      disconnecting={disconnecting}
      checking={checkingGoogle}
    />
  );

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Settings
      </h1>

      {googleBanner === "connected" && (
        <div className="banner banner-ok" role="status">
          Google connected.
        </div>
      )}
      {googleBanner === "access_denied" && (
        <div className="banner banner-error" role="alert">
          Google refused the sign-in because that account is not on your consent screen's Test users
          list. Add it under Audience → Test users, then sign in again with the same account.
        </div>
      )}
      {googleBanner === "scope_missing" && (
        <div className="banner banner-error" role="alert">
          {(() => {
            const missing = searchParams.get("missing") ?? "";
            const scopes = missing
              ? missing
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [];
            const labelMap: Record<string, string> = {
              "https://www.googleapis.com/auth/tasks": "Google Tasks",
              "https://www.googleapis.com/auth/gmail.compose": "Gmail drafts",
              "https://www.googleapis.com/auth/drive": "Google Drive",
              "https://www.googleapis.com/auth/youtube.readonly": "YouTube view counts",
              tasks: "Google Tasks",
              "gmail.compose": "Gmail drafts",
              drive: "Google Drive",
              "drive.readonly": "Google Drive",
              "youtube.readonly": "YouTube view counts",
            };
            const labels = scopes.map((s) => labelMap[s] ?? s);
            const labelText = labels.length ? labels.join(", ") : "a required permission";
            return `Google did not grant ${labelText}. Sign in again and leave every permission ticked.`;
          })()}
        </div>
      )}
      {googleBanner === "error" && (
        <div className="banner banner-error" role="alert">
          Google connection failed — try again.
        </div>
      )}
      {googleBanner === "redirect_uri_mismatch" && (
        <div className="banner banner-error" role="alert">
          {/* D13: the one OAuth failure with a mechanical fix gets the fix in
              the message — the correct value, one click away, instead of an
              error to decode against the console. */}
          <span>
            Google refused the sign-in because the redirect URI registered on your OAuth client does
            not match this app&apos;s. Copy the correct value and paste it into your client&apos;s
            Authorized redirect URIs exactly as-is, then sign in again.
          </span>
          <button
            type="button"
            className="action-button"
            onClick={() => {
              void navigator.clipboard.writeText(googleStatus?.redirectUri ?? "").then(
                () => setCopiedCorrectUri(true),
                () => setCopiedCorrectUri(false),
              );
            }}
          >
            {copiedCorrectUri ? "Copied — paste it into Google" : "Copy correct URI"}
          </button>
        </div>
      )}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div className="banner banner-ok" role="status">
          Saved.
        </div>
      )}

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {/* Each card below is a labelled group so same-named fields stay
            distinguishable to anyone navigating by form control (1.3.1). The
            section further down holds one card, which its own heading already
            names — a second group there would say the same thing twice. */}
        <section className="settings-section" aria-labelledby="section-connections">
          <h2 id="section-connections">Connections</h2>

          <div className="card" role="group" aria-labelledby="group-google">
            <h3 id="group-google">Google</h3>
            {googleSettled ? (
              <>
                <p className="connection-summary" role="status">
                  <span className="ok">Connected</span>
                  {googleStatus.email ? ` as ${googleStatus.email}` : ""}
                </p>
                <details className="disclosure">
                  <summary>Manage Google connection</summary>
                  <div className="disclosure-body">{googleCard}</div>
                </details>
              </>
            ) : (
              /* Fresh or broken: the full card keeps its weight, because the
                 fix is on it. */
              googleCard
            )}
          </div>

          <div className="card" role="group" aria-labelledby="group-provider">
            <h3 id="group-provider">Extraction provider</h3>
            {providerSettled ? (
              <>
                <p className="connection-summary">
                  {PROVIDER_SHORT[form.provider]}
                  {form.model ? ` · ${form.model}` : ""}
                </p>
                <details className="disclosure">
                  <summary>Manage provider</summary>
                  <div className="disclosure-body">{providerFields}</div>
                </details>
              </>
            ) : (
              /* A provider that needs a key and has none stored is not settled:
                 the fields stay out where they can be filled. */
              providerFields
            )}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="section-tuning">
          <h2 id="section-tuning">Transcript → Tasks</h2>
          <div className="card">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="tasklist-name">Task list name</label>
                <input
                  id="tasklist-name"
                  value={form.tasklistName}
                  onChange={(event) => setField("tasklistName", event.target.value)}
                />
              </div>
            </div>
            <p className="muted">
              Transcripts are read from a single Google Drive folder. Pick the folder your
              transcript service writes to, then enable polling.
            </p>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="drive-folder">Drive folder</label>
                <div className="field-row">
                  <input
                    id="drive-folder"
                    aria-describedby="drive-folder-hint"
                    value={
                      form.driveFolderName
                        ? `${form.driveFolderName} (${form.driveFolderId})`
                        : form.driveFolderId
                    }
                    placeholder="No folder chosen"
                    readOnly
                  />
                  <button
                    type="button"
                    className="action-button"
                    onClick={() => void chooseFolder()}
                    disabled={googleStatus?.state !== "connected" || picking}
                    aria-describedby={
                      googleStatus?.state !== "connected" ? "drive-picker-disabled-hint" : undefined
                    }
                  >
                    {picking ? "Opening…" : form.driveFolderId ? "Change folder" : "Choose folder"}
                  </button>
                </div>
                {googleStatus?.state !== "connected" ? (
                  <p id="drive-picker-disabled-hint" className="muted field-hint">
                    Sign in with Google first — the picker needs your Drive access.
                  </p>
                ) : null}
                {pickerError ? (
                  <p className="field-error" role="alert">
                    {pickerError}
                  </p>
                ) : null}
                <p id="drive-folder-hint" className="muted field-hint">
                  The picker shows your Drive folders — no folder ID to copy. Requires Google Drive
                  access; sign in again after enabling the Drive API.
                </p>
              </div>
              <div className="field">
                <label htmlFor="poll-interval">Poll interval (minutes)</label>
                <input
                  id="poll-interval"
                  aria-describedby={
                    pollInvalid ? "poll-interval-error poll-interval-hint" : "poll-interval-hint"
                  }
                  aria-invalid={pollInvalid || undefined}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={form.pollIntervalMinutes}
                  onChange={(event) => setField("pollIntervalMinutes", event.target.value)}
                />
                {pollInvalid && (
                  <p id="poll-interval-error" className="field-error">
                    Enter a whole number of minutes — 1 or more.
                  </p>
                )}
                <p id="poll-interval-hint" className="muted field-hint">
                  One minute or longer.
                </p>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={form.driveEnabled}
                  onChange={(event) => setField("driveEnabled", event.target.checked)}
                />
                Enable Drive polling
              </label>
            </div>
            <div className="field-row">
              <button
                type="button"
                className="action-button"
                onClick={() => void syncDrive()}
                aria-disabled={syncing}
              >
                Sync now
              </button>
              <span role="status">{syncResult && <span className="ok">{syncResult}</span>}</span>
            </div>
            <p className="muted">
              Supported: .txt, .md, .json, .jsonc, .pdf, .docx, and native Google Docs (exported as
              text). Other files are ignored.
            </p>
          </div>
        </section>

        <div className="field-row">
          <button type="submit" className="primary action-button" aria-disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>

      {/* Relay status — issue://80 Settings + ADR-0031: health, channel status, last wake-up, no secrets */}
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
                  ? ` — ${relayStatus.channels.map((c) => c.channelId).join(", ")}`
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
            <label htmlFor="relay-base-url">Relay base URL</label>
            <input
              id="relay-base-url"
              value={relayBaseUrlInput}
              onChange={(event) => setRelayBaseUrlInput(event.target.value)}
              placeholder="http://127.0.0.1:4318"
            />
            <p className="muted field-hint">
              Local default 4318; production is https://relay.example.com.
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
              onClick={() => void installRelay()}
              aria-disabled={relayBusy}
            >
              {relayBusy ? "Working…" : "Register / Update relay"}
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void pollRelay()}
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
            treated as External Guests. Domains are compared case-insensitively after normalized
            email parsing and stored lowercased. Consumer domains (gmail.com, outlook.com,
            icloud.com, etc.) remain external and are never treated as employer evidence.
          </p>
          <p className="muted">
            Calendar authority required by the Google connection: Calendar read and watch (calendar,
            calendar.events) to watch your primary Calendar, plus Gmail read/send and Drive for
            enrichment. Use <strong>Check my setup</strong> above to verify the required scopes and
            that the Calendar and Gmail APIs are enabled. No Calendar credentials or event data are
            stored by the relay (ADR-0031).
          </p>
          <div className="field">
            <label htmlFor="meeting-brief-domains">
              Internal Domains (comma or newline separated)
            </label>
            <input
              id="meeting-brief-domains"
              value={meetingBriefInternalDomains}
              onChange={(event) => setMeetingBriefInternalDomains(event.target.value)}
              placeholder="example.com, internal.example.org"
              aria-describedby="meeting-brief-domains-hint"
            />
            <p id="meeting-brief-domains-hint" className="muted field-hint">
              Enter one or more domains, separated by commas or new lines. Saved domains are
              normalized to lower case; duplicates are removed. Example: found42.com, example.com
            </p>
          </div>
          <div className="field-row">
            <button
              type="button"
              className="action-button"
              onClick={() => void saveMeetingBrief()}
              aria-disabled={meetingBriefSaving}
            >
              {meetingBriefSaving ? "Saving…" : "Save domains"}
            </button>
          </div>
        </div>
        <div className="card" role="group" aria-labelledby="group-hubspot">
          <h3 id="group-hubspot">HubSpot CRM</h3>
          <p className="muted">
            Per-user private-app token (read-only contacts, companies, deals). Never uses a shared
            Found42 credential. Stored via Shell-credential/Module-call boundary; status shows
            redacted hint only.
          </p>
          {hubspotStatus ? (
            <p role="status">
              <strong>Status:</strong> {hubspotStatus.state}
              {hubspotStatus.tokenHint ? ` (${hubspotStatus.tokenHint})` : ""}
              {hubspotStatus.lastVerifiedAt
                ? ` — last verified ${hubspotStatus.lastVerifiedAt}`
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
              value={hubspotTokenInput}
              onChange={(event) => setHubspotTokenInput(event.target.value)}
              placeholder="pat-na1-..."
              autoComplete="off"
            />
            <p className="muted field-hint">
              Create a private app in HubSpot with scopes crm.objects.contacts.read,
              crm.objects.companies.read, crm.objects.deals.read, then paste its access token.
            </p>
          </div>
          {hubspotError ? (
            <p className="field-error" role="alert">
              {hubspotError}
            </p>
          ) : null}
          <div className="field-row">
            {/* Unavailable because nothing is configured — no token typed, no
                connection to tear down — is native `disabled`; busy is
                `aria-disabled`, which is what the accessibility suite's busy
                query reads. The two states never share a signal. */}
            <button
              type="button"
              className="action-button"
              onClick={() => void connectHubspot()}
              disabled={hubspotTokenInput.trim() === ""}
              aria-disabled={hubspotBusy}
            >
              {hubspotBusy ? "Connecting…" : "Connect HubSpot"}
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void disconnectHubspot()}
              disabled={hubspotStatus?.state === "unconfigured"}
              aria-disabled={hubspotBusy}
            >
              Disconnect
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void checkHubspot()}
              disabled={hubspotStatus?.state === "unconfigured"}
              aria-disabled={checkingHubspot}
            >
              {checkingHubspot ? "Checking…" : "Check my setup"}
            </button>
          </div>
          {hubspotCheck ? (
            <div className="banner" role="status">
              <p>
                <strong>Probe:</strong> {hubspotCheck.state} — {hubspotCheck.detail}
              </p>
              {hubspotCheck.items.length > 0 && (
                <ul>
                  {hubspotCheck.items.map((item, idx) => (
                    <li key={idx}>
                      {item.label}: {item.ok ? "ok" : "failed"} — {item.detail}
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted">Checked at {hubspotCheck.checkedAt}</p>
            </div>
          ) : null}
        </div>
        <div className="card" role="group" aria-labelledby="group-guest-profile">
          <h3 id="group-guest-profile">Guest Profile</h3>
          <p className="muted">
            Per-user provider for current role and background. Stores endpoint and API key via
            Shell-credential/Module-call boundary; status shows redacted hint only.
          </p>
          {guestProfileStatus ? (
            <p role="status">
              <strong>Status:</strong> {guestProfileStatus.state}
              {guestProfileStatus.endpoint ? ` · ${guestProfileStatus.endpoint}` : ""}
              {guestProfileStatus.apiKeyHint ? ` (${guestProfileStatus.apiKeyHint})` : ""}
              {guestProfileStatus.lastVerifiedAt
                ? ` — last verified ${guestProfileStatus.lastVerifiedAt}`
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
              value={guestProfileEndpointInput}
              onChange={(event) => setGuestProfileEndpointInput(event.target.value)}
              placeholder="https://profile.example/api"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="guest-profile-key">Guest Profile API key</label>
            <input
              id="guest-profile-key"
              type="password"
              value={guestProfileKeyInput}
              onChange={(event) => setGuestProfileKeyInput(event.target.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
            <p className="muted field-hint">
              Provider supplies current employer evidence; no imported browser session or CAPTCHA
              bypass.
            </p>
          </div>
          {guestProfileError ? (
            <p className="field-error" role="alert">
              {guestProfileError}
            </p>
          ) : null}
          <div className="field-row">
            <button
              type="button"
              className="action-button"
              onClick={() => void connectGuestProfile()}
              disabled={guestProfileEndpointInput.trim() === ""}
              aria-disabled={guestProfileBusy}
            >
              {guestProfileBusy ? "Connecting…" : "Connect Guest Profile"}
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void disconnectGuestProfile()}
              disabled={guestProfileStatus?.state === "unconfigured"}
              aria-disabled={guestProfileBusy}
            >
              Disconnect
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void checkGuestProfile()}
              disabled={guestProfileStatus?.state === "unconfigured"}
              aria-disabled={checkingGuestProfile}
            >
              {checkingGuestProfile ? "Checking…" : "Check my setup"}
            </button>
          </div>
          {guestProfileCheck ? (
            <div className="banner" role="status">
              <p>
                <strong>Probe:</strong> {guestProfileCheck.state} — {guestProfileCheck.detail}
              </p>
              <p className="muted">Checked at {guestProfileCheck.checkedAt}</p>
            </div>
          ) : null}
        </div>
        <div className="card" role="group" aria-labelledby="group-google-meeting-brief">
          <h3 id="group-google-meeting-brief">Google — Calendar, Gmail, Drive</h3>
          <p className="muted">
            Required scopes: calendar.readonly, gmail.readonly, gmail.send, gmail.compose, drive.
            Use Check my setup in the Connections → Google card above to verify scopes and API
            enablement. Calendar channel and sync token are shown below without secrets.
          </p>
          <p role="status" className="muted">
            Google: {googleStatus?.state ?? "loading"}{" "}
            {googleStatus?.email ? `as ${googleStatus.email}` : ""}
          </p>
          {googleCheck ? (
            <ul>
              {googleCheck.items.map((item, idx) => (
                <li key={idx}>
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
            Relay stores only installation, channel, message, expiry and ack metadata; no Calendar
            credentials or event data. See Calendar Relay section above for health/channel/last
            wake-up. Relay health: {relayStatus?.relayHealth ?? "loading"}
            {relayStatus?.lastWakeUpAt
              ? ` · last wake-up ${relayStatus.lastWakeUpAt}`
              : " · no wake-up yet"}
            .
          </p>
        </div>
      </section>
      <section className="settings-section" aria-labelledby="section-youtube">
        <h2 id="section-youtube">YouTube Trends</h2>
        <SpreadsheetCard />
      </section>
    </div>
  );
}
