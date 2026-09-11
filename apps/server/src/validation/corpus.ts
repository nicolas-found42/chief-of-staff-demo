import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CampaignCorpusRevision } from "@chief-of-staff-demo/shared";

/**
 * Loads the frozen corpus revision a campaign is planned against
 * (#363, MWR-017/019).
 *
 * A case is one transcript plus, for Goldens, the hand-written expectations
 * beside it. The revision id is a content hash over the case ids and their
 * bytes, so the plan's slot counts are derived from what was actually frozen
 * and a changed corpus is a different revision rather than a silent edit.
 */

export interface CampaignCorpusCase {
  caseId: string;
  kind: "golden" | "incident" | "brief";
  transcriptPath: string;
  transcriptFile: string;
  /** The hand-written expectations for a Golden case; null for the others. */
  goldenPath: string | null;
}

export interface LoadedCampaignCorpus {
  revision: CampaignCorpusRevision;
  cases: CampaignCorpusCase[];
}

export interface LoadCampaignCorpusInput {
  goldenDir: string;
  /** Where the incident transcripts live; every `.md`/`.txt` is one case. */
  incidentDir?: string | undefined;
  briefDir?: string | undefined;
}

function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function goldenTranscriptName(goldenPath: string): string {
  const parsed = JSON.parse(readFileSync(goldenPath, "utf8")) as { transcript?: unknown };
  if (typeof parsed.transcript !== "string" || parsed.transcript.length === 0) {
    throw new Error(
      `Golden ${goldenPath.split("/").pop() ?? goldenPath} does not name its transcript; ` +
        "every Golden case must pair with one input transcript.",
    );
  }
  return parsed.transcript;
}

function transcriptFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => /\.(md|txt)$/.test(entry))
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .sort();
}

function revisionHash(cases: readonly CampaignCorpusCase[]): string {
  const hash = createHash("sha256");
  for (const entry of [...cases].sort((a, b) => (a.caseId < b.caseId ? -1 : 1))) {
    hash.update(`${entry.kind}:${entry.caseId}:${entry.transcriptFile}:`);
    hash.update(readFileSync(entry.transcriptPath));
    if (entry.goldenPath !== null) hash.update(readFileSync(entry.goldenPath));
  }
  return hash.digest("hex");
}

export function loadCampaignCorpus(input: LoadCampaignCorpusInput): LoadedCampaignCorpus {
  const cases: CampaignCorpusCase[] = [];
  const transcriptsDir = join(input.goldenDir, "transcripts");
  for (const entry of readdirSync(input.goldenDir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const goldenPath = join(input.goldenDir, entry);
    const transcriptFile = goldenTranscriptName(goldenPath);
    cases.push({
      caseId: fileStem(entry),
      kind: "golden",
      transcriptPath: join(transcriptsDir, transcriptFile),
      transcriptFile,
      goldenPath,
    });
  }
  for (const [kind, dir] of [
    ["incident", input.incidentDir],
    ["brief", input.briefDir],
  ] as const) {
    if (dir === undefined) continue;
    for (const entry of transcriptFiles(dir)) {
      cases.push({
        caseId: fileStem(entry),
        kind,
        transcriptPath: join(dir, entry),
        transcriptFile: entry,
        goldenPath: null,
      });
    }
  }
  const revision: CampaignCorpusRevision = {
    revision: revisionHash(cases),
    goldenCaseIds: cases.filter((entry) => entry.kind === "golden").map((entry) => entry.caseId),
    incidentCaseIds: cases
      .filter((entry) => entry.kind === "incident")
      .map((entry) => entry.caseId),
    briefCaseIds: cases.filter((entry) => entry.kind === "brief").map((entry) => entry.caseId),
  };
  return { revision, cases };
}
