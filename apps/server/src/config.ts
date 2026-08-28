import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AppConfig,
  type ConfigUpdate,
  type ModuleConfigs,
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
    typeof base === "object" &&
    base !== null &&
    !Array.isArray(base) &&
    typeof patch === "object" &&
    !Array.isArray(patch)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      out[key] = deepMerge(out[key], value);
    }
    return out;
  }
  return patch;
}

function defaultConfig(): AppConfig {
  return {
    provider: "mock",
    model: "",
    apiKey: "",
    tasklistName: "Meeting Followups",
    google: {
      clientId: "",
      clientSecret: "",
      refreshToken: null,
      lastConnectedAt: null,
      hasExpiredBefore: false,
    },
    notion: { token: "", lastVerifiedAt: null },
    drive: { enabled: false, folderId: "", folderName: "", pollIntervalMinutes: 2 },
    ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL },
    modules: {
      "youtube-trends": { channels: [], spreadsheetId: "", spreadsheetUrl: "" },
      "idea-engine": { spreadsheetId: "", spreadsheetUrl: "", prompts: {} },
      "content-scout": {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dailyTime: "08:00",
        weeklyDiscoveryDay: 1,
        weeklyDiscoveryTime: "09:00",
        shortlistSize: 5,
        notion: {
          databaseId: "",
          dataSourceId: "",
          databaseUrl: "",
          mapping: {
            name: "Name",
            status: "Status",
            platform: "Platform",
            format: "Format",
            scheduledDate: "Scheduled date",
          },
        },
      },
      "meeting-brief-generator": {
        internalDomains: [],
        guestProfile: {
          endpoint: "",
          apiKey: "",
          lastVerifiedAt: null,
          lastCheckAt: null,
          lastCheckState: null,
          lastCheckDetail: null,
        },
        hubspot: { token: "", lastVerifiedAt: null },
      },
    },
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
          `Cannot parse ${this.configFile}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    const merged = deepMerge(defaultConfig(), stored) as Record<string, unknown>;
    // Old configs had fireflies/watch — strictObject would reject them; drop before parse.
    delete merged.fireflies;
    delete merged.watch;
    const parsed = ConfigSchema.parse(merged);
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

  getModuleConfig<K extends keyof ModuleConfigs>(key: K): ModuleConfigs[K] {
    return this.get().modules[key];
  }

  /** Merge a partial update. Absent secret fields keep their stored values. */
  update(patch: ConfigUpdate): AppConfig {
    const merged = deepMerge(this.get(), patch);
    this.config = normalize(ConfigSchema.parse(merged));
    this.persist();
    return this.config;
  }

  /**
   * A Module's own configuration, replaced wholesale. Namespaced under the
   * Module, and deliberately not reachable through `PUT /api/config`: a
   * Module's configuration changes through that Module's own endpoints, where
   * the Module can check it first.
   */
  setModuleConfig<K extends keyof ModuleConfigs>(key: K, next: ModuleConfigs[K]): void {
    const current = this.get();
    this.config = { ...current, modules: { ...current.modules, [key]: next } };
    this.persist();
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

  setNotionToken(token: string, verifiedAt: string | null): void {
    const current = this.get();
    this.config = { ...current, notion: { token, lastVerifiedAt: verifiedAt } };
    this.persist();
  }

  /**
   * Record that Google has refused this grant at least once. Latching rather
   * than toggling: the fact stored is "this consent screen does expire", which
   * a later successful sign-in does not undo.
   */
  markGoogleExpired(): void {
    const current = this.get();
    if (current.google.hasExpiredBefore) {
      return;
    }
    this.config = { ...current, google: { ...current.google, hasExpiredBefore: true } };
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.configFile), { recursive: true });
    writeFileSync(this.configFile, JSON.stringify(this.get(), null, 2) + "\n", "utf8");
  }
}

function secretHint(value: string): SecretHint {
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
    notion: {
      token: secretHint(config.notion.token),
      lastVerifiedAt: config.notion.lastVerifiedAt,
    },
    drive: {
      enabled: config.drive.enabled,
      folderId: config.drive.folderId,
      folderName: config.drive.folderName,
      pollIntervalMinutes: config.drive.pollIntervalMinutes,
    },
    ollama: {
      baseUrl: config.ollama.baseUrl,
    },
  };
}
