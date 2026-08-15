import {
  LLM_MODEL_ID,
  type AppConfig,
  type ModelsConfig,
  type ProfileConfig,
} from "@chief-of-staff/contracts";
import {
  createDeterministicIdGenerator,
  loadAndValidateDefinition,
  runWorkflow,
  type EngineServices,
  type IdGenerator,
  type RunSourceInfo,
  Workspace,
} from "@chief-of-staff/workflow";
import type { RunManifest } from "@chief-of-staff/contracts";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import {
  createPiModels,
  PiAiInvoker,
} from "@chief-of-staff/agents";
import { buildAdapterRegistry } from "@chief-of-staff/workflow";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURES_DIR = join(REPO_ROOT, "fixtures", "llm");
export const REFERENCE_DIR = join(REPO_ROOT, "reference");


export const FIXED_CLOCK_ISO = "2026-08-15T15:00:00.000Z";
export const fixedClock = (): Date => new Date(FIXED_CLOCK_ISO);

export function makeTestProfile(): ProfileConfig {
  return {
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
}

export function makeTestModels(): ModelsConfig {
  return {
    provider: "openrouter",
    model: LLM_MODEL_ID,
    reasoningEffort: null,
    maxOutputTokens: null,
  };
}

export function makeTestApp(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    maxParallelTasks: 4,
    watchDebounceMs: 750,
    maxTranscriptBytes: 26_214_400,
    allowedUiOrigins: ["http://localhost:5173", "https://OWNER.github.io"],
    ...overrides,
  };
}

export interface GoldenRunOptions {
  seed?: string;
  app?: AppConfig;
  profile?: ProfileConfig;
  models?: ModelsConfig;
  fixtureCaseOverrides?: Record<string, string>;
  mode?: "replay";
}

export interface GoldenRunResult {
  manifest: RunManifest;
  workspace: Workspace;
  runId: string;
  ids: IdGenerator;
  cleanup: () => Promise<void>;
}

/** Runs the golden transcript through the engine in replay mode in a fresh
 * temp workspace with a constant injected clock and deterministic ids. */
export async function runGoldenTranscript(
  options: GoldenRunOptions = {}
): Promise<GoldenRunResult> {
  const root = await mkdtemp(join(tmpdir(), "chief-of-staff-golden-"));
  const workspace = new Workspace(root);
  await workspace.initialize();
  const ids = createDeterministicIdGenerator(options.seed ?? "golden");
  const runId = ids.runId();
  const profile = options.profile ?? makeTestProfile();
  const models = options.models ?? makeTestModels();
  const app = options.app ?? makeTestApp();

  // Claim the source: copy the golden transcript into source/processing.
  const transcriptBytes = await readFile(
    join(REPO_ROOT, "fixtures", "transcripts", "golden-meeting.txt")
  );
  const sourceRel = `source/processing/${runId}/golden-meeting.txt`;
  await workspace.writeBytes(sourceRel, new Uint8Array(transcriptBytes));
  const stat = await workspace.statFile(sourceRel);
  const transcriptText = transcriptBytes.toString("utf8");

  const source: RunSourceInfo = {
    filename: "golden-meeting.txt",
    title: "golden-meeting",
    mimeType: "text/plain",
    byteSize: transcriptBytes.byteLength,
    sha256: requireSha256(new Uint8Array(transcriptBytes)),
    stat: { birthtimeMs: stat.mtimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.mtimeMs },
  };

  const { definition, sha256 } = await loadAndValidateDefinition(
    {
      definitionPath: join(REFERENCE_DIR, "workflow-definition.json"),
      hashPath: join(REFERENCE_DIR, "workflow-definition.sha256"),
      repoRoot: REPO_ROOT,
    },
    new Set(buildAdapterRegistry().keys()),
    (path) => readFile(path, "utf8")
  );

  const services: EngineServices = {
    workspace,
    ids,
    clock: fixedClock,
    telemetry: new InMemoryTelemetryContext(),
    adapters: buildAdapterRegistry(),
    ai: new PiAiInvoker({
      models: createPiModels(),
      mode: "replay",
      thinkingLevel: "off",
      workspace,
      fixturesDir: FIXTURES_DIR,
      loadFixtureFile: async (filePath) => readFile(filePath, "utf8"),
    }),
    profile,
    models,
    app,
    mode: "replay",
    signal: new AbortController().signal,
    timezone: "America/New_York",
    definition,
    definitionSha256: sha256,
    definitionPath: "reference/workflow-definition.json",
    logger: { info() {}, warn() {}, error() {} },
  };

  const manifest = await runWorkflow(services, {
    runId,
    source,
    transcriptText,
    transcriptSha256: requireSha256(Buffer.from(transcriptText, "utf8")),
  });

  return {
    manifest,
    workspace,
    runId,
    ids,
    cleanup: async () => {
      // Temp dirs are removed by the OS; keep the helper simple.
    },
  };
}


export function requireSha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function writeCalendarFixture(workspace: Workspace): Promise<void> {
  const calendar = await readFile(join(REPO_ROOT, "fixtures", "calendar", "events.json"));
  await workspace.writeBytes("calendar/events.json", new Uint8Array(calendar));
}

export async function writeFileIfMissing(path: string, content: string): Promise<void> {
  await writeFile(path, content, { flag: "wx" }).catch(() => undefined);
}
