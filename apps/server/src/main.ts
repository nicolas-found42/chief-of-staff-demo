import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import { DEFAULT_MODELS } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "./config.js";
import { registerApi } from "./api/router.js";
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
import type { MeetingBriefFixtureEvent } from "@chief-of-staff-demo/shared";
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
const meetingBrief = new MeetingBriefHost({
  runs,
  workspaceDir,
  configStore,
  getCompleteJson: meetingBriefCompleteJson,
  // Calendar provider is injectable/fake for tests; real Google Calendar provider lands in later wave.
  getOwnerEmail: () => null,
  log: (message) => console.log(`[meeting-brief] ${message}`),
});
/* The Shell's whole knowledge of what it hosts. Order is arbitrary: what a
   person sees is the web app's Module list, not this one. */
const modules: HostedModule[] = [transcript, youtube, ideaEngine, contentScout, meetingBrief];
const app = fastify({ logger: false });

app.setErrorHandler((error: FastifyError, _request, reply) => {
  reply.code(error.statusCode ?? 500).send({ error: error.message });
});

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const webIndex = existsSync(`${webDist}/index.html`);
if (webIndex) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
}
app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/") || request.method !== "GET") {
    reply.code(404).send({ error: "not found" });
    return;
  }
  if (webIndex) {
    reply.code(200).sendFile("index.html");
    return;
  }
  reply.code(404).send({ error: "not found" });
});

await registerApi(app, {
  runs,
  port,
  configStore,
  modules,
  google: googleConnection,
  onConfigChanged: () => {
    for (const module of modules) {
      module.start?.();
    }
  },
});
registerRelayRoutes(app, { workspaceDir });
registerMeetingBriefHubSpotRoutes(app, { configStore });

if (process.env.ENABLE_TEST_SEED === "1") {
  app.post("/api/test/meeting-brief/schedule", async (request) => {
    const body = request.body as { event?: MeetingBriefFixtureEvent; dueAt?: string };
    if (!body.event || typeof body.event !== "object") return { error: "event required" };
    const event = body.event;
    const dueAt = body.dueAt ? new Date(body.dueAt) : new Date();
    meetingBrief.scheduleOccurrence(event, dueAt);
    return { scheduled: true };
  });
  app.post("/api/test/meeting-brief/process-due", async (request) => {
    const body = request.body as { now?: string };
    const now = body.now ? new Date(body.now) : new Date();
    const created = await meetingBrief.processDueSchedules(now);
    await meetingBrief.idle();
    return { created };
  });
  app.post("/api/test/meeting-brief/advance", async (request) => {
    const body = request.body as { ms?: number; now?: string };
    const now = body.now
      ? new Date(body.now)
      : typeof body.ms === "number"
        ? new Date(Date.now() + body.ms)
        : new Date();
    const created = await meetingBrief.processDueSchedules(now);
    await meetingBrief.idle();
    try {
      const runner = (meetingBrief as unknown as { runner: { recoverRuns: () => Promise<number> } })
        .runner;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runner may be absent in test helper
      if (runner) await runner.recoverRuns();
      await meetingBrief.idle();
    } catch {
      // ignore recover failure in test helper
    }
    return { now: now.toISOString(), created };
  });
  app.post("/api/test/meeting-brief/set-now", async (request) => {
    const body = request.body as { now?: string | null };
    // stub: no-op, just acknowledge for hermetic journey compatibility
    return { now: body.now ?? null };
  });
  app.get("/api/test/meeting-brief/fake-gmail/messages", async () => {
    // Fallback to index-derived delivery check; return empty stub that journey will interpret via index
    // Try to derive from runs if available: look at last message via index
    try {
      const idx = meetingBrief.index();
      const msgs = idx.briefs
        .filter((b) => b.delivery?.status === "sent" || b.delivery?.status === "reconciled")
        .map((b) => ({
          to: b.delivery?.recipient ?? "owner@example.com",
          subject: b.meetingBrief?.logistics.title
            ? `Meeting Brief: ${b.meetingBrief.logistics.title}`
            : "Meeting Brief",
          deliveryId: b.delivery?.deliveryId ?? "",
        }));
      return { messages: msgs };
    } catch {
      return { messages: [] };
    }
  });
  app.post("/api/test/meeting-brief/fake-gmail/clear", async () => {
    return { cleared: true };
  });
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

const shutdown = async (): Promise<void> => {
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
