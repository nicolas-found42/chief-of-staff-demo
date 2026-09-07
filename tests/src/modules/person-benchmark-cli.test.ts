import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BenchmarkReportSchema, BenchmarkPersonArtifactSchema } from "@chief-of-staff-demo/shared";

it("rejects unknown requested people without writing a successful empty report", () => {
  const output = mkdtempSync(join(tmpdir(), "benchmark-invalid-selection-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--people",
        "definitely-unknown",
        "--out",
        output,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown Benchmark Person: definitely-unknown");
    expect(readdirSync(output)).toEqual([]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

it("refuses a rejected corpus instead of evaluating its remaining entries", () => {
  const corpus = mkdtempSync(join(tmpdir(), "benchmark-invalid-corpus-"));
  const output = mkdtempSync(join(tmpdir(), "benchmark-invalid-output-"));
  try {
    writeFileSync(join(corpus, "broken.json"), "{}");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--corpus",
        corpus,
        "--out",
        output,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Benchmark corpus contains rejected entries");
    expect(readdirSync(output)).toEqual([]);
  } finally {
    rmSync(corpus, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

it.each([
  { args: [], error: "Benchmark selection is empty" },
  { args: ["--people", ""], error: "--people must select at least one person" },
  { args: ["--limit", "0"], error: "--limit must be a positive integer" },
  { args: ["--limit", "-1"], error: "--limit must be a positive integer" },
  { args: ["--limit", "no"], error: "--limit must be a positive integer" },
])("rejects invalid selection: $error", ({ args, error }) => {
  const corpus = mkdtempSync(join(tmpdir(), "benchmark-empty-corpus-"));
  const output = mkdtempSync(join(tmpdir(), "benchmark-empty-output-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--corpus",
        corpus,
        "--out",
        output,
        ...args,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(readdirSync(output)).toEqual([]);
  } finally {
    rmSync(corpus, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

it("records a valid limited subset as intentional and preserves its failed evaluation", () => {
  const output = mkdtempSync(join(tmpdir(), "benchmark-limited-"));
  try {
    const config = join(output, "config.json");
    writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--people",
        "achim-steiner,ana-botin",
        "--limit",
        "1",
        "--out",
        output,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    const reportFile = readdirSync(output).find(
      (file) =>
        file.startsWith("fixed-documents-") &&
        file.endsWith(".json") &&
        !file.endsWith(".operation.json") &&
        !file.endsWith(".person.json"),
    )!;
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(join(output, reportFile), "utf8")),
    );
    expect(report.selection).toEqual({
      requested: ["achim-steiner", "ana-botin"],
      evaluated: ["achim-steiner"],
      skipped: [{ slug: "ana-botin", reason: "Excluded by --limit." }],
    });
    expect(report.status).toBe("failed");
    expect(report.execution).toMatchObject({
      status: "completed",
      selected: ["achim-steiner"],
      evaluated: 1,
      assessed: 0,
    });
    expect(report.people[0]?.assessment?.judge).toBe("failed");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

it("records all default corpus members excluded by --limit without an explicit --people list", () => {
  const output = mkdtempSync(join(tmpdir(), "benchmark-default-limit-"));
  try {
    const config = join(output, "config.json");
    writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--limit",
        "1",
        "--out",
        output,
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    const file = readdirSync(output).find(
      (name) =>
        name.startsWith("fixed-documents-") &&
        name.endsWith(".json") &&
        !name.endsWith(".operation.json") &&
        !name.endsWith(".person.json"),
    )!;
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(join(output, file), "utf8")),
    );
    expect(report.selection.requested).toHaveLength(30);
    expect(report.selection.evaluated).toHaveLength(1);
    expect(report.selection.skipped).toEqual(
      report.selection.requested
        .filter((slug) => !report.selection.evaluated.includes(slug))
        .map((slug) => ({ slug, reason: "Excluded by --limit." })),
    );
    expect(report.selection.skipped).toHaveLength(29);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

it.each([
  {
    args: ["--mode", "live-discovery", "--concurrency", "0"],
    error: "--concurrency must be a positive integer",
  },
  {
    args: ["--mode", "live-discovery", "--concurrency", "5"],
    error: "--concurrency must be an integer from 1 to 4",
  },
  {
    args: ["--mode", "live-discovery", "--concurrency", "1.5"],
    error: "--concurrency must be a positive integer",
  },
  /* Fixed-document mode researches people concurrently now: each person runs
     through its own composition over per-profile keyed stores, so parallel
     people touch disjoint files and share only process-wide route rests
     (#233). There is no fixed-documents concurrency case left to reject. */
])("rejects unsafe benchmark concurrency: $args", ({ args, error }) => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/person-research-benchmark.mts", ...args],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(error);
});

it("retains public evidence without credentials and produces a separately reassessable artifact", () => {
  const output = mkdtempSync(join(tmpdir(), "benchmark-retained-evidence-"));
  try {
    const config = join(output, "config.json");
    writeFileSync(
      config,
      JSON.stringify({ provider: "mock", model: "mock", apiKey: "fixture-secret-never-copy" }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--people",
        "achim-steiner",
        "--retain-evidence",
        "--out",
        output,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1); // Mock judging fails honestly, evidence remains usable.
    const files = readdirSync(output);
    const evidence = join(
      output,
      files.find((file) => file.endsWith(".evidence"))!,
    );
    expect(readdirSync(evidence)).not.toContain("config.json");
    const manifest = JSON.parse(readFileSync(join(evidence, "snapshot-manifest.json"), "utf8")) as {
      completedOperationIds: string[];
    };
    const reportFile = files.find(
      (file) =>
        file.endsWith(".json") &&
        file !== "config.json" &&
        !file.endsWith(".operation.json") &&
        !file.endsWith(".person.json"),
    )!;
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(join(output, reportFile), "utf8")),
    );
    expect(report.provenance.researchSettings.operationConcurrency).toBe(1);
    expect(report.evidenceBundleHash).toMatch(/^[a-f0-9]{64}$/);
    const personFile = files.find((file) => file.endsWith(".person.json"))!;
    const personArtifact = BenchmarkPersonArtifactSchema.parse(
      JSON.parse(readFileSync(join(output, personFile), "utf8")),
    );
    expect(personArtifact.runId).toBe(report.runId);
    expect(personArtifact.result).toEqual(report.people[0]);
    expect(personArtifact.result.assessment?.phases).toMatchObject({
      reference: { status: "failed" },
      support: { status: "not-attempted" },
    });
    expect(result.stderr).toContain(
      "judge failed (reference failed, support/usefulness not-attempted)",
    );
    expect(result.stderr).toContain("credited recovery 0/");

    expect(manifest.completedOperationIds).toEqual([report.people[0].assessment!.operationId]);
    const reassessed = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--reassess",
        join(output, reportFile),
        "--evidence-workspace",
        evidence,
        "--config",
        config,
        "--out",
        join(output, "reassessed"),
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(reassessed.status, reassessed.stderr).toBe(1);
    expect(reassessed.stdout).toContain("no research was repeated");
    const reassessedPerson = readdirSync(join(output, "reassessed")).find((file) =>
      file.endsWith(".person.json"),
    )!;
    const reassessedArtifact = BenchmarkPersonArtifactSchema.parse(
      JSON.parse(readFileSync(join(output, "reassessed", reassessedPerson), "utf8")),
    );
    expect(reassessedArtifact.reassessmentOf).toBe(report.runId);
    expect(reassessedArtifact.result.assessment?.judge).toBe("failed");
    expect(reassessed.stderr).toContain(
      "judge failed (reference failed, support/usefulness not-attempted)",
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
