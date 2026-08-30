import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyError } from "fastify";
import { DEFAULT_MODELS } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "./config.js";
import { registerApi } from "./api/router.js";
import { registerStaticServing } from "./api/static.js";
import { registerRelayRoutes } from "./relay/routes.js";
import { seedRelayBaseUrlFromEnv } from "./relay/state.js";
import { registerMeetingBriefHubSpotRoutes } from "./modules/meeting-brief-generator/hubspot/routes.js";
import { contentScoutTestPorts, registerTestSeed } from "./api/testSeed.js";
import type { HostedModule } from "./engine/host.js";
import { makeCompleteJson } from "./llm/providers.js";
import { openGoogleConnection } from "./google/connection.js";
import { TranscriptHost } from "./modules/transcript/host.js";
import { YoutubeHost } from "./modules/youtube/host.js";
import { IdeaEngineHost } from "./modules/idea-engine/host.js";
import { ContentScoutHost } from "./modules/content-scout/host.js";
import { MeetingBriefHost } from "./modules/meeting-brief-generator/host.js";
import { createMeetingBriefProductionRuntime } from "./modules/meeting-brief-generator/production.js";
import {
  createMeetingBriefTestRuntime,
  registerMeetingBriefTestRoutes,
} from "./modules/meeting-brief-generator/testRuntime.js";
import { playwrightBrowserRenderer } from "./modules/content-scout/adapters/browser.js";
import { youtubeSourceClient } from "./modules/content-scout/adapters/youtube.js";
import { ExternalRuntimeInspector } from "./modules/content-scout/runtime.js";
import { contentScoutProductionAdapters } from "./modules/content-scout/adapters/production.js";
import { PublicRouteSourceDiscoverer } from "./modules/content-scout/discoverer.js";
import {
  PublicBrandProfileCrawler,
  modelBrandProfileProposer,
} from "./modules/content-scout/brand-profile.js";
import { modelDraftGenerator, modelOpportunityRanker } from "./modules/content-scout/model.js";
import {
  NotionCalendar,
  NotionCalendarPublisher,
  NotionConnection,
} from "./modules/content-scout/notion.js";
import { workspaceLayout } from "./paths.js";
import { openRuns } from "./runs.js";
import { ContentResearchHost } from "./modules/content-research/host.js";
import { createHookExtractor, createPeopleDiscoverer } from "./modules/content-research/model.js";
import { contentResearchProductionAdapters } from "./modules/content-research/adapters/production.js";
import { seedContentResearchV1 } from "./modules/content-research/seed.js";
import { ContentScoutStore } from "./modules/content-scout/store.js";
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
const notionConnection = new NotionConnection(configStore);
const notionCalendar = new NotionCalendar(notionConnection, configStore);
const notionPublisher = new NotionCalendarPublisher(notionConnection, configStore);
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
  draftGenerator: testContentScout?.draftGenerator ?? modelDraftGenerator(contentScoutCompleteJson),
  notionPublisher: testContentScout?.notionPublisher ?? notionPublisher,
  notionConnection,
  notionCalendar,
  discoverer: new PublicRouteSourceDiscoverer(),
  brandProfileCrawler: testContentScout?.brandProfileCrawler ?? new PublicBrandProfileCrawler(),
  brandProfileProposer:
    testContentScout?.brandProfileProposer ?? modelBrandProfileProposer(contentScoutCompleteJson),
  runtimeInspector: testContentScout?.runtimeInspector ?? new ExternalRuntimeInspector(),
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
/* Owner identity, read once and held until the connection changes (ADR-0036):
   the digest is a draft to the owner only, so the address must be the
   connected account's, never something a Run discovered. */
let contentResearchOwnerEmail: string | null = null;
const refreshContentResearchOwner = async (): Promise<void> => {
  const status = await googleConnection.state();
  contentResearchOwnerEmail =
    status.state === "connected" && status.email ? status.email.toLowerCase() : null;
};
const contentResearchScoutStore = new ContentScoutStore(workspaceDir, () => new Date());
const contentResearch = new ContentResearchHost({
  runs,
  workspaceDir,
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
  hookExtractor: {
    extract: async (input) => {
      const extractor = createHookExtractor(contentResearchCompleteJson);
      return extractor(input);
    },
  },
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
  getOwnerEmail: () => contentResearchOwnerEmail,
  getBrandProfile: () => contentResearchScoutStore.currentBrandProfile(),
  configStore,
  log: (message) => console.log(`[content-research] ${message}`),
});
seedContentResearchV1(contentResearch);
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
      log: meetingBriefLog,
    });
const meetingBrief: MeetingBriefHost = meetingBriefTest?.host ?? meetingBriefProduction!.host;
/* The Shell's whole knowledge of what it hosts. Order is arbitrary: what a
   person sees is the web app's Module list, not this one. */
const modules: HostedModule[] = [
  transcript,
  youtube,
  ideaEngine,
  contentScout,
  contentResearch,
  meetingBrief,
];
const app = fastify({ logger: false });

app.setErrorHandler((error: FastifyError, _request, reply) => {
  reply.code(error.statusCode ?? 500).send({ error: error.message });
});

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
await registerStaticServing(app, { webDist });

await registerApi(app, {
  runs,
  port,
  configStore,
  modules,
  google: googleConnection,
  onConfigChanged: () => {
    for (const module of modules.filter((candidate) => candidate !== meetingBrief)) {
      module.start?.();
    }
    meetingBriefProduction?.invalidateGoogleIdentity();
    // Connecting a different Google account changes who the owner is, so read
    // the new identity rather than leaving it null until the next restart.
    void meetingBriefProduction?.refreshOwnerIdentity().catch(() => null);
    meetingBrief.start();
  },
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

/* Same rule for the Content Research digest: the owner is known before the
   first Run, and Google being unreachable at boot is not fatal. */
await refreshContentResearchOwner().catch(() => {
  contentResearchOwnerEmail = null;
});
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
