import {
  BenchmarkComparisonSchema,
  type BenchmarkComparison,
  type BenchmarkGroupSummary,
  type BenchmarkPerson,
  type BenchmarkPersonResult,
  type BenchmarkReport,
} from "@chief-of-staff-demo/shared";
import { requirementLabel } from "./evaluate.js";

/**
 * Grouped results, always with their denominators.
 *
 * A group without its denominator is how an aggregate improvement hides a
 * regression: "eight recovered" says nothing until it is eight of how many,
 * over how many people.
 */
export function summarizeGroups(
  people: BenchmarkPerson[],
  results: BenchmarkPersonResult[],
): BenchmarkGroupSummary[] {
  const byPerson = new Map(people.map((person) => [person.slug, person]));
  const dimensions: {
    dimension: BenchmarkGroupSummary["dimension"];
    key: (person: BenchmarkPerson) => string[];
  }[] = [
    { dimension: "industry", key: (person) => [person.industry] },
    { dimension: "role", key: (person) => [person.role] },
    { dimension: "footprint", key: (person) => [person.footprint] },
    { dimension: "language", key: (person) => [person.language] },
    { dimension: "region", key: (person) => [person.region] },
    {
      dimension: "source-family",
      key: (person) => [...new Set(person.documents.map((document) => document.family))],
    },
  ];
  const summaries: BenchmarkGroupSummary[] = [];
  for (const { dimension, key } of dimensions) {
    const buckets = new Map<string, BenchmarkPersonResult[]>();
    for (const result of results) {
      const person = byPerson.get(result.slug);
      if (!person) continue;
      for (const value of key(person)) {
        const bucket = buckets.get(value) ?? [];
        bucket.push(result);
        buckets.set(value, bucket);
      }
    }
    for (const [value, bucket] of [...buckets].sort(([a], [b]) => a.localeCompare(b)))
      summaries.push({
        dimension,
        key: value,
        people: bucket.length,
        referenceFacts: bucket.reduce((sum, entry) => sum + entry.completeness.referenceFacts, 0),
        recovered: bucket.reduce((sum, entry) => sum + entry.completeness.recovered, 0),
        ambiguous: bucket.reduce((sum, entry) => sum + entry.completeness.ambiguous, 0),
        criticalFindings: bucket.reduce(
          (sum, entry) => sum + entry.factualReliability.criticalFindings,
          0,
        ),
        overclaims: bucket.reduce(
          (sum, entry) => sum + entry.factualReliability.overclaims.length,
          0,
        ),
      });
  }
  return summaries;
}

/** Every reference fact nobody recovered: the concrete follow-up target list. */
export function remainingMisses(
  people: BenchmarkPerson[],
  results: BenchmarkPersonResult[],
): BenchmarkReport["remainingMisses"] {
  const byPerson = new Map(people.map((person) => [person.slug, person]));
  const misses: BenchmarkReport["remainingMisses"] = [];
  for (const result of results) {
    const person = byPerson.get(result.slug);
    if (!person) continue;
    for (const judgement of result.completeness.judgements) {
      if (judgement.verdict === "recovered") continue;
      const fact = person.facts.find((entry) => entry.id === judgement.factId);
      if (!fact) continue;
      misses.push({
        slug: person.slug,
        factId: fact.id,
        statement: fact.statement,
        acquisition: fact.acquisition,
        requirements: fact.requirements,
        explanation:
          fact.acquisition === "beyond-current-coverage"
            ? `${judgement.verdict}: ${fact.note ?? "the reference records evidence the application cannot currently acquire."}`
            : `${judgement.verdict}: ${judgement.rationale}`,
      });
    }
  }
  return misses;
}

/**
 * Compare two runs.
 *
 * The comparison refuses to be a headline number. It reports recovery on both
 * sides against the same denominator, the critical findings and overclaims each
 * side produced, and — first — whether the two runs were comparable at all. A
 * different corpus version, judge or model makes the answer `not-comparable`
 * rather than a delta with a footnote nobody reads.
 */
export function compareReports(
  baseline: BenchmarkReport,
  candidate: BenchmarkReport,
): BenchmarkComparison {
  const conditionChanges: string[] = [];
  const note = (label: string, before: string, after: string) => {
    if (before !== after) conditionChanges.push(`${label}: ${before} → ${after}`);
  };
  note("corpus version", baseline.provenance.corpusVersion, candidate.provenance.corpusVersion);
  note("judge provider", baseline.provenance.judgeProvider, candidate.provenance.judgeProvider);
  note(
    "evaluated people",
    JSON.stringify([...baseline.selection.evaluated].sort()),
    JSON.stringify([...candidate.selection.evaluated].sort()),
  );
  note("judge model", baseline.provenance.judgeModel, candidate.provenance.judgeModel);
  note("judge version", baseline.provenance.judgeVersion, candidate.provenance.judgeVersion);
  note("research model", baseline.provenance.researchModel, candidate.provenance.researchModel);
  note("mode", baseline.mode, candidate.mode);
  note("network", baseline.provenance.network, candidate.provenance.network);
  for (const [key, value] of Object.entries(baseline.provenance.researchSettings))
    note(
      `research setting ${key}`,
      String(value),
      String(candidate.provenance.researchSettings[key] ?? "absent"),
    );

  /* A changed reference version invalidates the comparison outright: the two
     runs were not answering the same questions. */
  const referenceChanges = [
    ...new Set([
      ...Object.keys(baseline.provenance.referenceVersions),
      ...Object.keys(candidate.provenance.referenceVersions),
    ]),
  ]
    .filter(
      (slug) =>
        baseline.provenance.referenceVersions[slug] !==
        candidate.provenance.referenceVersions[slug],
    )
    .map((slug) => [slug, baseline.provenance.referenceVersions[slug] ?? "absent"] as const);
  for (const [slug, version] of referenceChanges)
    conditionChanges.push(
      `reference ${slug}: ${version} → ${candidate.provenance.referenceVersions[slug] ?? "absent"}`,
    );

  const comparable =
    referenceChanges.length === 0 &&
    JSON.stringify([...baseline.selection.evaluated].sort()) ===
      JSON.stringify([...candidate.selection.evaluated].sort()) &&
    baseline.provenance.judgeProvider === candidate.provenance.judgeProvider &&
    baseline.provenance.corpusVersion === candidate.provenance.corpusVersion &&
    baseline.provenance.judgeModel === candidate.provenance.judgeModel &&
    baseline.provenance.judgeVersion === candidate.provenance.judgeVersion &&
    baseline.mode === candidate.mode &&
    baseline.status === "completed" &&
    candidate.status === "completed";

  const baselineBySlug = new Map(baseline.people.map((entry) => [entry.slug, entry]));
  const perPerson: BenchmarkComparison["perPerson"] = [];
  for (const entry of candidate.people) {
    const before = baselineBySlug.get(entry.slug);
    if (!before) continue;
    perPerson.push({
      slug: entry.slug,
      referenceFacts: entry.completeness.referenceFacts,
      baselineRecovered: before.completeness.recovered,
      candidateRecovered: entry.completeness.recovered,
      newCriticalFindings: Math.max(
        0,
        entry.factualReliability.criticalFindings - before.factualReliability.criticalFindings,
      ),
      newOverclaims: Math.max(
        0,
        entry.factualReliability.overclaims.length - before.factualReliability.overclaims.length,
      ),
    });
  }

  const totals = {
    referenceFacts: perPerson.reduce((sum, entry) => sum + entry.referenceFacts, 0),
    baselineRecovered: perPerson.reduce((sum, entry) => sum + entry.baselineRecovered, 0),
    candidateRecovered: perPerson.reduce((sum, entry) => sum + entry.candidateRecovered, 0),
    baselineCriticalFindings: baseline.people.reduce(
      (sum, entry) => sum + entry.factualReliability.criticalFindings,
      0,
    ),
    candidateCriticalFindings: candidate.people.reduce(
      (sum, entry) => sum + entry.factualReliability.criticalFindings,
      0,
    ),
    baselineOverclaims: baseline.people.reduce(
      (sum, entry) => sum + entry.factualReliability.overclaims.length,
      0,
    ),
    candidateOverclaims: candidate.people.reduce(
      (sum, entry) => sum + entry.factualReliability.overclaims.length,
      0,
    ),
  };

  const newCritical = perPerson.reduce((sum, entry) => sum + entry.newCriticalFindings, 0);
  const newIdentityFailures = candidate.people.reduce(
    (sum, entry) =>
      sum +
      Math.max(
        0,
        entry.factualReliability.wrongPersonAttributions -
          (baselineBySlug.get(entry.slug)?.factualReliability.wrongPersonAttributions ?? 0),
      ),
    0,
  );
  const gained = totals.candidateRecovered - totals.baselineRecovered;
  const verdict = !comparable
    ? "not-comparable"
    : gained > 0 && newCritical === 0 && newIdentityFailures === 0
      ? "improved"
      : gained < 0 || newCritical > 0 || newIdentityFailures > 0
        ? "regressed"
        : "unchanged";

  return BenchmarkComparisonSchema.parse({
    schemaVersion: 1,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    conditionChanges,
    comparable,
    totals,
    perPerson,
    verdict,
    verdictDetail: !comparable
      ? `Not comparable: ${conditionChanges.join("; ") || "one of the runs did not complete"}.`
      : `${gained >= 0 ? "+" : ""}${String(gained)} reference facts recovered out of ${String(totals.referenceFacts)}; ${String(newCritical)} newly introduced critical integrity findings; ${String(newIdentityFailures)} newly introduced wrong-person attributions.`,
  });
}

/** The readable report. Deliberately plain: it is read in a terminal and in a diff. */
export function renderReport(report: BenchmarkReport, people: BenchmarkPerson[]): string {
  const byPerson = new Map(people.map((person) => [person.slug, person]));
  const lines: string[] = [];
  lines.push(`# Person Research Benchmark — ${report.mode}`);
  lines.push("");
  lines.push(`Run \`${report.runId}\` · **${report.status}** · ${report.statusDetail}`);
  lines.push("");
  lines.push("## Conditions");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  const provenance: [string, string][] = [
    ["Corpus version", report.provenance.corpusVersion],
    ["Pipeline", report.provenance.pipeline],
    [
      "Research provider/model",
      `${report.provenance.researchProvider} · ${report.provenance.researchModel}`,
    ],
    [
      "Judge provider/model",
      `${report.provenance.judgeProvider} · ${report.provenance.judgeModel}`,
    ],
    ["Judge version", report.provenance.judgeVersion],
    ["Prompt version", report.provenance.promptVersion],
    ["Network", report.provenance.network],
    ["Started", report.provenance.startedAt],
    ["Finished", report.provenance.finishedAt],
    [
      "Research settings",
      Object.entries(report.provenance.researchSettings)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", "),
    ],
    [
      "Measured usage",
      report.provenance.usage
        ? `${String(report.provenance.usage.inputCharacters)} input characters, ${String(report.provenance.usage.outputCharacters)} output characters; tokens and cost unavailable from the model boundary`
        : "unavailable from the model boundary",
    ],
  ];
  for (const [field, value] of provenance) lines.push(`| ${field} | ${value} |`);
  lines.push("");

  if (report.selection.skipped.length) {
    lines.push("## Not evaluated");
    lines.push("");
    for (const skipped of report.selection.skipped)
      lines.push(`- \`${skipped.slug}\`: ${skipped.reason}`);
    lines.push("");
  }

  lines.push("## Per person");
  lines.push("");
  lines.push(
    "| Person | Industry | Footprint | Recovered / facts | Ambiguous | Critical | Overclaims | Claims | Sources | Families | Conclusion |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of report.people) {
    const person = byPerson.get(result.slug);
    lines.push(
      `| ${result.slug} | ${person?.industry ?? "?"} | ${person?.footprint ?? "?"} | ${String(result.completeness.recovered)} / ${String(result.completeness.referenceFacts)} | ${String(result.completeness.ambiguous)} | ${String(result.factualReliability.criticalFindings)} | ${String(result.factualReliability.overclaims.length)} | ${String(result.richness.claims)} | ${String(result.richness.sources)} | ${String(result.richness.distinctFamilies)} | ${result.operational.conclusion} |`,
    );
  }
  lines.push("");

  lines.push("## The four measures, kept separate");
  lines.push("");
  const totals = report.people.reduce(
    (sum, entry) => ({
      facts: sum.facts + entry.completeness.referenceFacts,
      recovered: sum.recovered + entry.completeness.recovered,
      partial: sum.partial + entry.completeness.partial,
      ambiguous: sum.ambiguous + entry.completeness.ambiguous,
      critical: sum.critical + entry.factualReliability.criticalFindings,
      overclaims: sum.overclaims + entry.factualReliability.overclaims.length,
      wrongPerson: sum.wrongPerson + entry.factualReliability.wrongPersonAttributions,
      verified: sum.verified + entry.factualReliability.verifiedCitations,
      citations: sum.citations + entry.factualReliability.totalCitations,
      claims: sum.claims + entry.richness.claims,
      sources: sum.sources + entry.richness.sources,
      understanding: sum.understanding + entry.usefulness.understanding,
      completedOperations:
        sum.completedOperations + (entry.operational.conclusion === "completed" ? 1 : 0),
    }),
    {
      facts: 0,
      recovered: 0,
      partial: 0,
      ambiguous: 0,
      critical: 0,
      overclaims: 0,
      wrongPerson: 0,
      verified: 0,
      citations: 0,
      claims: 0,
      sources: 0,
      understanding: 0,
      completedOperations: 0,
    },
  );
  const people_ = Math.max(1, report.people.length);
  lines.push(
    `- **Factual reliability** — ${String(totals.verified)} of ${String(totals.citations)} citations verify against their retained source version; ${String(totals.critical)} critical integrity findings; ${String(totals.overclaims)} judged overclaims, of which ${String(totals.wrongPerson)} are wrong-person attributions.`,
  );
  lines.push(
    `- **Completeness** — ${String(totals.recovered)} of ${String(totals.facts)} reference facts recovered, ${String(totals.partial)} partially, ${String(totals.ambiguous)} left ambiguous for review.`,
  );
  lines.push(
    `- **Absolute richness** — ${String(totals.claims)} published claims over ${String(totals.sources)} retained sources; reported beside completeness, never folded into it.`,
  );
  lines.push(
    `- **Meeting-preparation usefulness** — mean understanding ${(totals.understanding / people_).toFixed(2)} of 3, judged with cited evidence.`,
  );
  lines.push(
    `- **Operational reliability** — ${String(totals.completedOperations)} of ${String(report.people.length)} operations reached their own completion conditions.`,
  );
  lines.push("");

  lines.push("## By group (with denominators)");
  lines.push("");
  lines.push(
    "| Dimension | Group | People | Recovered / facts | Ambiguous | Critical | Overclaims |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const group of report.groups)
    lines.push(
      `| ${group.dimension} | ${group.key} | ${String(group.people)} | ${String(group.recovered)} / ${String(group.referenceFacts)} | ${String(group.ambiguous)} | ${String(group.criticalFindings)} | ${String(group.overclaims)} |`,
    );
  lines.push("");

  const failureTotals: Record<string, number> = {};
  for (const result of report.people)
    for (const [code, count] of Object.entries(result.operational.failuresByCode))
      failureTotals[code] = (failureTotals[code] ?? 0) + count;
  if (Object.keys(failureTotals).length) {
    lines.push("## Failures by reason code");
    lines.push("");
    lines.push("| Code | Attempts |");
    lines.push("| --- | --- |");
    for (const [code, count] of Object.entries(failureTotals).sort((a, b) => b[1] - a[1]))
      lines.push(`| ${code} | ${String(count)} |`);
    lines.push("");
  }

  lines.push("## Remaining misses");
  lines.push("");
  lines.push(
    "These are the acceptance targets for follow-up source and extraction work. A miss marked `beyond-current-coverage` was authored knowing the application cannot reach it today; it stays in the reference.",
  );
  lines.push("");
  lines.push("| Person | Fact | Requirements | Acquisition | Why it is still missing |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const miss of report.remainingMisses.slice(0, 400))
    lines.push(
      `| ${miss.slug} | ${escapeCell(miss.statement)} | ${miss.requirements.map(requirementLabel).join("; ")} | ${miss.acquisition} | ${escapeCell(miss.explanation)} |`,
    );
  lines.push("");
  return lines.join("\n");
}

export function renderComparison(comparison: BenchmarkComparison): string {
  const lines: string[] = [];
  lines.push("# Person Research Benchmark — incumbent versus expanded");
  lines.push("");
  lines.push(
    `Baseline \`${comparison.baselineRunId}\` versus candidate \`${comparison.candidateRunId}\`: **${comparison.verdict}**.`,
  );
  lines.push("");
  lines.push(comparison.verdictDetail);
  lines.push("");
  if (comparison.conditionChanges.length) {
    lines.push("## Conditions that differed");
    lines.push("");
    for (const change of comparison.conditionChanges) lines.push(`- ${change}`);
    lines.push("");
  } else {
    lines.push("Both runs held the reference version, judge configuration and mode fixed.");
    lines.push("");
  }
  lines.push("## Per person");
  lines.push("");
  lines.push(
    "| Person | Facts | Baseline recovered | Candidate recovered | New critical | New overclaims |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const entry of comparison.perPerson)
    lines.push(
      `| ${entry.slug} | ${String(entry.referenceFacts)} | ${String(entry.baselineRecovered)} | ${String(entry.candidateRecovered)} | ${String(entry.newCriticalFindings)} | ${String(entry.newOverclaims)} |`,
    );
  lines.push("");
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300);
}
