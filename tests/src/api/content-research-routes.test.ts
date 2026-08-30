import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NamedPerson } from "@chief-of-staff-demo/shared";
import { ContentResearchHost } from "../../../apps/server/src/modules/content-research/host";
import { openRuns } from "../../../apps/server/src/runs";

/**
 * The Module's own endpoints, over a real server instance and a temporary
 * Workspace. What matters here is that a watchlist the operator can add to is
 * also one they can take someone off — a Named Person added by mistake was
 * otherwise only removable by editing Workspace JSON by hand.
 */
let app: FastifyInstance;
let host: ContentResearchHost;

beforeEach(async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-research-routes-"));
  /* No Run executes here, so the collaborators a Run would reach are never
     called — only the watchlist routes are under test. */
  host = new ContentResearchHost(
    fromPartial({
      runs: openRuns(workspaceDir),
      workspaceDir,
      adapters: [],
      discoverFeeds: async () => [],
      now: () => new Date("2026-08-30T08:00:00.000Z"),
      log: () => {},
    }),
  );
  app = fastify();
  host.routes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function watchedNames(): Promise<string[]> {
  const response = await app.inject({ method: "GET", url: "/api/content-research/people" });
  return response.json<NamedPerson[]>().map((person) => person.name);
}

describe("Content Research people routes", () => {
  it("stops watching a Named Person, and leaves the rest of the watchlist alone", async () => {
    const added = await app.inject({
      method: "POST",
      url: "/api/content-research/people",
      payload: { name: "Ada Lovelace" },
    });
    await app.inject({
      method: "POST",
      url: "/api/content-research/people",
      payload: { name: "Grace Hopper" },
    });
    expect(await watchedNames()).toEqual(["Ada Lovelace", "Grace Hopper"]);

    const person = added.json<NamedPerson>();
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/content-research/people/${person.id}`,
    });

    expect(removed.statusCode).toBe(200);
    expect(await watchedNames()).toEqual(["Grace Hopper"]);
  });

  it("reports an unknown Named Person rather than reporting a removal that did not happen", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/content-research/people/person_does_not_exist",
    });

    expect(response.statusCode).toBe(404);
  });
});
