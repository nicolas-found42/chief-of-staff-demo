import type {
  DriveIntakeStatus,
  GoogleStatus,
  RedactedConfig,
  RunDetail,
  RunPage,
  SetupCheck,
  YoutubeChannel,
  YoutubeTrends,
} from "@chief-of-staff-demo/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

async function requestText(path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new ApiError(response.status, message);
  }
  return await response.text();
}

export interface ConfigPayload {
  config: RedactedConfig;
  defaults: Record<string, string>;
}

/** What the Runs list asks for: one Module's Runs or every Module's, a page at a time. */
export interface RunListQuery {
  module?: string;
  limit?: number;
  cursor?: string | null;
}

function runsPath(query: RunListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.module) {
    params.set("module", query.module);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query.cursor) {
    params.set("cursor", query.cursor);
  }
  const search = params.toString();
  return search ? `/api/runs?${search}` : "/api/runs";
}

export const api = {
  listRuns: (query?: RunListQuery) => request<RunPage>(runsPath(query)),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  retry: (id: string) =>
    request<{ status: string }>(`/api/runs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  getArtifact: (runId: string, name: string) =>
    requestText(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`),
  getConfig: () => request<ConfigPayload>("/api/config"),
  saveConfig: (update: Record<string, unknown>) =>
    request<ConfigPayload>("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }),
  googleStatus: () => request<GoogleStatus>("/api/google/status"),
  googleCheck: () => request<SetupCheck>("/api/google/check", { method: "POST" }),
  googleConnect: () => request<{ authUrl: string }>("/api/google/connect"),
  googleDisconnect: () => request<GoogleStatus>("/api/google/disconnect", { method: "POST" }),
  googlePickerToken: () =>
    request<{ token: string; expiresAt: string | null }>("/api/google/picker-token"),
  driveSync: () => request<{ created: number }>("/api/drive/sync", { method: "POST" }),
  /* Remembered intake facts only (D14): the endpoint makes zero Google calls. */
  driveIntakeStatus: () => request<DriveIntakeStatus>("/api/intake/drive"),
  /* Derived from the Runs on disk, so it answers while Google is expired. */
  youtubeTrends: () => request<YoutubeTrends>("/api/youtube/trends"),
  addYoutubeChannel: (url: string) =>
    request<{ channel: YoutubeChannel }>("/api/youtube/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  removeYoutubeChannel: (id: string) =>
    request<{ removed: string }>(`/api/youtube/channels/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  runYoutubeNow: () => request<{ runId: string }>("/api/youtube/run", { method: "POST" }),
  createYoutubeSpreadsheet: () =>
    request<{ spreadsheet: { id: string; url: string } }>("/api/youtube/spreadsheet", {
      method: "POST",
    }),
  ideaEngineIdeas: () =>
    request<import("@chief-of-staff-demo/shared").IdeaEngineIndex>("/api/idea-engine/ideas"),
  ideaEngineBackfill: () =>
    request<{ created: number; skipped: number }>("/api/idea-engine/backfill", { method: "POST" }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
