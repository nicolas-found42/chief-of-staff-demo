import {
  classifyPerson,
  toClassifiablePerson,
  type AmbiguityAssignment,
  type AmbiguitySummary,
} from "./ambiguity.js";
import type { BenchmarkCorpus } from "./corpus.js";
import type { BenchmarkPersonResult } from "@chief-of-staff-demo/shared";

/**
 * Pure measurement arithmetic for the issue-#270 differential (issue #236's
 * paraphrase/cross-language contract, before vs after on one retained
 * population). No models, no disk: the driver script supplies both arms'
 * person results, this module counts, joins, classifies and renders.
 */

/** One judged arm of the differential. */
export interface ContractArm {
  /** "pre-contract" (judge `.8` behavior) or "contract" (current). */
  label: string;
  /** Recorded contract identity, e.g. "2026-09-06.10" or "2026-09-06.8 behavior". */
  contract: string;
  /** sha256 of the recovery system prompt actually sent by this arm. */
  recoveryPromptSha256: string;
  people: BenchmarkPersonResult[];
}

export interface ContractArmCounts {
  people: number;
  facts: number;
  recovered: number;
  partial: number;
  missing: number;
  contradicted: number;
  ambiguous: number;
  ambiguousSupportAssessmentFailed: number;
  supportFailedPeople: string[];
  referenceFailedPeople: string[];
}

export function countArm(arm: ContractArm): ContractArmCounts {
  const counts: ContractArmCounts = {
    people: arm.people.length,
    facts: 0,
    recovered: 0,
    partial: 0,
    missing: 0,
    contradicted: 0,
    ambiguous: 0,
    ambiguousSupportAssessmentFailed: 0,
    supportFailedPeople: [],
    referenceFailedPeople: [],
  };
  for (const person of arm.people) {
    const phases = person.assessment?.phases;
    if (!phases)
      throw new Error(`Contract differential person ${person.slug} has no judge phases.`);
    if (phases.support.status !== "completed") counts.supportFailedPeople.push(person.slug);
    if (phases.reference.status !== "completed") counts.referenceFailedPeople.push(person.slug);
    for (const judgement of person.completeness.judgements) {
      counts.facts += 1;
      /* The verdict union is exactly these five literals, so the chain below
         exhausts it: the final arm counts the ambiguous remainder. */
      if (judgement.verdict === "recovered") counts.recovered += 1;
      else if (judgement.verdict === "partial") counts.partial += 1;
      else if (judgement.verdict === "missing") counts.missing += 1;
      else if (judgement.verdict === "contradicted") counts.contradicted += 1;
      else counts.ambiguous += 1;
    }
    counts.ambiguousSupportAssessmentFailed +=
      person.completeness.ambiguousSupportAssessmentFailed ?? 0;
  }
  return counts;
}

interface ContractTransition {
  slug: string;
  factId: string;
  before: string;
  after: string;
}

export interface ContractDiff {
  transitions: ContractTransition[];
  /** matrix[before][after] = fact count. */
  matrix: Record<string, Record<string, number>>;
}

export function diffArms(before: ContractArm, after: ContractArm): ContractDiff {
  const beforeBySlug = new Map(before.people.map((person) => [person.slug, person]));
  const afterBySlug = new Map(after.people.map((person) => [person.slug, person]));
  if (beforeBySlug.size !== before.people.length || afterBySlug.size !== after.people.length)
    throw new Error("Contract differential arms contain duplicate people.");
  for (const slug of beforeBySlug.keys())
    if (!afterBySlug.has(slug))
      throw new Error(
        `Contract differential population mismatch: ${slug} is missing from the ${after.label} arm.`,
      );
  for (const slug of afterBySlug.keys())
    if (!beforeBySlug.has(slug))
      throw new Error(
        `Contract differential population mismatch: ${slug} is missing from the ${before.label} arm.`,
      );
  const transitions: ContractTransition[] = [];
  const matrix: Record<string, Record<string, number>> = {};
  for (const person of before.people) {
    const other = afterBySlug.get(person.slug);
    if (!other) throw new Error(`Contract differential lost ${person.slug} mid-join.`);
    const afterByFact = new Map(
      other.completeness.judgements.map((judgement) => [judgement.factId, judgement.verdict]),
    );
    for (const judgement of person.completeness.judgements) {
      const afterVerdict = afterByFact.get(judgement.factId);
      if (afterVerdict === undefined)
        throw new Error(
          `Contract differential population mismatch: fact ${person.slug}/${judgement.factId} is missing from the ${after.label} arm.`,
        );
      transitions.push({
        slug: person.slug,
        factId: judgement.factId,
        before: judgement.verdict,
        after: afterVerdict,
      });
      const row = (matrix[judgement.verdict] ??= {});
      row[afterVerdict] = (row[afterVerdict] ?? 0) + 1;
    }
  }
  return { transitions, matrix };
}

/** Index corpus reference statements by `slug/factId` for classification citations. */
export function indexCorpusStatements(corpus: BenchmarkCorpus): Map<string, string> {
  const statements = new Map<string, string>();
  for (const person of corpus.people)
    for (const fact of person.facts) statements.set(`${person.slug}/${fact.id}`, fact.statement);
  return statements;
}

/** Classify one arm's ambiguous residuals through the shared #234 classifier. */
export function classifyArm(
  population: string,
  arm: ContractArm,
  resolveStatement: (slug: string, factId: string) => string | null,
): AmbiguityAssignment[] {
  const assignments: AmbiguityAssignment[] = [];
  for (const person of arm.people)
    assignments.push(...classifyPerson(population, toClassifiablePerson(person), resolveStatement));
  return assignments;
}

export interface ContractSideRecord {
  label: string;
  contract: string;
  recoveryPromptSha256: string;
  counts: ContractArmCounts;
  causes: AmbiguitySummary;
}

/** Render the human measurement record: conditions, counts, transitions, residuals. */
export function renderContractDifferentialMarkdown(input: {
  title: string;
  conditions: { label: string; value: string }[];
  before: ContractSideRecord;
  after: ContractSideRecord;
  diff: ContractDiff;
  notes: string[];
}): string {
  const lines: string[] = [`# ${input.title}`, ""];
  lines.push("## Conditions (held fixed across both arms except the contract)", "");
  for (const condition of input.conditions)
    lines.push(`- **${condition.label}**: ${condition.value}`);
  lines.push(
    "",
    `- **before arm (${input.before.label})**: contract ${input.before.contract}, recovery prompt sha256 \`${input.before.recoveryPromptSha256}\``,
    `- **after arm (${input.after.label})**: contract ${input.after.contract}, recovery prompt sha256 \`${input.after.recoveryPromptSha256}\``,
    "",
    "## Before and after ambiguous counts",
    "",
    "| Side | People | Facts | Recovered | Partial | Missing | Contradicted | Ambiguous | Ambiguous (support-failed) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const side of [input.before, input.after]) {
    const counts = side.counts;
    lines.push(
      `| ${side.label} | ${String(counts.people)} | ${String(counts.facts)} | ${String(counts.recovered)} | ${String(counts.partial)} | ${String(counts.missing)} | ${String(counts.contradicted)} | ${String(counts.ambiguous)} | ${String(counts.ambiguousSupportAssessmentFailed)} |`,
    );
  }
  const reduction = input.before.counts.ambiguous - input.after.counts.ambiguous;
  lines.push(
    "",
    `Ambiguous reduction before → after: **${String(reduction)}** ` +
      `(${String(input.before.counts.ambiguous)} → ${String(input.after.counts.ambiguous)}).`,
    "",
    "## Per-fact verdict transitions (before → after)",
    "",
    "| Before \\ After | recovered | partial | missing | contradicted | ambiguous |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const verdict of ["recovered", "partial", "missing", "contradicted", "ambiguous"]) {
    const row = input.diff.matrix[verdict] ?? {};
    lines.push(
      `| ${verdict} | ` +
        ["recovered", "partial", "missing", "contradicted", "ambiguous"]
          .map((after) => String(row[after] ?? 0))
          .join(" | ") +
        " |",
    );
  }
  const moved = input.diff.transitions.filter((entry) => entry.before !== entry.after);
  lines.push("", `Facts with a changed verdict: **${String(moved.length)}**.`, "");
  for (const entry of moved)
    lines.push(`- ${entry.slug}/${entry.factId}: ${entry.before} → ${entry.after}`);
  lines.push("", "## Residual ambiguity by cause", "");
  for (const side of [
    { name: input.before.label, summary: input.before.causes },
    { name: input.after.label, summary: input.after.causes },
  ]) {
    lines.push(`### ${side.name} (${String(side.summary.total)} ambiguous)`, "");
    for (const [cause, count] of Object.entries(side.summary.perCause))
      lines.push(`- ${cause}: ${String(count)}`);
    lines.push("");
  }
  const supportFailed = [
    ...new Set([
      ...input.before.counts.supportFailedPeople,
      ...input.after.counts.supportFailedPeople,
    ]),
  ];
  lines.push(
    "## Support-phase failures (reported separately, never counted as semantic ambiguity)",
    "",
    supportFailed.length === 0
      ? "No support-phase failures in either arm: every ambiguous verdict above is a completed assessment."
      : `People with an incomplete support assessment: ${supportFailed.join(", ")}. ` +
          "Their recovered/partial verdicts are withheld by the evaluator and counted apart " +
          "in the ambiguous (support-failed) column.",
    "",
    "## Notes",
    "",
  );
  for (const note of input.notes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}
