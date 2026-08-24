import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { RunSourceSpec } from "../modules/transcript/module.js";

export interface TestSeedContext {
  startRun: (spec: RunSourceSpec) => Promise<string>;
}

/**
 * Hermetic e2e seam: create a Drive-type Run from the sample transcript
 * without needing a real Drive folder. Not part of the user-facing API and
 * never registered unless the explicit test flag is set, so an unset variable
 * cannot expose it (no NODE_ENV string compare).
 */
export async function registerTestSeed(app: FastifyInstance, ctx: TestSeedContext): Promise<void> {
  app.post("/api/test/seed", async (_request, reply) => {
    try {
      let bytes: Buffer | null = null;
      const candidates = [
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../tests/fixtures/transcripts/sample-transcript.md",
        ),
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
      const runId = await ctx.startRun({
        intake: "drive",
        fileName: "sample-transcript.md",
        bytes,
      });
      reply.code(201);
      return { runId };
    } catch (error) {
      reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  });
}
