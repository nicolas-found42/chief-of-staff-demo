import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BenchmarkReportSchema,
  BenchmarkPersonArtifactSchema,
  type BenchmarkPersonResult,
  type BenchmarkReport,
  type BenchmarkCollectionResult,
  type PersonResearchOperationOutcome,
} from "../packages/shared/src/index.js";
import { ConfigStore } from "../apps/server/src/config.js";
import {
  DEFAULT_REASONING_EFFORT,
  makeCompleteJson,
  MAX_RESTING_ROUTES,
  ROUTE_COOLDOWN_MS,
  ROUTE_REST_POLICY,
} from "../apps/server/src/llm/providers.js";
import { probeSourceEligibility } from "../apps/server/src/source-adapters/eligibility.js";
import { readPersonSource } from "../apps/server/src/person-profile/research-readers.js";
import { playwrightBrowserRenderer } from "../apps/server/src/source-adapters/browser.js";
import { loadCorpus, requirementCoverage } from "../apps/server/src/person-benchmark/corpus.js";
import {
  evaluatePerson,
  evaluateLivePopulation,
  runId,
  type EvaluationPorts,
  type PersonEvaluation,
} from "../apps/server/src/person-benchmark/evaluate.js";
import { evaluateCollection } from "../apps/server/src/person-benchmark/collection.js";
import { composePersonProfiles } from "../apps/server/src/person-profile/composition.js";
import { EXTRACTION_PREFERRED_MIN_THROUGHPUT } from "../apps/server/src/person-profile/research.js";
import { JUDGE_VERSION } from "../apps/server/src/person-benchmark/judge.js";
import { retainEvidence } from "../apps/server/src/person-benchmark/evidence.js";
import { reassessReport } from "../apps/server/src/person-benchmark/reassess.js";
import { configurePipeline } from "../apps/server/src/person-benchmark/pipelines.js";
import {
  compareReports,
  coverageGapTotals,
  leadDispositionTotals,
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
  --concurrency <1-4>                      People researched concurrently (default: 1).
  --retain-evidence                       Preserve a public evidence snapshot under --out for reassessment.
  --render                                 Allow the bounded anonymous browser route (live mode).
  --compare <baseline.json> <candidate.json>  Compare two saved reports and exit.
  --reassess <report.json>                  Reassess retained evidence without researching again.
  --evidence-workspace <dir>                Isolated public snapshot with snapshot-manifest.json.
  --reassess-only-failed                   Freeze completed assessments; retry failed assessments only.
  --lineage-root <dir>                     Bounded report directory for first reassessment ancestry.
  --probe-sources                          Probe every source route's anonymous access and exit.
  --corpus-coverage                        Print the corpus's requirement coverage and exit.
  --help                                   This text.

Live mode contacts real public sources and the configured model provider. Fixed-document
mode contacts the model provider only. Neither mode touches a live Workspace.
Comparison requires complete explicit assessment of the same nonempty selected population,
not successful research. Failed research statuses remain failed and operational outcomes are
reported separately. Incomplete, legacy-unassessed, or regressed comparisons exit nonzero.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
  return value;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/* Machine-read benchmark artifacts persist minified: one JSON document per line keeps a
   30-person run's committed diff small enough for review tooling to fetch (Sourcery cannot
   fetch diffs over 20k lines), and the .md report stays the human-readable record. (#237) */
function persistPersonArtifact(value: unknown, stem: string, out: string): void {
  const artifact = BenchmarkPersonArtifactSchema.parse(value);
  mkdirSync(out, { recursive: true });
  const person = artifact.result;
  const path = join(out, `${stem}-${person.slug}.person.json`);
  writeFileSync(path, `${JSON.stringify(artifact)}\n`, { flag: "wx" });
  const phases = person.assessment?.phases;
  const phaseDetail = phases
    ? `reference ${phases.reference.status}, support/usefulness ${phases.support.status}`
    : "phase details unavailable";
  process.stderr.write(
    `    ${person.slug}: research ${person.operational.conclusion} · judge ${person.assessment?.judge ?? "unassessed"} (${phaseDetail}) · credited recovery ${String(person.completeness.recovered)}/${String(person.completeness.referenceFacts)} · ${path}\n`,
  );
}

function positiveInteger(name: string, fallback: number): number {
  const value = arg(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

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
  process.stdout.write(
    `Collection scenarios: ${String(corpus.scenarios.length)} (r18; separate from individual facts).\n`,
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
  writeFileSync(join(out, "comparison.json"), `${JSON.stringify(comparison)}\n`);
  writeFileSync(join(out, "comparison.md"), `${renderComparison(comparison)}\n`);
  process.stdout.write(`${renderComparison(comparison)}\n`);
  process.exit(!comparison.comparable || comparison.verdict === "regressed" ? 1 : 0);
}

const mode = arg("mode") ?? "fixed-documents";
if (mode !== "live-discovery" && mode !== "fixed-documents")
  throw new Error("--mode must be live-discovery or fixed-documents.");
const pipeline = arg("pipeline") ?? "expanded";
if (pipeline !== "incumbent" && pipeline !== "expanded")
  throw new Error("--pipeline must be incumbent or expanded.");

const concurrency = positiveInteger("concurrency", 1);
if (concurrency > 4) throw new Error("--concurrency must be an integer from 1 to 4.");

const configPath = arg("config") ?? "workspace/config.json";
const settings = new ConfigStore(resolve(configPath), false);
settings.load();
const research = settings.getForPurpose("personResearch");
const planning = settings.getForPurpose("researchPlanning");
const judging = settings.getForPurpose("evaluationJudge");

const corpus = loadCorpus(corpusDir);
for (const rejection of corpus.rejected)
  process.stderr.write(`REJECTED ${rejection.file}: ${rejection.reason}\n`);
if (corpus.rejected.length) throw new Error("Benchmark corpus contains rejected entries.");

const reassessmentPath = arg("reassess");
if (reassessmentPath) {
  const evidenceWorkspace = arg("evidence-workspace");
  if (!evidenceWorkspace) throw new Error("--reassess requires --evidence-workspace.");
  if (
    [
      "people",
      "limit",
      "mode",
      "pipeline",
      "profile-calls",
      "profile-ms",
      "read-concurrency",
      "concurrency",
      "retain-evidence",
      "render",
    ].some(flag)
  )
    throw new Error(
      "Reassessment preserves the original research selection and configuration; research overrides are not allowed.",
    );
  const report = await reassessReport({
    reportPath: reassessmentPath,
    evidenceWorkspace,
    onlyFailed: flag("reassess-only-failed"),
    ...(arg("lineage-root") ? { lineageRoot: arg("lineage-root")! } : {}),
    outputDirectory: resolve(arg("out") ?? "artifacts/person-benchmark"),
    corpus,
    judgeProvider: judging.provider,
    judgeModel: judging.model,
    onPerson: (artifact, operation) => {
      const stem = `${artifact.result.mode}-${artifact.pipeline}-reassessed-${artifact.runId}`;
      const out = arg("out") ?? "artifacts/person-benchmark";
      persistPersonArtifact(artifact, stem, out);
      writeFileSync(
        join(out, `${stem}-${artifact.result.slug}.operation.json`),
        `${JSON.stringify(operation)}\n`,
        { flag: "wx" },
      );
    },
    judge: makeCompleteJson(
      {
        provider: judging.provider,
        model: judging.model,
        apiKey: judging.apiKey,
        baseUrl: judging.ollama.baseUrl,
      },
      join(tmpdir(), "person-benchmark-mock.json"),
    ),
  });
  const out = arg("out") ?? "artifacts/person-benchmark";
  mkdirSync(out, { recursive: true });
  const stem = `${report.mode}-${report.provenance.pipeline}-reassessed-${report.runId}`;
  writeFileSync(join(out, `${stem}.json`), `${JSON.stringify(report)}\n`, { flag: "wx" });
  writeFileSync(join(out, `${stem}.md`), `${renderReport(report, corpus.people)}\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${renderReport(report, corpus.people)}\n\nWrote ${join(out, `${stem}.json`)}\n`,
  );
  process.exit(report.status === "completed" ? 0 : 1);
}
if (flag("reassess-only-failed") || flag("lineage-root"))
  throw new Error("--reassess-only-failed and --lineage-root require --reassess.");
if (flag("evidence-workspace")) throw new Error("--evidence-workspace requires --reassess.");

const requested = (arg("people") ?? "")
  .split(",")
  .map((slug) => slug.trim())
  .filter(Boolean);
if (flag("people") && requested.length === 0)
  throw new Error("--people must select at least one person.");
const limit = positiveInteger("limit", corpus.people.length);
let selected = requested.length
  ? corpus.people.filter((person) => requested.includes(person.slug))
  : corpus.people;
for (const slug of requested) {
  if (!corpus.people.some((person) => person.slug === slug))
    throw new Error(`Unknown Benchmark Person: ${slug}`);
}
selected = selected.slice(0, limit);
if (selected.length === 0) throw new Error("Benchmark selection is empty.");
const requestedPopulation = requested.length
  ? requested
  : corpus.people.map((person) => person.slug);
const skipped = requestedPopulation
  .filter((slug) => !selected.some((person) => person.slug === slug))
  .map((slug) => ({ slug, reason: "Excluded by --limit." }));

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
const researchOutcomes: PersonResearchOperationOutcome[] = [];
const population: { slug: string; profileId: string }[] = [];
let collection: BenchmarkCollectionResult[] = [];
let status: BenchmarkReport["status"] = "completed";
let statusDetail = "Every selected Benchmark Person was evaluated.";
let executionStatus: "completed" | "interrupted" = "interrupted";
let evidenceBundleHash: string | undefined;

const overrides: { profileCalls: number; profileMilliseconds: number; readConcurrency: number } = {
  profileCalls: positiveInteger("profile-calls", configured.settings.profileCalls),
  profileMilliseconds: positiveInteger("profile-ms", configured.settings.profileMilliseconds),
  readConcurrency: positiveInteger("read-concurrency", configured.settings.readConcurrency),
};

const workspaceDir = mkdtempSync(join(tmpdir(), "person-benchmark-collection-"));
try {
  const ports: EvaluationPorts = {
    workspaceDir,
    search: configured.search,
    complete: () => measured(research),
    ...(pipeline === "expanded" ? { plan: () => measured(planning) } : {}),
    judge: measured(judging),
    ...(configured.seeds ? { seeds: configured.seeds } : {}),
    ...(configured.readSource ? { readSource: configured.readSource } : {}),
    ...(flag("render") && mode === "live-discovery" ? { render: playwrightBrowserRenderer() } : {}),
    settings: overrides,
  };
  const onStarted = (person: (typeof selected)[number], index: number) =>
    process.stderr.write(
      `[${String(index + 1)}/${String(selected.length)}] ${person.slug} (${mode}, ${pipeline})\n`,
    );
  const onEvaluated = (evaluation: PersonEvaluation) => {
    const person = evaluation.result;
    results.push(evaluation.result);
    results.sort(
      (a, b) =>
        selected.findIndex((person) => person.slug === a.slug) -
        selected.findIndex((person) => person.slug === b.slug),
    );
    population.push({ slug: person.slug, profileId: evaluation.profileId });
    if (evaluation.operation) researchOutcomes.push(evaluation.operation);
    writeFileSync(
      join(outDir, `${stem}-${person.slug}.operation.json`),
      `${JSON.stringify(evaluation.operation)}\n`,
    );
    persistPersonArtifact(
      {
        schemaVersion: 1,
        runId: id,
        corpusVersion: corpus.version,
        pipeline,
        judgeProvider: judging.provider,
        judgeModel: judging.model,
        judgeVersion: JUDGE_VERSION,
        assessedAt: new Date().toISOString(),
        result: person,
      },
      stem,
      outDir,
    );
  };
  let people;
  if (mode === "live-discovery") {
    ({ people } = await evaluateLivePopulation(selected, {
      ...ports,
      concurrency,
      onStarted,
      onEvaluated,
    }));
  } else {
    /* Fixed-document mode used to research people serially. Each person runs
       through its own composition over the shared collection workspace, and
       every store under it is keyed per profile or per source, so parallel
       people touch disjoint files; collection scoring reads the workspace
       only after every worker settles. The one shared file (the research
       queue snapshot) is loaded per composition and only its throwaway
       persistence can interleave — nothing mid-run reads it back. Route
       rests are process-wide by design, so parallel people share what each
       learns about bad routes, the way the long-running app does (#233). */
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      while (next < selected.length) {
        const index = next++;
        const person = selected[index]!;
        onStarted(person, index);
        onEvaluated(await evaluatePerson(person, mode, ports));
      }
    });
    /* An output/assessment failure must not strand a sibling's accepted
       operation mid-write: every worker settles before the first failure
       surfaces, mirroring the live population path. */
    const settled = await Promise.allSettled(workers);
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    people = composePersonProfiles({
      workspaceDir,
      search: configured.search,
      complete: () => measured(research),
      confirmedTranscripts: () => [],
      transcriptStillConfirmed: () => false,
      researchEnabled: () => false,
    });
  }
  collection = await evaluateCollection(people, population, corpus.scenarios, {
    references: corpus.people,
    judge: measured(judging),
  });
  executionStatus = "completed";
} catch (error) {
  /* An interrupted run is reported as interrupted with whatever it completed.
     It never leaves an earlier successful report standing as this run's. */
  status = "interrupted";
  statusDetail = `The run stopped after ${String(results.length)} of ${String(selected.length)} people: ${error instanceof Error ? error.message : "unknown error"}`;
} finally {
  try {
    if (flag("retain-evidence")) {
      const evidenceDirectory = join(outDir, `${stem}.evidence`);
      evidenceBundleHash = retainEvidence(
        workspaceDir,
        evidenceDirectory,
        results.flatMap((result) =>
          result.assessment?.operationId ? [result.assessment.operationId] : [],
        ),
      );
      process.stderr.write(`Retained evidence: ${evidenceDirectory}\n`);
    }
  } catch (error) {
    status = "interrupted";
    statusDetail = `Evidence snapshot failed: ${error instanceof Error ? error.message : "unknown error"}`;
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}
if (
  status === "completed" &&
  (results.some((result) => result.failure !== null) ||
    collection.some((result) => result.assessmentStatus !== "completed"))
) {
  status = "failed";
  statusDetail = `${String(results.filter((result) => result.failure).length)} of ${String(results.length)} people had research or assessment failures; ${String(collection.filter((result) => result.assessmentStatus !== "completed").length)} collection scenarios had assessment failures. These failures remain recorded even when evaluation execution finished.`;
}

const report: BenchmarkReport = {
  schemaVersion: 1,
  runId: id,
  ...(evidenceBundleHash ? { evidenceBundleHash } : {}),
  status,
  statusDetail,
  execution: {
    status: executionStatus,
    selected: selected.map((person) => person.slug),
    evaluated: results.length,
    assessed: results.filter(
      (result) =>
        result.assessment?.operationId &&
        result.assessment.integrity === "completed" &&
        result.assessment.judge === "completed",
    ).length,
    scenarioIds: corpus.scenarios.map((scenario) => scenario.id),
  },
  mode,
  selection: {
    requested: requestedPopulation,
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
    ...(mode === "live-discovery" && pipeline === "expanded"
      ? { planningProvider: planning.provider, planningModel: planning.model }
      : {}),
    judgeProvider: judging.provider,
    judgeModel: judging.model,
    judgeVersion: JUDGE_VERSION,
    promptVersion: "2026-09-06.4",
    collectorVersions: { "person-research": "2026-09-06" },
    researchSettings: {
      ...configured.conditions,
      ...overrides,
      operationConcurrency: concurrency,
      modelRetryPolicy:
        "One same-binding idle/transport retry inside the original deadline; extraction and benchmark judges only",
      usageAccounting:
        "Logical request text and returned answer characters; excludes retried wire payloads",
      judgeBindingPreference: "forced_tool_call when model-declared; default otherwise",
      extractionBindingPreference: "forced_tool_call when model-declared; default otherwise",
      extractionRouteSort: "throughput",
      extractionRouteThroughputFloorTps: EXTRACTION_PREFERRED_MIN_THROUGHPUT,
      /* Requested thinking depth; the seam omits it for models that advertise
         no effort list, so provider defaults apply there. */
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      reasoningExclude: true,
      routeRestPolicy: ROUTE_REST_POLICY,
      routeRestCooldownSeconds: ROUTE_COOLDOWN_MS / 1000,
      routeRestMaxRoutes: MAX_RESTING_ROUTES,
      planner: mode === "live-discovery" && pipeline === "expanded",
    },
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
  collection,
  groups: summarizeGroups(selected, results),
  remainingMisses: remainingMisses(selected, results),
  leadDispositions: leadDispositionTotals(researchOutcomes),
  coverageGaps: coverageGapTotals(researchOutcomes),
};

const validated = BenchmarkReportSchema.parse(report);
writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify(validated)}\n`);
writeFileSync(join(outDir, `${stem}.md`), `${renderReport(validated, selected)}\n`);
process.stdout.write(`${renderReport(validated, selected)}\n`);
process.stdout.write(`\nWrote ${join(outDir, `${stem}.json`)} and ${join(outDir, `${stem}.md`)}\n`);
process.exit(status === "completed" ? 0 : 1);
