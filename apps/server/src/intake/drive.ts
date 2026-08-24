import { google } from "googleapis";
import type { AppConfig, DriveIntakeStatus } from "@chief-of-staff-demo/shared";
import { buildGoogleAuth } from "../google/oauth.js";
import { googleFailureHint, type GoogleConnection } from "../google/connection.js";
import { loadState, saveState, type WorkspaceState } from "../state.js";
import { workspaceLayout } from "../paths.js";
import { isSupportedFileName, MAX_UPLOAD_BYTES } from "../text/convert.js";
import { meetingDateFromFileName } from "../pipeline/run.js";
const MAX_INGESTED = 1000;

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

function toBuffer(data: unknown): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data && typeof (data as { byteLength?: unknown }).byteLength === "number") {
    return Buffer.from(data as unknown as ArrayBuffer);
  }
  return Buffer.from(String(data ?? ""), "utf8");
}

export class DriveError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

export interface DriveFileClient {
  files: {
    list: (
      params: Record<string, unknown>,
    ) => Promise<{
      data?: {
        files?: Array<{
          id?: string;
          name?: string;
          mimeType?: string;
          webViewLink?: string;
          size?: string;
          modifiedTime?: string;
        }>;
        nextPageToken?: string | null;
      };
    }>;
    get: (
      params: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => Promise<{ data?: unknown }>;
    export: (
      params: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => Promise<{ data?: unknown }>;
  };
}

export interface DriveIntakeDeps {
  getConfig: () => AppConfig;
  workspaceDir: string;
  port: number;
  startRun: (spec: {
    intake: "drive";
    fileName: string;
    bytes: Buffer;
    sourceUrl?: string | null;
    externalId: string | null;
    context?: { meetingDate: string | null; attendees: { name: string; email: string | null }[] };
  }) => Promise<string>;
  log: (message: string) => void;
  google: GoogleConnection;
  /** Test seam: override Drive client. */
  getDriveClient?: (config: AppConfig, port: number) => DriveFileClient;
}
function buildDriveClient(config: AppConfig, port: number) {
  const auth = buildGoogleAuth(config, port);
  return google.drive({ version: "v3", auth });
}

export class DriveIntake {
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * The poll currently running, if any. Three things start a poll — the
   * interval, the immediate poll `start()` fires on every settings save, and
   * `Sync now` — and two of them overlapping used to ingest the whole folder
   * twice: each pass held its own `ingestedIds` snapshot taken before the other
   * had written to it, so every file looked new and every transcript produced
   * two Runs, two sets of Google Tasks and two Gmail drafts. Saving the folder
   * and then saving again to enable polling was enough to do it. A poll in
   * flight is therefore shared rather than duplicated: a second caller awaits
   * the same answer instead of starting a second pass. `stop()` cannot cancel
   * an in-flight poll, which is why the guard lives here and not on the timer.
   */
  private inFlight: Promise<{ created: number }> | null = null;

  constructor(private readonly deps: DriveIntakeDeps) {}

  start(): void {
    this.stop();
    const config = this.deps.getConfig();
    if (!config.drive.enabled || !config.drive.folderId) {
      return;
    }
    const intervalMs = config.drive.pollIntervalMinutes * 60_000;
    this.timer = setInterval(() => {
      this.pollSafely();
    }, intervalMs);
    this.pollSafely();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private pollSafely(): void {
    this.pollOnce().catch((error) => {
      this.deps.log(`Drive poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async pollOnce(): Promise<{ created: number }> {
    if (this.inFlight) {
      return this.inFlight;
    }
    /* Assigned before the first await inside `runPoll` can yield, so no second
       caller can slip past the guard. */
    const poll = this.runPoll();
    this.inFlight = poll;
    try {
      return await poll;
    } finally {
      this.inFlight = null;
    }
  }

  private async runPoll(): Promise<{ created: number }> {
    const config = this.deps.getConfig();
    try {
      if (!config.drive.enabled || !config.drive.folderId) {
        /* Not an attempt; recording one would teach the liveness line to lie. */
        return { created: 0 };
      }
      const status = await this.deps.google.state();
      if (status.state !== "connected") {
        this.deps.log(`Drive poll skipped: ${googleFailureHint(status.state)}`);
        return { created: 0 };
      }
      const created = await this.ingestNewFiles(config);
      this.rememberPoll("ok");
      return { created };
    } catch (error) {
      this.rememberPoll("failed");
      try {
        this.deps.google.observe(error);
      } catch {}
      throw error;
    }
  }

  /** Remembered fact only (D14): what happened, never a prediction. */
  private rememberPoll(outcome: "ok" | "failed"): void {
    this.updateState((state) => {
      state.drive.lastPollAt = new Date().toISOString();
      state.drive.lastPollOutcome = outcome;
    });
  }

  /**
   * What the intake remembers (D14): configuration and the last completed
   * poll attempt, read from the workspace. It never asks Google anything —
   * ADR-0008 economics apply here too.
   */
  status(): DriveIntakeStatus {
    const config = this.deps.getConfig();
    const layout = workspaceLayout(this.deps.workspaceDir);
    const state = loadState(layout.stateFile);
    return {
      enabled: config.drive.enabled,
      configured: Boolean(config.drive.folderId),
      folderName: config.drive.folderName,
      pollIntervalMinutes: config.drive.pollIntervalMinutes,
      /* Null until the first poll of this process finishes: after a restart
         the line must not claim a last-checked time it does not have. */
      lastPollAt: state.drive.lastPollAt,
      lastPollOutcome: state.drive.lastPollOutcome,
    };
  }

  /**
   * Load-modify-save against the state file as it stands. Reading a snapshot
   * once and writing it back later loses whatever another writer recorded in
   * between — with `ingestedIds` that means re-ingesting files that were
   * already turned into Runs.
   */
  private updateState(mutate: (state: WorkspaceState) => void): void {
    const layout = workspaceLayout(this.deps.workspaceDir);
    const state = loadState(layout.stateFile);
    mutate(state);
    saveState(layout.stateFile, state);
  }

  private async ingestNewFiles(config: AppConfig): Promise<number> {
    const layout = workspaceLayout(this.deps.workspaceDir);
    const ingested = new Set(loadState(layout.stateFile).drive.ingestedIds);

    const drive = this.deps.getDriveClient
      ? this.deps.getDriveClient(config, this.deps.port)
      : buildDriveClient(config, this.deps.port);

    const folderId = config.drive.folderId;
    let pageToken: string | undefined;
    let created = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let response: {
        data?: {
          files?: Array<{
            id?: string;
            name?: string;
            mimeType?: string;
            webViewLink?: string;
            size?: string;
            modifiedTime?: string;
          }>;
          nextPageToken?: string | null;
        };
      } | null = null;
      try {
        response = (await drive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: "nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, size)",
          pageSize: 100,
          pageToken,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        })) as {
          data?: {
            files?: Array<{
              id?: string;
              name?: string;
              mimeType?: string;
              webViewLink?: string;
              size?: string;
              modifiedTime?: string;
            }>;
            nextPageToken?: string | null;
          };
        };
      } catch (error: unknown) {
        try {
          this.deps.google.observe(error);
        } catch {}
        const err = error as {
          code?: number;
          status?: number;
          response?: { status?: number };
          message?: string;
        };
        const status = err?.code ?? err?.status ?? err?.response?.status;
        const message = err?.message ?? String(error);
        if (status === 401) {
          this.deps.log("Drive poll skipped: Google not connected");
          return created;
        }
        if (
          status === 403 ||
          status === 404 ||
          /notFound/i.test(message) ||
          /notAccessible|not_found|File not found/i.test(message)
        ) {
          this.deps.log(`Drive folder not found or not accessible: ${folderId}`);
          return created;
        }
        throw new DriveError(`Drive list failed: ${message}`, status);
      }

      const files: Array<{
        id?: string;
        name?: string;
        mimeType?: string;
        webViewLink?: string;
        size?: string;
        modifiedTime?: string;
      }> = response?.data?.files ?? [];

      const fresh = files.filter(
        (f) => typeof f.id === "string" && typeof f.name === "string" && !ingested.has(f.id),
      );

      for (const file of fresh) {
        const fileId = file.id as string;
        const fileName = file.name as string;
        const mimeType = file.mimeType ?? "";
        const isFolder = mimeType === "application/vnd.google-apps.folder";
        if (isFolder) {
          continue;
        }

        const isGoogleDoc = mimeType === GOOGLE_DOC_MIME;
        if (!isGoogleDoc && !isSupportedFileName(fileName)) {
          this.deps.log(`Ignoring unsupported file ${fileName} (${mimeType || "unknown type"})`);
          continue;
        }

        if (file.size && Number(file.size) > MAX_UPLOAD_BYTES) {
          this.deps.log(`Skipping oversized Drive file ${fileName} (${file.size} bytes)`);
          continue;
        }
        let bytes: Buffer;
        let sourceUrl: string | null = file.webViewLink ?? null;

        try {
          if (isGoogleDoc) {
            const exported = await drive.files.export({ fileId, mimeType: "text/plain" }, {
              responseType: "arraybuffer",
            } as unknown as Record<string, unknown>);
            bytes = toBuffer(exported.data);
            if (bytes.byteLength > MAX_UPLOAD_BYTES) {
              this.deps.log(
                `Skipping oversized Drive file ${fileName} (${bytes.byteLength} bytes)`,
              );
              continue;
            }
          } else {
            const fetched = await drive.files.get({ fileId, alt: "media" }, {
              responseType: "arraybuffer",
            } as unknown as Record<string, unknown>);
            bytes = toBuffer(fetched.data);
            if (bytes.byteLength > MAX_UPLOAD_BYTES) {
              this.deps.log(
                `Skipping oversized Drive file ${fileName} (${bytes.byteLength} bytes)`,
              );
              continue;
            }
          }
        } catch (error: unknown) {
          try {
            this.deps.google.observe(error);
          } catch {}
          this.deps.log(
            `Failed to fetch Drive file ${fileName} (${fileId}): ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        // For Google Docs the Drive name has no extension; add .txt so convertToText can handle it as plain text
        const effectiveName =
          isGoogleDoc && !isSupportedFileName(fileName) ? `${fileName}.txt` : fileName;
        const meetingDate = meetingDateFromFileName(effectiveName);

        try {
          await this.deps.startRun({
            intake: "drive",
            fileName: effectiveName,
            bytes,
            sourceUrl,
            externalId: fileId,
            context: { meetingDate, attendees: [] },
          });
        } catch (error: unknown) {
          try {
            this.deps.google.observe(error);
          } catch {}
          this.deps.log(
            `Pipeline rejected Drive file ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        created += 1;
        ingested.add(fileId);
        /* Recorded only once the Run exists, so a file the pipeline rejected is
           retried on the next poll rather than silently swallowed. */
        this.updateState((state) => {
          if (state.drive.ingestedIds.includes(fileId)) {
            return;
          }
          state.drive.ingestedIds.push(fileId);
          if (state.drive.ingestedIds.length > MAX_INGESTED) {
            state.drive.ingestedIds.splice(0, state.drive.ingestedIds.length - MAX_INGESTED);
          }
        });
      }

      pageToken = response?.data?.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    return created;
  }
}
