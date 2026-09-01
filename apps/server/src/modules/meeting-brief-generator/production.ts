import type { CompleteJson } from "../../llm/providers.js";
import type { ConfigStore } from "../../config.js";
import type { GoogleConnection } from "../../google/connection.js";
import type { Runs } from "../../runs.js";
import { RelayWakeUpPoller } from "../../relay/poller.js";
import { RelayStateStore } from "../../relay/state.js";
import { MeetingBriefHost } from "./host.js";
import { HubSpotConnection } from "./hubspot/connection.js";
import { createGmailProvider, type GmailProvider } from "./google/gmail.js";
import {
  createCalendarHistoryProvider,
  type CalendarHistoryProvider,
} from "./google/calendarHistory.js";
import { createDriveProvider, type DriveProvider } from "./google/drive.js";
import {
  createGmailDeliveryProvider,
  gmailOwnerEmail,
  type GmailDeliveryProvider,
} from "./google/gmailDelivery.js";
import {
  createGoogleCalendarProvider,
  googleCalendarTransport,
  workspaceCalendarRelayRegistry,
} from "./google/calendar.js";
import { DuckDuckGoPublicIntelligenceProvider } from "./enrichment/publicIntelligence.js";
import { createEmployerProposer } from "./enrichment/employerProposer.js";
import { PersonProfileResolver } from "../../person-profile/resolver.js";
import { PersonProfileStore } from "../../person-profile/store.js";
import {
  createHubSpotPersonProfileSource,
  createPublicWebPersonProfileSource,
} from "../../person-profile/sources.js";
import { createPublicSearch } from "../../source-adapters/search.js";
import { createFeedDiscoverer } from "../../source-adapters/feeds.js";

export interface MeetingBriefProductionRuntimeOptions {
  runs: Runs;
  workspaceDir: string;
  configStore: ConfigStore;
  google: GoogleConnection;
  getCompleteJson: () => CompleteJson;
  /**
   * Owner onboarding (issue #123): owner-only delivery is gated separately
   * from Calendar eligibility, which keeps using the raw connected identity.
   */
  isOwnerProfileConfirmed?: () => boolean;
  log?: (message: string) => void;
}

export interface MeetingBriefProductionRuntime {
  host: MeetingBriefHost;
  relayPoller: RelayWakeUpPoller;
  hubSpotConnection: HubSpotConnection;
  invalidateGoogleIdentity(): void;
  /** Read the connected Google identity and cache it as the workspace owner. */
  refreshOwnerIdentity(): Promise<string | null>;
}

/** Production composition root for the complete live Meeting Brief Generator. */
export function createMeetingBriefProductionRuntime(
  options: MeetingBriefProductionRuntimeOptions,
): MeetingBriefProductionRuntime {
  const requireGoogleAuth = () => {
    const access = options.google.auth();
    if (!access.ok) throw new Error(`missing_configuration: Google connection is ${access.state}`);
    return access.auth;
  };
  /**
   * The workspace owner, and its only source is the connected Google identity
   * (ADR-0034). Never event data: an attendee marked `self` is the same address
   * in the happy case, but it arrives from the Calendar payload, it is absent
   * whenever a read returns no event carrying it, and reading it there makes
   * every eligibility decision depend on what a list call happened to return.
   * `refreshOwnerIdentity` is awaited before the Module starts, so the owner is
   * known before the first Run rather than discovered by one.
   */
  let ownerEmail: string | null = null;
  let deliveryOwnerEmail: string | null = null;
  const invalidateGoogleIdentity = (): void => {
    ownerEmail = null;
    deliveryOwnerEmail = null;
  };
  const refreshOwnerIdentity = async (): Promise<string | null> => {
    const status = await options.google.state();
    ownerEmail = status.state === "connected" && status.email ? status.email.toLowerCase() : null;
    return ownerEmail;
  };

  const gmailProvider: GmailProvider = {
    listExactThreads: (guestEmail, maxResults) =>
      createGmailProvider(requireGoogleAuth()).listExactThreads(guestEmail, maxResults),
    listCompanyThreads: (companyDomain, maxResults) =>
      createGmailProvider(requireGoogleAuth()).listCompanyThreads(companyDomain, maxResults),
  };
  const calendarHistoryProvider: CalendarHistoryProvider = {
    listPastMeetings: (guestEmail, maxResults, before) =>
      createCalendarHistoryProvider(requireGoogleAuth()).listPastMeetings(
        guestEmail,
        maxResults,
        before,
      ),
  };
  const driveProvider: DriveProvider = {
    searchDocs: (query, maxResults) =>
      createDriveProvider(requireGoogleAuth()).searchDocs(query, maxResults),
  };
  const resolveDeliveryOwner = async () => {
    deliveryOwnerEmail ??= await gmailOwnerEmail(requireGoogleAuth());
    return deliveryOwnerEmail;
  };
  const gmailDeliveryProvider: GmailDeliveryProvider = {
    async send(params) {
      return createGmailDeliveryProvider(requireGoogleAuth(), await resolveDeliveryOwner()).send(
        params,
      );
    },
    async findByDeliveryId(deliveryId) {
      return createGmailDeliveryProvider(
        requireGoogleAuth(),
        await resolveDeliveryOwner(),
      ).findByDeliveryId(deliveryId);
    },
  };
  const relayStore = new RelayStateStore(`${options.workspaceDir}/relay.json`);
  const googleCalendarProvider = createGoogleCalendarProvider(
    googleCalendarTransport(requireGoogleAuth),
    workspaceCalendarRelayRegistry(relayStore),
  );
  const hubSpotConnection = new HubSpotConnection(options.configStore);
  const personProfiles = new PersonProfileResolver({
    store: new PersonProfileStore(options.workspaceDir),
    sources: [
      createHubSpotPersonProfileSource(() => hubSpotConnection.api()),
      createPublicWebPersonProfileSource({
        search: createPublicSearch(),
        discoverFeeds: createFeedDiscoverer(),
      }),
    ],
  });
  const host = new MeetingBriefHost({
    runs: options.runs,
    workspaceDir: options.workspaceDir,
    configStore: options.configStore,
    getCompleteJson: options.getCompleteJson,
    calendarProvider: googleCalendarProvider,
    calendarUse: "snapshot",
    enrichmentProviders: {
      gmailProvider,
      calendarHistoryProvider,
      driveProvider,
      personProfiles,
      publicIntelligenceProvider: new DuckDuckGoPublicIntelligenceProvider(),
      proposeEmployer: createEmployerProposer(options.getCompleteJson),
    },
    getOwnerEmail: () => ownerEmail,
    ...(options.isOwnerProfileConfirmed
      ? { isOwnerProfileConfirmed: options.isOwnerProfileConfirmed }
      : {}),
    gmailDeliveryProvider,
    ...(options.log ? { log: options.log } : {}),
  });
  const relayPoller = new RelayWakeUpPoller({
    store: relayStore,
    processWakeUps: (messages) => host.handleRelayWakeUp(messages).then(() => undefined),
    ...(options.log ? { log: options.log } : {}),
  });
  return {
    host,
    relayPoller,
    hubSpotConnection,
    invalidateGoogleIdentity,
    refreshOwnerIdentity,
  };
}
