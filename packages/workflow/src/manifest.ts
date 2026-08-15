import type {
  ArtifactType,
  LlmMode,
  ManifestArtifact,
  RunManifest,
  RunStatus,
  SourceMetadata,
  StepArtifact,
  StepError,
  StepInvocationRecord,
  StepWarning,
  UsageSummary,
} from "@chief-of-staff/contracts";
import { atomicWriteText } from "./filesystem.js";

export interface ManifestInit {
  runId: string;
  workflow: { path: string; revision: number; sha256: string };
  source: SourceMetadata;
  transcriptSha256: string;
  configSha256: { profile: string; models: string };
  now: string;
  timezone: string;
  llm: { mode: LlmMode; model: string };
}

export function createManifest(init: ManifestInit): RunManifest {
  return {
    schemaVersion: 1,
    runId: init.runId,
    status: "running",
    workflow: init.workflow,
    source: init.source,
    transcriptSha256: init.transcriptSha256,
    configSha256: init.configSha256,
    now: init.now,
    timezone: init.timezone,
    llm: init.llm,
    tasks: [],
    steps: [],
    unresolvedRefs: [],
    warnings: [],
    artifacts: [],
    discardedTasks: 0,
    error: null,
  };
}

export function addStepRecord(manifest: RunManifest, record: StepInvocationRecord): void {
  manifest.steps.push(record);
}

export function addArtifact(manifest: RunManifest, artifact: ManifestArtifact): void {
  if (!manifest.artifacts.some((existing) => existing.artifactId === artifact.artifactId)) {
    manifest.artifacts.push(artifact);
  }
}

export function addUsage(manifest: RunManifest, usage: UsageSummary): void {
  const current = manifest.usage;
  manifest.usage = {
    input: (current?.input ?? 0) + usage.input,
    output: (current?.output ?? 0) + usage.output,
    cacheRead: (current?.cacheRead ?? 0) + usage.cacheRead,
    cacheWrite: (current?.cacheWrite ?? 0) + usage.cacheWrite,
    totalTokens: (current?.totalTokens ?? 0) + usage.totalTokens,
    costTotal: (current?.costTotal ?? 0) + usage.costTotal,
  };
}

export function addWarning(manifest: RunManifest, warning: StepWarning): void {
  manifest.warnings.push(warning);
}

export function toStepError(error: unknown): StepError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      code?: string;
      message?: string;
      retryable?: boolean;
    };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable ?? false,
      };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "FILESYSTEM_WRITE", message, retryable: false };
}

export function artifactToStepArtifact(
  runId: string,
  stepId: string,
  invocationId: string,
  taskIndex: number | null,
  startedAt: string,
  finishedAt: string,
  status: StepArtifact["status"],
  output: unknown,
  warnings: StepWarning[],
  error: StepError | null
): StepArtifact {
  return {
    schemaVersion: 1,
    runId,
    stepId,
    invocationId,
    taskIndex,
    status,
    startedAt,
    finishedAt,
    output,
    warnings,
    error,
  };
}

export async function writeManifestFile(path: string, manifest: RunManifest): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export type { ArtifactType, RunStatus };
