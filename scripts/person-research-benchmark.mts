import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BenchmarkReportSchema,
  type BenchmarkPersonResult,
  type BenchmarkReport,
} from "../packages/shared/src/index.js";
import { ConfigStore } from "../apps/server/src/config.js";
import { makeCompleteJson } from "../apps/server/src/llm/providers.js";
import { probeSourceEligibility } from "../apps/server/src/source-adapters/eligibility.js";
import { readPersonSource } from "../apps/server/src/person-profile/research-readers.js";
import { playwrightBrowserRenderer } from "../apps/server/src/source-adapters/browser.js";
import { loadCorpus, requirementCoverage } from "../apps/server/src/person-benchmark/corpus.js";
import { evaluatePerson, runId } from "../apps/server/src/person-benchmark/evaluate.js";
import { JUDGE_VERSION } from "../apps/server/src/person-benchmark/judge.js";
import { configurePipeline } from "../apps/server/src/person-benchmark/pipelines.js";
import {
  compareReports,
  remainingMisses,
  renderComparison,
  renderReport,
  summarizeGroups,
} from "../apps/server/src/person-benchmark/report.js";

/**
 * The Person Research Benchmark CLI (issue #228).
 *
 * Developer tooling over the production research capability: it composes the
 * real Person Profiles product in a throwaway Workspace, asks it to research
 * each Benchmark Person, and reports what came back. It never reads or writes
 * the live Workspace, never sends anything externally, and never creates a
 * Task.
 *
 * A failed or interrupted run is written as a failed run. Previously
 * successful output is never left standing in its place — the same rule the
 * Debrief evaluation CLI already follows.
 */

const HELP = `Person Research Benchmark

  pnpm exec tsx scripts/person-research-benchmark.mts [options]

Options
  --mode <live-discovery|fixed-documents>  Evaluation mode (default: fixed-documents).
  --pipeline <incumbent|expanded>          Which pipeline to run (default: expanded).
  --people <slug,slug>                     Evaluate a subset. Default: the whole collection.
  --limit <n>                              Evaluate only the first n selected people.
  --corpus <dir>                           Corpus directory (default: benchmark/person-research/people).
  --config <path>                          Workspace config for provider credentials
                                           (default: workspace/config.json). Never printed.
  --out <dir>                              Report directory (default: artifacts/person-benchmark).
  --profile-calls <n>                      Model-call bound per operation.
  --profile-ms <n>                         Wall-clock bound per operation.
  --read-concurrency <n>                   Sources read at once.
  --render                                 Allow the bounded anonymous browser route (live mode).
  --compare <baseline.json> <candidate.json>  Compare two saved reports and exit.
  --probe-sources                          Probe every source route's anonymous access and exit.
  --corpus-coverage                        Print the corpus's requirement coverage and exit.
  --help                                   This text.

Live mode contacts real public sources and the configured model provider. Fixed-document
mode contacts the model provider only. Neither mode touches a live Workspace.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

if (flag("help")) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

if (flag("probe-sources")) {
  const results = await probeSourceEligibility();
  for (const result of results)
    process.stdout.write(
      `${result.route.padEnd(24)} ${result.status.padEnd(14)} ${String(result.httpStatus ?? "-").padEnd(5)} ${result.detail}\n`,
    );
  const failed = results.filter(
    (result) => result.status === "in-production" && (result.httpStatus !== 200 || !result.shapeOk),
  );
  process.stdout.write(
    `\n${String(results.length - failed.length)}/${String(results.length)} routes answered as documented.\n`,
  );
  process.exit(failed.length ? 1 : 0);
}

const corpusDir = arg("corpus") ?? "benchmark/person-research/people";

if (flag("corpus-coverage")) {
  const corpus = loadCorpus(corpusDir);
  process.stdout.write(`corpus ${corpus.version}: ${String(corpus.people.length)} people\n`);
  for (const rejection of corpus.rejected)
    process.stdout.write(`REJECTED ${rejection.file}: ${rejection.reason}\n`);
  for (const row of requirementCoverage(corpus.people))
    process.stdout.write(
      `${row.requirement.padEnd(4)} ${String(row.people).padStart(3)} people ${String(row.facts).padStart(4)} facts  ${row.label}\n`,
    );
  process.exit(corpus.rejected.length ? 1 : 0);
}

const comparisonIndex = process.argv.indexOf("--compare");
if (comparisonIndex !== -1) {
  const baselinePath = process.argv[comparisonIndex + 1];
  const candidatePath = process.argv[comparisonIndex + 2];
  if (!baselinePath || !candidatePath)
    throw new Error("--compare needs a baseline report path and a candidate report path.");
  const baseline = BenchmarkReportSchema.parse(JSON.parse(readFileSync(baselinePath, "utf8")));
  const candidate = BenchmarkReportSchema.parse(JSON.parse(readFileSync(candidatePath, "utf8")));
  const comparison = compareReports(baseline, candidate);
  const out = arg("out") ?? "artifacts/person-benchmark";
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  writeFileSync(join(out, "comparison.md"), `${renderComparison(comparison)}\n`);
  process.stdout.write(`${renderComparison(comparison)}\n`);
  process.exit(comparison.verdict === "regressed" ? 1 : 0);
}

const mode = arg("mode") ?? "fixed-documents";
if (mode !== "live-discovery" && mode !== "fixed-documents")
  throw new Error("--mode must be live-discovery or fixed-documents.");
const pipeline = arg("pipeline") ?? "expanded";
if (pipeline !== "incumbent" && pipeline !== "expanded")
  throw new Error("--pipeline must be incumbent or expanded.");

const configPath = arg("config") ?? "workspace/config.json";
const settings = new ConfigStore(resolve(configPath), false);
settings.load();
const research = settings.getForPurpose("personResearch");
const planning = settings.getForPurpose("researchPlanning");
const judging = settings.getForPurpose("evaluationJudge");

const corpus = loadCorpus(corpusDir);
for (const rejection of corpus.rejected)
  process.stderr.write(`REJECTED ${rejection.file}: ${rejection.reason}\n`);

const requested = (arg("people") ?? "")
  .split(",")
  .map((slug) => slug.trim())
  .filter(Boolean);
let selected = requested.length
  ? corpus.people.filter((person) => requested.includes(person.slug))
  : corpus.people;
const limit = Number(arg("limit") ?? "0");
if (Number.isFinite(limit) && limit > 0) selected = selected.slice(0, limit);
const skipped = requested
  .filter((slug) => !selected.some((person) => person.slug === slug))
  .map((slug) => ({ slug, reason: "Not present in the corpus." }));

const configured = configurePipeline(pipeline, readPersonSource);
const modelFor = (config: ReturnType<ConfigStore["getForPurpose"]>) =>
  makeCompleteJson(
    {
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.ollama.baseUrl,
    },
    join(tmpdir(), "person-benchmark-mock.json"),
  );

let inputCharacters = 0;
let outputCharacters = 0;
const measured =
  (config: ReturnType<ConfigStore["getForPurpose"]>) =>
  async (request: Parameters<ReturnType<typeof makeCompleteJson>>[0]) => {
    inputCharacters += request.system.length + request.user.length;
    const answer = await modelFor(config)(request);
    outputCharacters += JSON.stringify(answer).length;
    return answer;
  };

const startedAt = new Date().toISOString();
const id = runId(corpus.version, mode, startedAt);
const outDir = arg("out") ?? "artifacts/person-benchmark";
mkdirSync(outDir, { recursive: true });
const stem = `${mode}-${pipeline}-${id}`;

const results: BenchmarkPersonResult[] = [];
let status: BenchmarkReport["status"] = "completed";
let statusDetail = "Every selected Benchmark Person was evaluated.";

const overrides: { profileCalls: number; profileMilliseconds: number; readConcurrency: number } = {
  profileCalls: Number(arg("profile-calls") ?? configured.settings.profileCalls),
  profileMilliseconds: Number(arg("profile-ms") ?? configured.settings.profileMilliseconds),
  readConcurrency: Number(arg("read-concurrency") ?? configured.settings.readConcurrency),
};

try {
  for (const [index, person] of selected.entries()) {
    const workspaceDir = mkdtempSync(join(tmpdir(), `person-benchmark-${person.slug}-`));
    process.stderr.write(
      `[${String(index + 1)}/${String(selected.length)}] ${person.slug} (${mode}, ${pipeline})\n`,
    );
    try {
      const evaluation = await evaluatePerson(person, mode, {
        workspaceDir,
        search: configured.search,
        complete: () => measured(research),
        ...(pipeline === "expanded" ? { plan: () => measured(planning) } : {}),
        judge: measured(judging),
        ...(configured.seeds ? { seeds: configured.seeds } : {}),
        ...(configured.readSource ? { readSource: configured.readSource } : {}),
        ...(flag("render") && mode === "live-discovery"
          ? { render: playwrightBrowserRenderer() }
          : {}),
        settings: overrides,
      });
      results.push(evaluation.result);
      writeFileSync(
        join(outDir, `${stem}-${person.slug}.operation.json`),
        `${JSON.stringify(evaluation.operation, null, 2)}\n`,
      );
      process.stderr.write(
        `    recovered ${String(evaluation.result.completeness.recovered)}/${String(evaluation.result.completeness.referenceFacts)} · ${String(evaluation.result.richness.sources)} sources · ${evaluation.result.operational.conclusion}\n`,
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
} catch (error) {
  /* An interrupted run is reported as interrupted with whatever it completed.
     It never leaves an earlier successful report standing as this run's. */
  status = "interrupted";
  statusDetail = `The run stopped after ${String(results.length)} of ${String(selected.length)} people: ${error instanceof Error ? error.message : "unknown error"}`;
}
if (status === "completed" && results.some((result) => result.failure !== null)) {
  status = "failed";
  statusDetail = `${String(results.filter((result) => result.failure).length)} of ${String(results.length)} people failed to evaluate; their failures are recorded per person.`;
}

const report: BenchmarkReport = {
  schemaVersion: 1,
  runId: id,
  status,
  statusDetail,
  mode,
  selection: {
    requested: requested.length ? requested : corpus.people.map((person) => person.slug),
    evaluated: results.map((result) => result.slug),
    skipped,
  },
  provenance: {
    corpusVersion: corpus.version,
    referenceVersions: Object.fromEntries(
      selected.map((person) => [person.slug, person.referenceVersion]),
    ),
    pipeline,
    researchProvider: research.provider,
    researchModel: research.model,
    judgeProvider: judging.provider,
    judgeModel: judging.model,
    judgeVersion: JUDGE_VERSION,
    promptVersion: "2026-09-06",
    collectorVersions: { "person-research": "2026-09-06" },
    researchSettings: { ...overrides, ...configured.conditions },
    network: mode === "live-discovery" ? "live" : "fixed-documents",
    usage: {
      inputCharacters,
      outputCharacters,
      tokens: "unavailable",
      cost: "unavailable",
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    host: hostname(),
  },
  people: results,
  groups: summarizeGroups(selected, results),
  remainingMisses: remainingMisses(selected, results),
};

const validated = BenchmarkReportSchema.parse(report);
writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify(validated, null, 2)}\n`);
writeFileSync(join(outDir, `${stem}.md`), `${renderReport(validated, selected)}\n`);
process.stdout.write(`${renderReport(validated, selected)}\n`);
process.stdout.write(`\nWrote ${join(outDir, `${stem}.json`)} and ${join(outDir, `${stem}.md`)}\n`);
process.exit(status === "completed" ? 0 : 1);
