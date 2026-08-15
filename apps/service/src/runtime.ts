import {
  PROTOCOL_VERSION,
  type ArtifactSummary,
  type LlmMode,
  type ReadinessReport,
  type RunDetailResponse,
  type RunManifest,
  type RunSummary,
  type SourceMetadata,
  type CalendarEvents,
  type ModelsConfig,
  type ProfileConfig,
} from "@chief-of-staff/contracts";
import {
  EventSink,
  ENGINE_STEP_TYPES,
  WorkflowError,
  Workspace,
  createLiveIdGenerator,
  loadAndValidateDefinition,
  parseLocalUri,
  runWorkflow,
  type EngineServices,
  type IdGenerator,
  type Logger,
  type RunInput,
  type RunSourceInfo,
} from "@chief-of-staff/workflow";
import { type TelemetryContext } from "@earendil-works/pi-telemetry";
import type { Models } from "@earendil-works/pi-ai";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ConfigStore, type ServiceConfig } from "./config.js";
import {
  initPiRuntime,
  mapReasoningEffort,
  runStartupChecks,
  createPiModels,
} from "./agents/pi-init.js";
import { JsonlTelemetryContext } from "./telemetry/jsonl.js";
import { PiAiInvoker } from "./agents/invoker.js";
import { buildAdapterRegistry } from "./adapters/local-adapters.js";
import { claimFile, finalizeSource, parseTranscript } from "./ingest.js";
import { TranscriptWatcher } from "./watcher/watcher.js";
export interface RuntimeOptions {
  workspace: Workspace;
  repoRoot: string;
  mode: LlmMode;
  fixturesDir?: string;
  developerMode: boolean;
  logger: Logger;
  /** Test seam: upload buffer write. */
  uploadToInbox?: (inboxFilePath: string, bytes: Uint8Array) => Promise<void>;
}

const REGISTERED_STEP_TYPES = new Set<string>([
  ...buildAdapterRegistry().keys(),
  ...ENGINE_STEP_TYPES,
]);

export class ServiceRuntime {
  private configStore: ConfigStore;
  private activeRuns = new Map<string, AbortController>();
  private watcher: TranscriptWatcher | null = null;
  private ids: IdGenerator = createLiveIdGenerator();
  config: ServiceConfig | null = null;
  definition: Awaited<ReturnType<typeof loadAndValidateDefinition>> | null = null;
  models: Models = createPiModels();
  private definitionPath = "reference/workflow-definition.json";
  private pairingCode: string | null = null;
  private pairingExpiresAt = 0;

  constructor(private readonly options: RuntimeOptions) {
    this.configStore = new ConfigStore(options.workspace);
  }

  async start(): Promise<void> {
    await this.options.workspace.initialize();
    this.config = await this.configStore.load();
    this.definition = await loadAndValidateDefinition(
      {
        definitionPath: join(this.options.repoRoot, "reference", "workflow-definition.json"),
        hashPath: join(this.options.repoRoot, "reference", "workflow-definition.sha256"),
        repoRoot: this.options.repoRoot,
      },
      REGISTERED_STEP_TYPES,
      (path) => readFile(path, "utf8")
    );
    const runtime = initPiRuntime({
      modelsConfig: this.config.models,
      apiKeyPresent: Boolean(process.env.OPENROUTER_API_KEY),
      liveMode: this.options.mode !== "replay",
    });
    this.models = runtime.models;
    this.options.logger.info(
      `Service started: mode=${this.options.mode}, model=${this.config.models.model}, workspace=${this.options.workspace.root}`
    );
    // Resume interrupted runs left behind by a crash.
    await this.recoverInterrupted();
    // Watch the inbox.
    this.watcher = new TranscriptWatcher({
      inboxDir: this.options.workspace.layout.inboxDir,
      debounceMs: this.config.app.watchDebounceMs,
      onFile: async (filePath) => {
        await this.startRunFromInbox(filePath);
      },
      log: (message) => this.options.logger.warn(message),
    });
    await this.watcher.start();
  }

  async stop(): Promise<void> {
    await this.watcher?.stop();
    for (const controller of this.activeRuns.values()) {
      controller.abort();
    }
  }

  readiness(): ReadinessReport {
    const config = this.config;
    const errors: string[] = [];
    const definitionValid = this.definition !== null;
    const workspaceWriteable = true;
    const openRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);
    const profileValid = config !== null;
    const modelsValid = config !== null && config.models.model === "nvidia/nemotron-3.5-lightning";
    const calendarValid = config !== null;
    const appValid = config !== null;
    if (!definitionValid) {
      errors.push("The workflow definition failed validation");
    }
    if (!profileValid) {
      errors.push("Profile configuration is missing");
    }
    if (!modelsValid) {
      errors.push("Model configuration is not the locked model");
    }
    if (!openRouterConfigured) {
      errors.push("OpenRouter API key is not present in the service environment");
    }
    if (config && this.options.mode !== "replay") {
      const checks = runStartupChecks({
        modelsConfig: config.models,
        apiKeyPresent: openRouterConfigured,
        liveMode: true,
      });
      for (const violation of checks.violations) {
        errors.push(violation);
      }
    }
    void workspaceWriteable;
    return {
      profileValid,
      modelsValid,
      calendarValid,
      appValid,
      definitionValid,
      workspaceWriteable,
      openRouterConfigured,
      errors,
    };
  }

  get workspace(): Workspace {
    return this.options.workspace;
  }

  /** Replaces a configuration file and refreshes derived runtime state. */
  async configStoreReplace(kind: "profile" | "models" | "calendar", value: unknown): Promise<unknown> {
    if (kind === "profile") {
      const profile = await this.configStore.replaceProfile(value as ProfileConfig);
      if (this.config) {
        this.config.profile = profile;
      }
      return profile;
    }
    if (kind === "models") {
      const modelsConfig = await this.configStore.replaceModels(value as ModelsConfig);
      if (this.config) {
        this.config.models = modelsConfig;
        const runtime = initPiRuntime({
          modelsConfig,
          apiKeyPresent: Boolean(process.env.OPENROUTER_API_KEY),
          liveMode: this.options.mode !== "replay",
        });
        this.models = runtime.models;
      }
      return modelsConfig;
    }
    const calendar = await this.configStore.replaceCalendar(value as CalendarEvents);
    if (this.config) {
      this.config.calendar = calendar;
    }
    return calendar;
  }


  /** Rotates a short-lived pairing code and displays it. */
  issuePairingCode(): string {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.pairingCode = code;
    this.pairingExpiresAt = Date.now() + 5 * 60_000;
    return code;
  }

  exchangePairingCode(code: string): string {
    if (this.pairingCode === null || Date.now() > this.pairingExpiresAt) {
      throw new WorkflowError("INVALID_CONFIGURATION", "No active pairing code; request one from the service console");
    }
    if (code.trim() !== this.pairingCode) {
      throw new WorkflowError("INVALID_CONFIGURATION", "Pairing code is invalid or expired");
    }
    // Short-lived and service-displayed; reusable within its TTL so several
    // browser contexts can pair during one session.
    return this.ids.randomToken(32);
  }

  pairingStatus(): { available: boolean; expiresAt?: string } {
    if (this.pairingCode === null || Date.now() > this.pairingExpiresAt) {
      return { available: false };
    }
    return {
      available: true,
      expiresAt: new Date(this.pairingExpiresAt).toISOString(),
    };
  }

  /** Ingest a transcript uploaded from the UI. */
  async uploadTranscript(filename: string, bytes: Uint8Array): Promise<string> {
    const safeName = basename(filename).replace(/[<>:"/\\|?*]/g, "_");
    const inboxPath = join(this.options.workspace.layout.inboxDir, safeName);
    if (this.options.uploadToInbox) {
      await this.options.uploadToInbox(inboxPath, bytes);
    } else {
      await writeFile(inboxPath, bytes);
    }
    return this.startRunFromInbox(inboxPath);
  }

  /** Claim a stable inbox file and run the pipeline. */
  async startRunFromInbox(filePath: string): Promise<string> {
    if (!this.config || !this.definition) {
      throw new WorkflowError("INVALID_CONFIGURATION", "Service is not configured");
    }
    const claimed = await claimFile(
      this.options.workspace,
      this.ids,
      filePath,
      this.config.app.maxTranscriptBytes
    );
    await this.pipeline(claimed.runId, claimed.source, claimed.claimedPath);
    return claimed.runId;
  }

  private buildEngineServices(
    runId: string,
    signal: AbortSignal,
    telemetry: TelemetryContext
  ): EngineServices {
    const config = this.config as ServiceConfig;
    const definition = this.definition;
    if (!definition) {
      throw new WorkflowError("INVALID_CONFIGURATION", "Service is not configured");
    }
    return {
      workspace: this.options.workspace,
      ids: this.ids,
      clock: () => new Date(),
      telemetry,
      adapters: buildAdapterRegistry(),
      ai: new PiAiInvoker({
        models: this.models,
        mode: this.options.mode,
        thinkingLevel: mapReasoningEffort(config.models.reasoningEffort),
        calendarFilePath: this.options.workspace.layout.calendarFile,
        fixturesDir: this.options.fixturesDir,
        logger: this.options.logger,
      }),
      profile: config.profile,
      models: config.models,
      app: config.app,
      mode: this.options.mode,
      signal,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      definition: definition.definition,
      definitionSha256: definition.sha256,
      definitionPath: this.definitionPath,
      logger: this.options.logger,
    };
  }

  private async pipeline(
    runId: string,
    source: RunSourceInfo,
    claimedPath: string,
    resumeFrom?: RunManifest
  ): Promise<RunManifest> {
    const runDir = this.options.workspace.runDir(runId);
    const telemetry = new JsonlTelemetryContext(join(runDir, "telemetry.jsonl"));
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    let manifest: RunManifest;
    try {
      const parsed = await parseTranscript(claimedPath, source.mimeType);
      const transcriptSha256 = await import("@chief-of-staff/workflow").then((m) =>
        m.sha256Hex(Buffer.from(parsed.text, "utf8"))
      );
      const input: RunInput = {
        runId,
        source,
        transcriptText: parsed.text,
        transcriptSha256,
        ...(resumeFrom ? { resumeFrom } : {}),
      };
      manifest = await runWorkflow(
        this.buildEngineServices(runId, controller.signal, telemetry),
        input
      );
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              "FILESYSTEM_WRITE",
              error instanceof Error ? error.message : String(error),
              { retryable: true, cause: error }
            );
      // For pre-workflow failures (parse, size) the engine never wrote a
      // manifest; record one for the UI.
      if (!(await this.options.workspace.exists(`runs/${runId}/manifest.json`))) {
        const failedManifest: RunManifest = {
          schemaVersion: 1,
          runId,
          status: controller.signal.aborted ? "cancelled" : "failed",
          workflow: {
            path: this.definitionPath,
            revision: this.definition?.definition.revision ?? 0,
            sha256: this.definition?.sha256 ?? "",
          },
          source: {
            filename: source.filename,
            mimeType: source.mimeType,
            byteSize: source.byteSize,
            sha256: source.sha256,
            timestamps: {
              claimedAt: new Date().toISOString(),
              birthtimeMs: source.stat.birthtimeMs,
              mtimeMs: source.stat.mtimeMs,
              ctimeMs: source.stat.ctimeMs,
            },
          },
          transcriptSha256: "",
          configSha256: { profile: "", models: "" },
          now: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          llm: { mode: this.options.mode, model: this.config?.models.model ?? "" },
          tasks: [],
          steps: [],
          unresolvedRefs: [],
          warnings: [],
          artifacts: [],
          discardedTasks: 0,
          error: {
            code: workflowError.code,
            message: workflowError.message,
            retryable: workflowError.retryable,
          },
        };
        await this.options.workspace.writeText(
          `runs/${runId}/manifest.json`,
          `${JSON.stringify(failedManifest, null, 2)}\n`
        );
        const sink = new EventSink(join(runDir, "events.jsonl"), () => new Date());
        await sink.emit({ runId, type: "run.started" });
        await sink.emit({
          runId,
          type: "run.finished",
          data: { status: failedManifest.status },
          error: failedManifest.error ?? undefined,
        });
        manifest = failedManifest;
      } else {
        manifest = JSON.parse(
          await this.options.workspace.readText(`runs/${runId}/manifest.json`)
        ) as RunManifest;
      }
    } finally {
      this.activeRuns.delete(runId);
    }
    await finalizeSource(this.options.workspace, runId, manifest.status, manifest.error);
    await this.options.workspace
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

  cancelRun(runId: string): void {
    const controller = this.activeRuns.get(runId);
    if (!controller) {
      throw new WorkflowError("INVALID_CONFIGURATION", `No active run ${runId}`);
    }
    controller.abort();
  }

  /** Retry: resume the same runId from its prior state. */
  async retryRun(runId: string): Promise<RunManifest> {
    if (this.activeRuns.has(runId)) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Run ${runId} is still active`);
    }
    const manifest = await this.readManifest(runId);
    if (!manifest) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Unknown run ${runId}`);
    }
    // Move the source back into processing if a previous failure moved it.
    const filename = manifest.source.filename;
    const failedRel = `source/failed/${runId}/${filename}`;
    const processedRel = `source/processed/${runId}/${filename}`;
    const processingRel = `source/processing/${runId}/${filename}`;
    if (await this.options.workspace.exists(failedRel)) {
      await this.options.workspace.writeText(`source/processing/${runId}/.claim`, "");
      const { rename } = await import("node:fs/promises");
      await rename(join(this.options.workspace.root, failedRel), join(this.options.workspace.root, processingRel));
    } else if (await this.options.workspace.exists(processedRel)) {
      // A completed run cannot be retried; users must run again.
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        `Run ${runId} already succeeded; use run again instead`
      );
    }
    const claimedPath = join(this.options.workspace.root, processingRel);
    const source: RunSourceInfo = {
      filename,
      title: basename(filename, filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : ""),
      mimeType: manifest.source.mimeType,
      byteSize: manifest.source.byteSize,
      sha256: manifest.source.sha256,
      stat: {
        birthtimeMs: manifest.source.timestamps.birthtimeMs,
        mtimeMs: manifest.source.timestamps.mtimeMs,
        ctimeMs: manifest.source.timestamps.ctimeMs,
      },
    };
    return this.pipeline(runId, source, claimedPath, manifest);
  }

  /** Run again: new run id from the normalized input snapshot. */
  async rerunRun(runId: string): Promise<RunManifest> {
    const manifest = await this.readManifest(runId);
    if (!manifest) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Unknown run ${runId}`);
    }
    const transcriptText = await this.options.workspace
      .readText(`runs/${runId}/input/transcript.txt`)
      .catch(() => "");
    if (!transcriptText) {
      throw new WorkflowError("INVALID_CONFIGURATION", `Run ${runId} has no reusable input snapshot`);
    }
    const newRunId = this.ids.runId();
    const filename = manifest.source.filename;
    const claimedPath = join(this.options.workspace.layout.sourceProcessingDir, newRunId, filename);
    await this.options.workspace.writeBytes(
      `source/processing/${newRunId}/${filename}`,
      Buffer.from(transcriptText, "utf8")
    );
    const source: RunSourceInfo = {
      filename,
      title: manifest.source.filename,
      mimeType: manifest.source.mimeType,
      byteSize: Buffer.byteLength(transcriptText, "utf8"),
      sha256: manifest.source.sha256,
      stat: {
        birthtimeMs: Date.now(),
        mtimeMs: Date.now(),
        ctimeMs: Date.now(),
      },
    };
    return this.pipeline(newRunId, source, claimedPath);
  }

  async readManifest(runId: string): Promise<RunManifest | null> {
    try {
      return JSON.parse(
        await this.options.workspace.readText(`runs/${runId}/manifest.json`)
      ) as RunManifest;
    } catch {
      return null;
    }
  }

  async listRunSummaries(): Promise<RunSummary[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.options.workspace.layout.runsDir);
    } catch {
      return [];
    }
    const summaries: RunSummary[] = [];
    for (const entry of entries) {
      const manifest = await this.readManifest(entry);
      if (!manifest) {
        continue;
      }
      const notification = await this.options.workspace.exists(`notifications/${entry}-summary.md`);
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
        hasNotification: notification,
        error: manifest.error ?? null,
      });
    }
    return summaries.sort((a, b) => b.runId.localeCompare(a.runId));
  }

  async getRunDetail(runId: string): Promise<RunDetailResponse | null> {
    const manifest = await this.readManifest(runId);
    if (!manifest) {
      return null;
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

  async resolveArtifact(artifactId: string): Promise<{ path: string; contentType: string }> {
    for (const summary of await this.listRunSummaries()) {
      const detail = await this.getRunDetail(summary.runId);
      const match = detail?.artifacts.find((a) => a.artifactId === artifactId);
      if (match) {
        const rel = parseLocalUri(match.uri);
        const abs = await this.options.workspace.resolve(rel);
        const info = await stat(abs);
        if (!info.isFile()) {
          throw new WorkflowError("ARTIFACT_NOT_FOUND", `Artifact ${artifactId} is not a file`);
        }
        return {
          path: abs,
          contentType: match.type === "task" || match.type === "step-artifact" || match.type === "tracking-csv" || match.type === "llm-request"
            ? "application/json"
            : match.type === "transcript"
              ? "text/plain; charset=utf-8"
              : "text/markdown; charset=utf-8",
        };
      }
    }
    throw new WorkflowError("ARTIFACT_NOT_FOUND", `No artifact with id ${artifactId}`);
  }

  private async recoverInterrupted(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.options.workspace.layout.sourceProcessingDir);
    } catch {
      return;
    }
    for (const runId of entries) {
      const manifest = await this.readManifest(runId);
      if (manifest && (manifest.status === "running" || manifest.status === "cancelled")) {
        // Mark interrupted so the UI can offer resume.
        const updated: RunManifest = {
          ...manifest,
          status: "interrupted",
          warnings: [
            ...manifest.warnings,
            { code: "INTERRUPTED", message: "The service restarted while this run was in progress; it can be resumed" },
          ],
        };
        await this.options.workspace
          .writeText(
            `runs/${runId}/manifest.json`,
            `${JSON.stringify(updated, null, 2)}\n`
          )
          .catch(() => undefined);
        this.options.logger.warn(`Recovered interrupted run ${runId}`);
      }
    }
  }
}

export { PROTOCOL_VERSION };
export type { RunManifest, RunSummary, SourceMetadata };
