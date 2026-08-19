import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { GoogleStatus, ProviderId } from "@chief-of-staff-demo/shared";
import { api, errorMessage, type ConfigPayload } from "../client";
import { GoogleConnect } from "../components/GoogleConnect";
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

interface FormState {
  provider: ProviderId;
  model: string;
  apiKey: string;
  tasklistName: string;
  googleClientId: string;
  googleClientSecret: string;
  firefliesApiKey: string;
  firefliesEnabled: boolean;
  /* Held as the raw string so clearing the field doesn't silently coerce to 0. */
  pollIntervalMinutes: string;
  watchEnabled: boolean;
  folderPath: string;
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
  const [saving, setSaving] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [modelNotice, setModelNotice] = useState("");
  const [googleStatus, setGoogleStatus] = useState<GoogleStatus | null>(null);
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
          firefliesApiKey: "",
          firefliesEnabled: fetched.config.fireflies.enabled,
          pollIntervalMinutes: String(fetched.config.fireflies.pollIntervalMinutes),
          watchEnabled: fetched.config.watch.enabled,
          folderPath: fetched.config.watch.folderPath,
          ollamaBaseUrl: fetched.config.ollama.baseUrl,
        });
      } catch (err) {
        setError(errorMessage(err));
      }
    };
    void load();
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        setGoogleStatus(await api.googleStatus());
      } catch {
        setGoogleStatus(null);
      }
    };
    void load();
  }, [payload]);

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
        fireflies: {
          enabled: form.firefliesEnabled,
          pollIntervalMinutes: Number(form.pollIntervalMinutes),
        },
        watch: { enabled: form.watchEnabled, folderPath: form.folderPath },
        ollama: { baseUrl: form.ollamaBaseUrl },
      };
      if (form.apiKey !== "") {
        update.apiKey = form.apiKey;
      }
      if (form.googleClientSecret !== "") {
        update.google = { clientId: form.googleClientId, clientSecret: form.googleClientSecret };
      }
      if (form.firefliesApiKey !== "") {
        update.fireflies = {
          enabled: form.firefliesEnabled,
          apiKey: form.firefliesApiKey,
          pollIntervalMinutes: Number(form.pollIntervalMinutes),
        };
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
              ollamaBaseUrl: savedPayload.config.ollama.baseUrl,
              apiKey: "",
              googleClientSecret: "",
              firefliesApiKey: "",
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
    try {
      setGoogleStatus(await api.googleDisconnect());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDisconnecting(false);
    }
  };

  const syncFireflies = async () => {
    if (syncing) {
      return;
    }
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      const { created } = await api.firefliesSync();
      setSyncResult(`Synced — ${created} new transcript(s) started.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  // Persistent hint text rather than a placeholder: this is the instruction
  // that stops someone from wiping a stored secret, and placeholders vanish
  // on the first keystroke (3.3.2).
  const secretHint = (set: boolean, hint: string) =>
    set ? `Stored (${hint}). Leave blank to keep it.` : "No value stored yet.";

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
      {googleBanner === "error" && (
        <div className="banner banner-error" role="alert">
          Google connection failed — try again.
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
        {/* Each card is a labelled group so the two "API key" fields are
            distinguishable to anyone navigating by form control (1.3.1). */}
        <div className="card" role="group" aria-labelledby="group-provider">
          <h2 id="group-provider">Extraction provider</h2>
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
                aria-describedby="api-key-hint"
                type="password"
                value={form.apiKey}
                autoComplete="off"
                onChange={(event) => setField("apiKey", event.target.value)}
              />
              <p id="api-key-hint" className="muted field-hint">
                {secretHint(payload.config.apiKey.set, payload.config.apiKey.hint)}
              </p>
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
        </div>

        <div className="card" role="group" aria-labelledby="group-google">
          <h2 id="group-google">Google</h2>
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
            signingIn={signingIn}
            disconnecting={disconnecting}
          />
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
        </div>

        <div className="card" role="group" aria-labelledby="group-fireflies">
          <h2 id="group-fireflies">Fireflies</h2>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="fireflies-api-key">Fireflies API key</label>
              <input
                id="fireflies-api-key"
                aria-describedby="fireflies-api-key-hint"
                type="password"
                value={form.firefliesApiKey}
                autoComplete="off"
                onChange={(event) => setField("firefliesApiKey", event.target.value)}
              />
              <p id="fireflies-api-key-hint" className="muted field-hint">
                {secretHint(
                  payload.config.fireflies.apiKey.set,
                  payload.config.fireflies.apiKey.hint
                )}
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
                checked={form.firefliesEnabled}
                onChange={(event) => setField("firefliesEnabled", event.target.checked)}
              />
              Enable polling
            </label>
          </div>
          <div className="field-row">
            <button type="button" onClick={syncFireflies} aria-disabled={syncing}>
              Sync now
            </button>
            <span role="status">{syncResult && <span className="ok">{syncResult}</span>}</span>
          </div>
        </div>

        <div className="card" role="group" aria-labelledby="group-watch">
          <h2 id="group-watch">Watch folder</h2>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="folder-path">Folder path</label>
              <input
                id="folder-path"
                aria-describedby="folder-path-hint"
                value={form.folderPath}
                placeholder="/absolute/path/to/folder"
                onChange={(event) => setField("folderPath", event.target.value)}
              />
              <p id="folder-path-hint" className="muted field-hint">
                An absolute path, for example /Users/you/Transcripts.
              </p>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.watchEnabled}
                onChange={(event) => setField("watchEnabled", event.target.checked)}
              />
              Enable folder watch
            </label>
          </div>
          <p className="muted">
            Stable files are moved into workspace/watch-archive/ first, then processed — the move is
            the dedupe.
          </p>
        </div>

        <div className="field-row">
          <button type="submit" className="primary" aria-disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </div>
  );
}
