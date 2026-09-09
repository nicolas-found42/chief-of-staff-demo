import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigStore } from "../apps/server/src/config.js";
import { loadCorpus } from "../apps/server/src/person-benchmark/corpus.js";
import { assessPerson } from "../apps/server/src/person-benchmark/evaluate.js";
import {
  CURRENT_CONTRACT,
  JUDGE_VERSION,
  PRE236_CONTRACT,
} from "../apps/server/src/person-benchmark/judge.js";
import { cachedCompleteJson } from "../apps/server/src/person-benchmark/judge-cache.js";
import { loadReassessmentEvidence } from "../apps/server/src/person-benchmark/reassess.js";
import {
  classifyArm,
  countArm,
  diffArms,
  indexCorpusStatements,
  renderContractDifferentialMarkdown,
} from "../apps/server/src/person-benchmark/contract-differential.js";
import { summarizeAssignments } from "../apps/server/src/person-benchmark/ambiguity.js";
import {
  makeCompleteJson,
  observeModelUsage,
  type CompletionRequest,
} from "../apps/server/src/llm/providers.js";
import type { BenchmarkPersonResult } from "../packages/shared/src/index.js";

/**
 * The issue-#270 contract differential.
 *
 * Re-judges one retained, evidence-backed population under the pre-#236
 * contract (judge `.8` behavior) and compares it against the retained
 * verdicts judged under the current contract, holding judge model, corpus
 * and evidence fixed. Support-phase requests replay the run's own judge
 * cache, so support outcomes are identical in both arms and only the
 * recovery contract varies. Reads reports and evidence; writes one
 * measurement record. Spends provider budget on the pre-contract arm only.
 */

/** sha256 of the `.8` recovery prompt (commit `9c6e308`); the run refuses to measure against anything else. */
const PRE236_EXPECTED_PROMPT_SHA256 =
  "510e74323a2cf9e53d29e5905b8f1141b1712bdaa823f7d20d8e11eed8e84f16";

/** The pinned judge model for this contract measurement (issue #270). */
const CONTRACT_JUDGE_MODEL = "inception/mercury-2.5-preview";

const HELP = `Judge Contract Differential (issue #270)

  pnpm exec tsx scripts/run-judge-contract-differential.mts --report <R.json> --evidence-workspace <dir> --config <path> [options]

Required
  --report <path>               Retained benchmark report (the contract arm's verdicts).
  --evidence-workspace <dir>    Isolated public snapshot with snapshot-manifest.json.
  --config <path>               Workspace config with provider credentials and the
                                pinned evaluationJudge model. Never printed.

Options
  --corpus <dir>                Corpus directory (default: benchmark/person-research/people).
  --out <dir>                   Output directory (default: artifacts/person-benchmark).
  --population <name>           Population label for the record (default: contract-differential).
  --repeat <n>                  Judge-cache repeat index of the run (default: 1).
  --judge-cache-namespace <ns>  Override the derived judge-cache namespace.
  --max-cost <dollars>          Abort once the provider-reported cost passes this.
  --help                        This text.

The pre-contract arm replays the run's judge cache for support-phase calls and
spends live budget on recovery calls only. The record lands as
<out>/judge-contract-differential-<population>-<report-stem>.{json,md}.`;

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === flag) return process.argv[index + 1];
    if (token?.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

function positiveNumber(name: string, fallback?: number): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`--${name} must be a positive number.`);
  return value;
}

if (arg("help") !== undefined || process.argv.includes("--help")) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const reportPath = arg("report");
const evidenceWorkspace = arg("evidence-workspace");
const configPath = arg("config");
if (!reportPath) throw new Error("--report is required.");
if (!evidenceWorkspace) throw new Error("--evidence-workspace is required.");
if (!configPath) throw new Error("--config is required (workspace config with credentials).");

const corpusDir = arg("corpus") ?? "benchmark/person-research/people";
const outDir = arg("out") ?? "artifacts/person-benchmark/differentials";
const population = arg("population") ?? "contract-differential";
const repeat = Math.trunc(positiveNumber("repeat", 1) ?? 1);
const maxCost = positiveNumber("max-cost");

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const preContractPromptHash = sha256(PRE236_CONTRACT.recoverySystem);
if (preContractPromptHash !== PRE236_EXPECTED_PROMPT_SHA256)
  throw new Error(
    "The pre-#236 recovery prompt no longer matches its recorded hash: the before arm would not be judge `.8` behavior. Refusing to measure.",
  );
const contractPromptHash = sha256(CURRENT_CONTRACT.recoverySystem);

const corpus = loadCorpus(corpusDir);
for (const rejection of corpus.rejected)
  process.stderr.write(`REJECTED ${rejection.file}: ${rejection.reason}\n`);
if (corpus.rejected.length) throw new Error("Benchmark corpus contains rejected entries.");
const statements = indexCorpusStatements(corpus);

const settings = new ConfigStore(resolve(configPath), false);
settings.load();
const judging = settings.getForPurpose("evaluationJudge");
if (judging.model !== CONTRACT_JUDGE_MODEL)
  throw new Error(
    `This measurement is pinned to ${CONTRACT_JUDGE_MODEL}; the config selects ${judging.model}. A different judge model is a separately recorded conditions decision.`,
  );

const usage = { costUsd: 0, sawCost: false };
observeModelUsage((observation) => {
  if (observation.costUsd !== null) {
    usage.costUsd += observation.costUsd;
    usage.sawCost = true;
  }
});
const live = makeCompleteJson(
  {
    provider: judging.provider,
    model: judging.model,
    apiKey: judging.apiKey,
    baseUrl: judging.ollama.baseUrl,
  },
  join(tmpdir(), "judge-contract-differential-mock.json"),
);
const measured = async (request: CompletionRequest) => {
  if (maxCost !== undefined && usage.sawCost && usage.costUsd > maxCost)
    throw new Error(
      `Model cost ceiling exceeded: $${usage.costUsd.toFixed(2)} > $${maxCost.toFixed(2)}. No record was written; raise --max-cost and rerun.`,
    );
  return live(request);
};

const workspaceDir = mkdtempSync(join(tmpdir(), "judge-contract-differential-"));
try {
  const loaded = await loadReassessmentEvidence({
    reportPath,
    evidenceWorkspace,
    corpus,
    judgeProvider: judging.provider,
    judgeModel: judging.model,
    workspaceDir,
  });
  const { original, evidence } = loaded;
  if (original.provenance.judgeProvider !== judging.provider)
    throw new Error("The retained report's judge provider differs from the configured one.");
  if (original.provenance.judgeModel !== judging.model)
    throw new Error(
      "The retained report's judge model differs from the configured one: both arms must share it.",
    );
  let afterContractNote = `The retained report was judged under the current ${JUDGE_VERSION}.`;
  if (original.provenance.judgeVersion !== JUDGE_VERSION) {
    if (original.provenance.judgeVersion !== "2026-09-06.9")
      throw new Error(
        `The retained report was judged under ${original.provenance.judgeVersion}, not the current ${JUDGE_VERSION}: the after arm would not be the current contract.`,
      );
    afterContractNote =
      "The retained report was judged under 2026-09-06.9. The .9 to .10 delta is rationale-prose clipping (#306) plus a rejected-phase retry (#307, the version bump); prompts, guards, and checks are unchanged, and both harden failures toward decided, so the .9 after arm is conservative for the decided counts.";
    process.stderr.write(`${afterContractNote}\n`);
  }

  const claimCounts = evidence.map(
    (entry) => `${entry.person.slug}=${String(entry.dossier?.claims.length ?? 0)}`,
  );
  const totalClaims = evidence.reduce((sum, entry) => sum + (entry.dossier?.claims.length ?? 0), 0);
  if (totalClaims === 0)
    throw new Error(
      "The retained population carries no dossier claims: the differential cannot measure the contract.",
    );

  const namespace =
    arg("judge-cache-namespace") ?? `judge-${original.provenance.judgeVersion}-r${String(repeat)}`;
  const judge = cachedCompleteJson(measured, {
    cacheDir: join(".cache", "person-benchmark", "judge"),
    namespace,
    provider: judging.provider,
    model: judging.model,
  });

  const preContractPeople: BenchmarkPersonResult[] = [];
  for (const entry of evidence) {
    process.stderr.write(`re-judging ${entry.person.slug} under the pre-#236 contract\n`);
    preContractPeople.push(
      await assessPerson(
        entry.person,
        original.mode,
        {
          dossier: entry.dossier,
          sources: entry.sources,
          publicProjection: entry.publicProjection,
          operation: entry.operation,
          judge,
          elapsedMilliseconds: entry.previous.operational.elapsedMilliseconds,
        },
        PRE236_CONTRACT,
      ),
    );
  }

  const before = {
    label: "pre-contract",
    contract: "2026-09-06.8 behavior (pre-#236 prompt and guards)",
    recoveryPromptSha256: preContractPromptHash,
    people: preContractPeople,
  };
  const after = {
    label: "contract",
    contract: original.provenance.judgeVersion,
    recoveryPromptSha256: contractPromptHash,
    people: original.people,
  };
  const beforeCounts = countArm(before);
  const afterCounts = countArm(after);
  const diff = diffArms(before, after);
  const resolveStatement = (slug: string, factId: string): string | null => {
    const statement = statements.get(`${slug}/${factId}`);
    if (statement !== undefined) return statement;
    const fallback = after.people
      .find((person) => person.slug === slug)
      ?.completeness.judgements.find((entry) => entry.factId === factId);
    process.stderr.write(
      `WARNING: no corpus fact for ${slug}/${factId}; citing the retained referenceQuote.\n`,
    );
    return fallback?.referenceQuote ?? null;
  };
  const beforeAssignments = classifyArm(`${population}-pre-contract`, before, resolveStatement);
  const afterAssignments = classifyArm(`${population}-contract`, after, resolveStatement);
  const beforeCauses = summarizeAssignments(beforeAssignments);
  const afterCauses = summarizeAssignments(afterAssignments);

  const reportStem = reportPath
    .split("/")
    .at(-1)
    ?.replace(/\.json$/, "");
  if (!reportStem) throw new Error("Cannot derive a record stem from --report.");
  const recordStem = `judge-contract-differential-${population}-${reportStem}`;
  mkdirSync(outDir, { recursive: true });
  const conditions = [
    { label: "Judge model (both arms)", value: `${judging.provider} ${judging.model}` },
    { label: "Corpus", value: `${corpusDir} version ${corpus.version}` },
    { label: "Retained report", value: `${reportPath} (run ${original.runId})` },
    { label: "Evidence bundle", value: `${evidenceWorkspace} sha256 ${loaded.bundleHash}` },
    { label: "Population claims", value: claimCounts.join(", ") },
    { label: "Judge cache namespace", value: namespace },
    {
      label: "Provider cost (pre-contract arm)",
      value: usage.sawCost ? `$${usage.costUsd.toFixed(4)}` : "unreported by provider",
    },
  ];
  const movedToDecided = diff.transitions.filter(
    (entry) => entry.before === "ambiguous" && entry.after !== "ambiguous",
  ).length;
  const movedToAmbiguous = diff.transitions.filter(
    (entry) => entry.before !== "ambiguous" && entry.after === "ambiguous",
  ).length;
  const notes = [
    `The after arm reuses the retained verdicts judged at research time under ${original.provenance.judgeVersion}; no model calls were spent on it. The before arm re-judged the same evidence live under the pre-#236 prompt and guards. ${afterContractNote}`,
    `Support-phase requests in the before arm replayed the run's judge cache (${namespace}), so support outcomes are byte-identical in both arms and only the recovery contract varies.`,
    `Ambiguous → decided transitions before → after: ${String(movedToDecided)}; decided → ambiguous: ${String(movedToAmbiguous)}. The difference is the measured reduction attributable to the paraphrase/cross-language contract on this population.`,
    `The before arm is one live sample per fact at temperature 0; resampling noise is not separated from the contract effect. The prompt eval (eval:judge-contract) asserts the decidable cases deterministically.`,
  ];
  const markdown = renderContractDifferentialMarkdown({
    title: `Judge-contract differential — ${population} (${reportStem})`,
    conditions,
    before: {
      label: before.label,
      contract: before.contract,
      recoveryPromptSha256: before.recoveryPromptSha256,
      counts: beforeCounts,
      causes: beforeCauses,
    },
    after: {
      label: after.label,
      contract: after.contract,
      recoveryPromptSha256: after.recoveryPromptSha256,
      counts: afterCounts,
      causes: afterCauses,
    },
    diff,
    notes,
  });
  const payload = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    population,
    inputs: {
      report: reportPath,
      reportSha256: loaded.saved.hash,
      evidenceWorkspace,
      evidenceBundleHash: loaded.bundleHash,
      corpus: corpusDir,
      corpusVersion: corpus.version,
      judgeCacheNamespace: namespace,
    },
    judge: { provider: judging.provider, model: judging.model },
    arms: {
      before: { contract: before.contract, recoveryPromptSha256: before.recoveryPromptSha256 },
      after: { contract: after.contract, recoveryPromptSha256: after.recoveryPromptSha256 },
    },
    counts: { before: beforeCounts, after: afterCounts },
    transitions: diff.transitions,
    matrix: diff.matrix,
    causes: { before: beforeCauses, after: afterCauses },
    assignments: { before: beforeAssignments, after: afterAssignments },
    costUsd: usage.sawCost ? usage.costUsd : null,
    notes,
  };
  writeFileSync(join(outDir, `${recordStem}.json`), `${JSON.stringify(payload)}\n`, { flag: "wx" });
  writeFileSync(join(outDir, `${recordStem}.md`), `${markdown}\n`, { flag: "wx" });
  process.stdout.write(
    `before ambiguous=${String(beforeCounts.ambiguous)} after ambiguous=${String(afterCounts.ambiguous)} ` +
      `facts=${String(beforeCounts.facts)} people=${String(beforeCounts.people)}\n`,
  );
  process.stdout.write(`Wrote ${outDir}/${recordStem}.{json,md}\n`);
} finally {
  rmSync(workspaceDir, { recursive: true, force: true });
}
