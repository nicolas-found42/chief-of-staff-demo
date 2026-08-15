import {
  DEFAULT_SERVICE_URL,
  PROTOCOL_VERSION,
  type ActionResponse,
  type ArtifactSummary,
  type CalendarEvents,
  type ConfigResponse,
  type HealthResponse,
  type ModelsConfig,
  type ProfileConfig,
  type RunDetailResponse,
  type RunSummary,
  type UploadResponse,
  type WorkflowEvent,
  type RunsPageResponse,
} from "@chief-of-staff/contracts";

export interface AppClient {
  token: string | null;
  getBaseUrl(): string;
  setBaseUrl(url: string): void;
  clearToken(): void;
  health(): Promise<HealthResponse>;
  pair(code: string): Promise<void>;
  getConfig(): Promise<ConfigResponse>;
  putProfile(profile: ProfileConfig): Promise<ProfileConfig>;
  putModels(models: ModelsConfig): Promise<ModelsConfig>;
  putCalendar(calendar: CalendarEvents): Promise<CalendarEvents>;
  uploadTranscript(file: File): Promise<UploadResponse>;
  listRuns(): Promise<RunsPageResponse>;
  getRun(runId: string): Promise<RunDetailResponse>;
  cancelRun(runId: string): Promise<ActionResponse>;
  retryRun(runId: string): Promise<ActionResponse>;
  rerunRun(runId: string): Promise<ActionResponse>;
  getArtifact(artifactId: string): Promise<string>;
  streamEvents(
    runId: string,
    after: number,
    onEvent: (event: WorkflowEvent) => void
  ): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const TOKEN_KEY = "chief-of-staff-token";

export class ApiClient implements AppClient {
  token: string | null = null;
  constructor(
    private baseUrl: string = DEFAULT_SERVICE_URL,
    private readonly sessionStorageRef: Storage = window.sessionStorage
  ) {
    this.token = this.sessionStorageRef.getItem(TOKEN_KEY);
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private storeToken(token: string): void {
    this.token = token;
    this.sessionStorageRef.setItem(TOKEN_KEY, token);
  }

  clearToken(): void {
    this.token = null;
    this.sessionStorageRef.removeItem(TOKEN_KEY);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (response.status === 401) {
      this.clearToken();
      throw new ApiError("SESSION_EXPIRED", "The session expired; pair again in Setup.", 401);
    }
    if (!response.ok) {
      let code = "REQUEST_FAILED";
      let message = `Request failed with status ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        // Non-JSON error body; keep the generic message.
      }
      throw new ApiError(code, message, response.status);
    }
    if (response.headers.get("content-type")?.includes("application/json")) {
      return (await response.json()) as T;
    }
    return (await response.text()) as unknown as T;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/v1/health");
  }

  async pair(code: string): Promise<void> {
    const body = await this.request<{ sessionToken: string }>("/v1/pair", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    this.storeToken(body.sessionToken);
  }

  getConfig(): Promise<ConfigResponse> {
    return this.request<ConfigResponse>("/v1/config");
  }

  putProfile(profile: ProfileConfig): Promise<ProfileConfig> {
    return this.request<ProfileConfig>("/v1/config/profile", {
      method: "PUT",
      body: JSON.stringify(profile),
    });
  }

  putModels(models: ModelsConfig): Promise<ModelsConfig> {
    return this.request<ModelsConfig>("/v1/config/models", {
      method: "PUT",
      body: JSON.stringify(models),
    });
  }

  putCalendar(calendar: CalendarEvents): Promise<CalendarEvents> {
    return this.request<CalendarEvents>("/v1/calendar", {
      method: "PUT",
      body: JSON.stringify(calendar),
    });
  }

  uploadTranscript(file: File): Promise<UploadResponse> {
    const form = new FormData();
    form.append("file", file, file.name);
    return this.request<UploadResponse>("/v1/transcripts", {
      method: "POST",
      body: form,
    });
  }

  listRuns(): Promise<RunsPageResponse> {
    return this.request<RunsPageResponse>("/v1/runs");
  }

  getRun(runId: string): Promise<RunDetailResponse> {
    return this.request<RunDetailResponse>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  cancelRun(runId: string): Promise<ActionResponse> {
    return this.request<ActionResponse>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      body: "{}",
    });
  }

  retryRun(runId: string): Promise<ActionResponse> {
    return this.request<ActionResponse>(`/v1/runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST",
      body: "{}",
    });
  }

  rerunRun(runId: string): Promise<ActionResponse> {
    return this.request<ActionResponse>(`/v1/runs/${encodeURIComponent(runId)}/rerun`, {
      method: "POST",
      body: "{}",
    });
  }

  getArtifact(artifactId: string): Promise<string> {
    return this.request<string>(`/v1/artifacts/${encodeURIComponent(artifactId)}`);
  }

  /** NDJSON event stream with replay from `after`; resolves when the stream ends. */
  async streamEvents(
    runId: string,
    after: number,
    onEvent: (event: WorkflowEvent) => void
  ): Promise<void> {
    const headers = new Headers();
    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    const response = await fetch(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events?after=${after}`,
      { headers }
    );
    if (response.status === 401) {
      this.clearToken();
      throw new ApiError("SESSION_EXPIRED", "The session expired; pair again in Setup.", 401);
    }
    if (!response.ok) {
      throw new ApiError("REQUEST_FAILED", `Events request failed (${response.status})`, response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        try {
          onEvent(JSON.parse(line) as WorkflowEvent);
        } catch {
          // Skip malformed lines.
        }
      }
    }
  }
}

export function isProtocolCompatible(health: HealthResponse): boolean {
  return health.protocolVersion === PROTOCOL_VERSION;
}

export type { ArtifactSummary, ConfigResponse, RunSummary };
