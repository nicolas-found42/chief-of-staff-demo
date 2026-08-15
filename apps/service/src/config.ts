import {
  AppConfigSchema,
  CalendarEventsSchema,
  ModelsConfigSchema,
  ProfileConfigSchema,
  Type,
  type AppConfig,
  type CalendarEvents,
  type ModelsConfig,
  type ProfileConfig,
} from "@chief-of-staff/contracts";
import { WorkflowError, atomicWriteText, Workspace } from "@chief-of-staff/workflow";
import { type TSchema } from "typebox";
import { Value } from "typebox/value";
import { readFile } from "node:fs/promises";

export const DEFAULT_APP_CONFIG: AppConfig = {
  maxParallelTasks: 4,
  watchDebounceMs: 750,
  maxTranscriptBytes: 26_214_400,
  allowedUiOrigins: ["http://localhost:5173", "https://OWNER.github.io"],
};

export const DEFAULT_MODELS_CONFIG: ModelsConfig = {
  provider: "openrouter",
  model: "nvidia/nemotron-3.5-lightning",
  reasoningEffort: null,
  maxOutputTokens: null,
};

export const DEFAULT_CALENDAR: CalendarEvents = {
  timezone: "America/New_York",
  events: [
    {
      id: "event-1",
      start: "2026-08-17T10:00:00-04:00",
      end: "2026-08-17T10:30:00-04:00",
      summary: "Busy",
      status: "busy",
    },
  ],
};

export interface ValidationResult<T> {
  value: T | null;
  errors: string[];
}

export function validateWith<T>(schema: TSchema, value: unknown): ValidationResult<T> {
  if (!Value.Check(schema, value)) {
    const errors = [...Value.Errors(schema, value)].map((error) => {
      const candidate = error as { path?: string; message: string };
      return `${candidate.path?.slice(1).split("/").join(".") || "(root)"}: ${candidate.message}`;
    });
    return { value: null, errors };
  }
  return { value: value as T, errors: [] };
}

export interface ServiceConfig {
  profile: ProfileConfig;
  models: ModelsConfig;
  app: AppConfig;
  calendar: CalendarEvents;
}

export class ConfigStore {
  constructor(private readonly workspace: Workspace) {}

  private path(name: string): string {
    return `${this.workspace.root}/config/${name}.json`;
  }

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path(name), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.writeJson(name, fallback);
        return fallback;
      }
      throw error;
    }
  }

  private async writeJson<T>(name: string, value: T): Promise<void> {
    await atomicWriteText(this.path(name), `${JSON.stringify(value, null, 2)}\n`);
  }

  async load(): Promise<ServiceConfig> {
    const [profile, models, app, calendar] = await Promise.all([
      this.readJson<ProfileConfig | null>("profile", null),
      this.readJson<ModelsConfig>("models", DEFAULT_MODELS_CONFIG),
      this.readJson<AppConfig>("app", DEFAULT_APP_CONFIG),
      this.readJson<CalendarEvents>("calendar", DEFAULT_CALENDAR),
    ]);
    if (profile === null) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        "config/profile.json is missing; the setup UI must create it before runs"
      );
    }
    const profileResult = validateWith<ProfileConfig>(ProfileConfigSchema, profile);
    const modelsResult = validateWith<ModelsConfig>(ModelsConfigSchema, models);
    const appResult = validateWith<AppConfig>(AppConfigSchema, app);
    const calendarResult = validateWith<CalendarEvents>(CalendarEventsSchema, calendar);
    const violations = [
      ...profileResult.errors.map((e) => `profile.${e}`),
      ...modelsResult.errors.map((e) => `models.${e}`),
      ...appResult.errors.map((e) => `app.${e}`),
      ...calendarResult.errors.map((e) => `calendar.${e}`),
    ];
    if (
      violations.length > 0 ||
      !profileResult.value ||
      !modelsResult.value ||
      !appResult.value ||
      !calendarResult.value
    ) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        `Configuration is invalid:\n- ${violations.join("\n- ")}`
      );
    }
    // Exact-origin validation: wildcard origins are rejected.
    for (const origin of appResult.value.allowedUiOrigins) {
      if (origin.includes("*") || origin.includes("..")) {
        throw new WorkflowError(
          "INVALID_CONFIGURATION",
          `app.allowedUiOrigins must contain exact origins only; got "${origin}"`
        );
      }
    }
    return {
      profile: profileResult.value,
      models: modelsResult.value,
      app: appResult.value,
      calendar: calendarResult.value,
    };
  }

  async replaceProfile(profile: ProfileConfig): Promise<ProfileConfig> {
    const result = validateWith<ProfileConfig>(ProfileConfigSchema, profile);
    if (!result.value) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        `Invalid profile:\n- ${result.errors.join("\n- ")}`
      );
    }
    await this.writeJson("profile", result.value);
    return result.value;
  }

  async replaceModels(models: ModelsConfig): Promise<ModelsConfig> {
    const result = validateWith<ModelsConfig>(ModelsConfigSchema, models);
    if (!result.value) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        `Invalid model configuration:\n- ${result.errors.join("\n- ")}`
      );
    }
    if (result.value.model !== "nvidia/nemotron-3.5-lightning") {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        "The model configuration is locked to nvidia/nemotron-3.5-lightning in version 1"
      );
    }
    if (result.value.provider !== "openrouter") {
      throw new WorkflowError("INVALID_CONFIGURATION", "Only the openrouter provider is supported");
    }
    await this.writeJson("models", result.value);
    return result.value;
  }

  async replaceCalendar(calendar: CalendarEvents): Promise<CalendarEvents> {
    const result = validateWith<CalendarEvents>(CalendarEventsSchema, calendar);
    if (!result.value) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        `Invalid calendar:\n- ${result.errors.join("\n- ")}`
      );
    }
    await this.writeJson("calendar", result.value);
    return result.value;
  }

  static readonly schemaTypebox = {
    profile: ProfileConfigSchema,
    models: ModelsConfigSchema,
    app: AppConfigSchema,
    calendar: CalendarEventsSchema,
    Type,
  };
}

export type { AppConfig, CalendarEvents, ModelsConfig, ProfileConfig };
