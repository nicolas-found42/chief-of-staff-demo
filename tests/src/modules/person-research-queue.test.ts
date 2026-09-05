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

test.each(["archive", "correction", "merge", "privacy", "pause", "gate", "stop", "evidence"])(
  "%s during retrieval prevents late research publication",
  async (change) => {
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
    let enabled = true;
    let evidence = "before";
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      enabled: () => enabled,
      evidenceRevision: () => evidence,
    });
    queue.enqueue(person.id, "created");
    const tick = queue.tick();
    await started;
    if (change === "archive") people.archive(person.id);
    if (change === "correction")
      people.correct(person.id, { role: "Director", note: "Owner correction" });
    if (change === "merge")
      people.merge(people.create({ fullName: "Survivor" }).id, { duplicateId: person.id });
    if (change === "privacy") people.privacyDelete(person.id, { confirmation: "DELETE PROFILE" });
    if (change === "pause") queue.configure({ paused: true });
    if (change === "gate") enabled = false;
    if (change === "stop") queue.stop();
    if (change === "evidence") evidence = "after deletion";
    release();
    await tick;
    expect(dossiers.get(person.id)).toBeNull();
    expect(queue.status().usedCalls).toBe(1);
  },
);

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

test("resumes the retained document after interruption during extraction without repeating search or retrieval", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-continuation-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let searches = 0,
    retrievals = 0,
    extractions = 0;
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => {
      searches += 1;
      return [
        { url: "https://example.com/stranger", title: "Different person", snippet: "" },
        { url: "https://example.com/maya", title: "Maya", snippet: "" },
      ];
    },
    fetch: async (url) => {
      retrievals += 1;
      return {
        url,
        status: 200,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: url.endsWith("/stranger")
          ? "An unrelated stranger."
          : "maya@example.com built Atlas.",
      };
    },
    complete: async () => {
      extractions += 1;
      if (extractions === 1) {
        entered();
        await waiting;
      }
      return {
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  });
  const deps = { workspaceDir: root, people, research, enabled: () => true };
  const first = new PersonResearchQueue(deps);
  first.enqueue(person.id, "created");
  const work = first.tick();
  await started;
  expect(first.status().jobs[0].checkpoint?.pendingSourceId).toBeTruthy();
  first.stop();
  release();
  await work;
  const restarted = new PersonResearchQueue(deps);
  await restarted.tick();
  expect(searches).toBe(1);
  expect(retrievals).toBe(2);
  expect(extractions).toBe(2);
  expect(restarted.status().jobs[0].calls).toBe(5);
  expect(restarted.status().jobs[0].elapsedMilliseconds).toBeGreaterThanOrEqual(0);
});

test("daily rollover resumes the pending extraction without resetting the profile allowance", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-daily-resume-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  let searches = 0,
    retrievals = 0,
    extractions = 0;
  let scope = "";
  let now = new Date("2026-09-05T12:00:00Z");
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => {
      searches++;
      return [{ url: "https://example.com/maya", title: "Maya", snippet: "" }];
    },
    fetch: async (url) => {
      retrievals++;
      return {
        url,
        status: 200,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: "maya@example.com built Atlas.",
      };
    },
    complete: async (request) => {
      scope = JSON.parse(request.user).researchScope;
      extractions++;
      return {
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  });
  const deps = { workspaceDir: root, people, research, now: () => now, enabled: () => true };
  const queue = new PersonResearchQueue(deps);
  queue.configure({ dailyCalls: 2, profileCalls: 3 });
  queue.enqueue(person.id, "created");
  await queue.tick();
  const paused = queue.status().jobs[0];
  expect(paused.state).toBe("paused");
  expect(paused.checkpoint?.pendingSourceId).toBeTruthy();
  expect(paused.calls).toBe(2);
  now = new Date("2026-09-06T12:00:00Z");
  const restarted = new PersonResearchQueue(deps);
  await restarted.tick();
  expect(scope).toContain("Full historical");
  expect([searches, retrievals, extractions]).toEqual([1, 1, 1]);
  expect(restarted.status().jobs[0].calls).toBe(3);
  expect(restarted.status().usedCalls).toBe(1);
});

test("SIGKILL during extraction resumes durable evidence and remaining calls in a new process owner", async () => {
  const { fork } = await import("node:child_process");
  const { once } = await import("node:events");
  const root = mkdtempSync(join(tmpdir(), "research-process-crash-"));
  roots.push(root);
  const child = fork(new URL("../fixtures/person-research-crash.mts", import.meta.url), [root], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    await once(child, "message");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    let extractions = 0;
    const research = new PersonResearch({
      dossiers: new PersonDossierStore(root),
      search: async () => {
        throw new Error("Search must not restart");
      },
      fetch: async () => {
        throw new Error("Retrieval must not restart");
      },
      complete: async () => {
        extractions++;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [],
          works: [],
          expertise: [],
          connections: [],
          sections: [],
        };
      },
    });
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      enabled: () => true,
    });
    expect(queue.status().jobs[0].calls).toBe(3);
    expect(queue.status().jobs[0].checkpoint?.pendingSourceId).toBeTruthy();
    await queue.tick();
    expect(extractions).toBe(1);
    expect(queue.status().jobs[0].calls).toBe(4);
    expect(queue.status().jobs[0].elapsedMilliseconds).toBeGreaterThan(0);
  } finally {
    child.kill("SIGKILL");
  }
});

test("aged backfill wins fairly while concurrent ticks enforce one shared daily allowance", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-fairness-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const older = people.create({ primaryEmail: "older@example.com" });
  let now = new Date("2026-09-05T08:00:00Z");
  const dispatched: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async (query) => {
      dispatched.push(query);
      await wait;
      return [];
    },
    complete: async () => ({}),
  });
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    now: () => now,
    enabled: () => true,
  });
  queue.configure({ dailyCalls: 1, concurrency: 2 });
  queue.enqueue(older.id, "backfill");
  now = new Date("2026-09-05T12:00:00Z");
  const meeting = people.create({ primaryEmail: "meeting@example.com" });
  queue.enqueue(meeting.id, "meeting");
  const first = queue.tick();
  await queue.tick();
  expect(dispatched).toEqual(["older@example.com"]);
  expect(queue.status().usedCalls).toBe(1);
  release();
  await first;
  expect(queue.status().jobs.find((job) => job.profileId === meeting.id)?.calls).toBe(0);
});
