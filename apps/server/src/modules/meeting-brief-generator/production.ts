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

export interface MeetingBriefProductionRuntimeOptions {
  runs: Runs;
  workspaceDir: string;
  configStore: ConfigStore;
  google: GoogleConnection;
  getCompleteJson: () => CompleteJson;
  log?: (message: string) => void;
}

export interface MeetingBriefProductionRuntime {
  host: MeetingBriefHost;
  relayPoller: RelayWakeUpPoller;
  hubSpotConnection: HubSpotConnection;
  invalidateGoogleIdentity(): void;
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
  let calendarOwnerEmail: string | null = null;
  let deliveryOwnerEmail: string | null = null;
  const invalidateGoogleIdentity = (): void => {
    calendarOwnerEmail = null;
    deliveryOwnerEmail = null;
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
  const calendarProvider = {
    watchChannel: (args: Parameters<typeof googleCalendarProvider.watchChannel>[0]) =>
      googleCalendarProvider.watchChannel(args),
    stopChannel: (args: Parameters<typeof googleCalendarProvider.stopChannel>[0]) =>
      googleCalendarProvider.stopChannel(args),
    async listEvents(args: Parameters<typeof googleCalendarProvider.listEvents>[0]) {
      const result = await googleCalendarProvider.listEvents(args);
      const self = result.events
        .flatMap((event) => event.attendees)
        .find((attendee) => attendee.self && attendee.email);
      if (self) calendarOwnerEmail = self.email.toLowerCase();
      return result;
    },
  };
  const hubSpotConnection = new HubSpotConnection(options.configStore);
  const host = new MeetingBriefHost({
    runs: options.runs,
    workspaceDir: options.workspaceDir,
    configStore: options.configStore,
    getCompleteJson: options.getCompleteJson,
    calendarProvider,
    calendarSnapshotRequired: true,
    enrichmentProviders: {
      gmailProvider,
      calendarHistoryProvider,
      driveProvider,
      publicIntelligenceProvider: new DuckDuckGoPublicIntelligenceProvider(),
      proposeEmployer: createEmployerProposer(options.getCompleteJson),
    },
    hubSpotConnection,
    gmailDeliveryProvider,
    getOwnerEmail: () => calendarOwnerEmail,
    ...(options.log ? { log: options.log } : {}),
  });
  const relayPoller = new RelayWakeUpPoller({
    store: relayStore,
    processWakeUps: (messages) => host.handleRelayWakeUp(messages).then(() => undefined),
    ...(options.log ? { log: options.log } : {}),
  });
  return { host, relayPoller, hubSpotConnection, invalidateGoogleIdentity };
}
