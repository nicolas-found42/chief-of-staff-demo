import {
  GUEST_PROFILE_PROVIDER_NAME,
  MEETING_BRIEF_MODULE_ID,
  type AppConfig,
  type GuestProfileCheckResult,
  type GuestProfileConnectionState,
  type GuestProfileStatus,
} from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../../../config.js";
import { createHttpGuestProfileProvider, type GuestProfileProvider } from "../profile/provider.js";

type FetchProbe = (endpoint: string, apiKey: string, signal?: AbortSignal) => Promise<Response>;
type GuestProfileConfig = AppConfig["modules"]["meeting-brief-generator"]["guestProfile"];

function hint(apiKey: string): string {
  return apiKey ? `…${apiKey.slice(-4)}` : "";
}

function connectionState(value: string | null): GuestProfileConnectionState | null {
  if (
    value === "unconfigured" ||
    value === "connected" ||
    value === "unverified" ||
    value === "rejected" ||
    value === "missing_authority" ||
    value === "unavailable"
  ) {
    return value;
  }
  return null;
}

export class GuestProfileConnection {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly fetchProbe: FetchProbe | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  status(): GuestProfileStatus {
    const profile = this.currentConfig();
    const lastCheckState = connectionState(profile.lastCheckState);
    if (!profile.endpoint || !profile.apiKey) {
      return {
        provider: GUEST_PROFILE_PROVIDER_NAME,
        endpoint: profile.endpoint || null,
        apiKeyHint: hint(profile.apiKey),
        state: "unconfigured",
        lastVerifiedAt: profile.lastVerifiedAt,
        lastCheck: null,
      };
    }
    const state: GuestProfileConnectionState = profile.lastVerifiedAt ? "connected" : "unverified";
    return {
      provider: GUEST_PROFILE_PROVIDER_NAME,
      endpoint: profile.endpoint,
      apiKeyHint: hint(profile.apiKey),
      state,
      lastVerifiedAt: profile.lastVerifiedAt,
      lastCheck:
        profile.lastCheckAt && lastCheckState
          ? {
              at: profile.lastCheckAt,
              state: lastCheckState,
              detail: profile.lastCheckDetail ?? "",
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
    this.saveConfig({
      ...this.currentConfig(),
      endpoint: trimmedEndpoint,
      apiKey: trimmedKey,
      lastCheckAt: null,
      lastCheckState: null,
      lastCheckDetail: null,
    });
    return this.status();
  }

  disconnect(): GuestProfileStatus {
    this.saveConfig({
      endpoint: "",
      apiKey: "",
      lastVerifiedAt: null,
      lastCheckAt: null,
      lastCheckState: null,
      lastCheckDetail: null,
    });
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
    if (this.status().state === "unconfigured") {
      return {
        state: "unconfigured",
        detail: "Guest Profile endpoint and API key are not configured.",
        checkedAt: this.now().toISOString(),
      };
    }
    const config = this.currentConfig();
    const checkedAt = this.now().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await this.probeFetch(config.endpoint, config.apiKey, controller.signal);
      clearTimeout(timeout);
      let state: GuestProfileConnectionState;
      let detail: string;
      if (response.status === 200) {
        state = "connected";
        detail = "Guest Profile provider accepted the credential and is reachable.";
        this.saveCheck(state, detail, checkedAt, checkedAt);
      } else if (response.status === 401) {
        state = "rejected";
        detail = "Guest Profile credential was rejected (401). Check the API key.";
      } else if (response.status === 403) {
        state = "missing_authority";
        detail = "Guest Profile credential lacks required authority (403).";
      } else if (response.status === 502 || response.status === 503 || response.status === 504) {
        state = "unavailable";
        detail = `Guest Profile provider is unavailable (${response.status}).`;
      } else {
        state = "unavailable";
        detail = `Guest Profile probe failed with ${response.status}.`;
      }
      if (state !== "connected") {
        this.saveCheck(state, detail, checkedAt, config.lastVerifiedAt);
      }
      return { state, detail, checkedAt };
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      const state: GuestProfileConnectionState = "unavailable";
      const detail = message.toLowerCase().includes("abort")
        ? "Guest Profile probe timed out."
        : `Guest Profile is unreachable: ${message}`;
      this.saveCheck(state, detail, checkedAt, config.lastVerifiedAt);
      return { state, detail, checkedAt };
    }
  }

  providerForCurrentConfig(): GuestProfileProvider | null {
    if (this.status().state === "unconfigured") return null;
    return createHttpGuestProfileProvider();
  }

  private currentConfig(): GuestProfileConfig {
    return this.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID).guestProfile;
  }

  private saveConfig(guestProfile: GuestProfileConfig): void {
    const moduleConfig = this.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID);
    this.configStore.setModuleConfig(MEETING_BRIEF_MODULE_ID, { ...moduleConfig, guestProfile });
  }

  private saveCheck(
    state: GuestProfileConnectionState,
    detail: string,
    checkedAt: string,
    lastVerifiedAt: string | null,
  ): void {
    this.saveConfig({
      ...this.currentConfig(),
      lastVerifiedAt,
      lastCheckAt: checkedAt,
      lastCheckState: state,
      lastCheckDetail: detail,
    });
  }
}
