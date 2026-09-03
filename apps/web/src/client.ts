import type {
  ContentEngineDraft,
  ContentProject,
  ContentProjectIntentPatch,
  ContentProjectReadiness,
  ContentProjectRevision,
  ContentProjectSummary,
  OutlineCharterApproval,
  OutlineSetOutcome,
  PlatformOutline,
  PlatformOutlineApproval,
  BrandProfileRevision,
  BrandProfileRevisionSummary,
  BrandProfileProposal,
  ContentProjectResearchMode,
  ContentProjectTarget,
  ContentResearchIndex,
  ContentShortlist,
  DriveIntakeStatus,
  GoogleStatus,
  HubSpotSetupCheck,
  HubSpotStatus,
  Meeting,
  MeetingBriefIndex,
  MeetingIndex,
  MeetingBriefPersonProfileReadModel,
  MeetingDebriefDetail,
  MeetingDebriefField,
  MeetingDebriefIndex,
  MeetingDebriefRecipient,
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
  PersonIdentitySignals,
  PersonProfileCorrectionInput,
  PersonProfileCreateInput,
  PersonProfileDeletionReceipt,
  PersonProfileDetachInput,
  PersonProfileLifecycleState,
  PersonProfileMergeInput,
  PersonProfileProjection,
  PersonProfileProjectionPurpose,
  OwnerOnboardingProposal,
  ConfirmedOwnerReference,
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
  TranscriptRelevanceQuery,
  TranscriptRelevanceReviewItem,
  TranscriptSummary,
  TranscriptConsumerDisclosure,
  TranscriptDeletionReceipt,
  TranscriptDeletionTombstone,
} from "@chief-of-staff-demo/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /* Some failures are disclosures, not just a message: a refused Profile
       lifecycle operation answers with the configurations and residual source
       documents the operator has to act on. Keep the parsed body so the
       surface can render it instead of only its first sentence. */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let parsed: unknown;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      parsed = body;
      if (body.message) {
        message = body.message;
      } else if (body.error) {
        message = body.error;
      }
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new ApiError(response.status, message, parsed);
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

/** A typed-identifier lookup: the proposed Profile, never yet saved by `preview`. */
export interface PersonProfileLookup {
  profile: PersonProfile;
  signals: PersonIdentitySignals;
  existing: boolean;
}

/** The Meeting Brief bundle vocabulary and the owner's recorded policy over it. */
export interface ProviderPolicyState {
  providers: string[];
  policy: Record<string, { disabled: boolean; changedAt: string; reason: string }>;
}

export interface ContentScoutState {
  brandProfile: BrandProfileRevision | null;
  brandProfileProposal: BrandProfileProposal | null;
  brandProfileRevisions: BrandProfileRevisionSummary[];
  sourceTargets: SourceTarget[];
  shortlist: ContentShortlist | null;
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
  settings: {
    timeZone: string;
    dailyTime: string;
    weeklyDiscoveryDay: number;
    weeklyDiscoveryTime: string;
    shortlistSize: number;
    canaryIntervalHours: number;
    canaryDisabledAdapters: string[];
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
  regenerateMeetingBrief: (runId: string) =>
    request<{ runId: string }>(`/api/meeting-brief/runs/${encodeURIComponent(runId)}/regenerate`, {
      method: "POST",
    }),
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
  /* Transcript Catalog intake (issue #142): one processing pass on demand,
     replacing Transcript → Tasks' retired /api/drive/sync. */
  driveSync: () =>
    request<{ processed: number; failed: number; skipped: number; unchanged: number }>(
      "/api/transcripts/intake/sync",
      { method: "POST" },
    ),
  /* Remembered intake facts only (D14): the endpoint makes zero Google calls. */
  driveIntakeStatus: () => request<DriveIntakeStatus>("/api/transcripts/intake"),
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
  brandProfileRevision: (id: string) =>
    request<{ revision: BrandProfileRevision }>(
      `/api/content-scout/brand-profile/revisions/${encodeURIComponent(id)}`,
    ),
  restoreBrandProfileRevision: (id: string) =>
    request<{ revision: BrandProfileRevision }>(
      `/api/content-scout/brand-profile/revisions/${encodeURIComponent(id)}/restore`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
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
  selectContentScout: (
    runId: string,
    opportunityIds: string[],
    project: {
      objective: string;
      audience: string;
      constraints?: string[];
      targets: ContentProjectTarget[];
      researchMode: ContentProjectResearchMode | null;
      seedMaterial?: string[];
    },
  ) =>
    request<{
      status: string;
      projects: { opportunityId: string; projectId: string; created: boolean }[];
    }>(`/api/content-scout/shortlists/${encodeURIComponent(runId)}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunityIds, project }),
    }),
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
  meetings: () => request<MeetingIndex>("/api/meetings/list"),
  meeting: (meetingId: string) =>
    request<Meeting>(`/api/meetings/${encodeURIComponent(meetingId)}`),
  meetingBriefConfig: () => request<{ internalDomains: string[] }>("/api/meeting-brief/config"),
  saveMeetingBriefConfig: (input: string[] | { internalDomains?: string[] }) =>
    request<{ internalDomains: string[] }>("/api/meeting-brief/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Array.isArray(input) ? { internalDomains: input } : input),
    }),
  meetingBriefProviderPolicy: () =>
    request<ProviderPolicyState>("/api/meeting-brief/provider-policy"),
  saveMeetingBriefProviderPolicy: (disabled: string[]) =>
    request<ProviderPolicyState>("/api/meeting-brief/provider-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled }),
    }),
  meetingBriefIndex: () => request<MeetingBriefIndex>("/api/meeting-brief/index"),
  contentProjects: () =>
    request<{ projects: ContentProjectSummary[] }>("/api/content-engine/projects"),
  contentProject: (projectId: string) =>
    request<{ project: ContentProject; readiness: ContentProjectReadiness }>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}`,
    ),
  contentProjectRevise: (projectId: string, patch: ContentProjectIntentPatch) =>
    request<ContentProjectRevision>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/revisions`,
      { method: "POST", body: JSON.stringify(patch) },
    ),
  contentProjectApproveOutlineCharter: (projectId: string, outlineCharterId: string) =>
    request<OutlineCharterApproval>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/outline-charters/${encodeURIComponent(outlineCharterId)}/approve`,
      { method: "POST" },
    ),
  contentProjectGenerateOutline: (projectId: string, target: string, instruction?: string) =>
    request<PlatformOutline>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/outlines/${encodeURIComponent(target)}`,
      { method: "POST", body: JSON.stringify(instruction === undefined ? {} : { instruction }) },
    ),
  contentProjectGenerateOutlineSet: (projectId: string) =>
    request<OutlineSetOutcome>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/outlines`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  contentProjectApproveOutline: (projectId: string, target: string) =>
    request<PlatformOutlineApproval>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/outlines/${encodeURIComponent(target)}/approve`,
      { method: "POST" },
    ),
  contentProjectGenerateDraft: (projectId: string, target: string, instruction?: string) =>
    request<ContentEngineDraft>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/drafts/${encodeURIComponent(target)}`,
      { method: "POST", body: JSON.stringify(instruction === undefined ? {} : { instruction }) },
    ),
  meetingDebriefIndex: () => request<MeetingDebriefIndex>("/api/meeting-debrief/index"),
  meetingDebriefDetail: (runId: string) =>
    request<MeetingDebriefDetail>(`/api/meeting-debrief/${encodeURIComponent(runId)}`),
  meetingDebriefRegenerate: (runId: string, field: MeetingDebriefField) =>
    request<{ resumed: boolean }>(`/api/meeting-debrief/${encodeURIComponent(runId)}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field }),
    }),
  meetingDebriefDropActionItem: (runId: string, index: number) =>
    request<{ dropped: number[] }>(
      `/api/meeting-debrief/${encodeURIComponent(runId)}/action-items/${index}/drop`,
      { method: "POST" },
    ),
  meetingDebriefConfirmRoster: (
    runId: string,
    entries: Array<{ email: string; displayName?: string | null }>,
  ) =>
    request<{ roster: { status: string } }>(
      `/api/meeting-debrief/${encodeURIComponent(runId)}/roster`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      },
    ),
  meetingDebriefAddRecipient: (runId: string, input: { profileId: string; email: string }) =>
    request<{ recipients: MeetingDebriefRecipient[] }>(
      `/api/meeting-debrief/${encodeURIComponent(runId)}/recipients`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  meetingDebriefRemoveRecipient: (runId: string, profileId: string) =>
    request<{ recipients: MeetingDebriefRecipient[] }>(
      `/api/meeting-debrief/${encodeURIComponent(runId)}/recipients/${encodeURIComponent(profileId)}`,
      { method: "DELETE" },
    ),
  meetingDebriefApprove: (runId: string) =>
    request<{ resumed: boolean }>(`/api/meeting-debrief/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
    }),
  meetingDebriefRedo: (runId: string) =>
    request<{ runId: string }>(`/api/meeting-debrief/${encodeURIComponent(runId)}/redo`, {
      method: "POST",
    }),
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
  contentResearchAllPeople: () => request<NamedPerson[]>("/api/content-research/people/all"),
  /* A watch is created only against a confirmed Person Profile (spec #134). */
  addContentResearchPerson: (profileId: string, handleHints?: NamedPerson["handleHints"]) =>
    request<NamedPerson>("/api/content-research/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, ...(handleHints ? { handleHints } : {}) }),
    }),
  pauseContentResearchPerson: (id: string) =>
    request<NamedPerson>(`/api/content-research/people/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    }),
  resumeContentResearchPerson: (id: string) =>
    request<NamedPerson>(`/api/content-research/people/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    }),
  stopWatchingContentResearchPerson: (id: string) =>
    request<NamedPerson>(`/api/content-research/people/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  contentResearchSuggestions: () =>
    request<PersonSuggestion[]>("/api/content-research/discovery/suggestions"),
  /* Approving requires the confirmed Profile the watch will be backed by. */
  decideContentResearchSuggestion: (
    id: string,
    action: "approved" | "dismissed" | "restore",
    profileId?: string,
  ) => {
    const path =
      action === "restore"
        ? `/api/content-research/discovery/${encodeURIComponent(id)}/restore`
        : `/api/content-research/discovery/${encodeURIComponent(id)}/${action}`;
    return request<{ suggestion: PersonSuggestion } | PersonSuggestion>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "approved" && profileId ? { profileId } : {}),
    });
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
  transcriptRelevanceQueue: () =>
    request<{ items: TranscriptRelevanceReviewItem[] }>("/api/transcripts/review/relevance"),
  searchTranscriptRelevance: (query: TranscriptRelevanceQuery) =>
    request<{ items: TranscriptRelevanceReviewItem[] }>(
      "/api/transcripts/review/relevance/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
      },
    ),
  decideTranscriptRelevance: (
    candidateId: string,
    action: "confirm" | "reject" | "unresolved",
    note?: string,
  ) =>
    request<{ item: TranscriptRelevanceReviewItem }>(
      `/api/transcripts/review/relevance/${encodeURIComponent(candidateId)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      },
    ),
  transcripts: () => request<{ transcripts: TranscriptSummary[] }>("/api/transcripts"),
  transcriptDeletionPreview: (transcriptId: string) =>
    request<{ transcript: TranscriptSummary; consumerRecords: TranscriptConsumerDisclosure[] }>(
      `/api/transcripts/${encodeURIComponent(transcriptId)}/deletion-preview`,
    ),
  deleteTranscript: (transcriptId: string, confirmation: string) =>
    request<TranscriptDeletionReceipt>(
      `/api/transcripts/${encodeURIComponent(transcriptId)}/delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation }),
      },
    ),
  transcriptTombstones: () =>
    request<{ tombstones: TranscriptDeletionTombstone[] }>("/api/transcripts/tombstones"),
  restoreTranscriptProcessing: (externalFileId: string) =>
    request<{ tombstone: TranscriptDeletionTombstone }>(
      `/api/transcripts/tombstones/${encodeURIComponent(externalFileId)}/restore`,
      { method: "POST" },
    ),
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
  lookupPersonProfile: (identifier: string) =>
    request<PersonProfileLookup>("/api/people/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier }),
    }),
  acceptPersonProfileLookup: (identifier: string) =>
    request<PersonProfileLookup>("/api/people/lookup/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier }),
    }),
  /** Re-run the public-web search from the identity the Profile already holds. */
  enrichPersonProfile: async (profileId: string) =>
    (
      await request<PersonProfileLookup>(`/api/people/${encodeURIComponent(profileId)}/enrich`, {
        method: "POST",
      })
    ).profile,
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
  // --- Profile lifecycle (ticket #122): archive, restore, privacy deletion.
  personProfileLifecycle: (profileId: string) =>
    request<PersonProfileLifecycleState>(`/api/people/${encodeURIComponent(profileId)}/lifecycle`),
  archivePersonProfile: (profileId: string) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/archive`, {
      method: "POST",
    }),
  restorePersonProfile: (profileId: string) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/restore`, {
      method: "POST",
    }),
  privacyDeletePersonProfile: (profileId: string, confirmation: string) =>
    request<PersonProfileDeletionReceipt>(
      `/api/people/${encodeURIComponent(profileId)}/privacy-delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation }),
      },
    ),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ---------------------------------------------------------------------------
 * Owner onboarding (issue #123): the proposal/confirmation namespace under
 * /api/onboarding. Mounted here, at the end, as its own section.
 * ------------------------------------------------------------------------- */

export interface OwnerOnboardingStatus {
  proposal: OwnerOnboardingProposal | null;
  confirmed: ConfirmedOwnerReference | null;
}

export const onboardingApi = {
  owner: () => request<OwnerOnboardingStatus>("/api/onboarding/owner"),
  confirm: (profileId: string) =>
    request<ConfirmedOwnerReference>("/api/onboarding/owner/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId }),
    }),
};

/* ---------------------------------------------------------------------------
 * Workspace migration (ticket #144): the one-time auth-preserving reset under
 * /api/migration. Mounted here, at the end, as its own section. Shapes match
 * the ticket contract and the read-only preview classifier in
 * apps/server/src/migration/workspace.ts — the preview payload is content-free
 * by construction: names of categories, counts, never stored values.
 * ------------------------------------------------------------------------- */

type MigrationState = "fresh" | "required" | "completed";

/** The content-free purge receipt the reset writes when it succeeds. */
export interface MigrationReceipt {
  schemaVersion: 1;
  migratedAt: string;
  durationMs: number;
  categories: {
    directories: number;
    files: number;
    preservedConfigKeys: number;
    droppedConfigKeys: number;
    preservedRelayKeys: number;
    droppedRelayKeys: number;
  };
}

interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
  href: string;
}

export interface OnboardingStatus {
  complete: boolean;
  steps: OnboardingStep[];
}

export interface MigrationStatus {
  state: MigrationState;
  onboarding: OnboardingStatus;
}

/** One inventoried category: its name verbatim, its disposition, a count. */
export interface MigrationInventoryCategory {
  name: string;
  classification: "authentication" | "disposable-product-state";
  count: number;
}

/**
 * A provider-owned record local values merely name. The values are deleted
 * with `localCategory`; the record itself is never touched by the reset.
 */
interface MigrationRemoteRecordDisclosure {
  name: string;
  classification: "remote-reference";
  count: number;
  localCategory: string;
  deletedByReset: false;
}

/**
 * Why the reset boundary could not be drawn. Names structure — a file, a
 * dotted key — never a stored value; the reset deletes nothing in this state.
 */
interface MigrationUnsafeMixedStateFinding {
  entry: string;
  key: string | null;
  reason: "unreadable" | "malformed" | "unrecognized-key" | "unrecognized-entry";
}

export type MigrationInventory =
  | {
      outcome: "inventory";
      categories: MigrationInventoryCategory[];
      remoteRecords: MigrationRemoteRecordDisclosure[];
    }
  | { outcome: "unsafe-mixed-state"; findings: MigrationUnsafeMixedStateFinding[] };

export const migrationApi = {
  /** Always mounted, never gated — the boot gate itself reads it. */
  status: () => request<MigrationStatus>("/api/migration/status"),
  inventory: () => request<MigrationInventory>("/api/migration/inventory"),
  confirm: (typedConfirmation: string) =>
    request<{ receipt: MigrationReceipt }>("/api/migration/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typedConfirmation }),
    }),
  receipt: () => request<MigrationReceipt>("/api/migration/receipt"),
};

/* ---------------------------------------------------------------------------
 * Generated-data clear (issue #144): the Settings danger zone's read-only
 * inventory and the one confirmed action that empties the Workspace.
 * ------------------------------------------------------------------------- */

/** One inventoried Workspace entry the clear deletes, names and counts only. */
interface GeneratedDataInventoryEntry {
  name: string;
  kind: "directory" | "file";
  fileCount: number | null;
}

export interface GeneratedDataInventory {
  entries: GeneratedDataInventoryEntry[];
}

interface ClearedSheetOutcome {
  destination: "youtube-trends" | "content-research-ledger";
  outcome: "cleared" | "skipped" | "missing" | "failed";
  tabs?: number;
  rows?: number;
  reason?: string;
}

/** The content-free record of one clear: names and counts, never stored values. */
export interface ClearDataReceipt {
  schemaVersion: number;
  clearedAt: string;
  durationMs: number;
  local: { directories: { name: string; files: number }[]; files: string[] };
  sheets: ClearedSheetOutcome[];
}

export const clearDataApi = {
  inventory: () => request<GeneratedDataInventory>("/api/clear-data/inventory"),
  confirm: (typedConfirmation: string) =>
    request<ClearDataReceipt>("/api/clear-data/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typedConfirmation }),
    }),
};
