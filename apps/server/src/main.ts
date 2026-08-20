import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { DEFAULT_MODELS } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "./config.js";
import { registerApi } from "./api/router.js";
import { makeCompleteJson } from "./llm/providers.js";
import { openGoogleConnection } from "./google/connection.js";
import { FirefliesIntake } from "./intake/fireflies.js";
import { WatchIntake } from "./intake/watch.js";
import { Pipeline } from "./pipeline/run.js";
import { workspaceLayout } from "./paths.js";
import { openRuns } from "./runs.js";
import { MAX_UPLOAD_BYTES } from "./text/convert.js";

const port = Number(process.env.PORT ?? 4317);
/* Loopback by default (ADR-0001). A container sets HOST=0.0.0.0 because the
   loopback interface inside a container is not reachable from the host; the
   published port is still bound to 127.0.0.1 on the host side. */
const host = process.env.HOST ?? "127.0.0.1";
const workspaceDir = process.env.WORKSPACE_DIR ?? "./workspace";
const layout = workspaceLayout(workspaceDir);
mkdirSync(layout.runsDir, { recursive: true });
mkdirSync(layout.watchArchiveDir, { recursive: true });

const configStore = new ConfigStore(layout.configFile);
const config = configStore.load();

const googleConnection = openGoogleConnection(configStore, port);
/* One owner for the run directory: the Pipeline and the API read and write the
   same Runs, not two objects over one directory. */
const runs = openRuns(workspaceDir);

const pipeline = new Pipeline({
  runs,
  getCompleteJson: () => {
    const current = configStore.get();
    return makeCompleteJson(
      {
        provider: current.provider,
        model: current.model,
        apiKey: current.apiKey,
        baseUrl: current.ollama.baseUrl,
      },
      layout.mockResultFile
    );
  },
  getLlmInfo: () => {
    const current = configStore.get();
    return { provider: current.provider, model: current.model };
  },
  google: googleConnection,
  getTasklistName: () => configStore.get().tasklistName,
  log: (message) => console.log(`[pipeline] ${message}`),
});

const fireflies = new FirefliesIntake({
  getConfig: () => configStore.get(),
  workspaceDir,
  startRun: (spec) => pipeline.startRun(spec),
  log: (message) => console.log(`[fireflies] ${message}`),
});

const watchIntake = new WatchIntake({
  archiveDir: layout.watchArchiveDir,
  onFile: async ({ fileName, bytes }) => {
    await pipeline.startRun({ type: "watch", fileName, bytes });
  },
  log: (message) => console.log(`[watch] ${message}`),
});

const app = fastify({ logger: false });

app.setErrorHandler((error: FastifyError, _request, reply) => {
  if (
    error.code === "FST_PART_FILE_TOO_LARGE" ||
    error.code === "FST_FILES_OVERSIZE" ||
    error.code === "FST_REQ_FILE_TOO_LARGE"
  ) {
    reply.code(413).send({ error: "file exceeds the 10 MB upload limit" });
    return;
  }
  reply.code(error.statusCode ?? 500).send({ error: error.message });
});

await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 50 } });

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

const syncWatchIntake = (): void => {
  const current = configStore.get();
  if (current.watch.enabled && current.watch.folderPath) {
    void watchIntake.start(current.watch.folderPath);
  } else {
    void watchIntake.stop();
  }
};

await registerApi(app, {
  runs,
  port,
  pipeline,
  configStore,
  fireflies,
  google: googleConnection,
  onConfigChanged: () => {
    fireflies.start();
    syncWatchIntake();
  },
});

await app.listen({ port, host });
console.log(
  `chief-of-staff-demo listening on http://localhost:${port} (workspace: ${resolve(workspaceDir)}, provider: ${config.provider}, model: ${config.model || DEFAULT_MODELS[config.provider]})`
);

fireflies.start();
syncWatchIntake();

const shutdown = async (): Promise<void> => {
  fireflies.stop();
  await watchIntake.stop();
  await app.close();
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
