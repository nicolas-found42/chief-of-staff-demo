import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AppConfig,
  type ConfigUpdate,
  type RedactedConfig,
  type SecretHint,
  ConfigSchema,
  DEFAULT_MODELS,
  DEFAULT_OLLAMA_BASE_URL,
} from "@chief-of-staff-demo/shared";

/** Recursively merge `patch` over `base`; missing keys keep the base value. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined || patch === null) {
    return base;
  }
  if (
    typeof base === "object" && base !== null && !Array.isArray(base) &&
    typeof patch === "object" && patch !== null && !Array.isArray(patch)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      out[key] = deepMerge(out[key], value);
    }
    return out;
  }
  return patch;
}

export function defaultConfig(): AppConfig {
  return {
    provider: "mock",
    model: "",
    apiKey: "",
    tasklistName: "Meeting Followups",
    google: { clientId: "", clientSecret: "", refreshToken: null, lastConnectedAt: null },
    fireflies: { enabled: false, apiKey: "", pollIntervalMinutes: 5 },
    watch: { enabled: false, folderPath: "" },
    ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL },
  };
}

/** Fill in the provider's default model when the stored model is empty. */
function normalize(config: AppConfig): AppConfig {
  return {
    ...config,
    model: config.model === "" ? DEFAULT_MODELS[config.provider] : config.model,
  };
}

export class ConfigStore {
  private config: AppConfig | null = null;

  constructor(private readonly configFile: string) {}

  load(): AppConfig {
    let stored: unknown = {};
    if (existsSync(this.configFile)) {
      try {
        stored = JSON.parse(readFileSync(this.configFile, "utf8"));
      } catch (err) {
        throw new Error(
          `Cannot parse ${this.configFile}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const parsed = ConfigSchema.parse(deepMerge(defaultConfig(), stored));
    this.config = normalize(parsed);
    this.persist();
    return this.config;
  }

  get(): AppConfig {
    if (!this.config) {
      throw new Error("ConfigStore.load() must run before get()");
    }
    return this.config;
  }

  /** Merge a partial update. Absent secret fields keep their stored values. */
  update(patch: ConfigUpdate): AppConfig {
    const merged = deepMerge(this.get(), patch);
    this.config = normalize(ConfigSchema.parse(merged));
    this.persist();
    return this.config;
  }

  /**
   * Stamps `lastConnectedAt` on the way in, because this is the one place a
   * sign-in is recorded. Clearing the token deliberately — switching accounts —
   * leaves the stamp alone: the console work is still done, and it is that fact,
   * not the token, which decides whether the setup steps are still needed.
   */
  setGoogleRefreshToken(token: string | null): void {
    const current = this.get();
    this.config = {
      ...current,
      google: {
        ...current.google,
        refreshToken: token,
        lastConnectedAt: token ? new Date().toISOString() : current.google.lastConnectedAt,
      },
    };
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.configFile), { recursive: true });
    writeFileSync(this.configFile, JSON.stringify(this.get(), null, 2) + "\n", "utf8");
  }
}

export function secretHint(value: string): SecretHint {
  return { set: value.length > 0, hint: value ? `…${value.slice(-4)}` : "" };
}

export function redactConfig(config: AppConfig): RedactedConfig {
  return {
    provider: config.provider,
    model: config.model,
    tasklistName: config.tasklistName,
    apiKey: secretHint(config.apiKey),
    google: {
      clientId: config.google.clientId,
      clientSecret: secretHint(config.google.clientSecret),
    },
    fireflies: {
      enabled: config.fireflies.enabled,
      apiKey: secretHint(config.fireflies.apiKey),
      pollIntervalMinutes: config.fireflies.pollIntervalMinutes,
    },
    watch: {
      enabled: config.watch.enabled,
      folderPath: config.watch.folderPath,
    },
    ollama: {
      baseUrl: config.ollama.baseUrl,
    },
  };
}
