import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyError } from "fastify";
import { DEFAULT_MODELS } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "./config.js";
import { registerApi } from "./api/router.js";
import { registerStaticServing } from "./api/static.js";
import { registerRelayRoutes } from "./relay/routes.js";
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
const modules: HostedModule[] = [transcript, youtube, ideaEngine, contentScout, meetingBrief];
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
    meetingBrief.start();
  },
});
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
