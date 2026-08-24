import { google } from "googleapis";
import type { AppConfig } from "@chief-of-staff-demo/shared";
import { buildGoogleAuth } from "../../google/oauth.js";
import type { GoogleConnection } from "../../google/connection.js";
import { hasSeenForModule, loadState, rememberSeenForModule } from "../../state.js";
import { workspaceLayout } from "../../paths.js";
import { isSupportedFileName, MAX_UPLOAD_BYTES } from "../../text/convert.js";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const IDEA_ENGINE_MODULE_ID = "idea-engine";

function toBuffer(data: unknown): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data && typeof (data as { byteLength?: unknown }).byteLength === "number") {
    return Buffer.from(data as unknown as ArrayBuffer);
  }
  if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint") {
    return Buffer.from(String(data), "utf8");
  }
  if (data === null || data === undefined) return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(data), "utf8");
}

class DriveError extends Error {
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
    list: (params: Record<string, unknown>) => Promise<{
      data?: {
        files?: Array<{
          id?: string;
          name?: string;
          mimeType?: string;
          webViewLink?: string;
          size?: string;
        }>;
        nextPageToken?: string | null;
      };
    }>;
    get: (
      params: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => Promise<{ data: unknown }>;
    export: (
      params: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => Promise<{ data: unknown }>;
  };
}

export interface IdeaEngineIntakeDeps {
  getConfig: () => AppConfig;
  workspaceDir: string;
  port: number;
  startRun: (spec: {
    fileName: string;
    bytes: Buffer;
    sourceUrl: string | null;
    externalId: string;
  }) => Promise<string>;
  log: (message: string) => void;
  google: GoogleConnection;
  getDriveClient?: (config: AppConfig, port: number) => DriveFileClient;
}

function buildDriveClient(config: AppConfig, port: number): DriveFileClient {
  const auth = buildGoogleAuth(config, port);
  return google.drive({ version: "v3", auth }) as unknown as DriveFileClient;
}

export class IdeaEngineIntake {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<{ created: number }> | null = null;

  constructor(private readonly deps: IdeaEngineIntakeDeps) {}

  start(): void {
    this.stop();
    const config = this.deps.getConfig();
    if (!config.drive.enabled || !config.drive.folderId) return;
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
      this.deps.log(
        `IdeaEngine poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async pollOnce(): Promise<{ created: number }> {
    if (this.inFlight) return this.inFlight;
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
      if (!config.drive.enabled || !config.drive.folderId) return { created: 0 };
      const status = await this.deps.google.state();
      if (status.state !== "connected") {
        this.deps.log(`IdeaEngine poll skipped: ${status.state}`);
        return { created: 0 };
      }
      const created = await this.ingestNewFiles(config);
      return { created };
    } catch (error) {
      try {
        this.deps.google.observe(error);
      } catch {
        // classify must not replace failure
      }
      throw error;
    }
  }

  private async ingestNewFiles(config: AppConfig): Promise<number> {
    const layout = workspaceLayout(this.deps.workspaceDir);
    // Namespaced hasSeen: read ideaEngine ingestedIds
    const ingested = new Set(loadState(layout.stateFile).ideaEngine.ingestedIds);

    const drive = this.deps.getDriveClient
      ? this.deps.getDriveClient(config, this.deps.port)
      : buildDriveClient(config, this.deps.port);

    const folderId = config.drive.folderId;
    let pageToken: string | undefined;
    let created = 0;

    for (;;) {
      let response: {
        data?: {
          files?: Array<{
            id?: string;
            name?: string;
            mimeType?: string;
            webViewLink?: string;
            size?: string;
          }>;
          nextPageToken?: string | null;
        };
      };
      try {
        response = await drive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: "nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, size)",
          pageSize: 100,
          ...(pageToken === undefined ? {} : { pageToken }),
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
      } catch (error: unknown) {
        try {
          this.deps.google.observe(error);
        } catch {
          void 0;
        }
        const err = error as {
          code?: number;
          status?: number;
          response?: { status?: number };
          message?: string;
        };
        const status = err.code ?? err.status ?? err.response?.status;
        const message = err.message ?? String(error);
        if (status === 401) {
          this.deps.log("IdeaEngine Drive poll skipped: Google not connected");
          return created;
        }
        if (
          status === 403 ||
          status === 404 ||
          /notFound/i.test(message) ||
          /notAccessible|not_found|File not found/i.test(message)
        ) {
          this.deps.log(`IdeaEngine Drive folder not found or not accessible: ${folderId}`);
          return created;
        }
        throw new DriveError(`Drive list failed: ${message}`, status);
      }

      const files = response.data?.files ?? [];
      const fresh = files.filter(
        (f) => typeof f.id === "string" && typeof f.name === "string" && !ingested.has(f.id),
      );

      for (const file of fresh) {
        const fileId = file.id as string;
        const fileName = file.name as string;
        const mimeType = file.mimeType ?? "";
        const isFolder = mimeType === "application/vnd.google-apps.folder";
        if (isFolder) continue;
        const isGoogleDoc = mimeType === GOOGLE_DOC_MIME;
        if (!isGoogleDoc && !isSupportedFileName(fileName)) {
          this.deps.log(
            `IdeaEngine ignoring unsupported file ${fileName} (${mimeType || "unknown type"})`,
          );
          continue;
        }
        if (file.size && Number(file.size) > MAX_UPLOAD_BYTES) {
          this.deps.log(
            `IdeaEngine skipping oversized Drive file ${fileName} (${file.size} bytes)`,
          );
          continue;
        }
        let bytes: Buffer;
        const sourceUrl: string | null = file.webViewLink ?? null;
        try {
          if (isGoogleDoc) {
            const exported = await drive.files.export(
              { fileId, mimeType: "text/plain" },
              { responseType: "arraybuffer" },
            );
            bytes = toBuffer(exported.data);
            if (bytes.byteLength > MAX_UPLOAD_BYTES) {
              this.deps.log(
                `IdeaEngine skipping oversized Drive file ${fileName} (${bytes.byteLength} bytes)`,
              );
              continue;
            }
          } else {
            const fetched = await drive.files.get(
              { fileId, alt: "media" },
              { responseType: "arraybuffer" },
            );
            bytes = toBuffer(fetched.data);
            if (bytes.byteLength > MAX_UPLOAD_BYTES) {
              this.deps.log(
                `IdeaEngine skipping oversized Drive file ${fileName} (${bytes.byteLength} bytes)`,
              );
              continue;
            }
          }
        } catch (error: unknown) {
          try {
            this.deps.google.observe(error);
          } catch {
            void 0;
          }
          this.deps.log(
            `IdeaEngine failed to fetch Drive file ${fileName} (${fileId}): ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        const effectiveName =
          isGoogleDoc && !isSupportedFileName(fileName) ? `${fileName}.txt` : fileName;

        try {
          await this.deps.startRun({
            fileName: effectiveName,
            bytes,
            sourceUrl,
            externalId: fileId,
          });
        } catch (error: unknown) {
          try {
            this.deps.google.observe(error);
          } catch {
            void 0;
          }
          this.deps.log(
            `IdeaEngine rejected Drive file ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        created += 1;
        ingested.add(fileId);
        // Load-modify-save guarded remember, namespaced
        const stateFile = layout.stateFile;
        // Use helper to ensure FIFO cap
        rememberSeenForModule(stateFile, IDEA_ENGINE_MODULE_ID, fileId);
      }

      pageToken = response.data?.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    return created;
  }

  /**
   * Backfill: enumerate Drive folder and create runs for files not yet ingested by idea-engine.
   * Respects hasSeen and existing Run externalId.
   */
  async backfill(existingExternalIds: Set<string>): Promise<{ created: number; skipped: number }> {
    const config = this.deps.getConfig();
    if (!config.drive.enabled || !config.drive.folderId) return { created: 0, skipped: 0 };
    const drive = this.deps.getDriveClient
      ? this.deps.getDriveClient(config, this.deps.port)
      : buildDriveClient(config, this.deps.port);
    const folderId = config.drive.folderId;
    let pageToken: string | undefined;
    let created = 0;
    let skipped = 0;
    const layout = workspaceLayout(this.deps.workspaceDir);

    for (;;) {
      let response: {
        data?: {
          files?: Array<{
            id?: string;
            name?: string;
            mimeType?: string;
            webViewLink?: string;
            size?: string;
          }>;
          nextPageToken?: string | null;
        };
      };
      try {
        response = await drive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: "nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, size)",
          pageSize: 100,
          ...(pageToken === undefined ? {} : { pageToken }),
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
      } catch (error: unknown) {
        throw new DriveError(
          `Drive list failed for backfill: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const files = response.data?.files ?? [];
      for (const file of files) {
        const fileId = file.id;
        const fileName = file.name;
        if (!fileId || !fileName) continue;
        const mimeType = file.mimeType ?? "";
        if (mimeType === "application/vnd.google-apps.folder") continue;
        const isGoogleDoc = mimeType === GOOGLE_DOC_MIME;
        if (!isGoogleDoc && !isSupportedFileName(fileName)) continue;
        // Respect hasSeen namespaced and existing Run externalId
        if (hasSeenForModule(layout.stateFile, IDEA_ENGINE_MODULE_ID, fileId)) {
          skipped += 1;
          continue;
        }
        if (existingExternalIds.has(fileId)) {
          skipped += 1;
          continue;
        }
        // Fetch bytes
        let bytes: Buffer;
        const sourceUrl: string | null = file.webViewLink ?? null;
        try {
          if (isGoogleDoc) {
            const exported = await drive.files.export(
              { fileId, mimeType: "text/plain" },
              { responseType: "arraybuffer" },
            );
            bytes = toBuffer(exported.data);
          } else {
            const fetched = await drive.files.get(
              { fileId, alt: "media" },
              { responseType: "arraybuffer" },
            );
            bytes = toBuffer(fetched.data);
          }
        } catch {
          skipped += 1;
          continue;
        }
        const effectiveName =
          isGoogleDoc && !isSupportedFileName(fileName) ? `${fileName}.txt` : fileName;
        try {
          await this.deps.startRun({
            fileName: effectiveName,
            bytes,
            sourceUrl,
            externalId: fileId,
          });
          rememberSeenForModule(layout.stateFile, IDEA_ENGINE_MODULE_ID, fileId);
          created += 1;
        } catch {
          skipped += 1;
        }
      }
      pageToken = response.data?.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    return { created, skipped };
  }
}
