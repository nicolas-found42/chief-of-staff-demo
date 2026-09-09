import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_CONTRACT,
  PRE236_CONTRACT,
  judgePerson,
} from "../apps/server/src/person-benchmark/judge.js";
import type { JudgeContract } from "../apps/server/src/person-benchmark/judge.js";
import { loadCorpus } from "../apps/server/src/person-benchmark/corpus.js";
import { makeCompleteJson } from "../apps/server/src/llm/providers.js";
import type { CompleteJson } from "../apps/server/src/llm/providers.js";
import { PersonDossierSchema } from "../packages/shared/src/index.js";
import type { BenchmarkPerson } from "../packages/shared/src/index.js";

/**
 * The issue-#270 prompt eval: the model half of the paraphrase/cross-language
 * contract, asserted against a real model rather than the stubbed judge the
 * unit tests pin.
 *
 * Each fixture group runs as one live recovery call under the current
 * recovery prompt; the support call is refused locally (recovery verdicts
 * stand without it), so the eval spends one judge call per group. A decidable
 * paraphrase or translation that comes back ambiguous fails the run, as does
 * a broadening that recovers or a control that misses its verdict. Outside
 * `check`, alongside the debrief eval: it needs OPENROUTER_API_KEY and spends
 * real budget.
 */

const DEFAULT_MODEL = "inception/mercury-2.5-preview";
const DEFAULT_FIXTURES = "tests/fixtures/judge-contract/cohorts.json";
const DEFAULT_OUT = "/tmp/judge-contract-gate";
interface FixtureReference {
  factId: string;
  statement: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

interface FixtureGroup {
  id: string;
  person: string;
  corpusSlug: string;
  why: string;
  references: FixtureReference[];
  claims: { id: string; statement: string }[];
  expect: Record<string, string[]>;
  retainedVerdicts: Record<string, string> | null;
}

interface Fixtures {
  schemaVersion: number;
  description: string;
  corpusVersion: string;
  retainedRunId: string;
  retainedReport: string;
  groups: FixtureGroup[];
}

/* The scripts workspace has no zod dependency, so the cohort file is
   validated by hand: shape asserts plus the coverage check that matters,
   every reference judged and every expectation attached to a reference. */
function loadFixtures(path: string): Fixtures {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Cohort file is not an object.");
  const fixtures = parsed as Fixtures;
  if (fixtures.schemaVersion !== 1) throw new Error("Cohort file schemaVersion must be 1.");
  if (fixtures.groups.length === 0) throw new Error("Cohort file holds no groups.");
  for (const group of fixtures.groups) {
    const ids = new Set(group.references.map((reference) => reference.factId));
    for (const factId of Object.keys(group.expect))
      if (!ids.has(factId)) throw new Error(`Group ${group.id} expects no such fact ${factId}.`);
    for (const reference of group.references)
      if (group.expect[reference.factId] === undefined)
        throw new Error(`Group ${group.id} leaves ${reference.factId} without an expectation.`);
  }
  return fixtures;
}

const HELP = `Judge Contract Prompt Eval (issue #270)

  pnpm exec tsx scripts/run-judge-contract-eval.mts [options]

  --corpus <dir>       Benchmark people directory
                      (default: benchmark/person-research/people).
  --model <id>        OpenRouter model for the live recovery calls
                      (default: ${DEFAULT_MODEL}).
  --contract <current|pre236>  Recovery contract under test
                      (default: current; pre236 replays judge .8).
  --out <dir>         Result directory (default: ${DEFAULT_OUT}).
  --help              This text.

Requires OPENROUTER_API_KEY. Spends real budget: one recovery call per group.
Exits nonzero when any case misses its expected verdicts.`;

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === flag) return process.argv[index + 1];
    if (token?.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

if (arg("help") !== undefined || process.argv.includes("--help")) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  process.stderr.write("OPENROUTER_API_KEY missing: this eval spends real provider budget.\n");
  process.exit(1);
}
const model = arg("model") ?? DEFAULT_MODEL;
const fixturesPath = arg("fixtures") ?? DEFAULT_FIXTURES;
const outDir = arg("out") ?? DEFAULT_OUT;
const contractName = arg("contract") ?? "current";
if (contractName !== "current" && contractName !== "pre236")
  throw new Error("--contract must be current or pre236.");
const contract: JudgeContract = contractName === "pre236" ? PRE236_CONTRACT : CURRENT_CONTRACT;
const contractSha256 = createHash("sha256").update(contract.recoverySystem).digest("hex");

const fixtures = loadFixtures(fixturesPath);
const complete: CompleteJson = makeCompleteJson({ provider: "openrouter", model, apiKey }, "");
/* The eval asserts recovery verdicts only. Refusing the support call keeps
   support spend at zero; the recovery judgements stand without it. */
const recoveryOnly: CompleteJson = async (request) => {
  const body: unknown = JSON.parse(request.user);
  const isRecovery = typeof body === "object" && body !== null && "references" in body;
  if (isRecovery) return complete(request);
  throw new Error("support not assessed by the contract eval");
};

interface CaseResult {
  group: string;
  factId: string;
  expected: string[];
  verdict: string;
  claimId: string | null;
  evidenceQuote: string | null;
  pass: boolean;
}

const corpus = loadCorpus(arg("corpus") ?? "benchmark/person-research/people");
if (corpus.rejected.length) throw new Error("Benchmark corpus contains rejected entries.");

const results: CaseResult[] = [];
for (const group of fixtures.groups) {
  const carrier = corpus.people.find((person) => person.slug === group.corpusSlug);
  if (!carrier) throw new Error(`Fixture group ${group.id} names unknown corpus slug.`);
  for (const reference of group.references) {
    const corpusStatement = carrier.facts.find((fact) => fact.id === reference.factId)?.statement;
    if (corpusStatement !== undefined && corpusStatement !== reference.statement)
      process.stderr.write(
        `WARNING: fixture ${group.id}/${reference.factId} drifts from the corpus; judging the fixture text.\n`,
      );
  }
  const seedFact = carrier.facts[0];
  if (!seedFact) throw new Error(`Carrier ${group.corpusSlug} holds no facts.`);
  const person: BenchmarkPerson = {
    ...carrier,
    displayName: group.person,
    facts: group.references.map((reference) => ({
      ...seedFact,
      id: reference.factId,
      statement: reference.statement,
      effectiveFrom: reference.effectiveFrom,
      effectiveTo: reference.effectiveTo,
    })),
  };
  const dossier = PersonDossierSchema.parse({
    schemaVersion: 1,
    profileId: `judge-contract-eval-${group.id}`,
    revision: 1,
    updatedAt: new Date().toISOString(),
    sourceIds: [],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
    claims: group.claims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      section: "career",
      status: "supported",
      nature: "statement",
      matchConfidence: "high",
      effectiveFrom: null,
      effectiveTo: null,
      supports: [],
      supersedes: [],
      changeReason: null,
      citations: [],
    })),
  });
  process.stderr.write(`judging ${group.id} (${String(group.references.length)} facts)\n`);
  const judged = await judgePerson(recoveryOnly, person, dossier, [], contract);
  for (const judgement of judged.judgements) {
    const expected = group.expect[judgement.factId];
    if (!expected)
      throw new Error(`Fixture ${group.id} expects no verdict for ${judgement.factId}.`);
    results.push({
      group: group.id,
      factId: judgement.factId,
      expected,
      verdict: judgement.verdict,
      claimId: judgement.claimId,
      evidenceQuote: judgement.evidenceQuote,
      pass: expected.includes(judgement.verdict),
    });
  }
}

const failures = results.filter((result) => !result.pass);
for (const result of results)
  process.stdout.write(
    `${result.pass ? "pass" : "FAIL"} ${result.group}/${result.factId}: ${result.verdict} (expected ${result.expected.join("|")})\n`,
  );
mkdirSync(outDir, { recursive: true });
const payload = {
  schemaVersion: 1 as const,
  generatedAt: new Date().toISOString(),
  model,
  contract: contractName,
  recoveryPromptSha256: contractSha256,
  fixtures: fixturesPath,
  corpusVersion: fixtures.corpusVersion,
  retainedRunId: fixtures.retainedRunId,
  passed: failures.length === 0,
  failures: failures.length,
  results,
};
writeFileSync(join(outDir, "judge-contract-eval.json"), `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(
  `judge-contract eval: ${String(results.length - failures.length)}/${String(results.length)} passed (${model})\n`,
);
if (failures.length > 0) process.exit(1);
