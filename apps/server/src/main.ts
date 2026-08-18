import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { DEFAULT_MODELS } from "@transcript-tasks/shared";
import { ConfigStore } from "./config.js";
import { registerApi } from "./api/router.js";
import { makeCompleteJson } from "./llm/providers.js";
import { googleOutputsFor } from "./google/outputs.js";
import { FirefliesIntake } from "./intake/fireflies.js";
import { WatchIntake } from "./intake/watch.js";
import { Pipeline } from "./pipeline/run.js";
import { workspaceLayout } from "./paths.js";
import { MAX_UPLOAD_BYTES } from "./text/convert.js";

const port = Number(process.env.PORT ?? 4317);
const workspaceDir = process.env.WORKSPACE_DIR ?? "./workspace";
const layout = workspaceLayout(workspaceDir);
mkdirSync(layout.runsDir, { recursive: true });
mkdirSync(layout.watchArchiveDir, { recursive: true });

const configStore = new ConfigStore(layout.configFile);
const config = configStore.load();

const pipeline = new Pipeline({
  workspaceDir,
  getCompleteJson: () => {
    const current = configStore.get();
    return makeCompleteJson(
      { provider: current.provider, model: current.model, apiKey: current.apiKey },
      layout.mockResultFile
    );
  },
  getGoogle: () => googleOutputsFor(configStore.get(), port),
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
  workspaceDir,
  port,
  pipeline,
  configStore,
  fireflies,
  onConfigChanged: () => {
    fireflies.start();
    syncWatchIntake();
  },
});

await app.listen({ port, host: "127.0.0.1" });
console.log(
  `transcript-found42 listening on http://localhost:${port} (workspace: ${resolve(workspaceDir)}, provider: ${config.provider}, model: ${config.model || DEFAULT_MODELS[config.provider]})`
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
