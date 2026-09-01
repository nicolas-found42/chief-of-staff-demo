import type {
  BrandProfileRevision,
  BrandProfileProposal,
  ContentDraft,
  ContentPack,
  ContentResearchIndex,
  ContentShortlist,
  DriveIntakeStatus,
  GoogleStatus,
  GuestProfileCheckResult,
  GuestProfileStatus,
  HubSpotSetupCheck,
  HubSpotStatus,
  MeetingBriefIndex,
  MeetingBriefPersonProfileReadModel,
  NamedPerson,
  PersonSuggestion,
  RedactedConfig,
  RunDetail,
  RunPage,
  SetupCheck,
  SourceAdapterCanaryTarget,
  SourceAdapterState,
  SourceBackfillWindowDays,
  SourceCanaryHealth,
  SourceCanaryReceipt,
  PersonProfile,
  PersonProfileCorrectionInput,
  PersonProfileCreateInput,
  PersonProfileDetachInput,
  PersonProfileMergeInput,
  PersonProfileProjection,
  PersonProfileProjectionPurpose,
  SourceCapability,
  SourceDiagnosticClassification,
  ContentScoutScheduleState,
  ContentScoutStorageUse,
  ContentScoutCleanupPreview,
  ContentScoutCleanupReceipt,
  ContentScoutRuntimeCapability,
  SourceSuggestion,
  SourceTarget,
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
      const body = (await response.json()) as { error?: string; message?: string };
      if (body.message) {
        message = body.message;
      } else if (body.error) {
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

export interface ContentScoutState {
  brandProfile: BrandProfileRevision | null;
  brandProfileProposal: BrandProfileProposal | null;
  sourceTargets: SourceTarget[];
  shortlist: ContentShortlist | null;
  contentPacks: ContentPack[];
  adapters: {
    id: string;
    state: SourceAdapterState;
    version: string;
    backfillWindowsDays: SourceBackfillWindowDays[];
    canaryTargets: SourceAdapterCanaryTarget[];
    promotionEligible: boolean;
  }[];
  runtimeCapabilities: ContentScoutRuntimeCapability[];
  storage: ContentScoutStorageUse;
  notion: { state: string; tokenHint: string; lastVerifiedAt: string | null };
  settings: {
    timeZone: string;
    dailyTime: string;
    weeklyDiscoveryDay: number;
    weeklyDiscoveryTime: string;
    shortlistSize: number;
    canaryIntervalHours: number;
    canaryDisabledAdapters: string[];
    notion: {
      databaseId: string;
      dataSourceId: string;
      databaseUrl: string;
      mapping: {
        name: string;
        status: string;
        platform: string;
        format: string;
        scheduledDate: string;
      };
    };
  } | null;
  sourceSuggestions: SourceSuggestion[];
  schedule: ContentScoutScheduleState;
  health: {
    runId: string | null;
    warnings: {
      adapterId: string;
      targetId: string | null;
      outcome: SourceDiagnosticClassification;
      affectedCapabilities: SourceCapability[];
    }[];
    runtimeWarnings: string[];
    canary: SourceCanaryHealth[];
  };
  canary: {
    receipts: SourceCanaryReceipt[];
    health: SourceCanaryHealth[];
  };
  linkedinEvidenceGate: {
    passed: boolean;
    reason?: string;
    adapterVersion: string | null;
    checkedAt: string;
    requiredTargets: number;
    repeatsPerTarget: number;
    representativeTargets: readonly string[];
    evidence: readonly {
      targetUrl: string;
      adapterVersion: string;
      outcome: SourceDiagnosticClassification;
      itemsFound: number;
      hasUsefulItem: boolean;
      observedAt: string;
    }[];
  };
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
  meetingBriefProfileConsumers: (runId: string) =>
    request<MeetingBriefPersonProfileReadModel>(
      `/api/meeting-brief/runs/${encodeURIComponent(runId)}/profile-consumers`,
    ),
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
  contentScout: () => request<ContentScoutState>("/api/content-scout"),
  saveBrandProfile: (input: {
    markdown: string;
    websiteUrl: string;
    includedUrls: string[];
    excludedUrls: string[];
    note?: string;
  }) =>
    request<{ revision: BrandProfileRevision }>("/api/content-scout/brand-profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  scanBrandProfile: (websiteUrl: string) =>
    request<{ runId: string }>("/api/content-scout/brand-profile/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ websiteUrl }),
    }),
  acceptBrandProfileProposal: (
    id: string,
    input: {
      acceptedSections: string[];
      includedUrls: string[];
      excludedUrls: string[];
      note?: string;
    },
  ) =>
    request<{ revision: BrandProfileRevision }>(
      `/api/content-scout/brand-profile/proposals/${encodeURIComponent(id)}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  addContentSource: (input: { adapterId: string; label: string; url: string }) =>
    request<{ target: SourceTarget }>("/api/content-scout/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  setContentSourceState: (id: string, state: "active" | "archived") =>
    request<{ target: SourceTarget }>(`/api/content-scout/sources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    }),
  backfillContentSource: (id: string, windowDays: SourceBackfillWindowDays) =>
    request<{ runId: string }>(`/api/content-scout/sources/${encodeURIComponent(id)}/backfill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowDays }),
    }),
  runContentScout: () => request<{ runId: string }>("/api/content-scout/run", { method: "POST" }),
  selectContentScout: (runId: string, opportunityIds: string[]) =>
    request<{ status: string }>(
      `/api/content-scout/shortlists/${encodeURIComponent(runId)}/select`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opportunityIds }),
      },
    ),
  skipContentScout: (runId: string) =>
    request<{ status: string }>(`/api/content-scout/shortlists/${encodeURIComponent(runId)}/skip`, {
      method: "POST",
    }),
  decideContentOpportunity: (
    runId: string,
    opportunityId: string,
    decision: "dismiss_angle" | "not_relevant" | "already_covered",
  ) =>
    request<{ shortlist: ContentShortlist }>(
      `/api/content-scout/shortlists/${encodeURIComponent(runId)}/opportunities/${encodeURIComponent(opportunityId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      },
    ),
  contentDraft: (packId: string, targetId: string) =>
    request<{ draft: ContentDraft; notionPage: { id: string; url: string } | null }>(
      `/api/content-scout/packs/${encodeURIComponent(packId)}/drafts/${encodeURIComponent(targetId)}`,
    ),
  connectNotion: (token: string) =>
    request<{ state: string; tokenHint: string; lastVerifiedAt: string | null }>(
      "/api/content-scout/notion/connect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      },
    ),
  disconnectNotion: () =>
    request<{ state: string; tokenHint: string; lastVerifiedAt: string | null }>(
      "/api/content-scout/notion/disconnect",
      { method: "POST" },
    ),
  configureNotionCalendar: (
    input:
      | { mode: "create"; parentPageId: string }
      | {
          mode: "existing";
          databaseId: string;
          dataSourceId: string;
          databaseUrl: string;
          mapping: {
            name: string;
            status: string;
            platform: string;
            format: string;
            scheduledDate: string;
          };
        },
  ) =>
    request<{ notion: NonNullable<ContentScoutState["settings"]>["notion"] }>(
      "/api/content-scout/notion/calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  runSourceDiscovery: () =>
    request<{ runId: string }>("/api/content-scout/discovery/run", { method: "POST" }),
  decideSourceSuggestion: (
    id: string,
    decision: "approved" | "dismissed" | "proposed",
    reason: string | null = null,
  ) =>
    request<{ suggestion: SourceSuggestion }>(
      `/api/content-scout/suggestions/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason }),
      },
    ),
  saveContentScoutSchedule: (input: {
    timeZone: string;
    dailyTime: string;
    weeklyDiscoveryDay: number;
    weeklyDiscoveryTime: string;
    shortlistSize: number;
    canaryIntervalHours: number;
    canaryDisabledAdapters: string[];
  }) =>
    request<ContentScoutState>("/api/content-scout/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  previewContentScoutCleanup: () =>
    request<ContentScoutCleanupPreview>("/api/content-scout/storage/cleanup/preview", {
      method: "POST",
    }),
  cleanupContentScoutTemporaryData: () =>
    request<ContentScoutCleanupReceipt>("/api/content-scout/storage/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "expired_temporary_data", confirm: true }),
    }),
  runCanaries: () =>
    request<{ receipts: SourceCanaryReceipt[] }>("/api/content-scout/canary/run", {
      method: "POST",
    }),
  getCanaries: () =>
    request<{ receipts: SourceCanaryReceipt[]; health: SourceCanaryHealth[] }>(
      "/api/content-scout/canary",
    ),
  // Relay status — issue://80 Settings (relay/channel status + last wake-up, no secrets) + ADR-0031
  relayStatus: () =>
    request<{
      installationId: string | null;
      relayBaseUrl: string | null;
      relayHealth: "ok" | "unreachable" | "not_configured";
      channels: Array<{ channelId: string; expiration: string | null; resourceId: string | null }>;
      lastWakeUpAt: string | null;
      hasSecret: boolean;
    }>("/api/relay/status"),
  relayInstall: (relayBaseUrl?: string) =>
    request<{
      installationId: string | null;
      relayBaseUrl: string | null;
      channels: Array<{ channelId: string; expiration: string | null }>;
      lastWakeUpAt: string | null;
    }>("/api/relay/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(relayBaseUrl ? { relayBaseUrl } : {}),
    }),
  relayPoll: () =>
    request<{ messages: unknown[]; lastWakeUpAt: string | null }>("/api/relay/poll", {
      method: "POST",
    }),
  hubspotStatus: () => request<HubSpotStatus>("/api/meeting-brief/hubspot/status"),
  hubspotConnect: (token: string) =>
    request<HubSpotStatus>("/api/meeting-brief/hubspot/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  hubspotDisconnect: () =>
    request<HubSpotStatus>("/api/meeting-brief/hubspot/disconnect", { method: "POST" }),
  hubspotCheck: () =>
    request<HubSpotSetupCheck>("/api/meeting-brief/hubspot/check", { method: "POST" }),
  guestProfileStatus: () => request<GuestProfileStatus>("/api/meeting-brief/guest-profile/status"),
  guestProfileConnect: (endpoint: string, apiKey: string) =>
    request<GuestProfileStatus>("/api/meeting-brief/guest-profile/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint, apiKey }),
    }),
  guestProfileDisconnect: () =>
    request<GuestProfileStatus>("/api/meeting-brief/guest-profile/disconnect", { method: "POST" }),
  guestProfileCheck: () =>
    request<GuestProfileCheckResult>("/api/meeting-brief/guest-profile/check", { method: "POST" }),
  meetingBriefConfig: () => request<{ internalDomains: string[] }>("/api/meeting-brief/config"),
  saveMeetingBriefConfig: (input: string[] | { internalDomains?: string[] }) =>
    request<{ internalDomains: string[] }>("/api/meeting-brief/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Array.isArray(input) ? { internalDomains: input } : input),
    }),
  meetingBriefIndex: () => request<MeetingBriefIndex>("/api/meeting-brief/index"),
  reconcileMeetingBrief: (forceFullSync = false) =>
    request<{
      scheduled: number;
      removed: number;
      invalidSyncRecovered: boolean;
      upcoming: unknown[];
    }>("/api/meeting-brief/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ forceFullSync }),
    }),
  prepareMeetingBriefNow: (occurrenceKey: string) =>
    request<{ runId: string | null; upcoming: unknown[] }>("/api/meeting-brief/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ occurrenceKey }),
    }),
  meetingBriefCalendarStatus: () =>
    request<{
      channel: {
        channelId: string;
        resourceId: string | null;
        expiration: string | null;
        calendarId: string;
      } | null;
      syncToken: string | null;
      hasToken: boolean;
      lastSyncAt: string | null;
    }>("/api/meeting-brief/calendar/status"),
  contentResearchIndex: () => request<ContentResearchIndex>("/api/content-research/index"),
  contentResearchPeople: () => request<NamedPerson[]>("/api/content-research/people"),
  addContentResearchPerson: (name: string, handleHints?: NamedPerson["handleHints"]) =>
    request<NamedPerson>("/api/content-research/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(handleHints ? { name, handleHints } : { name }),
    }),
  stopWatchingContentResearchPerson: (id: string) =>
    request<NamedPerson>(`/api/content-research/people/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  contentResearchSuggestions: () =>
    request<PersonSuggestion[]>("/api/content-research/discovery/suggestions"),
  decideContentResearchSuggestion: (id: string, action: "approved" | "dismissed" | "restore") => {
    const path =
      action === "restore"
        ? `/api/content-research/discovery/${encodeURIComponent(id)}/restore`
        : `/api/content-research/discovery/${encodeURIComponent(id)}/${action}`;
    return request<{ suggestion: PersonSuggestion } | PersonSuggestion>(path, { method: "POST" });
  },
  runContentResearch: () =>
    request<{ runId: string }>("/api/content-research/run", { method: "POST" }),
  backfillContentResearch: (windowDays: 7 | 30 | 90) =>
    request<{ runId: string }>("/api/content-research/backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowDays }),
    }),
  discoverContentResearchPeople: () =>
    request<{ runId: string }>("/api/content-research/discover", { method: "POST" }),
  people: (query?: string, includeArchived?: boolean) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (includeArchived) params.set("includeArchived", "true");
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return request<PersonProfile[]>(`/api/people${suffix}`);
  },
  createPersonProfile: (input: PersonProfileCreateInput) =>
    request<PersonProfile>("/api/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  personProfile: (profileId: string) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}`),
  personProfileRevisions: (profileId: string) =>
    request<PersonProfile[]>(`/api/people/${encodeURIComponent(profileId)}/revisions`),
  personProfileRevision: (profileId: string, revision: number) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/revisions/${revision}`),
  personProfileProjection: (
    profileId: string,
    purpose: PersonProfileProjectionPurpose,
    revision?: number,
  ) => {
    const params = new URLSearchParams({ purpose });
    if (revision !== undefined) params.set("revision", String(revision));
    return request<PersonProfileProjection>(
      `/api/people/${encodeURIComponent(profileId)}/projection?${params.toString()}`,
    );
  },
  // --- Identity repair (ticket #121): correction, merge, detach, invalidations.
  correctPersonProfile: (profileId: string, input: PersonProfileCorrectionInput) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  mergePersonProfile: (profileId: string, input: PersonProfileMergeInput) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/merges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  detachPersonEvidence: (profileId: string, input: PersonProfileDetachInput) =>
    request<{ from: PersonProfile; to: PersonProfile | null }>(
      `/api/people/${encodeURIComponent(profileId)}/detachments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
