import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ProviderId, SetupCheck } from "@chief-of-staff-demo/shared";
import { api, errorMessage, type ConfigPayload } from "../client";
import { GoogleConnect } from "../components/GoogleConnect";
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
    const model = form.model === "" || previousDefault ? defaults[provider] ?? "" : form.model;
    setForm((current) => (current ? { ...current, provider, model } : current));
    // Changing Provider rewrites a field the user did not touch. Sighted users
    // watch it happen; everyone else needs it said (WCAG 3.2.2).
    setModelNotice(
      model === form.model ? "" : model ? `Model changed to ${model}.` : "Model cleared."
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
          : current
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
        })
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
        "That is not a Web application client. Create the client with application type Web application, then download its JSON."
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
              Where Ollama listens. Use http://host.docker.internal:11434 when this app runs in
              a container and Ollama runs on the host. No API key needed.
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
        payload.config.google.clientSecret.hint
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
            const scopes = missing ? missing.split(",").map((s) => s.trim()).filter(Boolean) : [];
            const labelMap: Record<string, string> = {
              "https://www.googleapis.com/auth/tasks": "Google Tasks",
              "https://www.googleapis.com/auth/gmail.compose": "Gmail drafts",
              "https://www.googleapis.com/auth/drive": "Google Drive",
              tasks: "Google Tasks",
              "gmail.compose": "Gmail drafts",
              drive: "Google Drive",
              "drive.readonly": "Google Drive",
            };
            const labels = scopes.map((s) => labelMap[s] ?? s);
            const labelText = labels.length ? labels.join(", ") : "a required permission";
            return `Google did not grant ${labelText}. Sign in again and leave all three permissions ticked.`;
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
            Google refused the sign-in because the redirect URI registered on your OAuth client
            does not match this app&apos;s. Copy the correct value and paste it into your
            client&apos;s Authorized redirect URIs exactly as-is, then sign in again.
          </span>
          <button
            type="button"
            className="action-button"
            onClick={() => {
              void navigator.clipboard.writeText(googleStatus?.redirectUri ?? "").then(
                () => setCopiedCorrectUri(true),
                () => setCopiedCorrectUri(false)
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
        {/* Each card is a labelled group so same-named fields stay
            distinguishable to anyone navigating by form control (1.3.1). */}
        <section className="settings-section" aria-labelledby="section-connections">
          <h2 id="section-connections">Connections</h2>

          <div className="card" role="group" aria-labelledby="group-google">
            <h3 id="group-google">Google</h3>
            {googleSettled ? (
              <>
                <p className="connection-summary" role="status">
                  <span className="ok">Connected</span>
                  {googleStatus?.email ? ` as ${googleStatus.email}` : ""}
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
          <div className="card" role="group" aria-labelledby="group-drive">
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
            <p className="muted">Transcripts are read from a single Google Drive folder. Pick the folder your transcript service writes to, then enable polling.</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="drive-folder">Drive folder</label>
              <div className="field-row">
                <input
                  id="drive-folder"
                  aria-describedby="drive-folder-hint"
                  value={form.driveFolderName ? `${form.driveFolderName} (${form.driveFolderId})` : form.driveFolderId}
                  placeholder="No folder chosen"
                  readOnly
                />
                <button
                  type="button"
                  className="action-button"
                  onClick={() => void chooseFolder()}
                  disabled={googleStatus?.state !== "connected" || picking}
                  aria-describedby={googleStatus?.state !== "connected" ? "drive-picker-disabled-hint" : undefined}
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
                The picker shows your Drive folders — no folder ID to copy. Requires Google Drive access; sign in again after enabling the Drive API.
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
            <button type="button" className="action-button" onClick={syncDrive} aria-disabled={syncing}>
              Sync now
            </button>
            <span role="status">{syncResult && <span className="ok">{syncResult}</span>}</span>
          </div>
          <p className="muted">
            Supported: .txt, .md, .json, .jsonc, .pdf, .docx, and native Google Docs (exported as text). Other files are ignored.
          </p>
        </div>
        </section>

        <div className="field-row">
          <button type="submit" className="primary action-button" aria-disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </div>
  );
}
