import type {
  AppConfig,
  DriveIntakeStatus,
  TranscriptIdentityExtractionResult,
} from "@chief-of-staff-demo/shared";
import { buildDriveClient } from "../intake/drive.js";
import type { GoogleConnection } from "../google/connection.js";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import { TranscriptCatalog, type TranscriptDebriefProcessor } from "./catalog.js";
import { createDriveCatalogSource } from "./drive-source.js";
import { TranscriptIdentityService } from "./identity.js";
import { TranscriptIdentityStore } from "./identity-store.js";

/**
 * Production composition of the Transcript Catalog (issue #142, completing the
 * #126 hand-forward).
 *
 * Until now only the Catalog's *store* was composed in production: the
 * ingestion service — consent, the processing ledger, and immutable record
 * registration — existed but was constructed nowhere outside tests and the
 * browser-suite seed. Transcript → Tasks was therefore still the only thing
 * reading the transcript folder, which is exactly the duplicate intake #142
 * retires. This is the replacement it is retired in favour of.
 *
 * The Catalog polls nothing on its own: a pass processes what the source
 * lists, and the caller decides when a pass runs. That keeps one Drive client,
 * one folder read, and one checkpoint in the Workspace.
 */
export interface TranscriptCatalogRuntimeOptions {
  workspaceDir: string;
  port: number;
  google: GoogleConnection;
  people: WorkspacePersonProfiles;
  getConfig: () => AppConfig;
  /** Disclosed in the pre-consent inventory, so consent is informed. */
  getLlmInfo: () => { provider: string; model: string };
  /** The Meeting Debrief hand-off; absent, mining still completes. */
  debrief?: TranscriptDebriefProcessor;
  log?: (message: string) => void;
}

export interface TranscriptCatalogRuntime {
  catalog: TranscriptCatalog;
  /**
   * What the intake remembers: its configuration and the last completed pass
   * of this process. It asks Google nothing (ADR-0008), and after a restart it
   * claims no last-checked time it does not have — the pass fact is held in
   * memory rather than as a durable checkpoint, because the Catalog's ledger
   * is already the durable record of what was processed.
   */
  intakeStatus(): DriveIntakeStatus;
  /** Begins the periodic processing pass at the configured Drive interval. */
  start(): void;
  stop(): void;
}

/**
 * The identity supplement seam (ADR-0043). Deterministic extraction runs
 * inside the identity service regardless; this is the optional model-backed
 * addition to it, and no adapter for it has been built. An empty supplement
 * is therefore the truthful production value — deterministic mining, plus
 * nothing — rather than a prompt invented here to fill the slot.
 */
const EMPTY_SUPPLEMENT: TranscriptIdentityExtractionResult = {
  version: 1,
  mentions: [],
  organizations: [],
};

export function createTranscriptCatalogRuntime(
  options: TranscriptCatalogRuntimeOptions,
): TranscriptCatalogRuntime {
  const log = options.log ?? (() => {});
  const identity = new TranscriptIdentityService({
    store: new TranscriptIdentityStore(options.workspaceDir),
    people: options.people,
    extractor: {
      version: "deterministic-v1",
      extract: () => EMPTY_SUPPLEMENT,
    },
  });

  const config = options.getConfig();
  const llm = options.getLlmInfo();
  const catalog = new TranscriptCatalog({
    workspaceDir: options.workspaceDir,
    source: createDriveCatalogSource(buildDriveClient(config, options.port), {
      folderId: config.drive.folderId,
      folderName: config.drive.folderName || null,
    }),
    disclosure: { provider: llm.provider, model: llm.model },
    identity,
    ...(options.debrief ? { debrief: options.debrief } : {}),
    log,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastPassAt: string | null = null;
  let lastPassOutcome: "ok" | "failed" | null = null;

  /**
   * One pass, guarded. Consent, an unconfigured folder and a disconnected
   * Google account all mean "there is nothing to read yet", not an error to
   * surface on a timer — the Catalog itself refuses without consent, and the
   * operator sees the reason on the intake surface rather than in a log loop.
   */
  const pass = async (): Promise<void> => {
    const current = options.getConfig();
    if (!current.drive.enabled || !current.drive.folderId) return;
    try {
      await catalog.processAvailable();
      lastPassOutcome = "ok";
    } catch (error) {
      lastPassOutcome = "failed";
      log(
        `transcript catalog pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    lastPassAt = new Date().toISOString();
  };

  return {
    catalog,
    intakeStatus(): DriveIntakeStatus {
      const current = options.getConfig();
      return {
        enabled: current.drive.enabled,
        configured: Boolean(current.drive.folderId),
        folderName: current.drive.folderName,
        pollIntervalMinutes: current.drive.pollIntervalMinutes,
        lastPollAt: lastPassAt,
        lastPollOutcome: lastPassOutcome,
      };
    },
    start(): void {
      if (timer !== null) return;
      const minutes = options.getConfig().drive.pollIntervalMinutes;
      timer = setInterval(() => void pass(), minutes * 60_000);
      /* Node keeps the process alive for a timer; intake must not be the
         reason a shutdown hangs. */
      timer.unref();
      void pass();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
