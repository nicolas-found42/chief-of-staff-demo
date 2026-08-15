/**
 * In-browser workflow runtime: the same engine and agent layer the local
 * service runs, executing entirely on the GitHub Pages origin. Implements the
 * same AppClient contract as the HTTP ApiClient, so the UI is indifferent to
 * where the engine lives.
 */
import {
  DEFAULT_SERVICE_URL,
  PROTOCOL_VERSION,
  SERVICE_VERSION,
  CalendarEventsSchema,
  ModelsConfigSchema,
  ProfileConfigSchema,
  type ActionResponse,
  type AppConfig,
  type ArtifactSummary,
  type CalendarEvents,
  type ConfigResponse,
  type HealthResponse,
  type ModelsConfig,
  type ProfileConfig,
  type RunDetailResponse,
  type RunManifest,
  type RunStatus,
  type RunSummary,
  type RunsPageResponse,
  type UploadResponse,
  type WorkflowEvent,
} from "@chief-of-staff/contracts";
import {
  buildAdapterRegistry,
  createLiveIdGenerator,
  ENGINE_STEP_TYPES,
  WorkflowError,
  Workspace,
  loadAndValidateDefinition,
  normalizeTextLf,
  parseLocalUri,
  runWorkflow,
  sha256Hex,
  utf8Bytes,
  type IdGenerator,
  type RunInput,
  type RunSourceInfo,
} from "@chief-of-staff/workflow/browser";
import {
  createPiModels,
  mapReasoningEffort,
  PiAiInvoker,
} from "@chief-of-staff/agents";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { AppClient } from "../api/client";
import { BrowserWorkspaceStore } from "./browser-store";

import definitionText from "../../../../reference/workflow-definition.json?raw";
import definitionSha256 from "../../../../reference/workflow-definition.sha256?raw";

const REPLAY_FIXTURES: Record<string, string> = {};
{
  const modules = import.meta.glob("../../../../fixtures/llm/*.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  for (const [path, text] of Object.entries(modules)) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    REPLAY_FIXTURES[name] = text;
  }
}

/** Where the user-pasted OpenRouter key persists. Always-persist per product
 * decision: pasting the key saves it to localStorage. */
export const OPENROUTER_KEY_STORAGE = "chief-of-staff-openrouter-key";

/** Replay-mode flag for deterministic UI e2e runs; never enabled by default. */
const REPLAY_FLAG_STORAGE = "chief-of-staff-replay";

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".docx"]);

export const DEFAULT_APP_CONFIG: AppConfig = {
  maxParallelTasks: 4,
  watchDebounceMs: 750,
  maxTranscriptBytes: 26_214_400,
  allowedUiOrigins: [],
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
      id: "weekly-staff",
      start: "2026-08-17T14:00:00-04:00",
      end: "2026-08-17T14:30:00-04:00",
      summary: "Weekly staff sync",
      status: "busy",
    },
  ],
};

const REGISTERED_STEP_TYPES = new Set<string>([
  ...buildAdapterRegistry().keys(),
  ...ENGINE_STEP_TYPES,
]);

interface ValidationResult<T> {
  value: T | null;
  errors: string[];
}

function validateWith<T>(schema: TSchema, value: unknown): ValidationResult<T> {
  if (!Value.Check(schema, value)) {
    const errors = [...Value.Errors(schema, value)].map((error) => {
      const candidate = error as { path?: string; message: string };
      return `${candidate.path?.slice(1).split("/").join(".") || "(root)"}: ${candidate.message}`;
    });
    return { value: null, errors };
  }
  return { value: value as T, errors: [] };
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

function titleOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(0, dot) : filename;
}

function mimeOf(filename: string): string {
  switch (extensionOf(filename)) {
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      throw new WorkflowError("SOURCE_UNSUPPORTED", `Unsupported file extension: ${filename}`);
  }
}

function notFoundError(message: string): Error {
  const error = new Error(message);
  Object.assign(error, { code: "ENOENT" });
  return error;
}

export class BrowserRuntime implements AppClient {
  token: string | null = null;
  private readonly workspace: Workspace;
  private readonly store: BrowserWorkspaceStore;
  private readonly ids: IdGenerator = createLiveIdGenerator();
  private readonly activeRuns = new Map<string, AbortController>();
  private definition: Awaited<ReturnType<typeof loadAndValidateDefinition>> | null = null;
  private definitionLoaded: Promise<void> | null = null;

  constructor(store?: BrowserWorkspaceStore) {
    this.store = store ?? new BrowserWorkspaceStore();
    this.workspace = new Workspace("", this.store);
  }

  getBaseUrl(): string {
    return DEFAULT_SERVICE_URL;
  }

  setBaseUrl(_url: string): void {
    // The in-browser engine has no service URL to target.
  }

  clearToken(): void {
    this.token = null;
  }

  private mode(): "live" | "replay" {
    return localStorage.getItem(REPLAY_FLAG_STORAGE) === "1" ? "replay" : "live";
  }

  private apiKey(): string | null {
    const key = localStorage.getItem(OPENROUTER_KEY_STORAGE)?.trim();
    return key && key.length > 0 ? key : null;
  }

  private async ensureDefinition(): Promise<void> {
    this.definitionLoaded ??= (async () => {
      await this.workspace.initialize();
      this.definition = await loadAndValidateDefinition(
        {
          definitionPath: "reference/workflow-definition.json",
          hashPath: "reference/workflow-definition.sha256",
          repoRoot: "",
        },
        REGISTERED_STEP_TYPES,
        async (path) => {
          if (path.endsWith(".sha256")) {
            return definitionSha256.trim();
          }
          return definitionText;
        }
      );
    })();
    await this.definitionLoaded;
  }

  private async loadConfig(): Promise<{
    profile: ProfileConfig | null;
    models: ModelsConfig;
    app: AppConfig;
    calendar: CalendarEvents;
  }> {
    const readJson = async <T>(path: string): Promise<T | null> => {
      try {
        return JSON.parse(await this.workspace.readText(path)) as T;
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    };
    const [profile, models, app, calendar] = await Promise.all([
      readJson<ProfileConfig>("config/profile.json"),
      readJson<ModelsConfig>("config/models.json"),
      readJson<AppConfig>("config/app.json"),
      readJson<CalendarEvents>("config/calendar.json"),
    ]);
    return {
      profile,
      models: models ?? DEFAULT_MODELS_CONFIG,
      app: app ?? DEFAULT_APP_CONFIG,
      calendar: calendar ?? DEFAULT_CALENDAR,
    };
  }

  async health(): Promise<HealthResponse> {
    return {
      serviceVersion: SERVICE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      workspace: { status: "ready" },
      pairing: { available: false },
    };
  }

  async pair(_code: string): Promise<void> {
    throw new Error("Pairing is not used by the in-browser engine");
  }

  async getConfig(): Promise<ConfigResponse> {
    await this.ensureDefinition();
    const config = await this.loadConfig();
    const profileValid = config.profile !== null;
    const modelsValid = config.models.model === "nvidia/nemotron-3.5-lightning";
    const errors: string[] = [];
    if (!profileValid) {
      errors.push("Profile configuration is missing");
    }
    if (!modelsValid) {
      errors.push("Model configuration is not the locked model");
    }
    if (!this.apiKey()) {
      errors.push("OpenRouter API key is not set; paste it below");
    }
    return {
      profile: config.profile ?? { name: "", title: "", company: "", writingStyle: "", focusAreas: [] },
      models: config.models,
      app: config.app,
      calendar: config.calendar,
      openRouterConfigured: this.apiKey() !== null,
      readiness: {
        profileValid,
        modelsValid,
        calendarValid: true,
        appValid: true,
        definitionValid: this.definition !== null,
        workspaceWriteable: true,
        openRouterConfigured: this.apiKey() !== null,
        errors,
      },
    };
  }

  async putProfile(profile: ProfileConfig): Promise<ProfileConfig> {
    const result = validateWith<ProfileConfig>(ProfileConfigSchema, profile);
    if (!result.value) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        `Invalid profile:\n- ${result.errors.join("\n- ")}`
      );
    }
    await this.workspace.writeText(
      "config/profile.json",
      `${JSON.stringify(result.value, null, 2)}\n`
    );
    return result.value;
  }

  async putModels(models: ModelsConfig): Promise<ModelsConfig> {
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
    await this.workspace.writeText(
      "config/models.json",
      `${JSON.stringify(result.value, null, 2)}\n`
    );
    return result.value;
  }

  async putCalendar(calendar: CalendarEvents): Promise<CalendarEvents> {
    const result = validateWith<CalendarEvents>(CalendarEventsSchema, calendar);
    if (!result.value) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        `Invalid calendar:\n- ${result.errors.join("\n- ")}`
      );
    }
    const text = `${JSON.stringify(result.value, null, 2)}\n`;
    // The config card stores under config/; the email agent's calendar tool
    // reads calendar/events.json from the workspace root.
    await this.workspace.writeText("config/calendar.json", text);
    await this.workspace.writeText("calendar/events.json", text);
    return result.value;
  }

  async uploadTranscript(file: File): Promise<UploadResponse> {
    await this.ensureDefinition();
    const config = await this.loadConfig();
    const profile = config.profile;
    if (!profile) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        "Profile configuration is missing; fill in Setup before uploading"
      );
    }
    if (this.mode() === "live" && !this.apiKey()) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        "OpenRouter API key is not set; paste your key in Setup before uploading"
      );
    }
    if (!SUPPORTED_EXTENSIONS.has(extensionOf(file.name))) {
      throw new WorkflowError(
        "SOURCE_UNSUPPORTED",
        `Unsupported transcript extension: ${file.name}`
      );
    }
    if (file.size > config.app.maxTranscriptBytes) {
      throw new WorkflowError(
        "SOURCE_TOO_LARGE",
        `Transcript is ${file.size} bytes; the limit is ${config.app.maxTranscriptBytes}`
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const runId = this.ids.runId();
    const mimeType = mimeOf(file.name);
    const source: RunSourceInfo = {
      filename: file.name,
      title: titleOf(file.name),
      mimeType,
      byteSize: bytes.byteLength,
      sha256: sha256Hex(bytes),
      stat: { birthtimeMs: Date.now(), mtimeMs: file.lastModified, ctimeMs: Date.now() },
    };
    await this.workspace.writeBytes(`source/processing/${runId}/${file.name}`, bytes);
    const text = await this.extractText(bytes, mimeType);
    void this.pipeline(runId, source, text, undefined, profile);
    return { runId, claimed: true };
  }

  private async extractText(bytes: Uint8Array, mimeType: string): Promise<string> {
    if (mimeType === "text/plain" || mimeType === "text/markdown") {
      return normalizeTextLf(new TextDecoder().decode(bytes));
    }
    if (mimeType === "application/pdf") {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const doc = await getDocument({ data: bytes.slice() }).promise;
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(
          content.items
            .map((item) => ("str" in item ? (item as { str: string }).str : ""))
            .join(" ")
        );
      }
      return normalizeTextLf(pages.join("\n"));
    }
    if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const mammoth = await import("mammoth");
      const copy = bytes.slice();
      const result = await mammoth.extractRawText({ arrayBuffer: copy.buffer });
      return normalizeTextLf(result.value);
    }
    throw new WorkflowError("SOURCE_UNSUPPORTED", `Unsupported MIME type: ${mimeType}`);
  }

  private async pipeline(
    runId: string,
    source: RunSourceInfo,
    transcriptText: string,
    resumeFrom: RunManifest | undefined,
    profile: ProfileConfig
  ): Promise<RunManifest> {
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    let manifest: RunManifest;
    try {
      const config = await this.loadConfig();
      const definition = this.definition;
      if (!definition) {
        throw new WorkflowError("INVALID_CONFIGURATION", "Workflow definition failed validation");
      }
      const input: RunInput = {
        runId,
        source,
        transcriptText,
        transcriptSha256: sha256Hex(utf8Bytes(transcriptText)),
        ...(resumeFrom ? { resumeFrom } : {}),
      };
      const services = {
        workspace: this.workspace,
        ids: this.ids,
        clock: () => new Date(),
        telemetry: new InMemoryTelemetryContext(),
        adapters: buildAdapterRegistry(),
        ai: new PiAiInvoker({
          models: createPiModels(),
          mode: this.mode(),
          thinkingLevel: mapReasoningEffort(config.models.reasoningEffort),
          workspace: this.workspace,
          ...(this.apiKey() !== null ? { apiKey: this.apiKey() ?? undefined } : {}),
          ...(this.mode() === "replay"
            ? {
                fixturesDir: "fixtures/llm",
                loadFixtureFile: async (path: string) => {
                  const name = path.slice(path.lastIndexOf("/") + 1);
                  const text = REPLAY_FIXTURES[name];
                  if (text === undefined) {
                    throw notFoundError(`Missing bundled replay fixture: ${path}`);
                  }
                  return text;
                },
              }
            : {}),
        }),
        profile,
        models: config.models,
        app: config.app,
        mode: this.mode(),
        signal: controller.signal,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        definition: definition.definition,
        definitionSha256: definition.sha256,
        definitionPath: "reference/workflow-definition.json",
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      };
      manifest = await runWorkflow(services, input);
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              "FILESYSTEM_WRITE",
              error instanceof Error ? error.message : String(error),
              { retryable: true, cause: error }
            );
      if (!(await this.workspace.exists(`runs/${runId}/manifest.json`))) {
        const status: RunStatus = controller.signal.aborted ? "cancelled" : "failed";
        manifest = this.failedManifest(runId, source, workflowError, status);
        await this.workspace.writeText(
          `runs/${runId}/manifest.json`,
          `${JSON.stringify(manifest, null, 2)}\n`
        );
        await this.workspace.appendText(
          `runs/${runId}/events.jsonl`,
          `${JSON.stringify({ runId, type: "run.started", sequence: 1, timestamp: new Date().toISOString() })}\n`
        );
        await this.workspace.appendText(
          `runs/${runId}/events.jsonl`,
          `${JSON.stringify({
            runId,
            type: "run.finished",
            sequence: 2,
            timestamp: new Date().toISOString(),
            data: { status },
            error: manifest.error ?? undefined,
          })}\n`
        );
      } else {
        manifest = JSON.parse(
          await this.workspace.readText(`runs/${runId}/manifest.json`)
        ) as RunManifest;
      }
    } finally {
      this.activeRuns.delete(runId);
    }
    await this.workspace
      .writeText(
        `service/claims/${runId}.json`,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            runId,
            sourceFilename: source.filename,
            claimedAt: new Date().toISOString(),
            status: manifest.status,
          },
          null,
          2
        )}\n`
      )
      .catch(() => undefined);
    return manifest;
  }

  private failedManifest(
    runId: string,
    source: RunSourceInfo,
    error: WorkflowError,
    status: RunStatus
  ): RunManifest {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      runId,
      status,
      workflow: {
        path: "reference/workflow-definition.json",
        revision: this.definition?.definition.revision ?? 0,
        sha256: this.definition?.sha256 ?? "",
      },
      source: {
        filename: source.filename,
        mimeType: source.mimeType,
        byteSize: source.byteSize,
        sha256: source.sha256,
        timestamps: {
          claimedAt: now,
          birthtimeMs: source.stat.birthtimeMs,
          mtimeMs: source.stat.mtimeMs,
          ctimeMs: source.stat.ctimeMs,
        },
      },
      transcriptSha256: "",
      configSha256: { profile: "", models: "" },
      now,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      llm: { mode: this.mode(), model: DEFAULT_MODELS_CONFIG.model },
      tasks: [],
      steps: [],
      unresolvedRefs: [],
      warnings: [],
      artifacts: [],
      discardedTasks: 0,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    };
  }

  async listRuns(): Promise<RunsPageResponse> {
    await this.ensureDefinition();
    let entries: string[] = [];
    try {
      entries = await this.store.readdir("runs");
    } catch {
      entries = [];
    }
    const summaries: RunSummary[] = [];
    for (const entry of entries) {
      const manifest = await this.readManifest(entry);
      if (!manifest) {
        continue;
      }
      const hasNotification = await this.workspace.exists(`notifications/${entry}-summary.md`);
      summaries.push({
        runId: manifest.runId,
        status: manifest.status,
        sourceFilename: manifest.source.filename,
        acceptedTaskCount: manifest.tasks.length,
        totalTaskCount: manifest.tasks.length + (manifest.discardedTasks ?? 0),
        mode: manifest.llm.mode,
        model: manifest.llm.model,
        createdAt: manifest.now,
        finishedAt: manifest.status === "running" ? null : manifest.now,
        durationMs:
          manifest.steps.length > 0
            ? Math.max(...manifest.steps.map((s) => Date.parse(s.finishedAt) - Date.parse(s.startedAt)))
            : null,
        hasNotification,
        error: manifest.error ?? null,
      });
    }
    return { total: summaries.length, runs: summaries.sort((a, b) => b.runId.localeCompare(a.runId)) };
  }

  private async readManifest(runId: string): Promise<RunManifest | null> {
    try {
      return JSON.parse(await this.workspace.readText(`runs/${runId}/manifest.json`)) as RunManifest;
    } catch {
      return null;
    }
  }

  async getRun(runId: string): Promise<RunDetailResponse> {
    const manifest = await this.readManifest(runId);
    if (!manifest) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Unknown run ${runId}`);
    }
    const artifacts: ArtifactSummary[] = manifest.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      type: artifact.type,
      uri: artifact.uri,
      taskIndex: artifact.taskIndex,
      stepId:
        manifest.steps.find((s) => s.artifactUri === artifact.uri)?.stepId ?? "unknown",
      byteSize: artifact.byteSize,
    }));
    return { manifest, artifacts };
  }

  async cancelRun(runId: string): Promise<ActionResponse> {
    const controller = this.activeRuns.get(runId);
    if (!controller) {
      throw new WorkflowError("INVALID_CONFIGURATION", `No active run ${runId}`);
    }
    controller.abort();
    return { runId, status: "cancelled" };
  }

  async retryRun(runId: string): Promise<ActionResponse> {
    if (this.activeRuns.has(runId)) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Run ${runId} is still active`);
    }
    const manifest = await this.readManifest(runId);
    if (!manifest) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Unknown run ${runId}`);
    }
    if (manifest.status === "succeeded") {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        `Run ${runId} already succeeded; use run again instead`
      );
    }
    const transcriptText = await this.workspace
      .readText(`runs/${runId}/input/transcript.txt`)
      .catch(() => "");
    if (!transcriptText) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Run ${runId} has no reusable input snapshot`);
    }
    const profile = await this.loadConfig().then((config) => config.profile);
    if (!profile) {
      throw new WorkflowError("INVALID_CONFIGURATION", "Profile configuration is missing");
    }
    const source: RunSourceInfo = {
      filename: manifest.source.filename,
      title: titleOf(manifest.source.filename),
      mimeType: manifest.source.mimeType,
      byteSize: manifest.source.byteSize,
      sha256: manifest.source.sha256,
      stat: {
        birthtimeMs: manifest.source.timestamps.birthtimeMs,
        mtimeMs: manifest.source.timestamps.mtimeMs,
        ctimeMs: manifest.source.timestamps.ctimeMs,
      },
    };
    void this.pipeline(runId, source, transcriptText, manifest, profile);
    return { runId, status: "running" };
  }

  async rerunRun(runId: string): Promise<ActionResponse> {
    const manifest = await this.readManifest(runId);
    if (!manifest) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Unknown run ${runId}`);
    }
    const transcriptText = await this.workspace
      .readText(`runs/${runId}/input/transcript.txt`)
      .catch(() => "");
    if (!transcriptText) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Run ${runId} has no reusable input snapshot`);
    }
    const profile = await this.loadConfig().then((config) => config.profile);
    if (!profile) {
      throw new WorkflowError("INVALID_CONFIGURATION", "Profile configuration is missing");
    }
    const newRunId = this.ids.runId();
    const filename = manifest.source.filename;
    await this.workspace.writeBytes(
      `source/processing/${newRunId}/${filename}`,
      utf8Bytes(transcriptText)
    );
    const source: RunSourceInfo = {
      filename,
      title: titleOf(filename),
      mimeType: manifest.source.mimeType,
      byteSize: utf8Bytes(transcriptText).byteLength,
      sha256: manifest.source.sha256,
      stat: { birthtimeMs: Date.now(), mtimeMs: Date.now(), ctimeMs: Date.now() },
    };
    void this.pipeline(newRunId, source, transcriptText, undefined, profile);
    return { runId: newRunId, status: "running" };
  }

  async getArtifact(artifactId: string): Promise<string> {
    for (const summary of (await this.listRuns()).runs) {
      const detail = await this.getRun(summary.runId);
      const match = detail.artifacts.find((a) => a.artifactId === artifactId);
      if (match) {
        return this.workspace.readText(parseLocalUri(match.uri));
      }
    }
    throw new WorkflowError("ARTIFACT_NOT_FOUND", `Artifact ${artifactId} not found`);
  }

  async streamEvents(
    runId: string,
    after: number,
    onEvent: (event: WorkflowEvent) => void
  ): Promise<void> {
    const path = `runs/${runId}/events.jsonl`;
    let last = after;
    for (;;) {
      const events = await this.readEvents(path).catch(() => []);
      for (const event of events) {
        if (event.sequence > last) {
          onEvent(event);
          last = event.sequence;
        }
      }
      const manifest = await this.readManifest(runId);
      if (manifest && manifest.status !== "running") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  private async readEvents(path: string): Promise<WorkflowEvent[]> {
    const text = await this.workspace.readText(path);
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as WorkflowEvent);
  }
}
