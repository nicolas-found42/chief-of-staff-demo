import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BenchmarkReportSchema, type BenchmarkReport } from "@chief-of-staff-demo/shared";
import { renderReport } from "../../../apps/server/src/person-benchmark/report.js";

const FIXTURE =
  "../../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.json";

it("accepts a provider that reports only one of the two token counts", () => {
  const report = BenchmarkReportSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL(FIXTURE, import.meta.url)), "utf8")),
  );
  const halfReported = structuredClone(report);
  halfReported.provenance.usage = {
    inputCharacters: 120,
    outputCharacters: 40,
    tokens: { input: 12, output: null },
    cost: 0.5,
  };
  const parsed = BenchmarkReportSchema.parse(halfReported);
  expect(parsed.provenance.usage?.tokens).toEqual({ input: 12, output: null });
});

function usageLine(report: BenchmarkReport) {
  const rendered = renderReport(report, []);
  const line = rendered.split("\n").find((entry) => entry.startsWith("| Measured usage |"));
  if (!line) throw new Error("rendered report carries no Measured usage row");
  return line;
}

function fixtureReport() {
  return BenchmarkReportSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL(FIXTURE, import.meta.url)), "utf8")),
  );
}

it("reports the provider-observed tokens and cost in the Measured usage row", () => {
  const report = fixtureReport();
  report.provenance.usage = {
    inputCharacters: 120,
    outputCharacters: 40,
    tokens: { input: 12, output: 34 },
    cost: 0.5,
  };
  const line = usageLine(report);
  expect(line).toContain("120 input characters, 40 output characters");
  expect(line).toContain("tokens 12 in / 34 out");
  expect(line).toContain("cost $0.5");
});

it("names only the halves the model boundary truly never supplied as unavailable", () => {
  const report = fixtureReport();
  report.provenance.usage = {
    inputCharacters: 120,
    outputCharacters: 40,
    tokens: { input: 12, output: null },
    cost: "unavailable",
  };
  const line = usageLine(report);
  expect(line).toContain("tokens 12 in / unavailable out");
  expect(line).toContain("cost unavailable from the model boundary");
});
