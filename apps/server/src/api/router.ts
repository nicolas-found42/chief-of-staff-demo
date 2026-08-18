import type { FastifyInstance } from "fastify";
import {
  DEFAULT_MODELS,
  type ConfigUpdate,
  ConfigUpdateSchema,
} from "@transcript-tasks/shared";
import type { ConfigStore } from "../config.js";
import { redactConfig } from "../config.js";
import { googleOutputsFor } from "../google/outputs.js";
import { exchangeGoogleCode, googleAuthUrl } from "../google/oauth.js";
import type { FirefliesIntake } from "../intake/fireflies.js";
import {
  type Pipeline,
  RunNotFoundError,
  RunNotRetryableError,
  listRunSummaries,
  readRunDetail,
} from "../pipeline/run.js";
import { isSupportedFileName } from "../text/convert.js";

export interface ApiContext {
  workspaceDir: string;
  port: number;
  pipeline: Pipeline;
  configStore: ConfigStore;
  fireflies: FirefliesIntake;
  onConfigChanged: () => void;
}

export async function registerApi(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/runs", async () => ({ runs: listRunSummaries(ctx.workspaceDir) }));

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = readRunDetail(ctx.workspaceDir, id);
    if (!detail) {
      reply.code(404).send({ error: "run not found" });
      return;
    }
    return detail;
  });

  app.post("/api/runs/upload", async (request, reply) => {
    const files: { fileName: string; bytes: Buffer }[] = [];
    for await (const part of request.files()) {
      if (part.fieldname !== "files") {
        continue;
      }
      const bytes = await part.toBuffer();
      files.push({ fileName: part.filename, bytes });
    }
    if (files.length === 0) {
      reply.code(400).send({ error: "no files uploaded (multipart field name must be 'files')" });
      return;
    }
    const unsupported = files.filter((file) => !isSupportedFileName(file.fileName));
    if (unsupported.length > 0) {
      reply.code(400).send({
        error: `unsupported file type: ${unsupported.map((file) => file.fileName).join(", ")}`,
      });
      return;
    }
    const runIds: string[] = [];
    for (const file of files) {
      runIds.push(
        await ctx.pipeline.startRun({ type: "upload", fileName: file.fileName, bytes: file.bytes })
      );
    }
    reply.code(202);
    return { runIds };
  });

  app.post("/api/runs/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const meta = await ctx.pipeline.retryRun(id);
      return { status: meta.status };
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        reply.code(404).send({ error: error.message });
        return;
      }
      if (error instanceof RunNotRetryableError) {
        reply.code(409).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.get("/api/config", async () => ({
    config: redactConfig(ctx.configStore.get()),
    defaults: DEFAULT_MODELS,
  }));

  app.put("/api/config", async (request, reply) => {
    const parsed = ConfigUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid config", issues: parsed.error.issues });
      return;
    }
    const update = parsed.data as ConfigUpdate;
    const next = ctx.configStore.update(update);
    ctx.onConfigChanged();
    return { config: redactConfig(next), defaults: DEFAULT_MODELS };
  });

  app.get("/api/google/status", async () => {
    const config = ctx.configStore.get();
    const outputs = googleOutputsFor(config, ctx.port);
    if (!outputs) {
      return { connected: false, email: null };
    }
    return { connected: true, email: await outputs.profileEmail() };
  });

  app.get("/api/google/connect", async (_request, reply) => {
    const config = ctx.configStore.get();
    if (!config.google.clientId || !config.google.clientSecret) {
      reply.code(400).send({
        error: "Google OAuth client not configured — set clientId and clientSecret in Settings first",
      });
      return;
    }
    return { authUrl: googleAuthUrl(config, ctx.port) };
  });

  app.get("/api/google/callback", async (request, reply) => {
    const query = request.query as { code?: string; error?: string };
    if (query.error || !query.code) {
      reply.redirect("/settings?google=error");
      return;
    }
    try {
      const refreshToken = await exchangeGoogleCode(ctx.configStore.get(), ctx.port, query.code);
      ctx.configStore.setGoogleRefreshToken(refreshToken);
      reply.redirect("/settings?google=connected");
    } catch (error) {
      request.log.warn(error, "Google OAuth code exchange failed");
      reply.redirect("/settings?google=error");
    }
  });

  app.post("/api/fireflies/sync", async (_request, reply) => {
    try {
      const { created } = await ctx.fireflies.pollOnce();
      return { created };
    } catch (error) {
      reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
