import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BenchmarkPersonArtifactSchema,
  type BenchmarkMode,
  type BenchmarkPersonArtifact,
} from "@chief-of-staff-demo/shared";

/**
 * The resume half of outage-proof arms: read a benchmark output directory and
 * classify every person artifact as carriable into a new run, refusable, or
 * unstamped. A completed, fully assessed person carried under a provably
 * identical run recipe is money already spent; everything else re-runs.
 * The reuse contract is strict by design — a confirmed recipe mismatch
 * refuses the whole directory, because arms under different conditions are
 * exactly the confound the conditions stamp exists to prevent.
 */

/** The run recipe a reuse candidate must prove it was produced under. */
export interface ResumeConditions {
  mode: BenchmarkMode;
  researchProvider: string;
  researchModel: string;
  promptVersion: string;
  reasoningEffort: string;
  seed?: number | undefined;
}

interface MismatchedConditions {
  slug: string;
  field: string;
  prior: unknown;
  current: unknown;
}

export interface ReusableDirectory {
  /** slug → artifact, ready to carry into the new run's report. */
  eligible: Map<string, BenchmarkPersonArtifact>;
  /** Artifacts that would qualify but predate conditions stamping. */
  unstamped: string[];
  /** Artifacts stamped under a different recipe: the caller refuses. */
  mismatched: MismatchedConditions[];
}

const CONDITION_FIELDS: (keyof ResumeConditions)[] = [
  "mode",
  "researchProvider",
  "researchModel",
  "promptVersion",
  "reasoningEffort",
  "seed",
];

/** Research finished and both assessments completed: nothing left to buy. */
function fullyAssessed(artifact: BenchmarkPersonArtifact): boolean {
  return (
    artifact.result.failure === null &&
    artifact.result.operational.conclusion === "completed" &&
    artifact.result.assessment?.integrity === "completed" &&
    artifact.result.assessment.judge === "completed"
  );
}

function classify(
  artifact: BenchmarkPersonArtifact,
  current: ResumeConditions,
  reuse: ReusableDirectory,
): void {
  /* A reassessment re-judges immutable evidence from an earlier run; the
     original run's own artifact is the reuse source. */
  if (artifact.reassessmentOf !== undefined) return;
  if (!fullyAssessed(artifact)) return;
  if (artifact.conditions === undefined) {
    reuse.unstamped.push(artifact.result.slug);
    return;
  }
  const differing = CONDITION_FIELDS.filter(
    (field) => artifact.conditions![field] !== current[field],
  );
  if (differing.length > 0) {
    reuse.mismatched.push(
      ...differing.map((field) => ({
        slug: artifact.result.slug,
        field,
        prior: artifact.conditions![field],
        current: current[field],
      })),
    );
    return;
  }
  reuse.eligible.set(artifact.result.slug, artifact);
}

/** Read every person artifact in the directory and sort it into the three
 *  buckets. Several runs in one directory are fine; the latest assessment of
 *  a slug wins, by the recorded assessment time. */
export function loadReusable(directory: string, current: ResumeConditions): ReusableDirectory {
  const reuse: ReusableDirectory = { eligible: new Map(), unstamped: [], mismatched: [] };
  const found = readdirSync(directory)
    .filter((name) => name.endsWith(".person.json"))
    .map((name) => {
      try {
        return BenchmarkPersonArtifactSchema.parse(
          JSON.parse(readFileSync(join(directory, name), "utf8")),
        );
      } catch {
        /* Not a readable person artifact — nothing to reuse from it. */
        return null;
      }
    })
    .filter((artifact): artifact is BenchmarkPersonArtifact => artifact !== null)
    .sort((a, b) => a.assessedAt.localeCompare(b.assessedAt));
  for (const artifact of found) classify(artifact, current, reuse);
  return reuse;
}
