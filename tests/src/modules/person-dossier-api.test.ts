import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { registerPersonDossierApi } from "../../../apps/server/src/api/person-dossiers.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { PersonResearchQueue } from "../../../apps/server/src/person-profile/research-queue.js";
import { PersonResearch } from "../../../apps/server/src/person-profile/research.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

test("owner can inspect research states, change budgets, and enqueue without waiting for the web", async () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-api-"));
  const app = Fastify();
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ primaryEmail: "maya@example.com" });
    const dossiers = new PersonDossierStore(root);
    const research = new PersonResearch({
      dossiers,
      search: async () => [],
      complete: async () => ({}),
    });
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      enabled: () => true,
    });
    registerPersonDossierApi(app, { people, dossiers, queue });
    const response = await app.inject({ method: "POST", url: `/api/people/${person.id}/research` });
    expect(response.statusCode).toBe(202);
    expect(response.json().research.state).toBe("queued");
    const settings = await app.inject({
      method: "PATCH",
      url: "/api/people/research/settings",
      payload: { dailyCalls: 12, paused: true },
    });
    expect(settings.json().settings.dailyCalls).toBe(12);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/people/research/settings",
          payload: { dailyCalls: -1 },
        })
      ).statusCode,
    ).toBe(400);
    const read = await app.inject(`/api/people/${person.id}/dossier`);
    expect(read.json().dossier).toBeNull();
    expect(read.json().research.state).toBe("queued");
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
