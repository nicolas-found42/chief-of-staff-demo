import type { FastifyInstance } from "fastify";
import type { AppConfig, RunMeta } from "@chief-of-staff-demo/shared";
import type { HostedModule } from "../../engine/host.js";
import type { GoogleConnection } from "../../google/connection.js";
import { DriveIntake } from "../../intake/drive.js";
import type { CompleteJson } from "../../llm/providers.js";
import { Pipeline } from "../../pipeline/run.js";
import type { Runs } from "../../runs.js";
import { TRANSCRIPT_MODULE_ID, TRANSCRIPT_MODULE_VERSION, type RunSourceSpec } from "./module.js";

export interface TranscriptHostDeps {
  runs: Runs;
  workspaceDir: string;
  port: number;
  getConfig: () => AppConfig;
  getCompleteJson: () => CompleteJson;
  getLlmInfo: () => { provider: string; model: string };
  google: GoogleConnection;
  log: (message: string) => void;
}

/**
 * Transcript → Tasks as the Shell holds it: its Runs, its Drive Intake, and the
 * two endpoints that belong to it rather than to the Shell. The Shell knows
 * this Module only through `HostedModule`, so the Drive folder — a noun of this
 * workflow and no other — never reaches a Shell route.
 */
export class TranscriptHost implements HostedModule {
  readonly id = TRANSCRIPT_MODULE_ID;
  readonly version = TRANSCRIPT_MODULE_VERSION;
  private readonly pipeline: Pipeline;
  private readonly intake: DriveIntake;

  constructor(deps: TranscriptHostDeps) {
    this.pipeline = new Pipeline({
      runs: deps.runs,
      getCompleteJson: deps.getCompleteJson,
      getLlmInfo: deps.getLlmInfo,
      google: deps.google,
      getTasklistName: () => deps.getConfig().tasklistName,
      log: deps.log,
    });
    this.intake = new DriveIntake({
      getConfig: deps.getConfig,
      workspaceDir: deps.workspaceDir,
      port: deps.port,
      startRun: (spec) => this.pipeline.startRun(spec),
      log: deps.log,
      google: deps.google,
    });
  }

  /** The Module's own entry point, used by its Intake and its test seam. */
  startRun(spec: RunSourceSpec): Promise<string> {
    return this.pipeline.startRun(spec);
  }

  retryRun(id: string): Promise<RunMeta> {
    return this.pipeline.retryRun(id);
  }

  start(): void {
    this.pipeline.startRecoveryLoop();
    this.intake.start();
  }

  stop(): void {
    this.pipeline.stopRecoveryLoop();
    this.intake.stop();
  }

  routes(app: FastifyInstance): void {
    app.post("/api/drive/sync", async (_request, reply) => {
      try {
        const { created } = await this.intake.pollOnce();
        return { created };
      } catch (error) {
        reply.code(502).send({
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    });

    /* Remembered intake facts only (D14): served from config and the state
       file, it makes zero Google calls. */
    app.get("/api/intake/drive", async () => this.intake.status());
  }
}
