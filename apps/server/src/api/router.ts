import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODELS,
  type ConfigUpdate,
  ConfigUpdateSchema,
} from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../config.js";
import { redactConfig } from "../config.js";
import { googleFailureHint, type GoogleConnection } from "../google/connection.js";
import type { DriveIntake } from "../intake/drive.js";
import { type Pipeline, RunNotFoundError, RunNotRetryableError } from "../pipeline/run.js";
import type { Runs } from "../runs.js";
export interface ApiContext {
  runs: Runs;
  port: number;
  pipeline: Pipeline;
  configStore: ConfigStore;
  driveIntake: DriveIntake;
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

  app.post("/api/drive/sync", async (_request, reply) => {
    try {
      const { created } = await ctx.driveIntake.pollOnce();
      return { created };
    } catch (error) {
      reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Test seam: create a Drive-type Run from the sample transcript without
  // needing a real Drive folder. Not part of the user-facing API; used only
  // by hermetic e2e tests that need a Run to exist.
  app.post("/api/test/seed", async (_request, reply) => {
    if (process.env.NODE_ENV === "production") {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    try {
      let bytes: Buffer | null = null;
      const candidates = [
        join(dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/transcripts/sample-transcript.md"),
        join(process.cwd(), "tests/fixtures/transcripts/sample-transcript.md"),
      ];
      for (const cand of candidates) {
        try {
          bytes = await readFile(cand);
          break;
        } catch {}
      }
      if (!bytes) {
        bytes = Buffer.from("# Weekly Product Sync\n\nAlice: hello\nBob: hi\n");
      }
      const runId = await ctx.pipeline.startRun({
        type: "drive",
        fileName: "sample-transcript.md",
        bytes,
      });
      reply.code(201);
      return { runId };
    } catch (error) {
      reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
