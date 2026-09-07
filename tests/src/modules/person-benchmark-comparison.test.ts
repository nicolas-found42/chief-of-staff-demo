import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BenchmarkReportSchema } from "@chief-of-staff-demo/shared";
import { compareReports, renderComparison } from "../../../apps/server/src/person-benchmark/report";

/** Historical failed smoke data stays failed; these controlled assessments are test-only. */
function assessedReport() {
  const report = BenchmarkReportSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  );
  report.execution = {
    status: "completed",
    selected: report.people.map((person) => person.slug),
    evaluated: report.people.length,
    assessed: report.people.length,
    scenarioIds: [],
  };
  for (const person of report.people)
    person.assessment = {
      operationId: `controlled-${person.slug}`,
      integrity: "completed",
      judge: "completed",
    };
  report.collection = [];
  return report;
}

it("compares fully assessed failed research without converting the run to success", () => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  baseline.people[0].operational.conclusion = "bounded";
  candidate.people[0].operational.conclusion = "completed";
  candidate.people[0].completeness.recovered += 1;
  const comparison = compareReports(baseline, candidate);
  expect(comparison.comparable).toBe(true);
  expect(comparison.verdict).toBe("improved");
  expect(baseline.status).toBe("failed");
  expect(comparison.operational.baselineStatus).toBe("failed");
  expect(comparison.perPerson[0]).toMatchObject({
    baselineConclusion: "bounded",
    candidateConclusion: "completed",
  });
  expect(renderComparison(comparison)).toContain("Research outcomes");
  expect(renderComparison(comparison)).toContain("failed");
});

it("renders withheld recovery as unmeasured rather than a proven zero", () => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  /* The observed judge-infrastructure shape (#271, #282): the assessment
     never completed, so the candidate's recovered count was never measured. */
  delete candidate.people[1].assessment;
  const comparison = compareReports(baseline, candidate);
  expect(comparison.perPerson[1]).toMatchObject({
    baselineAssessed: true,
    candidateAssessed: false,
  });
  const rendered = renderComparison(comparison);
  const withheldRow = rendered
    .split("\n")
    .find((line) => line.startsWith(`| ${comparison.perPerson[1].slug} `));
  expect(withheldRow).toContain("| 0 | unmeasured |");
  const assessedRow = rendered
    .split("\n")
    .find((line) => line.startsWith(`| ${comparison.perPerson[0].slug} `));
  expect(assessedRow).not.toContain("unmeasured");
});
it.each(["critical", "wrong-person"])(
  "detects a newly introduced %s failure when another failure disappears at the same count",
  (kind) => {
    const baseline = assessedReport();
    const original = baseline.people[0].factualReliability;
    if (kind === "critical") {
      original.criticalFindings = 1;
      original.criticalFindingKeys = ["a".repeat(64)];
      original.integrityFindings = [
        {
          check: "citation-quote-present",
          severity: "critical",
          subject: "generated-old-claim-id",
          detail: "Unsupported first assertion",
          fingerprint: "a".repeat(64),
        },
      ];
    } else {
      original.wrongPersonAttributions = 1;
      original.overclaims = [
        {
          claimId: "generated-old-claim-id",
          statement: "First namesake built Atlas.",
          kind: "wrong-person",
          citedQuote: "Atlas credits",
          rationale: "Wrong person",
          matchedUnjustifiedId: null,
          reviewRequired: false,
        },
      ];
    }
    const candidate = structuredClone(baseline);
    candidate.people[0].completeness.recovered += 1;
    const changed = candidate.people[0].factualReliability;
    if (kind === "critical") {
      changed.criticalFindingKeys = ["b".repeat(64)];
      changed.integrityFindings[0] = {
        ...changed.integrityFindings[0],
        fingerprint: "b".repeat(64),
        subject: "generated-new-claim-id",
        detail: "Unsupported second assertion",
      };
    } else {
      changed.overclaims[0] = {
        ...changed.overclaims[0],
        claimId: "generated-new-claim-id",
        statement: "Second namesake built Borealis.",
      };
    }
    const comparison = compareReports(baseline, candidate);
    expect(comparison.comparable).toBe(true);
    expect(comparison.verdict).toBe("regressed");
    expect(comparison.perPerson[0]).toMatchObject(
      kind === "critical" ? { newCriticalFindings: 1 } : { newWrongPersonAttributions: 1 },
    );

    // Merely regenerating a claim ID does not introduce a different failure.
    if (kind === "critical") {
      changed.criticalFindingKeys = original.criticalFindingKeys;
      changed.integrityFindings = original.integrityFindings.map((finding) => ({
        ...finding,
        subject: "different-generated-id",
      }));
    } else
      changed.overclaims = original.overclaims.map((finding) => ({
        ...finding,
        claimId: "different-generated-id",
      }));
    expect(compareReports(baseline, candidate).verdict).toBe("improved");
  },
);

it("refuses to establish improvement when a critical count has no retained finding identities", () => {
  const report = assessedReport();
  report.people[0].factualReliability.criticalFindings = 1;
  report.people[0].factualReliability.integrityFindings = [];
  expect(compareReports(report, report).comparable).toBe(false);
  report.people[0].factualReliability.integrityFindings = [
    {
      check: "private-evidence-isolation",
      severity: "critical",
      subject: "random-claim-id",
      detail: "A public projection cites private Workspace evidence.",
    },
  ];
  expect(compareReports(report, report).comparable).toBe(false);
});

it.each([
  "legacy",
  "judge",
  "integrity",
  "operation",
  "partial",
  "duplicate",
  "empty",
  "execution",
])("does not compare an unassessed or incomplete evaluation: %s", (reason) => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  if (reason === "legacy") delete candidate.execution;
  if (reason === "judge") candidate.people[0].assessment!.judge = "failed";
  if (reason === "integrity") candidate.people[0].assessment!.integrity = "failed";
  if (reason === "operation") candidate.people[0].assessment!.operationId = null;
  if (reason === "partial") candidate.people.pop();
  if (reason === "duplicate") candidate.people[1] = structuredClone(candidate.people[0]);
  if (reason === "empty") {
    candidate.people = [];
    candidate.execution!.selected = [];
    candidate.selection.evaluated = [];
    candidate.execution!.evaluated = 0;
    candidate.execution!.assessed = 0;
  }
  if (reason === "execution") candidate.execution!.status = "interrupted";
  expect(compareReports(baseline, candidate).verdict).toBe("not-comparable");
});

it("reports operational regressions separately from improved reference recovery", () => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  baseline.people[0].operational.conclusion = "completed";
  candidate.people[0].operational.conclusion = "interrupted";
  candidate.people[0].completeness.recovered += 1;
  const comparison = compareReports(baseline, candidate);
  expect(comparison.verdict).toBe("improved");
  expect(comparison.operational.regressedPeople).toEqual([candidate.people[0].slug]);
  expect(comparison.verdictDetail).toContain("Reference coverage");
});

it("requires every planned collection assessment to complete", () => {
  const baseline = assessedReport();
  baseline.execution!.scenarioIds = ["intersection"];
  expect(compareReports(baseline, baseline).comparable).toBe(false);
  baseline.collection = [
    {
      scenarioId: "intersection",
      assessmentStatus: "completed",
      requirement: "r18",
      categories: ["directing", "screenwriting"],
      expectedMatches: [],
      recoveredMatches: [],
      missingMatches: [],
      additionalMatchesForReview: [],
      assessments: [],
      demonstrated: [],
      claimed: [],
      coverage: {
        activeProfiles: baseline.people.length,
        researchedProfiles: 0,
        demonstrated: 0,
        claimedOnly: 0,
      },
      scope: "Controlled missing intersection",
    },
  ];
  expect(compareReports(baseline, baseline).comparable).toBe(true);
  baseline.collection[0].assessmentStatus = "failed";
  expect(compareReports(baseline, baseline).comparable).toBe(false);
});

it.each([true, false])(
  "CLI comparison keeps failed research honest and refuses failed assessment: assessed=%s",
  (assessed) => {
    const output = mkdtempSync(join(tmpdir(), "benchmark-comparison-contract-"));
    try {
      const baseline = assessedReport();
      const candidate = structuredClone(baseline);
      if (!assessed) candidate.people[0].assessment!.judge = "failed";
      const before = join(output, "baseline.json");
      const after = join(output, "candidate.json");
      writeFileSync(before, JSON.stringify(baseline));
      writeFileSync(after, JSON.stringify(candidate));
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/person-research-benchmark.mts",
          "--compare",
          before,
          after,
          "--out",
          output,
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(assessed ? 0 : 1);
      expect(result.stdout).toContain(assessed ? "unchanged" : "not-comparable");
      expect(result.stdout).toContain("failed");
      expect(JSON.parse(readFileSync(before, "utf8"))).toMatchObject({ status: "failed" });
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  },
);
