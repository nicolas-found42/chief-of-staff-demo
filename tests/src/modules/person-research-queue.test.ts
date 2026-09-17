import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { PersonResearchReadiness } from "@chief-of-staff-demo/shared";
import { PersonResearchQueue } from "../../../apps/server/src/person-profile/research-queue.js";
import {
  PersonResearch,
  type ResearchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("queue coalesces creation requests and counts failed calls without deferring them to another day", async () => {
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
  const deps = {
    workspaceDir: root,
    people,
    research,
    now: () => now,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  };
  const first = new PersonResearchQueue(deps);
  first.configure({ paused: false });
  first.enqueue(person.id, "created");
  first.enqueue(person.id, "meeting");
  const queue = new PersonResearchQueue(deps);
  expect(queue.status().jobs).toHaveLength(1);
  await queue.tick();
  expect(queue.status().usedCalls).toBe(1);
  expect(queue.status().jobs[0]?.state).toBe("unavailable");
  queue.enqueue(person.id, "explicit");
  await queue.tick();
  expect(queue.status().jobs[0]?.state).toBe("unavailable");
  expect(queue.status().usedCalls).toBe(2);
  now = new Date("2026-09-06T12:00:00Z");
  await queue.tick();
  expect(queue.status().usedCalls).toBe(1);
  expect(queue.status().jobs[0]?.state).toBe("unavailable");
});
test("one named lookup returns one Profile's queue record", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-"));
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
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  queue.enqueue(person.id, "created");
  const job = queue.job(person.id);
  expect(job?.profileId).toBe(person.id);
  expect(job?.state).toBe("queued");
  /* The named lookup hands back the same record the status endpoint reports
     for this Profile, so the dossier view keeps its response shape. */
  expect(job).toEqual(queue.status().jobs.find((entry) => entry.profileId === person.id));
  /* And a clone: a caller holding the record cannot mutate the queue. */
  job!.state = "researching";
  expect(queue.job(person.id)?.state).toBe("queued");
  expect(queue.job("no-such-profile")).toBeNull();
});

test("summary()/diagnostics()/aggregate() are bounded, one-profile, checkpoint-free, and side-effect-free", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-summary-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const other = people.create({ primaryEmail: "other@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [{ url: "https://example.com/maya", title: "Maya", snippet: "" }],
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: "maya@example.com built Atlas.",
    }),
    complete: async () => ({
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
    }),
  });
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  queue.enqueue(person.id, "created");
  queue.enqueue(other.id, "created");
  await queue.tick();

  expect(queue.summary("no-such-profile")).toBeNull();
  const summary = queue.summary(person.id);
  expect(summary?.profileId).toBe(person.id);
  expect(summary?.state).toBe("empty");
  // Named one-profile lookup, not a whole-queue clone: nothing about the
  // other Profile's job leaks in, and no checkpoint or full attempt ledger
  // is embedded (#417 F4, spec §7).
  expect(summary).not.toHaveProperty("checkpoint");
  expect(JSON.stringify(summary)).not.toContain(other.id);
  expect(Buffer.byteLength(JSON.stringify(summary), "utf8")).toBeLessThanOrEqual(16 * 1024);

  const page = queue.diagnostics(person.id);
  expect(page).not.toBeNull();
  expect(page?.entries.length).toBeLessThanOrEqual(50);
  expect(page?.operationId).toBe(summary?.decisive?.operationId ?? page?.operationId);
  expect(queue.diagnostics("no-such-profile")).toBeNull();

  const aggregate = queue.aggregate();
  expect(aggregate.totalJobs).toBe(2);
  expect(aggregate.byState.empty).toBe(1);
  expect(aggregate.byState.queued).toBe(1);
  expect(aggregate).not.toHaveProperty("jobs");

  // Side-effect-free: reading the summary/diagnostics/aggregate must never
  // enqueue new work or change any job's state.
  expect(queue.job(person.id)?.state).toBe("empty");
  expect(queue.job(other.id)?.state).toBe("queued");
});

/**
 * Typed enqueue decisions (issue #418, T3): `enqueue()` used to return void
 * and no-op silently in four distinct situations (#417 F1). Every path now
 * returns an honest, exhaustive decision.
 */
test("enqueue() returns a typed accepted decision naming the queued work", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-decision-"));
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
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  expect(queue.enqueue(person.id, "created")).toEqual({
    kind: "accepted",
    profileId: person.id,
    jobState: "queued",
  });
});

test("enqueue() reports already-active work instead of silently coalescing it", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-decision-"));
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
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  queue.enqueue(person.id, "created");
  expect(queue.enqueue(person.id, "viewed")).toEqual({
    kind: "already-active",
    profileId: person.id,
    jobState: "queued",
  });
});

test("enqueue() defers a non-urgent reason still inside the existing job's backoff window", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-decision-"));
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
  let now = new Date("2026-09-05T12:00:00Z");
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    now: () => now,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  queue.enqueue(person.id, "created");
  await queue.tick();
  now = new Date("2026-09-05T12:00:01Z");
  /* "viewed" is only urgent once the existing job has aged 48h; freshly
     completed, its refresh backoff is still well in the future. */
  const decision = queue.enqueue(person.id, "viewed");
  expect(decision.kind).toBe("deferred");
  if (decision.kind === "deferred") {
    expect(decision.profileId).toBe(person.id);
    expect(Date.parse(decision.nextAt)).toBeGreaterThan(Date.parse(now.toISOString()));
  }
});

test("enqueue() rejects on readiness, carrying the actual blocker, without touching the queue", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-decision-"));
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
  const readiness = {
    state: "setup-required" as const,
    reason: "owner-not-confirmed" as const,
    nextAction: { label: "Open Settings", href: "/settings" },
  };
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => readiness,
  });
  expect(queue.enqueue(person.id, "explicit")).toEqual({
    kind: "rejected-readiness",
    profileId: person.id,
    readiness,
  });
  expect(queue.status().jobs).toHaveLength(0);
});

test("enqueue() rejects on the queue's own administrative pause via readiness()", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-decision-"));
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
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  queue.configure({ paused: true });
  expect(queue.enqueue(person.id, "explicit")).toEqual({
    kind: "rejected-readiness",
    profileId: person.id,
    readiness: { state: "paused", reason: "administratively-paused" },
  });
});

test("enqueue() reports inactive-profile for an archived Profile and for one that does not exist", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-decision-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  people.archive(person.id);
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  expect(queue.enqueue(person.id, "explicit")).toEqual({
    kind: "inactive-profile",
    profileId: person.id,
  });
  expect(queue.enqueue("person_absent", "explicit")).toEqual({
    kind: "inactive-profile",
    profileId: "person_absent",
  });
});

test("queue.readiness() reports paused only over an otherwise-ready readiness", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-decision-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  const setupRequired: PersonResearchReadiness = {
    state: "setup-required",
    reason: "provider-not-configured",
  };
  let base: PersonResearchReadiness = { state: "ready", reason: "ready" };
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => base,
  });
  expect(queue.readiness()).toEqual(base);
  queue.configure({ paused: true });
  expect(queue.readiness()).toEqual({ state: "paused", reason: "administratively-paused" });
  /* A genuine setup problem is never hidden behind "paused". */
  base = setupRequired;
  expect(queue.readiness()).toEqual(setupRequired);
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
      readiness: () =>
        enabled
          ? { state: "ready" as const, reason: "ready" as const }
          : { state: "setup-required" as const, reason: "provider-not-configured" as const },
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
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
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
  const deps = {
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  };
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
  /* `calls` counts model calls now that requests are bounded separately:
     one extraction before the interruption and one after it. */
  expect(restarted.status().jobs[0].calls).toBe(2);
  expect(restarted.status().jobs[0].elapsedMilliseconds).toBeGreaterThanOrEqual(0);
});

test("continuous research finishes pending extraction before daily rollover", async () => {
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
  const deps = {
    workspaceDir: root,
    people,
    research,
    now: () => now,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  };
  const queue = new PersonResearchQueue(deps);
  queue.configure({ profileCalls: 3 });
  queue.enqueue(person.id, "created");
  await queue.tick();
  const completed = queue.status().jobs[0];
  expect(completed.state).toBe("empty");
  /* A completed operation leaves no traversal behind: the next run is a
     refresh of changed evidence, not the second half of this one. */
  expect(completed.checkpoint).toBeUndefined();
  expect(completed.calls).toBe(1);
  now = new Date("2026-09-06T12:00:00Z");
  const restarted = new PersonResearchQueue(deps);
  await restarted.tick();
  expect(scope).toContain("Full historical");
  expect([searches, retrievals, extractions]).toEqual([1, 1, 1]);
  expect(restarted.status().jobs[0].calls).toBe(1);
  expect(restarted.status().usedCalls).toBe(0);
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
      readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
    });
    /* One model call was reserved before the process died; the retained
       document and that reservation both survive into the new owner. */
    expect(queue.status().jobs[0].calls).toBe(1);
    expect(queue.status().jobs[0].checkpoint?.pendingSourceId).toBeTruthy();
    await queue.tick();
    expect(extractions).toBe(1);
    expect(queue.status().jobs[0].calls).toBe(2);
    expect(queue.status().jobs[0].elapsedMilliseconds).toBeGreaterThan(0);
  } finally {
    child.kill("SIGKILL");
  }
});

test("aged backfill wins fairly while concurrent ticks enforce configured concurrency", async () => {
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
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  queue.configure({ concurrency: 1 });
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

test("a save merges a concurrent instance's jobs", () => {
  /* One Workspace can carry several queue instances at once — the benchmark
     researches fixed-document people concurrently (#233) — and each holds the
     snapshot it loaded. A save merges with the file so neither instance drops
     the other's jobs. */
  const { root, deps, kept, dropped } = shared("merge");
  const first = new PersonResearchQueue(deps);
  const second = new PersonResearchQueue(deps);
  /* Both loaded the empty file before either wrote. */
  first.enqueue(kept.id, "explicit");
  second.enqueue(dropped.id, "explicit");
  expect(onDisk(root).sort()).toEqual([kept.id, dropped.id].sort());
});

test.each(["the instance that removed it", "an instance still holding it"])(
  "a removal survives a later save by %s",
  (saver) => {
    /* A merge must never undo a deletion, and the two directions fail
       differently. The remover must not read its own deleted job back from a
       snapshot written before the removal. A concurrent instance must not
       re-add a job it still holds but the file no longer has — that job was
       deleted by someone else, and a stale snapshot is not grounds to
       resurrect it. Privacy deletion depends on both. */
    const { root, deps, kept, dropped } = shared("removal");
    const remover = new PersonResearchQueue(deps);
    remover.enqueue(kept.id, "explicit");
    remover.enqueue(dropped.id, "explicit");
    /* Loads with both jobs, so it holds the one about to be deleted. */
    const stale = new PersonResearchQueue(deps);
    expect(onDisk(root).sort()).toEqual([kept.id, dropped.id].sort());

    remover.remove(dropped.id);
    expect(onDisk(root)).toEqual([kept.id]);

    /* Any unrelated change is enough to trigger the merge. */
    (saver === "the instance that removed it" ? remover : stale).configure({ paused: true });
    expect(onDisk(root)).toEqual([kept.id]);
  },
);

test("unified history retains every completed operation after restart with stable pages and no active duplicates", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-complete-history-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  let now = new Date("2026-09-05T12:00:00Z");
  let holdSearch = false;
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    now: () => now,
    search: async () => {
      if (holdSearch) {
        holdSearch = false;
        started.resolve();
        await gate.promise;
      }
      return [];
    },
    complete: async () => ({}),
  });
  const deps = {
    workspaceDir: root,
    people,
    research,
    now: () => now,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  };
  const queue = new PersonResearchQueue(deps);
  const finished = [];
  for (let index = 0; index < 3; index += 1) {
    queue.enqueue(person.id, "explicit");
    await queue.tick(person.id);
    expect(queue.operation(person.id)?.conclusion).toBe("completed");
    finished.push(queue.history().find((row) => row.phase === "current")!);
    // Two equal start times exercise the cursor's ID tie-break, not only dates.
    if (index === 1) now = new Date("2026-09-06T12:00:00Z");
  }
  const expected = finished.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const restarted = new PersonResearchQueue(deps);
  expect(restarted.history().map((row) => row.id)).toEqual(expected.map((row) => row.id));
  const firstPage = restarted.history({ limit: 2 });
  const secondPage = restarted.history({ limit: 2, before: firstPage[1] });
  expect([...firstPage, ...secondPage].map((row) => row.id)).toEqual(expected.map((row) => row.id));
  const older = restarted.history().filter((row) => row.phase === "previous");
  holdSearch = true;
  now = new Date("2026-09-07T12:00:00Z");
  restarted.enqueue(person.id, "explicit");
  now = new Date("2026-09-08T12:00:00Z");
  const running = restarted.tick(person.id);
  await started.promise;
  try {
    const live = restarted.history();
    expect(live.filter((row) => row.status === "researching")).toHaveLength(1);
    expect(new Set(live.map((row) => row.id)).size).toBe(4);
    expect(live.filter((row) => older.some((old) => old.id === row.id))).toEqual(older);
    expect(
      new PersonResearchQueue(deps).history().map(({ id, createdAt }) => ({ id, createdAt })),
    ).toEqual(live.map(({ id, createdAt }) => ({ id, createdAt })));
  } finally {
    gate.resolve();
    await running;
  }
  const final = new PersonResearchQueue(deps).history();
  expect(final.filter((row) => row.status === "completed")).toHaveLength(4);
  expect(new Set(final.map((row) => row.id)).size).toBe(4);
  expect(final.filter((row) => older.some((old) => old.id === row.id))).toEqual(older);
});

/**
 * Issue #418, T5, spec §7; #417 F5: starting a new operation must never
 * present a prior settled conclusion as its own live progress or failure.
 */
test("a new operation's live progress never shows the prior operation's conclusion, which stays available as labeled history", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-history-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  let pauseNextSearch = false;
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => {
      if (pauseNextSearch) {
        pauseNextSearch = false;
        started.resolve();
        await gate.promise;
      }
      return [{ url: "https://example.com/maya", title: "Maya", snippet: "" }];
    },
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: "maya@example.com built Atlas.",
    }),
    complete: async () => ({
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
    }),
  });
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  queue.enqueue(person.id, "created");
  await queue.tick();
  const jobA = queue.job(person.id);
  /* A "completed" operation clears its checkpoint (#228), so the NEXT
     dispatch mints a genuinely new operation identity rather than resuming
     this one -- the scenario spec §7 asks for. */
  expect(jobA?.operation?.conclusion).toBe("completed");
  expect(jobA?.checkpoint).toBeUndefined();
  const operationAId = jobA?.operation?.operationId;
  const detailA = jobA?.detail;
  expect(operationAId).toBeTruthy();

  pauseNextSearch = true;
  queue.enqueue(person.id, "explicit");
  const queuedSummary = queue.summary(person.id);
  expect(queuedSummary?.state).toBe("queued");
  expect(queuedSummary?.detail).not.toBe(detailA);
  expect(queue.operation(person.id)?.detail).toBe(detailA);
  const running = queue.tick(person.id);
  await started.promise;

  const mid = queue.job(person.id);
  expect(mid?.state).toBe("researching");
  expect(mid?.currentOperationId).toBeTruthy();
  expect(mid?.currentOperationId).not.toBe(operationAId);
  /* The defining fix (#417 F5): an active operation's own `detail` is
     neutral progress, never the previous operation's terminal conclusion. */
  expect(mid?.detail).not.toBe(detailA);
  expect(mid?.previousConclusion).toMatchObject({
    operationId: operationAId,
    conclusion: "completed",
    detail: detailA,
  });

  const midSummary = queue.summary(person.id);
  expect(midSummary?.state).toBe("researching");
  expect(midSummary?.detail).not.toBe(detailA);
  expect(midSummary?.previousConclusion?.operationId).toBe(operationAId);

  gate.resolve();
  await running;
  const jobB = queue.job(person.id);
  expect(jobB?.operation?.operationId).not.toBe(operationAId);
  /* A's conclusion is still there, just no longer sitting in `detail`. */
  expect(jobB?.previousConclusion?.operationId).toBe(operationAId);
});

test("restart preserves the decisive summary and the previous-conclusion history (issue #418, T5)", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-restart-history-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  let pauseNextSearch = false;
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => {
      if (pauseNextSearch) {
        pauseNextSearch = false;
        started.resolve();
        await gate.promise;
      }
      return [{ url: "https://example.com/maya", title: "Maya", snippet: "" }];
    },
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: "maya@example.com built Atlas.",
    }),
    complete: async () => ({
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
    }),
  });
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  queue.enqueue(person.id, "created");
  await queue.tick();
  const operationAId = queue.job(person.id)?.operation?.operationId;
  const detailA = queue.operation(person.id)?.detail;
  expect(queue.job(person.id)?.operation?.decisiveExtraction?.classification).toBe(
    "no-supported-facts",
  );

  pauseNextSearch = true;
  queue.enqueue(person.id, "explicit");
  const running = queue.tick(person.id);
  await started.promise;
  // Simulate a process restart while operation B is still in flight: a new
  // queue instance loads the durable file directly, never resolving B.
  const restarted = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });
  const restartedJob = restarted.job(person.id);
  /* Shutdown demotes "researching" back to "queued" exactly as before this
     change (#228); the new fields survive that demotion untouched. */
  expect(restartedJob?.state).toBe("queued");
  expect(restartedJob?.operation?.decisiveExtraction?.classification).toBe("no-supported-facts");
  expect(restartedJob?.previousConclusion?.operationId).toBe(operationAId);
  expect(restartedJob?.currentOperationId).not.toBe(operationAId);
  const restartedSummary = restarted.summary(person.id);
  expect(restartedSummary?.state).toBe("queued");
  expect(restartedSummary?.detail).not.toBe(detailA);
  expect(restartedSummary?.previousConclusion).toMatchObject({
    operationId: operationAId,
    detail: detailA,
  });
  expect(restarted.operation(person.id)?.detail).toBe(detailA);
  gate.resolve();
  await running;
});

/** One Workspace, two Profiles, and the deps every queue instance shares. */
function shared(label: string) {
  const root = mkdtempSync(join(tmpdir(), `research-queue-${label}-`));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const kept = people.create({ primaryEmail: "kept@example.com" });
  const dropped = people.create({ primaryEmail: "dropped@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  return {
    root,
    kept,
    dropped,
    deps: {
      workspaceDir: root,
      people,
      research,
      readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
    },
  };
}

function onDisk(root: string): string[] {
  const state = JSON.parse(readFileSync(join(root, "person-research.json"), "utf8")) as {
    jobs: { profileId: string }[];
  };
  return state.jobs.map((job) => job.profileId);
}

/**
 * Audit F2/F6: a job that once ended `bounded` kept its spent lifetime
 * counters, so `enqueue` never reset them and every later attempt was cut a
 * 1-call/1000-ms slice that could accomplish nothing while reporting a
 * wall-clock backstop it never came close to. The fixture is the exact state
 * the audit measured: the ceiling reached on both axes, with a checkpoint
 * retained — which is what suppressed the reset.
 */
function exhaustedJobFixture(
  root: string,
  profile: { id: string; revision: number },
  operationId: string,
): void {
  writeFileSync(
    join(root, "person-research.json"),
    JSON.stringify({
      schemaVersion: 1,
      settings: {
        paused: false,
        concurrency: 1,
        refreshHours: 168,
        profileCalls: 12,
        profileMilliseconds: 120000,
        readConcurrency: 4,
        requestTimeoutMilliseconds: 20000,
        quietRounds: 2,
      },
      day: "2026-09-15",
      usedCalls: 325,
      jobs: [
        {
          profileId: profile.id,
          state: "incomplete",
          reasons: ["created"],
          queuedAt: "2026-09-15T20:00:00.000Z",
          updatedAt: "2026-09-15T22:02:55.000Z",
          nextAt: "2026-09-15T22:02:55.000Z",
          calls: 12,
          sources: 2,
          attempts: 5,
          elapsedMilliseconds: 137831,
          detail: "The operation's wall-clock backstop was reached with work still pending.",
          checkpoint: {
            operationId,
            profileRevision: profile.revision,
            pass: 1,
            visited: [],
            linked: [],
            direct: [],
            queries: [],
            results: [],
            pendingSourceIds: [],
            retainedSourceIds: [],
          },
          operation: {
            operationId,
            profileId: profile.id,
            conclusion: "bounded",
            startedAt: "2026-09-15T21:57:30.557Z",
            finishedAt: "2026-09-15T21:57:35.095Z",
            detail: "The operation's wall-clock backstop was reached with work still pending.",
            rounds: 24,
            modelCalls: 12,
            requests: 207,
            sourcesRetained: 2,
            claimsPublished: 5,
            coverage: [],
            leads: [],
            attempts: [],
            gaps: [],
          },
        },
      ],
    }),
  );
}

test("audit F2: an explicit request on a lifetime-exhausted job is cut a whole allowance and keeps its checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-budget-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "budget@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  /* Observing the allowance the queue computed, not replacing the
     computation: the real `run` still executes underneath. */
  const allowances: ResearchAllowance[] = [];
  const realRun = research.run.bind(research);
  research.run = async (profile, allowance) => {
    allowances.push(allowance);
    return realRun(profile, allowance);
  };
  exhaustedJobFixture(root, person, "op-bounded-1");
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });

  queue.enqueue(person.id, "explicit");
  const queued = queue.job(person.id);
  /* The retained traversal survives the new allowance: this is a new
     operation over kept work, not a re-read from nothing. */
  expect(queued?.checkpoint?.operationId).toBe("op-bounded-1");
  expect(queued?.calls).toBe(0);
  expect(queued?.elapsedMilliseconds).toBe(0);

  await queue.tick();
  expect(allowances).toHaveLength(1);
  expect(allowances[0].maxModelCalls).toBeGreaterThan(1);
  expect(allowances[0].maxMilliseconds).toBeGreaterThan(1000);
  /* The whole configured allowance, not a remainder of a spent one. */
  expect(allowances[0].maxModelCalls).toBe(12);
  expect(allowances[0].maxMilliseconds).toBe(120000);
});

test("audit F2/F6: an automatic attempt on a spent allowance reports the exhausted allowance, not a wall-clock backstop", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-budget-reason-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "budget@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  const allowances: ResearchAllowance[] = [];
  const realRun = research.run.bind(research);
  research.run = async (profile, allowance) => {
    allowances.push(allowance);
    return realRun(profile, allowance);
  };
  exhaustedJobFixture(root, person, "op-bounded-2");
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  });

  queue.enqueue(person.id, "viewed");
  await queue.tick();
  const job = queue.job(person.id);
  /* No doomed slice was dispatched at all: the clamped attempt that used to
     burn ten seconds and publish nothing never starts. */
  expect(allowances).toHaveLength(0);
  expect(job?.state).toBe("incomplete");
  expect(job?.detail).toContain("research allowance is spent");
  expect(job?.detail).toContain("12 of 12 model calls");
  expect(job?.detail).toContain("138s of its 120s research time");
  expect(job?.detail).not.toContain("wall-clock");
  /* Partial results and the retained traversal survive the honest refusal. */
  expect(job?.checkpoint?.operationId).toBe("op-bounded-2");
  expect(job?.sources).toBe(2);
});

test("audit F2: explicit research renews a restart-recovered queued operation before dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-recovered-budget-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "recovered@example.com" });
  exhaustedJobFixture(root, person, "op-recovered");
  const file = join(root, "person-research.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.jobs[0].state = "researching";
  state.jobs[0].startedAt = "2026-09-15T22:02:54.000Z";
  writeFileSync(file, JSON.stringify(state));
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  const allowances: ResearchAllowance[] = [];
  const run = research.run.bind(research);
  research.run = (profile, allowance) => {
    allowances.push(allowance);
    return run(profile, allowance);
  };
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    now: () => new Date("2026-09-15T22:02:55.000Z"),
    readiness: () => ({ state: "ready", reason: "ready" }),
  });
  expect(queue.job(person.id)?.state).toBe("queued");
  expect(queue.enqueue(person.id, "explicit").kind).toBe("accepted");
  expect(queue.job(person.id)?.calls).toBe(0);
  expect(queue.job(person.id)?.elapsedMilliseconds).toBe(0);
  expect(queue.job(person.id)?.checkpoint?.operationId).toBe("op-recovered");
  expect(queue.job(person.id)?.sources).toBe(2);
  expect(queue.status().usedCalls).toBe(325);
  expect(queue.enqueue(person.id, "explicit").kind).toBe("already-active");
  await queue.tick();
  expect(allowances).toHaveLength(1);
  expect(allowances[0].maxModelCalls).toBe(12);
  expect(allowances[0].maxMilliseconds).toBe(120000);
  expect(queue.job(person.id)?.state).toBe("empty");
  expect(queue.job(person.id)?.detail).not.toContain("allowance is spent");
});
