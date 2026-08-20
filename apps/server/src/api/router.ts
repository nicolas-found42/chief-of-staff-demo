import type { FastifyInstance } from "fastify";
import {
  DEFAULT_MODELS,
  type ConfigUpdate,
  ConfigUpdateSchema,
} from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../config.js";
import { redactConfig } from "../config.js";
import { googleFailureHint, type GoogleConnection } from "../google/connection.js";
import type { FirefliesIntake } from "../intake/fireflies.js";
import { type Pipeline, RunNotFoundError, RunNotRetryableError } from "../pipeline/run.js";
import type { Runs } from "../runs.js";
import { isSupportedFileName } from "../text/convert.js";

export interface ApiContext {
  runs: Runs;
  port: number;
  pipeline: Pipeline;
  configStore: ConfigStore;
  fireflies: FirefliesIntake;
  /** The only route to Google: the four states, the consent screen, and sign-out. */
  google: GoogleConnection;
  onConfigChanged: () => void;
}

export async function registerApi(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const runs = ctx.runs;
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/runs", async () => ({ runs: runs.list() }));

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = runs.detail(id);
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
        /* Skipping a part without consuming its stream stalls the iterator, and
           the 400 below never reaches the client. Discard it instead of
           buffering: a wrong field name is not worth 10 MB of memory. */
        part.file.resume();
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
    /* Credentials may have changed under the connection, so what it remembers
       about Google is no longer evidence of anything. */
    ctx.google.invalidate();
    ctx.onConfigChanged();
    return { config: redactConfig(next), defaults: DEFAULT_MODELS };
  });

  app.get("/api/google/status", async () => ctx.google.state());

  /* Clearing the refresh token is the only way back to a chooser once a token
     is held: Google reuses the last-granted account silently, so switching
     accounts and recovering from a rejected token both start here. */
  app.post("/api/google/disconnect", async () => {
    ctx.google.disconnect();
    return ctx.google.state();
  });

  /* POST, not GET: it spends the refresh token and calls Google twice, so it
     must not be reachable by a link or a prefetch. Person-initiated only
     (ADR-0008). */
  app.post("/api/google/check", async () => ctx.google.verifySetup());

  app.get("/api/google/connect", async (_request, reply) => {
    const access = ctx.google.authUrl();
    if (!access.ok) {
      reply.code(400).send({ error: googleFailureHint(access.state) });
      return;
    }
    return { authUrl: access.url };
  });

  app.get("/api/google/callback", async (request, reply) => {
    const query = request.query as { code?: string; error?: string };
    if (query.error || !query.code) {
      /* `access_denied` has one cause worth naming: the account that just
         signed in is not on the consent screen's Test users list, so Google
         refused before issuing anything. Every other refusal is generic, and
         only the app knows the attempt happened at all. */
      const reason = query.error === "access_denied" ? "access_denied" : "error";
      reply.redirect(`/settings?google=${reason}`);
      return;
    }
    try {
      await ctx.google.completeSignIn(query.code);
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
