import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ProviderId } from "@transcript-tasks/shared";
import { api, errorMessage, type ConfigPayload } from "../client";

const PROVIDER_OPTIONS: { value: ProviderId; label: string }[] = [
  { value: "mock", label: "mock (test/demo — reads workspace/mock-result.json)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "gemini", label: "Google Gemini" },
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
  pollIntervalMinutes: number;
  watchEnabled: boolean;
  folderPath: string;
}

export function SettingsPage() {
  const [payload, setPayload] = useState<ConfigPayload | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [googleConnected, setGoogleConnected] = useState(false);
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
          pollIntervalMinutes: fetched.config.fireflies.pollIntervalMinutes,
          watchEnabled: fetched.config.watch.enabled,
          folderPath: fetched.config.watch.folderPath,
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
        const status = await api.googleStatus();
        setGoogleConnected(status.connected);
        setGoogleEmail(status.email);
      } catch {
        setGoogleConnected(false);
        setGoogleEmail(null);
      }
    };
    void load();
  }, [payload]);

  if (!form || !payload) {
    return (
      <div className="page">
        <h1>Settings</h1>
        {error ? <div className="banner banner-error">{error}</div> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const googleBanner = searchParams.get("google");

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  const changeProvider = (provider: ProviderId) => {
    setForm((current) => {
      if (!current) {
        return current;
      }
      const defaults = payload.defaults;
      const previousDefault = Object.values(defaults).includes(current.model);
      const model = current.model === "" || previousDefault ? defaults[provider] ?? "" : current.model;
      return { ...current, provider, model };
    });
    setSaved(false);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const update: Record<string, unknown> = {
        provider: form.provider,
        model: form.model,
        tasklistName: form.tasklistName,
        google: { clientId: form.googleClientId },
        fireflies: {
          enabled: form.firefliesEnabled,
          pollIntervalMinutes: form.pollIntervalMinutes,
        },
        watch: { enabled: form.watchEnabled, folderPath: form.folderPath },
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
          pollIntervalMinutes: form.pollIntervalMinutes,
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
      setBusy(false);
    }
  };

  const connectGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      const { authUrl } = await api.googleConnect();
      window.location.assign(authUrl);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const syncFireflies = async () => {
    setBusy(true);
    setSyncResult(null);
    setError(null);
    try {
      const { created } = await api.firefliesSync();
      setSyncResult(`Synced — ${created} new transcript(s) started.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const secretPlaceholder = (set: boolean, hint: string) =>
    set ? `stored (${hint}) — leave blank to keep` : "not set";

  return (
    <div className="page">
      <h1>Settings</h1>

      {googleBanner === "connected" && (
        <div className="banner banner-ok">Google connected.</div>
      )}
      {googleBanner === "error" && (
        <div className="banner banner-error">Google connection failed — try again.</div>
      )}
      {error && <div className="banner banner-error">{error}</div>}
      {saved && <div className="banner banner-ok">Saved.</div>}

      <div className="card">
        <h2>Extraction provider</h2>
        <div className="form-grid">
          <label>
            Provider
            <select
              value={form.provider}
              onChange={(event) => changeProvider(event.target.value as ProviderId)}
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <input
              value={form.model}
              placeholder={payload.defaults[form.provider] || "model id"}
              onChange={(event) => setField("model", event.target.value)}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              value={form.apiKey}
              autoComplete="off"
              placeholder={secretPlaceholder(payload.config.apiKey.set, payload.config.apiKey.hint)}
              onChange={(event) => setField("apiKey", event.target.value)}
            />
          </label>
        </div>
        {form.provider === "mock" && (
          <p className="muted">
            Mock mode returns workspace/mock-result.json (or a skip stub when absent) — useful for
            demos and tests. No API key needed.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Google</h2>
        <div className="form-grid">
          <label>
            OAuth client ID
            <input
              value={form.googleClientId}
              onChange={(event) => setField("googleClientId", event.target.value)}
            />
          </label>
          <label>
            OAuth client secret
            <input
              type="password"
              value={form.googleClientSecret}
              autoComplete="off"
              placeholder={secretPlaceholder(
                payload.config.google.clientSecret.set,
                payload.config.google.clientSecret.hint
              )}
              onChange={(event) => setField("googleClientSecret", event.target.value)}
            />
          </label>
          <label>
            Task list name
            <input
              value={form.tasklistName}
              onChange={(event) => setField("tasklistName", event.target.value)}
            />
          </label>
        </div>
        <div className="field-row">
          <span>
            {googleConnected ? (
              <>
                <span className="ok">Connected</span>
                {googleEmail ? ` as ${googleEmail}` : ""}
              </>
            ) : (
              <span className="muted">Not connected</span>
            )}
          </span>
          <button onClick={connectGoogle} disabled={busy}>
            Connect Google
          </button>
        </div>
        <p className="muted">
          Redirect URI to register: <code>http://localhost:4317/api/google/callback</code>. Tasks go
          to the task list above; drafts land in Gmail Drafts and are never sent.
        </p>
      </div>

      <div className="card">
        <h2>Fireflies</h2>
        <div className="form-grid">
          <label>
            API key
            <input
              type="password"
              value={form.firefliesApiKey}
              autoComplete="off"
              placeholder={secretPlaceholder(
                payload.config.fireflies.apiKey.set,
                payload.config.fireflies.apiKey.hint
              )}
              onChange={(event) => setField("firefliesApiKey", event.target.value)}
            />
          </label>
          <label>
            Poll interval (minutes)
            <input
              type="number"
              min={1}
              value={form.pollIntervalMinutes}
              onChange={(event) => setField("pollIntervalMinutes", Number(event.target.value))}
            />
          </label>
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
          <button onClick={syncFireflies} disabled={busy}>
            Sync now
          </button>
          {syncResult && <span className="ok">{syncResult}</span>}
        </div>
      </div>

      <div className="card">
        <h2>Watch folder</h2>
        <div className="form-grid">
          <label>
            Folder path
            <input
              value={form.folderPath}
              placeholder="/absolute/path/to/folder"
              onChange={(event) => setField("folderPath", event.target.value)}
            />
          </label>
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
        <button className="primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
