import { useCallback, useEffect, useState } from "react";
import type { AppClient } from "../api/client";
import { isProtocolCompatible } from "../api/client";
import type { ConfigResponse } from "@chief-of-staff/contracts";

export function SettingsPage({
  client,
  serviceInfo,
}: {
  client: AppClient;
  serviceInfo: { version: string; protocol: number } | null;
}) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState("");

  const refresh = useCallback(async () => {
    try {
      const value = await client.getConfig();
      setConfig(value);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    setOrigin(window.location.origin);
    void refresh();
  }, [refresh]);

  return (
    <section className="page" aria-labelledby="settings-heading">
      <h1 id="settings-heading">Settings</h1>
      {error && <p className="bad">{error}</p>}
      <div className="card">
        <h2>Connection diagnostics</h2>
        <dl className="kv">
          <dt>Service URL</dt>
          <dd>{client.getBaseUrl()}</dd>
          <dt>UI origin</dt>
          <dd>{origin}</dd>
          <dt>Paired</dt>
          <dd>{client.token ? "yes" : "no"}</dd>
          <dt>Service version</dt>
          <dd>
            {serviceInfo ? serviceInfo.version : "unknown"}
            {serviceInfo && !isProtocolCompatible({ protocolVersion: serviceInfo.protocol, serviceVersion: serviceInfo.version, workspace: { status: "ready" }, pairing: { available: false } }) ? (
              <span className="bad"> (incompatible protocol)</span>
            ) : null}
          </dd>
          <dt>Protocol</dt>
          <dd>{serviceInfo ? serviceInfo.protocol : "unknown"}</dd>
        </dl>
      </div>
      <div className="card">
        <h2>Configuration</h2>
        {config ? (
          <dl className="kv">
            <dt>Provider</dt>
            <dd>{config.models.provider}</dd>
            <dt>Model</dt>
            <dd>{config.models.model}</dd>
            <dt>Reasoning effort</dt>
            <dd>{config.models.reasoningEffort ?? "default"}</dd>
            <dt>Max parallel tasks</dt>
            <dd>{config.app.maxParallelTasks}</dd>
            <dt>Watch debounce (ms)</dt>
            <dd>{config.app.watchDebounceMs}</dd>
            <dt>Max transcript bytes</dt>
            <dd>{config.app.maxTranscriptBytes}</dd>
            <dt>Allowed UI origins</dt>
            <dd>{config.app.allowedUiOrigins.join(", ")}</dd>
            <dt>OpenRouter key</dt>
            <dd>{config.openRouterConfigured ? "configured" : "not configured"}</dd>
          </dl>
        ) : (
          <p className="muted">Pair with the service to see configuration.</p>
        )}
      </div>
      <div className="card">
        <h2>Data handling</h2>
        <p>
          Live runs send transcript-derived content and the workflow prompts to OpenRouter and
          the model provider selected by OpenRouter. No other application data is sent remotely.
          Drafts, plans, tasks, tracking rows, and notifications are stored only as local files
          in the workspace on your machine. The OpenRouter API key exists only in the service
          process environment and is never displayed here.
        </p>
      </div>
    </section>
  );
}
