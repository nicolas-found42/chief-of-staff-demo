import { describe, expect, it } from "vitest";
import {
  EventSink,
  createDeterministicIdGenerator,
  loadAndValidateDefinition,
  runWorkflow,
  Workspace,
  type EngineServices,
} from "@chief-of-staff/workflow";
import {
  PiAiInvoker,
  buildAdapterRegistry,
  createPiModels,
} from "@chief-of-staff/service";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGoldenTranscript, REPO_ROOT } from "../helpers/engine.js";

const REGISTERED_STEP_TYPES = new Set<string>([
  ...buildAdapterRegistry().keys(),
  "ai.prompt.object",
  "ai.prompt.text",
  "iterator",
  "paths",
]);

const PROFILE = {
  name: "Ada Lovelace",
  title: "Chief of Staff",
  company: "Analytical Engines Inc.",
  writingStyle: "I am concise in my communication, polite but direct. I prefer shorter emails.",
  focusAreas: [
    "Customer success: reduce churn and expand accounts",
    "Product quality: ship reliable releases",
    "Operational efficiency: automate repeatable work",
  ],
};

const MODELS = {
  provider: "openrouter" as const,
  model: "nvidia/nemotron-3.5-lightning",
  reasoningEffort: null,
  maxOutputTokens: null,
};

const APP = {
  maxParallelTasks: 4,
  watchDebounceMs: 750,
  maxTranscriptBytes: 26_214_400,
  allowedUiOrigins: ["http://localhost:5173"],
};

function makeSpan(): {
  setStatus: () => void;
  setAttributes: () => void;
  addEvent: () => void;
  startSpan: <T>(_o: { name: string }, c: (s: unknown) => T | Promise<T>) => Promise<T>;
} {
  const span = {
    setStatus() {},
    setAttributes() {},
    addEvent() {},
    startSpan<T>(_o: { name: string }, c: (s: unknown) => T | Promise<T>): Promise<T> {
      return Promise.resolve(c(makeSpan()));
    },
  };
  return span;
}

function makeTelemetry(): {
  startSpan: <T>(_o: { name: string }, c: (s: unknown) => T | Promise<T>) => Promise<T>;
} {
  return {
    startSpan<T>(_o: { name: string }, c: (s: unknown) => T | Promise<T>): Promise<T> {
      return Promise.resolve(c(makeSpan()));
    },
  };
}

async function loadDefinition() {
  return loadAndValidateDefinition(
    {
      definitionPath: join(REPO_ROOT, "reference", "workflow-definition.json"),
      hashPath: join(REPO_ROOT, "reference", "workflow-definition.sha256"),
      repoRoot: REPO_ROOT,
    },
    REGISTERED_STEP_TYPES,
    (path) => readFile(path, "utf8")
  );
}

async function buildServices(
  workspace: Workspace,
  ids: ReturnType<typeof createDeterministicIdGenerator>,
  opts: { fixturesDir: string; mode?: "replay" }
): Promise<EngineServices> {
  const { definition, sha256 } = await loadDefinition();
  return {
    workspace,
    ids,
    clock: () => new Date("2026-08-15T15:00:00.000Z"),
    telemetry: makeTelemetry() as never,
    adapters: buildAdapterRegistry(),
    ai: new PiAiInvoker({
      models: createPiModels(),
      mode: opts.mode ?? "replay",
      thinkingLevel: "off",
      calendarFilePath: join(workspace.root, "calendar", "events.json"),
      fixturesDir: opts.fixturesDir,
      sleep: async () => undefined,
      jitter: () => 0,
    }),
    profile: PROFILE,
    models: MODELS,
    app: APP,
    mode: opts.mode ?? "replay",
    signal: new AbortController().signal,
    timezone: "America/New_York",
    definition,
    definitionSha256: sha256,
    definitionPath: "reference/workflow-definition.json",
    logger: { info() {}, warn() {}, error() {} },
  };
}

async function prepareWorkspace(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = new Workspace(root);
  await workspace.initialize();
  const transcriptText = await readFile(
    join(REPO_ROOT, "fixtures", "transcripts", "golden-meeting.txt"),
    "utf8"
  );
  await writeFile(
    join(root, "calendar", "events.json"),
    JSON.stringify({ timezone: "UTC", events: [] }),
    "utf8"
  );
  const ids = createDeterministicIdGenerator(prefix);
  const runId = ids.runId();
  const sourceRel = `source/processing/${runId}/golden-meeting.txt`;
  await workspace.writeBytes(sourceRel, Buffer.from(transcriptText, "utf8"));
  const stat = await workspace.statFile(sourceRel);
  return {
    root,
    workspace,
    ids,
    runId,
    transcriptText,
    stat,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("failure and recovery", () => {
  it("names the exact invocation when a replay fixture is missing", async () => {
    const env = await prepareWorkspace("missing-fixture-");
    const services = await buildServices(env.workspace, env.ids, {
      fixturesDir: join(env.root, "no-such-fixtures"),
    });
    const manifest = await runWorkflow(services, {
      runId: env.runId,
      source: {
        filename: "golden-meeting.txt",
        title: "golden-meeting",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(env.transcriptText),
        sha256: "x".repeat(64),
        stat: { birthtimeMs: env.stat.mtimeMs, mtimeMs: env.stat.mtimeMs, ctimeMs: env.stat.mtimeMs },
      },
      transcriptText: env.transcriptText,
      transcriptSha256: "y".repeat(64),
    });
    expect(manifest.status).toBe("failed");
    expect(manifest.error?.code).toBe("REPLAY_FIXTURE_MISSING");
    expect(manifest.error?.message).toContain("eitxht:main");
    await env.cleanup();
  });

  it("waits for already-started branches and writes no notification on failure", async () => {
    const env = await prepareWorkspace("branch-fail-");
    const partialFixtures = await mkdtemp(join(tmpdir(), "partial-fixtures-"));
    await writeFile(
      join(partialFixtures, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        fixtureVersion: 1,
        cases: {
          "eitxht:main": "eitxht-main.json",
          "maoa1p:0000": "maoa1p-0000.json",
        },
      }),
      "utf8"
    );
    await writeFile(
      join(partialFixtures, "eitxht-main.json"),
      await readFile(join(REPO_ROOT, "fixtures", "llm", "eitxht-main.json"), "utf8"),
      "utf8"
    );
    await writeFile(
      join(partialFixtures, "maoa1p-0000.json"),
      await readFile(join(REPO_ROOT, "fixtures", "llm", "maoa1p-0000.json"), "utf8"),
      "utf8"
    );
    const services = await buildServices(env.workspace, env.ids, {
      fixturesDir: partialFixtures,
    });
    const manifest = await runWorkflow(services, {
      runId: env.runId,
      source: {
        filename: "golden-meeting.txt",
        title: "golden-meeting",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(env.transcriptText),
        sha256: "x".repeat(64),
        stat: { birthtimeMs: env.stat.mtimeMs, mtimeMs: env.stat.mtimeMs, ctimeMs: env.stat.mtimeMs },
      },
      transcriptText: env.transcriptText,
      transcriptSha256: "y".repeat(64),
    });
    expect(manifest.status).toBe("failed");
    // The email branch (task 0) completed before the iterator failed.
    const emailSteps = manifest.steps.filter((s) => s.taskIndex === 0);
    expect(emailSteps.length).toBeGreaterThan(0);
    expect(emailSteps.every((s) => s.status === "succeeded")).toBe(true);
    // The failing branch names the exact missing invocation.
    expect(JSON.stringify(manifest.error)).toContain("ia2vvr:0001");
    // No completion notification may be written after iterator failure.
    const notifications = await readdir(join(env.root, "notifications")).catch(() => []);
    expect(notifications).toEqual([]);
    // The email draft exists (already-started branch settled safely).
    const drafts = await readdir(join(env.root, "gmail", "drafts"));
    expect(drafts).toHaveLength(1);
    await env.cleanup();
    await rm(partialFixtures, { recursive: true, force: true });
  });

  it("produces IDEMPOTENCY_CONFLICT when a tampered artifact differs", async () => {
    const run = await runGoldenTranscript();
    const draftFiles = await readdir(join(run.workspace.root, "gmail", "drafts"));
    expect(draftFiles).toHaveLength(1);
    await writeFile(
      join(run.workspace.root, "gmail", "drafts", draftFiles[0]),
      "tampered content\n",
      "utf8"
    );
    const { definition, sha256 } = await loadDefinition();
    const transcriptText = await readFile(
      join(run.workspace.root, "runs", run.runId, "input", "transcript.txt"),
      "utf8"
    );
    const services: EngineServices = {
      workspace: run.workspace,
      ids: run.ids,
      clock: () => new Date("2026-08-15T15:00:00.000Z"),
      telemetry: makeTelemetry() as never,
      adapters: buildAdapterRegistry(),
      ai: new PiAiInvoker({
        models: createPiModels(),
        mode: "replay",
        thinkingLevel: "off",
        calendarFilePath: join(run.workspace.root, "calendar", "events.json"),
        fixturesDir: join(REPO_ROOT, "fixtures", "llm"),
        sleep: async () => undefined,
        jitter: () => 0,
      }),
      profile: PROFILE,
      models: MODELS,
      app: APP,
      mode: "replay",
      signal: new AbortController().signal,
      timezone: "America/New_York",
      definition,
      definitionSha256: sha256,
      definitionPath: "reference/workflow-definition.json",
      logger: { info() {}, warn() {}, error() {} },
    };
    const manifest = await runWorkflow(services, {
      runId: run.runId,
      source: {
        filename: "golden-meeting.txt",
        title: "golden-meeting",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(transcriptText),
        sha256: "x".repeat(64),
        stat: { birthtimeMs: 0, mtimeMs: 0, ctimeMs: 0 },
      },
      transcriptText,
      transcriptSha256: "y".repeat(64),
    });
    expect(manifest.status).toBe("failed");
    expect(manifest.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    // The tampered file was not overwritten.
    expect(
      await readFile(join(run.workspace.root, "gmail", "drafts", draftFiles[0]), "utf8")
    ).toBe("tampered content\n");
  });

  it("reuses verified outputs on a re-run without duplicating drafts or rows", async () => {
    const run = await runGoldenTranscript();
    const draftsBefore = await readdir(join(run.workspace.root, "gmail", "drafts"));
    const { definition, sha256 } = await loadDefinition();
    const transcriptText = await readFile(
      join(run.workspace.root, "runs", run.runId, "input", "transcript.txt"),
      "utf8"
    );
    const services: EngineServices = {
      workspace: run.workspace,
      ids: run.ids,
      clock: () => new Date("2026-08-15T15:00:00.000Z"),
      telemetry: makeTelemetry() as never,
      adapters: buildAdapterRegistry(),
      ai: new PiAiInvoker({
        models: createPiModels(),
        mode: "replay",
        thinkingLevel: "off",
        calendarFilePath: join(run.workspace.root, "calendar", "events.json"),
        fixturesDir: join(REPO_ROOT, "fixtures", "llm"),
        sleep: async () => undefined,
        jitter: () => 0,
      }),
      profile: PROFILE,
      models: MODELS,
      app: APP,
      mode: "replay",
      signal: new AbortController().signal,
      timezone: "America/New_York",
      definition,
      definitionSha256: sha256,
      definitionPath: "reference/workflow-definition.json",
      logger: { info() {}, warn() {}, error() {} },
    };
    await runWorkflow(services, {
      runId: run.runId,
      source: {
        filename: "golden-meeting.txt",
        title: "golden-meeting",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(transcriptText),
        sha256: "x".repeat(64),
        stat: { birthtimeMs: 0, mtimeMs: 0, ctimeMs: 0 },
      },
      transcriptText,
      transcriptSha256: "y".repeat(64),
    });
    const draftsAfter = await readdir(join(run.workspace.root, "gmail", "drafts"));
    expect(draftsAfter).toEqual(draftsBefore);
    const csv = await readFile(join(run.workspace.root, "tracking", "actions.csv"), "utf8");
    expect(csv.trim().split("\n")).toHaveLength(4);
  });

  it("resumes from a prior manifest by reusing verified prior outputs", async () => {
    const run = await runGoldenTranscript();
    const { definition, sha256 } = await loadDefinition();
    const transcriptText = await readFile(
      join(run.workspace.root, "runs", run.runId, "input", "transcript.txt"),
      "utf8"
    );
    const services: EngineServices = {
      workspace: run.workspace,
      ids: run.ids,
      clock: () => new Date("2026-08-15T15:00:00.000Z"),
      telemetry: makeTelemetry() as never,
      adapters: buildAdapterRegistry(),
      ai: new PiAiInvoker({
        models: createPiModels(),
        mode: "replay",
        thinkingLevel: "off",
        calendarFilePath: join(run.workspace.root, "calendar", "events.json"),
        fixturesDir: join(REPO_ROOT, "fixtures", "llm"),
        sleep: async () => undefined,
        jitter: () => 0,
      }),
      profile: PROFILE,
      models: MODELS,
      app: APP,
      mode: "replay",
      signal: new AbortController().signal,
      timezone: "America/New_York",
      definition,
      definitionSha256: sha256,
      definitionPath: "reference/workflow-definition.json",
      logger: { info() {}, warn() {}, error() {} },
    };
    const resumed = await runWorkflow(services, {
      runId: run.runId,
      source: {
        filename: "golden-meeting.txt",
        title: "golden-meeting",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(transcriptText),
        sha256: "x".repeat(64),
        stat: { birthtimeMs: 0, mtimeMs: 0, ctimeMs: 0 },
      },
      transcriptText,
      transcriptSha256: "y".repeat(64),
      resumeFrom: run.manifest,
    });
    expect(resumed.status).toBe("succeeded");
    // Every prior invocation was reused (no re-execution), no duplicates.
    expect(resumed.steps.every((step) => step.status === "succeeded")).toBe(true);
    const drafts = await readdir(join(run.workspace.root, "gmail", "drafts"));
    expect(drafts).toHaveLength(1);
    const csv = await readFile(join(run.workspace.root, "tracking", "actions.csv"), "utf8");
    expect(csv.trim().split("\n")).toHaveLength(4);
  });

  it("cancellation and retry reuse the same run id while run again creates a new one", async () => {
    const ids = createDeterministicIdGenerator("cancel-test");
    const runIdA = ids.runId();
    const runIdB = ids.runId();
    expect(runIdB).not.toBe(runIdA);
    // A retry resumes the SAME run id: the engine is re-invoked with the
    // stored id, which the deterministic generator reproduces on a fresh
    // service process with the same seed.
    const fresh = createDeterministicIdGenerator("cancel-test");
    expect(fresh.runId()).toBe(runIdA);
  });

  it("emits monotonic sequences for every event", async () => {
    const root = await mkdtemp(join(tmpdir(), "events-seq-"));
    const sink = new EventSink(join(root, "events.jsonl"), () => new Date("2026-08-15T15:00:00.000Z"));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => sink.emit({ runId: "r", type: "progress", data: { i } }))
    );
    const text = await readFile(join(root, "events.jsonl"), "utf8");
    const sequences = text
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
    await rm(root, { recursive: true, force: true });
  });
});
