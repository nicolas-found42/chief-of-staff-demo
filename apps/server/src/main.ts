import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyError } from "fastify";
import { DEFAULT_MODELS, type ConfirmedOwnerReference } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "./config.js";
import { registerApi } from "./api/router.js";
import { registerStaticServing } from "./api/static.js";
import { registerRelayRoutes } from "./relay/routes.js";
import { seedRelayBaseUrlFromEnv } from "./relay/state.js";
import { registerMeetingBriefHubSpotRoutes } from "./modules/meeting-brief-generator/hubspot/routes.js";
import { contentScoutTestPorts, registerTestSeed } from "./api/testSeed.js";
import { PersonProfileStore } from "./person-profile/store.js";
import { WorkspacePersonProfiles } from "./person-profile/profiles.js";
import { WorkspacePersonProfileReferences } from "./person-profile/references.js";
import { TranscriptCatalogStore } from "./transcript-catalog/store.js";
import { OwnerOnboarding } from "./onboarding/owner.js";
import type { HostedModule } from "./engine/host.js";
import { makeCompleteJson } from "./llm/providers.js";
import { openGoogleConnection } from "./google/connection.js";
import { TranscriptHost } from "./modules/transcript/host.js";
import { YoutubeHost } from "./modules/youtube/host.js";
import { IdeaEngineHost } from "./modules/idea-engine/host.js";
import { ContentScoutHost } from "./modules/content-scout/host.js";
import { MeetingBriefHost } from "./modules/meeting-brief-generator/host.js";
import { createMeetingBriefProductionRuntime } from "./modules/meeting-brief-generator/production.js";
import { MeetingDebriefHost } from "./modules/meeting-debrief/host.js";
import { createMeetingDebriefProductionRuntime } from "./modules/meeting-debrief/production.js";
import {
  createMeetingDebriefTestRuntime,
  registerMeetingDebriefTestRoutes,
} from "./modules/meeting-debrief/testRuntime.js";
import {
  createMeetingBriefTestRuntime,
  registerMeetingBriefTestRoutes,
} from "./modules/meeting-brief-generator/testRuntime.js";
import { playwrightBrowserRenderer } from "./modules/content-scout/adapters/browser.js";
import { youtubeSourceClient } from "./modules/content-scout/adapters/youtube.js";
import { ExternalRuntimeInspector } from "./modules/content-scout/runtime.js";
import { contentScoutProductionAdapters } from "./modules/content-scout/adapters/production.js";
import { contentResearchProductionAdapters } from "./composition/content-research-portfolio.js";
import { PublicRouteSourceDiscoverer } from "./modules/content-scout/discoverer.js";
import {
  PublicBrandProfileCrawler,
  modelBrandProfileProposer,
} from "./modules/content-scout/brand-profile.js";
import { modelOpportunityRanker } from "./modules/content-scout/model.js";
import { WorkspaceContentProjects } from "./content-projects/projects.js";
import {
  createModelDraftProvider,
  createModelOutlineProvider,
} from "./content-projects/generation.js";
import { createPublicSearchResearchProvider } from "./content-projects/research.js";
import { contentProjectOpportunityStarter } from "./content-projects/opportunity-projects.js";
import { CONTENT_PROJECT_TARGETS } from "@chief-of-staff-demo/shared";
import { workspaceLayout } from "./paths.js";
import { openRuns } from "./runs.js";
import { ContentResearchHost } from "./modules/content-research/host.js";
import { ContentResearchStore } from "./modules/content-research/store.js";
import { ContentResearchWatchRegistry } from "./modules/content-research/profile-registry.js";
import { createHookExtractor, createPeopleDiscoverer } from "./modules/content-research/model.js";
import { seedContentResearchV1 } from "./modules/content-research/seed.js";
import { createPublicSearch } from "./source-adapters/search.js";
import { WorkspaceBrandProfileStore } from "./brand-profile/store.js";
import { buildGoogleAuth } from "./google/oauth.js";
import {
  createSpreadsheet,
  ensureTab,
  appendRows,
  readRows,
  updateRow,
  isSpreadsheetMissing,
} from "./google/sheets.js";
import { createGmailDraft } from "./google/gmail.js";
import { TranscriptRelevanceService } from "./transcript-catalog/relevance.js";
import { TranscriptRelevanceStore } from "./transcript-catalog/relevance-store.js";
import { TranscriptIdentityStore } from "./transcript-catalog/identity-store.js";
import {
  TranscriptDeletionService,
  type TranscriptConsumerRegistry,
} from "./transcript-catalog/deletion.js";
import { WorkspacePersonProfileTranscriptEvidence } from "./person-profile/transcript-evidence.js";
import { createLexicalTranscriptRelevanceIndex } from "./transcript-catalog/relevance-index.js";
import { registerTranscriptRelevanceApi } from "./api/transcript-review.js";
import { registerTranscriptDeletionApi } from "./api/transcript-delete.js";

const port = Number(process.env.PORT ?? 4317);
/* Loopback by default (ADR-0001). A container sets HOST=0.0.0.0 because the
   loopback interface inside a container is not reachable from the host; the
   published port is still bound to 127.0.0.1 on the host side. */
const host = process.env.HOST ?? "127.0.0.1";
const workspaceDir = process.env.WORKSPACE_DIR ?? "./workspace";
const layout = workspaceLayout(workspaceDir);
mkdirSync(layout.runsDir, { recursive: true });

const configStore = new ConfigStore(layout.configFile);
const config = configStore.load();

const googleConnection = openGoogleConnection(configStore, port);
/* One owner for the run directory: every Module and the API read and write the
   same Runs, not one object per Module over one directory. */
const runs = openRuns(workspaceDir);
const peopleStore = new PersonProfileStore(workspaceDir);
/* Content Research owns its watches, so its Profile references are disclosed
   by a registry over the same store the Module runs on (spec #134, ADR-0042):
   archive and privacy deletion refuse while a watch is active, and privacy
   deletion purges the watch's reference. The store is created here so the
   registry and the Module share the one Workspace state. */
const contentResearchStore = new ContentResearchStore(workspaceDir, () => new Date());
/* Lifecycle disclosures come from the real Workspace stores: the confirmed
   owner reference is the active dependent configuration, and the residual
   disclosure scans the catalogued transcripts and collected public source
   items that name the person. All reads are local. */
const transcriptCatalogStore = new TranscriptCatalogStore(workspaceDir);
const peopleProfiles: WorkspacePersonProfiles = new WorkspacePersonProfiles({
  store: peopleStore,
  lifecycle: [
    new WorkspacePersonProfileReferences(runs, {
      ownerReference: (): ConfirmedOwnerReference | null => ownerOnboarding.confirmed(),
      transcripts: () => transcriptCatalogStore.listTranscripts(),
      publicItems: () => contentResearch.listSourceItems(),
    }),
    new ContentResearchWatchRegistry(contentResearchStore),
  ],
});
const ownerOnboarding = new OwnerOnboarding({ people: peopleProfiles, workspaceDir });

/* Semantic transcript relevance (issue #127): the reviewable discovery lane
   over the Transcript Catalog's retained corpus. Like the Catalog itself it
   is a Workspace resource behind a library seam; the Drive ingestion
   composition remains with the integrating ticket (#126 hand-forward). The
   local lexical index keeps every judgment in-process (ADR-0001); a model- or
   embedding-backed searcher replaces it at the same seam. */
const transcriptRelevanceStore = new TranscriptRelevanceStore(workspaceDir);
const transcriptIdentityStore = new TranscriptIdentityStore(workspaceDir);
const transcriptRelevance = new TranscriptRelevanceService({
  corpus: transcriptCatalogStore,
  store: transcriptRelevanceStore,
  searcher: createLexicalTranscriptRelevanceIndex(),
});

/* Transcript deletion with local cascades and reingestion tombstones (issue
   #128). Consumer modules register a cascade each: the Person Profiles
   registry purges transcript-origin Person Evidence (including its copies
   inside Profile revisions) while independently supported facts survive.
   A consumer built on transcript-derived Runs registers here the same way. */
const transcriptConsumerRegistries: TranscriptConsumerRegistry[] = [
  new WorkspacePersonProfileTranscriptEvidence(peopleStore),
];
const transcriptDeletion = new TranscriptDeletionService({
  catalog: transcriptCatalogStore,
  identity: transcriptIdentityStore,
  relevance: transcriptRelevanceStore,
  registries: transcriptConsumerRegistries,
  log: (message) => console.log(`[transcript] ${message}`),
});

const transcript = new TranscriptHost({
  runs,
  workspaceDir,
  port,
  getConfig: () => configStore.get(),
  getCompleteJson: () => {
    const current = configStore.get();
    return makeCompleteJson(
      {
        provider: current.provider,
        model: current.model,
        apiKey: current.apiKey,
        baseUrl: current.ollama.baseUrl,
      },
      layout.mockResultFile,
    );
  },
  getLlmInfo: () => {
    const current = configStore.get();
    return { provider: current.provider, model: current.model };
  },
  google: googleConnection,
  log: (message) => console.log(`[transcript] ${message}`),
});

const youtube = new YoutubeHost({
  runs,
  configStore,
  workspaceDir,
  port,
  google: googleConnection,
  log: (message) => console.log(`[youtube-trends] ${message}`),
});

const ideaEngine = new IdeaEngineHost({
  runs,
  configStore,
  workspaceDir,
  port,
  google: googleConnection,
  log: (message) => console.log(`[idea-engine] ${message}`),
});

const contentScoutCompleteJson = () => {
  const current = configStore.get();
  return makeCompleteJson(
    {
      provider: current.provider,
      model: current.model,
      apiKey: current.apiKey,
      baseUrl: current.ollama.baseUrl,
    },
    layout.mockResultFile,
  );
};
const testContentScout =
  process.env.ENABLE_TEST_SEED === "1" ? contentScoutTestPorts(() => new Date()) : null;
/* The governed Content Engine path (#133): selecting a shortlisted Content
   Opportunity starts exactly one Content Project here; the Pack and Notion
   publication path is retired. Generation and research run through the
   Project's own gates at the Shell's one model seam. */
const contentProjects = new WorkspaceContentProjects({
  workspaceDir,
  people: peopleProfiles,
  ownerOnboarding,
  brandProfiles: new WorkspaceBrandProfileStore(workspaceDir, () => new Date()),
  researchProviders: [createPublicSearchResearchProvider(createPublicSearch(), () => new Date())],
  outlineProviders: CONTENT_PROJECT_TARGETS.map((target) =>
    createModelOutlineProvider(contentScoutCompleteJson, target),
  ),
  draftProviders: CONTENT_PROJECT_TARGETS.map((target) =>
    createModelDraftProvider(contentScoutCompleteJson, target),
  ),
});
const contentScout = new ContentScoutHost({
  runs,
  workspaceDir,
  configStore,
  adapters:
    testContentScout?.adapters ??
    contentScoutProductionAdapters({
      workspaceDir,
      renderBrowser: playwrightBrowserRenderer(),
      getYouTubeAccess: () => {
        const access = googleConnection.auth();
        return access.ok
          ? { ok: true, client: youtubeSourceClient(access.auth) }
          : { ok: false, state: access.state };
      },
    }),
  ranker: testContentScout?.ranker ?? modelOpportunityRanker(contentScoutCompleteJson),
  opportunityProjects: contentProjectOpportunityStarter(contentProjects),
  discoverer: new PublicRouteSourceDiscoverer(),
  brandProfileCrawler: testContentScout?.brandProfileCrawler ?? new PublicBrandProfileCrawler(),
  brandProfileProposer:
    testContentScout?.brandProfileProposer ?? modelBrandProfileProposer(contentScoutCompleteJson),
  runtimeInspector: testContentScout?.runtimeInspector ?? new ExternalRuntimeInspector(),
  isOwnerProfileConfirmed: () => ownerOnboarding.confirmed() !== null,
  log: (message) => console.log(`[content-scout] ${message}`),
});
const contentResearchCompleteJson = () => {
  const current = configStore.get();
  return makeCompleteJson(
    {
      provider: current.provider,
      model: current.model,
      apiKey: current.apiKey,
      baseUrl: current.ollama.baseUrl,
    },
    layout.mockResultFile,
  );
};
/* The Person Profiles product area's Workspace-owned interface. The store is
   the same one Meeting Brief's resolver writes through: both are synchronous,
   uncached writers of the one Workspace directory. */
/* Owner onboarding (issue #123): the connected Google identity is read once
   and held until the connection changes (ADR-0036), and owner-identity-
   dependent outward workflows get it only while a confirmed owner Profile
   reference stands — otherwise the typed owner-missing state. */
const refreshOwnerIdentity = async (): Promise<void> => {
  await ownerOnboarding.refreshConnectedIdentity(() => googleConnection.state());
};
const brandProfiles = new WorkspaceBrandProfileStore(workspaceDir);
const contentResearch = new ContentResearchHost({
  runs,
  workspaceDir,
  store: contentResearchStore,
  /* Watches resolve and pin their Profile through the public-safe projection
     seam (spec #134): publications and public surfaces only. */
  profileProjection: (profileId) => peopleProfiles.project("public-safe", profileId),
  adapters: contentResearchProductionAdapters({
    workspaceDir,
    renderBrowser: playwrightBrowserRenderer(),
    getYouTubeAccess: () => {
      const access = googleConnection.auth();
      return access.ok
        ? { ok: true, client: youtubeSourceClient(access.auth) }
        : { ok: false, state: access.state };
    },
  }),
  hookExtractor: { extract: createHookExtractor(contentResearchCompleteJson) },
  searchPublic: createPublicSearch(),
  discoverer: {
    discover: async (input) => {
      const shape = await createPeopleDiscoverer(contentResearchCompleteJson)(input);
      return shape.candidates.map((candidate) => ({
        ...candidate,
        relationshipToBrand: candidate.relationshipToBrand ?? "unspecified",
        source: "llm-public-search",
      }));
    },
  },
  sheetsFactory: () => {
    const access = googleConnection.auth();
    if (!access.ok) return { ok: false, state: access.state };
    const auth = buildGoogleAuth(configStore.get(), port);
    return {
      ok: true,
      client: {
        createSpreadsheet: (title: string) => createSpreadsheet(auth, title),
        ensureTab: (spreadsheetId: string, title: string, header: string[]) =>
          ensureTab(auth, spreadsheetId, title, header),
        appendRows: (spreadsheetId: string, tab: string, rows: (string | number)[][]) =>
          appendRows(auth, spreadsheetId, tab, rows),
        readRows: (spreadsheetId: string, tab: string) => readRows(auth, spreadsheetId, tab),
        updateRow: (
          spreadsheetId: string,
          tab: string,
          rowNumber: number,
          values: (string | number)[],
        ) => updateRow(auth, spreadsheetId, tab, rowNumber, values),
        isMissing: (error: unknown) => isSpreadsheetMissing(error),
      },
      spreadsheet: null,
    };
  },
  gmailFactory: () => {
    const access = googleConnection.auth();
    if (!access.ok) return { ok: false, state: access.state };
    const auth = buildGoogleAuth(configStore.get(), port);
    return {
      ok: true,
      client: {
        createDraft: (draft: { to: string; subject: string; body: string }) =>
          createGmailDraft(auth, draft),
      },
    };
  },
  getOwnerEmail: () => ownerOnboarding.outwardOwnerEmail(),
  getBrandProfile: () => brandProfiles.current(),
  configStore,
  log: (message) => console.log(`[content-research] ${message}`),
});
seedContentResearchV1(contentResearch, peopleProfiles);
const meetingBriefCompleteJson = () => {
  const current = configStore.get();
  return makeCompleteJson(
    {
      provider: current.provider,
      model: current.model,
      apiKey: current.apiKey,
      baseUrl: current.ollama.baseUrl,
    },
    layout.mockResultFile,
  );
};
const meetingBriefLog = (message: string) => console.log(`[meeting-brief] ${message}`);
const meetingBriefTest =
  process.env.ENABLE_TEST_SEED === "1"
    ? createMeetingBriefTestRuntime({
        runs,
        workspaceDir,
        configStore,
        initialNow: new Date("2026-08-28T10:00:00.000Z"),
        personProfiles: peopleProfiles,
      })
    : null;
const meetingBriefProduction = meetingBriefTest
  ? null
  : createMeetingBriefProductionRuntime({
      runs,
      workspaceDir,
      configStore,
      google: googleConnection,
      getCompleteJson: meetingBriefCompleteJson,
      /* Owner onboarding (issue #123): delivery's outward send waits for the
         confirmed owner reference; eligibility keeps the raw identity. */
      isOwnerProfileConfirmed: () => ownerOnboarding.confirmed() !== null,
      personProfiles: peopleProfiles,
      /* Confirmed transcript evidence (issue #138): the Brief reads the
         Catalog's confirmed links and its reviewed relevance decisions. */
      transcriptRelevance,
      log: meetingBriefLog,
    });
const meetingBrief: MeetingBriefHost = meetingBriefTest?.host ?? meetingBriefProduction!.host;
/* Meeting Debrief (issue #139): the retrospective sibling of Meeting Brief.
   It consumes the Transcript Catalog's immutable records and identity review
   state, and has no outward-write capability at all. The test runtime keeps
   everything real except the extraction, so the browser journey never
   depends on a live model. */
const meetingDebriefTest =
  process.env.ENABLE_TEST_SEED === "1"
    ? createMeetingDebriefTestRuntime({
        runs,
        workspaceDir,
        ownerEmail: () => ownerOnboarding.outwardOwnerEmail(),
        log: (message) => console.log(`[meeting-debrief] ${message}`),
      })
    : null;
const meetingDebrief: MeetingDebriefHost =
  meetingDebriefTest?.host ??
  createMeetingDebriefProductionRuntime({
    runs,
    workspaceDir,
    people: peopleProfiles,
    ownerEmail: () => ownerOnboarding.outwardOwnerEmail(),
    getCompleteJson: () => {
      const current = configStore.get();
      return makeCompleteJson(
        {
          provider: current.provider,
          model: current.model,
          apiKey: current.apiKey,
          baseUrl: current.ollama.baseUrl,
        },
        layout.mockResultFile,
      );
    },
    getLlmInfo: () => {
      const current = configStore.get();
      return { provider: current.provider, model: current.model };
    },
    log: (message) => console.log(`[meeting-debrief] ${message}`),
  }).host;
/* The Shell's whole knowledge of what it hosts. Order is arbitrary: what a
   person sees is the web app's Module list, not this one. */
const modules: HostedModule[] = [
  transcript,
  youtube,
  ideaEngine,
  contentScout,
  contentResearch,
  meetingBrief,
  meetingDebrief,
];
const app = fastify({ logger: false });

app.setErrorHandler((error: FastifyError, _request, reply) => {
  reply.code(error.statusCode ?? 500).send({ error: error.message });
});

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
await registerStaticServing(app, { webDist });

if (meetingDebriefTest) {
  registerMeetingDebriefTestRoutes(app, meetingDebriefTest);
}
await registerApi(app, {
  runs,
  port,
  configStore,
  modules,
  google: googleConnection,
  people: peopleProfiles,
  onboarding: ownerOnboarding,
  onConfigChanged: async () => {
    meetingBriefProduction?.invalidateGoogleIdentity();
    await meetingBriefProduction?.refreshOwnerIdentity().catch(() => null);
    await refreshOwnerIdentity();
    for (const module of modules.filter((candidate) => candidate !== meetingBrief)) {
      module.start?.();
    }
    meetingBrief.start();
  },
});
/* Semantic transcript relevance Review surface (issue #127). */
registerTranscriptRelevanceApi(app, {
  relevance: transcriptRelevance,
  /* Late transcript evidence (issue #138): a confirmed suggestion marks every
     Brief composed without it as regenerable, and sends nothing. */
  onRelevanceConfirmed: (transcriptId) =>
    meetingBrief.noteConfirmedTranscriptEvidence(transcriptId),
});
/* Transcript deletion surface (issue #128): corpus listing, cascade
   deletion, tombstones, and restore-processing-permission. */
registerTranscriptDeletionApi(app, {
  catalog: transcriptCatalogStore,
  deletion: transcriptDeletion,
});
// A fresh Workspace adopts the relay address the deployment declares, so the
// bundled relay is reachable before anyone opens Settings. A stored address
// wins, so this never overrides an operator's own choice (issue #109).
seedRelayBaseUrlFromEnv(workspaceDir, process.env.RELAY_BASE_URL);
registerRelayRoutes(app, {
  workspaceDir,
  processWakeUps: (messages) => meetingBrief.handleRelayWakeUp(messages).then(() => undefined),
  onInstalled: async () => {
    await meetingBrief.ensureCalendarWatch();
    await meetingBrief.reconcileCalendar();
  },
});
registerMeetingBriefHubSpotRoutes(app, {
  configStore,
  connection: meetingBriefTest?.hubSpotConnection ?? meetingBriefProduction!.hubSpotConnection,
});

if (meetingBriefTest) {
  registerMeetingBriefTestRoutes(app, meetingBriefTest);
}

if (process.env.ENABLE_TEST_SEED === "1") {
  await registerTestSeed(app, {
    workspaceDir,
    startRun: (spec) => transcript.startRun(spec),
    createFailedRun: () => {
      const run = runs.create({
        module: transcript.id,
        moduleVersion: transcript.version,
        intake: "drive",
        fileName: "retryable-failure.md",
        sourceUrl: null,
        externalId: null,
      });
      run.started("extract");
      run.failed("extract", "fixture_failure", "The extraction failed. Retry the Run.");
      return run.id;
    },
    personStore: peopleStore,
    ownerOnboarding,
    runs,
    ...(meetingBriefTest
      ? { upsertMeetingBriefEvent: (event) => meetingBriefTest.upsertEvent(event) }
      : {}),
  });
}

await app.listen({ port, host });
console.log(
  `chief-of-staff-demo listening on http://localhost:${port} (workspace: ${resolve(workspaceDir)}, provider: ${config.provider}, model: ${config.model || DEFAULT_MODELS[config.provider]})`,
);

// The workspace owner has to be known before the first Run, not discovered by
// one: eligibility drops the owner-declined rule when it is null (ADR-0034), so
// a Run that raced the lookup would silently brief a declined meeting. Google
// being unreachable leaves it null and is not fatal — deliver then fails
// retryably rather than sending to nobody.
await meetingBriefProduction?.refreshOwnerIdentity().catch((error: unknown) => {
  console.log(
    `[meeting-brief] owner identity unavailable at boot: ${error instanceof Error ? error.message : String(error)}`,
  );
  return null;
});

/* Same rule for owner onboarding and the workflows gated behind it: the
   identity is held before the first Run, and Google being unreachable at
   boot is not fatal — it preserves the last determinate owner identity. */
await refreshOwnerIdentity();
for (const module of modules) {
  module.start?.();
}
meetingBriefProduction?.relayPoller.start();

const shutdown = async (): Promise<void> => {
  meetingBriefProduction?.relayPoller.stop();
  for (const module of modules) {
    module.stop?.();
  }
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
