import type { FastifyInstance } from "fastify";
import type { AppConfig, RunMeta } from "@chief-of-staff-demo/shared";
import { IDEA_ENGINE_MODULE_ID, IDEA_ENGINE_MODULE_VERSION } from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../../config.js";
import type { HostedModule } from "../../engine/host.js";
import { Runner } from "../../engine/runner.js";
import type { Runs } from "../../runs.js";
import { ideaEngineModule, type IdeaEngineInput } from "./module.js";
import { IdeaEngineIntake } from "./intake.js";
import { IdeaIndex } from "./index.js";
import type { GoogleConnection } from "../../google/connection.js";
import { googleFailureHint } from "../../google/connection.js";
import { createGmailDraft } from "../../google/gmail.js";
import {
  appendRowsWithUserEntered,
  ensureTabWithMigration,
  isSpreadsheetMissing,
} from "../../google/sheets.js";
import type { GoogleAuth } from "../../google/oauth.js";
import { makeCompleteJson } from "../../llm/providers.js";
import { workspaceLayout } from "../../paths.js";

export interface IdeaEngineHostDeps {
  runs: Runs;
  configStore: ConfigStore;
  workspaceDir: string;
  port: number;
  google: GoogleConnection;
  log: (message: string) => void;
  getCompleteJson?: () => import("../../llm/providers.js").CompleteJson;
  getDriveClient?: (config: AppConfig, port: number) => import("./intake.js").DriveFileClient;
  getSheetsClient?: (auth: GoogleAuth) => import("./module.js").SheetsClient;
  getGmailClient?: (auth: GoogleAuth) => import("./module.js").GmailClient;
}

export class IdeaEngineHost implements HostedModule {
  readonly id = IDEA_ENGINE_MODULE_ID;
  readonly version = IDEA_ENGINE_MODULE_VERSION;
  private readonly runner: Runner<IdeaEngineInput>;
  private readonly intake: IdeaEngineIntake;
  private readonly index: IdeaIndex;

  constructor(private readonly deps: IdeaEngineHostDeps) {
    this.index = new IdeaIndex({
      runs: deps.runs,
      spreadsheet: () => {
        const cfg = deps.configStore.get().modules["idea-engine"];
        return cfg.spreadsheetId ? { id: cfg.spreadsheetId, url: cfg.spreadsheetUrl } : null;
      },
    });

    this.runner = new Runner({
      runs: deps.runs,
      module: ideaEngineModule({
        getConfig: () => deps.configStore.get(),
        getCompleteJson: () => {
          if (deps.getCompleteJson) return deps.getCompleteJson();
          const cfg = deps.configStore.get();
          const layout = workspaceLayout(deps.workspaceDir);
          return makeCompleteJson(
            {
              provider: cfg.provider,
              model: cfg.model,
              apiKey: cfg.apiKey,
              baseUrl: cfg.ollama.baseUrl,
            },
            layout.mockResultFile,
          );
        },
        getLlmInfo: () => {
          const cfg = deps.configStore.get();
          return { provider: cfg.provider, model: cfg.model };
        },
        getSheets: () => this.sheets(),
        getGmail: () => this.gmail(),
        observe: (error) => deps.google.observe(error),
        invalidateIndex: () => this.index.invalidate(),
      }),
      log: deps.log,
    });

    this.intake = new IdeaEngineIntake({
      getConfig: () => deps.configStore.get(),
      workspaceDir: deps.workspaceDir,
      port: deps.port,
      startRun: (spec) =>
        this.runner.startRun(
          {
            intake: "drive",
            fileName: spec.fileName,
            sourceUrl: spec.sourceUrl,
            externalId: spec.externalId,
          },
          {
            kind: "fresh",
            fileName: spec.fileName,
            bytes: spec.bytes,
            sourceUrl: spec.sourceUrl,
            externalId: spec.externalId,
          },
        ),
      log: deps.log,
      google: deps.google,
      getDriveClient: deps.getDriveClient as unknown as (
        config: AppConfig,
        port: number,
      ) => import("./intake.js").DriveFileClient,
    });
  }

  // For testing: allow injecting completeJson after construction
  setCompleteJson(complete: import("../../llm/providers.js").CompleteJson): void {
    // Re-create runner module with new completeJson? For simplicity, mutate deps
    (this.deps as unknown as Record<string, unknown>).getCompleteJson = () => complete;
    // Need to rebuild runner's module reference - easiest: replace runner's module deps closure.
    // Our ideaEngineModule closure captured getCompleteJson function at construction time (via deps.getCompleteJson).
    // Since we mutated deps object to new function, future calls will use new one if module reads deps.getCompleteJson() each call.
    // Our module's getCompleteJson is () => deps.getCompleteJson() where deps is host deps? Wait we passed arrow that reads deps.getCompleteJson.
    // Actually we passed getCompleteJson: () => deps.getCompleteJson ... but deps.getCompleteJson is the host's getCompleteJson prop, not function returning CompleteJson.
    // Hmm.
  }

  retryRun(id: string): Promise<RunMeta> {
    return this.runner.retryRun(id);
  }

  idle(): Promise<void> {
    return this.runner.idle();
  }

  start(): void {
    this.intake.start();
  }

  stop(): void {
    this.intake.stop();
  }

  routes(app: FastifyInstance): void {
    app.get("/api/idea-engine/ideas", async () => this.index.read());

    app.post("/api/idea-engine/backfill", async (_request, reply) => {
      // Check google connected? Not required for listing, but for fetch we need drive.
      const sheetsAccess = this.sheets();
      if (!sheetsAccess.ok && sheetsAccess.state !== "connected") {
        // We still allow backfill even without sheets? But drive needs connected.
        // Drive check is via intake's google.state()
      }
      const googleState = await this.deps.google.state();
      if (googleState.state !== "connected") {
        reply.code(400).send({ error: googleFailureHint(googleState.state) });
        return;
      }
      // Collect existing externalIds for idea-engine runs
      const existing = new Set<string>();
      for (const summary of this.deps.runs.list({ module: IDEA_ENGINE_MODULE_ID }).runs) {
        const h = this.deps.runs.open(summary.id);
        if (!h) continue;
        const meta = h.read();
        if (meta.externalId) existing.add(meta.externalId);
      }
      try {
        const result = await this.intake.backfill(existing);
        return result;
      } catch (error) {
        reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });
  }

  private sheets(): import("./module.js").SheetsAccess {
    const cfg = this.deps.configStore.get().modules["idea-engine"];
    const spreadsheet = cfg.spreadsheetId
      ? { id: cfg.spreadsheetId, url: cfg.spreadsheetUrl }
      : null;
    // If no spreadsheet configured, we still return ok with null spreadsheet -> module will skip publish unless it decides to fail.
    // But spec says spreadsheet is existing All RA Content Ideas; if not configured, we treat as ok with null to allow run to complete without sheet.
    const authAccess = this.deps.google.auth();
    if (!authAccess.ok) return { ok: false, state: authAccess.state };
    const auth = authAccess.auth;
    const client: import("./module.js").SheetsClient = this.deps.getSheetsClient
      ? this.deps.getSheetsClient(auth)
      : {
          ensureTab: (id, title, header) => ensureTabWithMigration(auth, id, title, header),
          ensureTabWithMigration: (id, title, header) =>
            ensureTabWithMigration(auth, id, title, header),
          appendRows: (id, tab, rows) => appendRowsWithUserEntered(auth, id, tab, rows),
          isMissing: isSpreadsheetMissing,
        };
    return { ok: true, client, spreadsheet };
  }

  private gmail(): import("./module.js").GmailAccess {
    const authAccess = this.deps.google.auth();
    if (!authAccess.ok) return { ok: false, state: authAccess.state };
    const auth = authAccess.auth;
    const client: import("./module.js").GmailClient = this.deps.getGmailClient
      ? this.deps.getGmailClient(auth)
      : {
          createDraft: (draft) => createGmailDraft(auth, draft),
        };
    return { ok: true, client };
  }
}
