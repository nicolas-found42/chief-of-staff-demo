import type {
  GoogleStatus,
  RedactedConfig,
  RunDetail,
  RunSummary,
  SetupCheck,
} from "@chief-of-staff-demo/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
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

export interface ConfigPayload {
  config: RedactedConfig;
  defaults: Record<string, string>;
}

export const api = {
  listRuns: () => request<{ runs: RunSummary[] }>("/api/runs"),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  retry: (id: string) =>
    request<{ status: string }>(`/api/runs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
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
  googleDisconnect: () =>
    request<GoogleStatus>("/api/google/disconnect", { method: "POST" }),
  driveSync: () => request<{ created: number }>("/api/drive/sync", { method: "POST" }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
