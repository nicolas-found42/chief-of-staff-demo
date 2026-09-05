import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PersonResearchQueue } from "../../../apps/server/src/person-profile/research-queue.js";
import { PersonResearch } from "../../../apps/server/src/person-profile/research.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("queue coalesces creation requests, resumes after restart, and reserves failed calls against daily limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => {
      throw new Error("Unavailable");
    },
    complete: async () => ({}),
  });
  let now = new Date("2026-09-05T12:00:00Z");
  const deps = { workspaceDir: root, people, research, now: () => now, enabled: () => true };
  const first = new PersonResearchQueue(deps);
  first.configure({ dailyCalls: 1, paused: false });
  first.enqueue(person.id, "created");
  first.enqueue(person.id, "meeting");
  const queue = new PersonResearchQueue(deps);
  expect(queue.status().jobs).toHaveLength(1);
  await queue.tick();
  expect(queue.status().usedCalls).toBe(1);
  expect(queue.status().jobs[0]?.state).toBe("unavailable");
  queue.enqueue(person.id, "explicit");
  await queue.tick();
  expect(queue.status().jobs[0]?.state).toBe("paused");
  now = new Date("2026-09-06T12:00:00Z");
  await queue.tick();
  expect(queue.status().usedCalls).toBe(1);
  expect(queue.status().jobs[0]?.state).toBe("unavailable");
});

test("a profile archived during retrieval cannot receive the late research result", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-race-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const research = new PersonResearch({
    dossiers,
    search: async () => {
      entered();
      await waiting;
      return [{ title: "Maya", url: "https://example.com/maya", snippet: "maya@example.com" }];
    },
    complete: async () => {
      throw new Error("Late model dispatch");
    },
  });
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    enabled: () => true,
  });
  queue.enqueue(person.id, "created");
  const tick = queue.tick();
  await started;
  people.archive(person.id);
  release();
  await tick;
  expect(dossiers.get(person.id)).toBeNull();
  expect(queue.status().usedCalls).toBe(1);
});

test("repeated enqueues and absent removes do not rewrite the queue state file", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-quiet-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  const now = new Date("2026-09-05T12:00:00Z");
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    now: () => now,
    enabled: () => true,
  });
  queue.enqueue(person.id, "created");
  const stateFile = join(root, "person-research.json");
  const persisted = readFileSync(stateFile, "utf8");
  queue.enqueue(person.id, "meeting");
  expect(readFileSync(stateFile, "utf8")).not.toBe(persisted);
  const afterReason = readFileSync(stateFile, "utf8");
  queue.enqueue(person.id, "meeting");
  queue.enqueue(person.id, "meeting");
  expect(readFileSync(stateFile, "utf8")).toBe(afterReason);
  queue.remove("person_absent");
  expect(readFileSync(stateFile, "utf8")).toBe(afterReason);
});
