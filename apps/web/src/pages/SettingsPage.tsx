import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  MODEL_PURPOSES,
  type AppConfig,
  type DriveIntakeStatus,
  type InstallationStatus,
  type ProviderId,
  type SetupCheck,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import {
  configApi,
  googleApi,
  intakeApi,
  type ConfigPayload,
  type TranscriptIntakeInventory,
} from "../clients/workspace";
import { GoogleConnect } from "../components/GoogleConnect";
import { OwnerOnboardingCard } from "../components/OwnerOnboardingCard";
import { MeetingBriefSettings } from "../components/MeetingBriefSettings";
import { SpreadsheetCard } from "../modules/youtube/SpreadsheetCard";
import { pickDriveFolder } from "../googlePicker";
import { ClearGeneratedDataCard } from "../components/ClearGeneratedDataCard";
import { useGoogleConnection } from "../useGoogleConnection";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/* Issue #198: the cloud providers a customer chooses between, with OpenRouter
   first because it is the recommendation — one key reaches models from many
   providers. Ollama is offered under Advanced local-model settings below, and
   mock only where the server admits it: tests and explicit demo mode. */
const PROVIDER_OPTIONS: { value: ProviderId; label: string }[] = [
  { value: "openrouter", label: "OpenRouter (recommended)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
];
const MOCK_OPTION = {
  value: "mock",
  label: "mock (test/demo — reads workspace/mock-result.json)",
} as const;
const OLLAMA_OPTION = { value: "ollama", label: "Ollama (local model)" } as const;

/** Compact one-word names for the settled-connection line (D11). */
const PROVIDER_SHORT: Record<ProviderId, string> = {
  mock: "Mock",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
  ollama: "Ollama",
};

type InstallationProvider = Exclude<ProviderId, "mock" | "ollama">;

function providerCredentialState(
  installation: InstallationStatus,
  provider: ProviderId,
): InstallationStatus["providerKeys"][InstallationProvider]["state"] | "not-required" {
  if (provider === "mock" || provider === "ollama") return "not-required";
  return installation.providerKeys[provider as InstallationProvider].state;
}

interface FormState {
  provider: ProviderId;
  model: string;
  models: NonNullable<AppConfig["models"]>;
  tasklistName: string;
  driveEnabled: boolean;
  driveFolderId: string;
  driveFolderName: string;
  /* Held as the raw string so clearing the field doesn't silently coerce to 0. */
  pollIntervalMinutes: string;
  ollamaBaseUrl: string;
  searxngUrl: string;
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
  /* Folder consent (ADR-0001): the Catalog refuses to read a single file until
     it is granted, and until this card existed there was no way to grant it —
     "Sync now" simply failed with the refusal. */
  const [intake, setIntake] = useState<DriveIntakeStatus | null>(null);
  const [inventory, setInventory] = useState<TranscriptIntakeInventory | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const location = useLocation();

  useEffect(() => {
    const load = async () => {
      try {
        const fetched = await configApi.getConfig();
        setPayload(fetched);
        setForm({
          provider: fetched.config.provider,
          model: fetched.config.model,
          models: fetched.config.models ?? {},
          tasklistName: fetched.config.tasklistName,
          driveEnabled: fetched.config.drive.enabled,
          driveFolderId: fetched.config.drive.folderId,
          driveFolderName: fetched.config.drive.folderName,
          pollIntervalMinutes: String(fetched.config.drive.pollIntervalMinutes),
          ollamaBaseUrl: fetched.config.ollama.baseUrl,
          searxngUrl: fetched.config.search.searxngUrl ?? "",
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

  /* Setup links name the exact control they need. The target appears after the
     config load; opening any containing disclosure first makes both settled
     and unconfigured provider states reachable without another click. */
  const deepLinkHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!form || !payload) return;
    const hash = location.hash;
    if (deepLinkHandled.current === hash) return;
    const id = hash.slice(1);
    const target = id ? document.getElementById(decodeURIComponent(id)) : null;
    if (!target) return;
    deepLinkHandled.current = hash;
    for (
      let disclosure = target.closest<HTMLDetailsElement>("details");
      disclosure;
      disclosure = disclosure.parentElement?.closest<HTMLDetailsElement>("details") ?? null
    ) {
      disclosure.open = true;
    }
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
    if (target.matches("a[href], button, input, select, textarea, [tabindex]")) {
      target.focus({ preventScroll: true });
    }
  }, [form, payload, location.hash, intake]);

  /* Above the loading gate: hooks cannot sit behind an early return. */
  const loadIntake = useCallback(() => {
    void intakeApi
      .driveIntakeStatus()
      .then(setIntake)
      .catch(() => setIntake(null));
  }, []);
  useEffect(() => loadIntake(), [loadIntake]);

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
    if (
      provider !== "ollama" &&
      provider !== "mock" &&
      providerCredentialState(payload.installation, provider) !== "configured"
    ) {
      setError("Choose a provider whose installation credential is configured, or use Ollama.");
      return;
    }
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
        models: form.models,
        tasklistName: form.tasklistName,
        drive: {
          enabled: form.driveEnabled,
          folderId: form.driveFolderId,
          folderName: form.driveFolderName,
          pollIntervalMinutes: Number(form.pollIntervalMinutes),
        },
        ollama: { baseUrl: form.ollamaBaseUrl },
        // Always sent, empty string included: unlike an omitted field this
        // also clears a stored URL, matching how the Ollama field behaves.
        search: { searxngUrl: form.searxngUrl },
      };
      const savedPayload = await configApi.saveConfig(update);
      setPayload(savedPayload);
      setForm((current) =>
        current
          ? {
              ...current,
              provider: savedPayload.config.provider,
              model: savedPayload.config.model,
              models: savedPayload.config.models ?? {},
              tasklistName: savedPayload.config.tasklistName,
              driveEnabled: savedPayload.config.drive.enabled,
              driveFolderId: savedPayload.config.drive.folderId,
              driveFolderName: savedPayload.config.drive.folderName,
              pollIntervalMinutes: String(savedPayload.config.drive.pollIntervalMinutes),
              ollamaBaseUrl: savedPayload.config.ollama.baseUrl,
              searxngUrl: savedPayload.config.search.searxngUrl ?? "",
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

  const signInGoogle = async () => {
    if (signingIn) return;
    setSigningIn(true);
    setError(null);
    try {
      const { authUrl } = await googleApi.connect();
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
      await googleApi.disconnect();
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
      const result = await googleApi.check();
      setGoogleCheck(result);
      await refreshGoogle();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCheckingGoogle(false);
    }
  };

  /** The pre-consent disclosure: read the folder listing, never a file. */
  const reviewFolder = async () => {
    setConsentBusy(true);
    setConsentError(null);
    try {
      setInventory(await intakeApi.transcriptIntakeInventory());
    } catch (err) {
      setConsentError(errorMessage(err));
    } finally {
      setConsentBusy(false);
    }
  };

  const grantConsent = async () => {
    setConsentBusy(true);
    setConsentError(null);
    try {
      await intakeApi.grantTranscriptIntakeConsent();
      setInventory(null);
      loadIntake();
    } catch (err) {
      setConsentError(errorMessage(err));
    } finally {
      setConsentBusy(false);
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
      const { processed } = await intakeApi.driveSync();
      setSyncResult(`Synced — ${processed} new transcript(s) catalogued.`);
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
      const { token } = await googleApi.pickerToken();
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

  /* Installation credentials are provisioned by the local operator; this page
     only reports their state and never offers an editable value. */

  /* Render the polling state from the last saved config, not the stale intake
     response. Catalog consent and backfill are independent facts below. */
  const savedPollingEnabled = payload.config.drive.enabled;
  const savedPollingFolder =
    payload.config.drive.folderName || intake?.folderName || "your Drive folder";
  const savedPollingMinutes = payload.config.drive.pollIntervalMinutes;
  const savedPollingSummary = savedPollingEnabled
    ? `Automatic Drive polling is enabled for ${savedPollingFolder} every ${savedPollingMinutes} ${
        savedPollingMinutes === 1 ? "minute" : "minutes"
      } when Google is connected.`
    : "Automatic Drive polling is paused. New transcripts are not checked for automatically.";
  const backfillSummary =
    intake?.catalog.backfill === "running"
      ? "Catalog backfill is catching up…"
      : intake?.catalog.backfill === "paused"
        ? "Catalog backfill is paused."
        : null;

  const installation = payload.installation;
  const availableProviders = PROVIDER_OPTIONS.filter(
    (option) => providerCredentialState(installation, option.value) === "configured",
  );
  const providerOptions = [
    ...availableProviders,
    ...(payload.mockAvailable || form.provider === "mock" ? [MOCK_OPTION] : []),
    OLLAMA_OPTION,
  ];

  const googleSettled = googleStatus?.state === "connected";
  const installationCard = (
    <section id="api-key" tabIndex={-1} className="card" aria-labelledby="api-key-heading">
      <h3 id="api-key-heading">Installation credentials</h3>
      <dl>
        <dt>Google OAuth client</dt>
        <dd>{installation.googleClient.state === "configured" ? "Configured" : "Missing"}</dd>
        {PROVIDER_OPTIONS.map((option) => (
          <div key={option.value}>
            <dt>{PROVIDER_SHORT[option.value]} key</dt>
            <dd>
              {providerCredentialState(installation, option.value) === "configured"
                ? "Configured"
                : "Missing"}
            </dd>
          </div>
        ))}
        <dt>Ollama</dt>
        <dd>Not required</dd>
      </dl>
      <p className="muted">
        Installation credentials are held by the local Guided Setup, not editable Workspace
        configuration. Run <code>./scripts/setup-wizard.sh</code> to provision or resume them.
      </p>
      <Link className="action-button" to="/onboarding?goal=meetings">
        Open Guided Setup
      </Link>
    </section>
  );

  const providerFields = () => (
    <>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="provider">Provider</label>
          <select
            id="provider"
            value={form.provider}
            onChange={(event) => changeProvider(event.target.value as ProviderId)}
          >
            {providerOptions.map((option) => (
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
        <details className="disclosure">
          <summary>Advanced: choose models per task</summary>
          <div className="disclosure-body">
            <fieldset>
              <legend>Models by purpose</legend>
              <p className="muted">
                These models use the selected provider and its installation credential. Leave a
                field blank to use the default model above.{" "}
              </p>
              {Object.entries(MODEL_PURPOSES).map(([purpose, label]) => (
                <div className="field" key={purpose}>
                  <label htmlFor={`model-${purpose}`}>{label}</label>
                  <input
                    id={`model-${purpose}`}
                    value={
                      form.models[form.provider]?.[purpose as keyof typeof MODEL_PURPOSES] ?? ""
                    }
                    placeholder={form.model || payload.defaults[form.provider]}
                    onChange={(event) =>
                      setField("models", {
                        ...form.models,
                        [form.provider]: {
                          ...form.models[form.provider],
                          [purpose]: event.target.value,
                        },
                      })
                    }
                  />
                  {purpose === "researchPlanning" && (
                    <p className="muted field-hint">
                      Plans each further batch of person research from the evidence collected so
                      far.
                    </p>
                  )}
                  {purpose === "evaluationJudge" && (
                    <p className="muted field-hint">
                      Judges the developer Person Research Benchmark. Keep it independent of the
                      research model so the judge is not marking its own work.
                    </p>
                  )}
                </div>
              ))}
            </fieldset>
          </div>
        </details>
      </div>
      {/* Local models are a deliberate, advanced choice (issue #198): they
          never crowd the first-run decision between cloud providers. */}
      <details className="disclosure" open={form.provider === "ollama"}>
        <summary>Advanced local-model settings</summary>
        <div className="disclosure-body">
          <p className="muted">
            Run extraction on a local Ollama server instead of a cloud provider — transcripts never
            leave this machine, and no API key is needed.
          </p>
          {form.provider !== "ollama" && (
            <div className="field-row">
              <button
                type="button"
                className="action-button"
                onClick={() => changeProvider("ollama")}
              >
                Use Ollama (local model)
              </button>
            </div>
          )}
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
        </div>
      </details>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="searxng-url">SearXNG URL</label>
          <input
            id="searxng-url"
            aria-describedby="searxng-url-hint"
            value={form.searxngUrl}
            placeholder="http://searxng:8080"
            onChange={(event) => setField("searxngUrl", event.target.value)}
          />
          <p id="searxng-url-hint" className="muted field-hint">
            Base URL of a self-hosted SearXNG instance. Leave empty to search without it. Use
            http://searxng:8080 when this app runs in the compose stack, or http://127.0.0.1:8080
            when both run on the host. No API key needed.
          </p>
        </div>
      </div>
      {form.provider === "mock" && (
        <p className="muted">
          Mock mode returns workspace/mock-result.json (or a skip stub when absent) — useful for
          demos and tests. No API key needed.
        </p>
      )}
    </>
  );

  const googleCard = (
    <GoogleConnect
      status={googleStatus}
      installationConfigured={installation.googleClient.state === "configured"}
      onSignIn={() => void signInGoogle()}
      onDisconnect={() => void disconnectGoogle()}
      onCheck={() => void checkGoogle()}
      check={googleCheck}
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
            <h3 id="group-google" tabIndex={-1}>
              Google
            </h3>
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
              googleCard
            )}
          </div>

          {/* Owner onboarding (issue #123): identity proposal and confirmation. */}
          <OwnerOnboardingCard googleConnectionState={googleStatus?.state ?? null} />
          <div id="guided-setup" tabIndex={-1}>
            <div className="card" role="group" aria-labelledby="group-provider">
              <h3 id="group-provider">Extraction provider</h3>
              {installationCard}
              {providerFields()}
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="section-tuning">
          <h2 id="section-tuning">Transcript intake</h2>
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
              <div className="field">
                <label className="checkbox-label" htmlFor="drive-polling">
                  <input
                    id="drive-polling"
                    type="checkbox"
                    checked={form.driveEnabled}
                    onChange={(event) => setField("driveEnabled", event.target.checked)}
                  />
                  Enable Drive polling
                </label>
              </div>
            </div>
            <p className="muted" role="status">
              {intake?.catalog.consent
                ? `${savedPollingSummary} ${intake.catalog.transcriptCount} transcript${
                    intake.catalog.transcriptCount === 1 ? "" : "s"
                  } ${savedPollingEnabled ? "catalogued" : "already catalogued"}. You gave permission to read ${
                    intake.catalog.consent.folderName
                  } on ${new Date(intake.catalog.consent.consentedAt).toLocaleDateString()}.`
                : `Drive polling is ${
                    savedPollingEnabled ? "enabled" : "paused"
                  }, but reading this folder still needs your permission. Nothing will be read until you allow it.`}
              {backfillSummary ? ` ${backfillSummary}` : ""}
            </p>
            <div className="field-row">
              <button
                id="transcript-sync"
                type="button"
                className="action-button"
                onClick={() => void syncDrive()}
                aria-disabled={syncing}
              >
                Sync now
              </button>
              <span className="muted">Sync now runs one manual pass.</span>
              <span role="status">{syncResult && <span className="ok">{syncResult}</span>}</span>
            </div>

            {/* Consent, and what it covers. The Catalog reads nothing from the
                folder until this is granted; before this card the only way to
                grant it was an API call, so the whole Debrief half of the
                Meeting Wizard was unreachable from the app. */}
            {intake?.catalog.consent ? (
              <span id="transcript-consent" className="visually-hidden" tabIndex={-1} />
            ) : null}
            {intake?.catalog.consent ? null : (
              <div className="card" id="transcript-consent" tabIndex={-1}>
                <h3>Reading this folder needs your permission</h3>
                <p className="muted">
                  Transcripts are read from Drive, kept locally, and sent to your configured model
                  to be summarised. Nothing is read until you allow it.
                </p>
                {consentError && (
                  <p className="banner-error" role="alert">
                    {consentError}
                  </p>
                )}
                {inventory ? (
                  <>
                    <p>
                      <strong>{inventory.fileCount}</strong> file
                      {inventory.fileCount === 1 ? "" : "s"} in{" "}
                      <strong>{inventory.folder.folderName}</strong>
                      {inventory.dateRange?.earliest && inventory.dateRange.latest
                        ? `, from ${inventory.dateRange.earliest} to ${inventory.dateRange.latest}`
                        : ""}{" "}
                      ({Math.round(inventory.estimatedScope.totalBytes / 1024)} KB).
                    </p>
                    <p className="muted">{inventory.localRetention}</p>
                    {inventory.providerExposure.sendsTranscriptTextToConfiguredModel && (
                      <p className="muted">
                        Transcript text is sent to {inventory.providerExposure.provider} (
                        {inventory.providerExposure.model}).
                      </p>
                    )}
                    <div className="field-row">
                      <button
                        type="button"
                        className="primary action-button"
                        onClick={() => void grantConsent()}
                        aria-disabled={consentBusy}
                      >
                        {consentBusy
                          ? "Starting…"
                          : `Allow and read ${inventory.fileCount} transcript${
                              inventory.fileCount === 1 ? "" : "s"
                            }`}
                      </button>
                      <button
                        type="button"
                        className="action-button"
                        onClick={() => setInventory(null)}
                        aria-disabled={consentBusy}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    className="action-button"
                    onClick={() => void reviewFolder()}
                    aria-disabled={consentBusy}
                  >
                    {consentBusy ? "Reading folder…" : "See what this covers"}
                  </button>
                )}
              </div>
            )}
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

      <MeetingBriefSettings googleStatus={googleStatus} googleCheck={googleCheck} />
      <section className="settings-section" aria-labelledby="section-youtube">
        <h2 id="section-youtube">YouTube Trends</h2>
        <SpreadsheetCard />
      </section>

      <section className="settings-section" aria-labelledby="section-diagnostics">
        <h2 id="section-diagnostics">Diagnostics</h2>
        <div className="card">
          <p className="muted">
            The technical record of every run, kept for diagnosis. Product surfaces link to the
            surface that owns a result; this list is the way back to the run behind it.
          </p>
          <p>
            <Link to="/runs" className="action-button">
              View all runs
            </Link>
          </p>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="section-danger">
        <h2 id="section-danger">Danger zone</h2>
        <ClearGeneratedDataCard />
      </section>
    </div>
  );
}
