import { GUEST_PROFILE_PROVIDER_NAME, type GuestProfileConnectionState } from "../profile/types.js";
import type { ConfigStore } from "../../../config.js";
import { createHttpGuestProfileProvider, type GuestProfileProvider } from "../profile/provider.js";

export interface GuestProfileStatus {
  provider: typeof GUEST_PROFILE_PROVIDER_NAME;
  endpoint: string | null;
  apiKeyHint: string;
  state: GuestProfileConnectionState;
  lastVerifiedAt: string | null;
  lastCheck?: { at: string; state: GuestProfileConnectionState; detail: string } | null;
}

export interface GuestProfileCheckResult {
  state: GuestProfileConnectionState;
  detail: string;
  checkedAt: string;
}

type FetchProbe = (endpoint: string, apiKey: string, signal?: AbortSignal) => Promise<Response>;

function hint(apiKey: string): string {
  return apiKey ? `…${apiKey.slice(-4)}` : "";
}

export class GuestProfileConnection {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly fetchProbe: FetchProbe | null = null,
    private readonly now: () => Date = () => new Date(),
    private readonly providerFactory: (
      endpoint: string,
      apiKey: string,
    ) => GuestProfileProvider = () => createHttpGuestProfileProvider(),
  ) {}

  status(): GuestProfileStatus {
    const cfg = this.configStore.get().modules["meeting-brief-generator"] as unknown as {
      guestProfile?: {
        endpoint: string;
        apiKey: string;
        lastVerifiedAt: string | null;
        lastCheckAt?: string | null;
        lastCheckState?: string | null;
        lastCheckDetail?: string | null;
      };
    };
    const gp = cfg.guestProfile;
    if (!gp || !gp.endpoint || !gp.apiKey) {
      return {
        provider: GUEST_PROFILE_PROVIDER_NAME,
        endpoint: gp?.endpoint ? gp.endpoint : null,
        apiKeyHint: hint(gp?.apiKey ?? ""),
        state: "unconfigured",
        lastVerifiedAt: gp?.lastVerifiedAt ?? null,
        lastCheck: null,
      };
    }
    const state: GuestProfileConnectionState = gp.lastVerifiedAt ? "connected" : "unverified";
    return {
      provider: GUEST_PROFILE_PROVIDER_NAME,
      endpoint: gp.endpoint,
      apiKeyHint: hint(gp.apiKey),
      state,
      lastVerifiedAt: gp.lastVerifiedAt ?? null,
      lastCheck:
        gp.lastCheckAt && gp.lastCheckState
          ? {
              at: gp.lastCheckAt,
              state: gp.lastCheckState as GuestProfileConnectionState,
              detail: gp.lastCheckDetail ?? "",
            }
          : null,
    };
  }

  connect(endpoint: string, apiKey: string): GuestProfileStatus {
    const trimmedEndpoint = endpoint.trim();
    const trimmedKey = apiKey.trim();
    if (!trimmedEndpoint) throw new Error("Guest Profile provider endpoint is required.");
    if (!trimmedKey) throw new Error("Guest Profile API key is required.");
    let url: URL;
    try {
      url = new URL(trimmedEndpoint);
    } catch {
      throw new Error("Guest Profile endpoint must be a valid URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Guest Profile endpoint must be http or https.");
    }
    const current = this.configStore.get();
    const next = {
      ...current.modules["meeting-brief-generator"],
      guestProfile: {
        endpoint: trimmedEndpoint,
        apiKey: trimmedKey,
        lastVerifiedAt:
          (
            current.modules["meeting-brief-generator"] as unknown as {
              guestProfile?: { lastVerifiedAt: string | null };
            }
          ).guestProfile?.lastVerifiedAt ?? null,
        lastCheckAt: null,
        lastCheckState: null,
        lastCheckDetail: null,
      },
      hubspot: (current.modules["meeting-brief-generator"] as unknown as { hubspot?: unknown })
        .hubspot ?? { token: "", lastVerifiedAt: null },
    };
    this.configStore.setModuleConfig("meeting-brief-generator", next as never);
    return this.status();
  }

  disconnect(): GuestProfileStatus {
    const current = this.configStore.get();
    const next = {
      ...current.modules["meeting-brief-generator"],
      guestProfile: {
        endpoint: "",
        apiKey: "",
        lastVerifiedAt: null,
        lastCheckAt: null,
        lastCheckState: null,
        lastCheckDetail: null,
      },
      hubspot: (current.modules["meeting-brief-generator"] as unknown as { hubspot?: unknown })
        .hubspot ?? { token: "", lastVerifiedAt: null },
    };
    this.configStore.setModuleConfig("meeting-brief-generator", next as never);
    return this.status();
  }

  private probeFetch(endpoint: string, apiKey: string, signal?: AbortSignal): Promise<Response> {
    if (this.fetchProbe) return this.fetchProbe(endpoint, apiKey, signal);
    const url = `${endpoint.replace(/\/$/, "")}/health`;
    const init: RequestInit = {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    };
    if (signal) init.signal = signal;
    return fetch(url, init);
  }

  async verifySetup(): Promise<GuestProfileCheckResult> {
    const s = this.status();
    if (s.state === "unconfigured") {
      return {
        state: "unconfigured",
        detail: "Guest Profile endpoint and API key are not configured.",
        checkedAt: this.now().toISOString(),
      };
    }
    const cfg = this.configStore.get().modules["meeting-brief-generator"] as unknown as {
      guestProfile: { endpoint: string; apiKey: string; lastVerifiedAt: string | null };
    };
    const endpoint = cfg.guestProfile.endpoint;
    const apiKey = cfg.guestProfile.apiKey;
    const checkedAt = this.now().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await this.probeFetch(endpoint, apiKey, controller.signal);
      clearTimeout(timeout);
      let state: GuestProfileConnectionState;
      let detail: string;
      if (res.status === 200) {
        // Bounded read-only probe — provider healthy. Try to distinguish empty vs data but both are healthy.
        // We do not consume body beyond status; health is enough. Mark lastVerifiedAt.
        state = "connected";
        detail = "Guest Profile provider accepted the credential and is reachable.";
        const current = this.configStore.get();
        const existing = current.modules["meeting-brief-generator"] as unknown as {
          guestProfile: {
            endpoint: string;
            apiKey: string;
            lastVerifiedAt: string | null;
            lastCheckAt?: string | null;
            lastCheckState?: string | null;
            lastCheckDetail?: string | null;
          };
        };
        this.configStore.setModuleConfig("meeting-brief-generator", {
          ...current.modules["meeting-brief-generator"],
          guestProfile: {
            endpoint: existing.guestProfile.endpoint,
            apiKey: existing.guestProfile.apiKey,
            lastVerifiedAt: checkedAt,
            lastCheckAt: checkedAt,
            lastCheckState: state,
            lastCheckDetail: detail,
          },
          hubspot: (current.modules["meeting-brief-generator"] as unknown as { hubspot?: unknown })
            .hubspot ?? { token: "", lastVerifiedAt: null },
        } as never);
      } else if (res.status === 401) {
        state = "rejected";
        detail = "Guest Profile credential was rejected (401). Check the API key.";
      } else if (res.status === 403) {
        state = "missing_authority";
        detail = "Guest Profile credential lacks required authority (403).";
      } else if (res.status === 502 || res.status === 503 || res.status === 504) {
        state = "unavailable";
        detail = `Guest Profile provider is unavailable (${res.status}).`;
      } else {
        state = "unavailable";
        detail = `Guest Profile probe failed with ${res.status}.`;
      }
      if (state !== "connected") {
        const current = this.configStore.get();
        const existing = current.modules["meeting-brief-generator"] as unknown as {
          guestProfile: { endpoint: string; apiKey: string; lastVerifiedAt: string | null };
        };
        this.configStore.setModuleConfig("meeting-brief-generator", {
          ...current.modules["meeting-brief-generator"],
          guestProfile: {
            endpoint: existing.guestProfile.endpoint,
            apiKey: existing.guestProfile.apiKey,
            lastVerifiedAt: existing.guestProfile.lastVerifiedAt,
            lastCheckAt: checkedAt,
            lastCheckState: state,
            lastCheckDetail: detail,
          },
        });
      }
      return { state, detail, checkedAt };
    } catch (e) {
      clearTimeout(timeout);
      const message = e instanceof Error ? e.message : String(e);
      const isAbort = message.toLowerCase().includes("abort");
      const state: GuestProfileConnectionState = "unavailable";
      const detail = isAbort
        ? "Guest Profile probe timed out."
        : `Guest Profile is unreachable: ${message}`;
      const current = this.configStore.get();
      const existing = current.modules["meeting-brief-generator"] as unknown as {
        guestProfile: { endpoint: string; apiKey: string; lastVerifiedAt: string | null };
      };
      this.configStore.setModuleConfig("meeting-brief-generator", {
        ...current.modules["meeting-brief-generator"],
        guestProfile: {
          endpoint: existing.guestProfile.endpoint,
          apiKey: existing.guestProfile.apiKey,
          lastVerifiedAt: existing.guestProfile.lastVerifiedAt,
          lastCheckAt: checkedAt,
          lastCheckState: state,
          lastCheckDetail: detail,
        },
      });
      return { state, detail, checkedAt };
    }
  }

  providerForCurrentConfig(): GuestProfileProvider | null {
    const s = this.status();
    if (s.state === "unconfigured" || !s.endpoint) return null;
    const cfg = this.configStore.get().modules["meeting-brief-generator"] as unknown as {
      guestProfile: { endpoint: string; apiKey: string };
    };
    return this.providerFactory(cfg.guestProfile.endpoint, cfg.guestProfile.apiKey);
  }
}
