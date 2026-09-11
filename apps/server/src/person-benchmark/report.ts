import {
  BenchmarkComparisonSchema,
  BenchmarkGroupSummarySchema,
  MAX_VERDICT_DETAIL,
  type BenchmarkComparison,
  type BenchmarkGroupSummary,
  type BenchmarkPerson,
  type BenchmarkPersonResult,
  type BenchmarkReport,
  type PersonResearchLead,
  type PersonResearchOperationOutcome,
} from "@chief-of-staff-demo/shared";
import { requirementLabel } from "./evaluate.js";
import { EVALUATOR_DOWNGRADE_PREFIX } from "./ambiguity.js";

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
      dimension: "reference-source-family",
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
        /* Carried assessments completed their support phase, so an absent
           measurement aggregates as zero (#271). */
        ambiguousSupportAssessmentFailed: bucket.reduce(
          (sum, entry) => sum + (entry.completeness.ambiguousSupportAssessmentFailed ?? 0),
          0,
        ),
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
      /* A withheld verdict's rationale opens with the evaluator's downgrade
         disclosure, and the beyond-current-coverage branch reports the corpus
         note instead of that rationale — so the disclosure must be carried
         over explicitly, or a judge-confirmed-but-credit-withheld fact reads
         as never-captured (issue #284). The disclosure is the rationale's
         first sentence; the downgrade reasons never carry a period of their
         own, and an unsentenced rationale is appended whole. */
      const withheld = judgement.rationale.startsWith(EVALUATOR_DOWNGRADE_PREFIX);
      const end = judgement.rationale.indexOf(". ");
      const disclosure = withheld
        ? ` ${(end === -1 ? judgement.rationale : judgement.rationale.slice(0, end + 1)).trim()}`
        : "";
      misses.push({
        slug: person.slug,
        factId: fact.id,
        statement: fact.statement,
        acquisition: fact.acquisition,
        requirements: fact.requirements,
        explanation:
          fact.acquisition === "beyond-current-coverage"
            ? `${judgement.verdict}: ${fact.note ?? "the reference records evidence the application cannot currently acquire."}${disclosure}`
            : `${judgement.verdict}: ${judgement.rationale}`,
      });
    }
  }
  return misses;
}

/**
 * Report-level aggregation over the run's research operation records (#281):
 * how every recorded lead resolved — with each disposition's share of the
 * denominator, so "#239: unresolved leads no longer dominant" is checkable
 * from the report alone — and how much planned coverage stays open. The
 * per-lead detail stays in the operation records; the report carries totals.
 */
export function leadDispositionTotals(
  outcomes: PersonResearchOperationOutcome[],
): NonNullable<BenchmarkReport["leadDispositions"]> {
  const counts: Record<PersonResearchLead["disposition"], number> = {
    pending: 0,
    investigated: 0,
    rejected: 0,
    deduplicated: 0,
    inaccessible: 0,
    interrupted: 0,
  };
  let totalLeads = 0;
  for (const outcome of outcomes)
    for (const lead of outcome.leads) {
      totalLeads += 1;
      counts[lead.disposition] += 1;
    }
  return {
    totalLeads,
    dispositions: Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([disposition, count]) => ({
        disposition: disposition as PersonResearchLead["disposition"],
        count,
        share: totalLeads === 0 ? 0 : count / totalLeads,
      }))
      .sort((a, b) => b.count - a.count || a.disposition.localeCompare(b.disposition)),
  };
}

/** The open-coverage side of the same aggregation: planned areas against the
 *  gaps they still name, plus the operations' own explicit remaining gaps. */
export function coverageGapTotals(
  outcomes: PersonResearchOperationOutcome[],
): NonNullable<BenchmarkReport["coverageGaps"]> {
  const totals = { areas: 0, areasWithOpenGaps: 0, areaGaps: 0, explicitGaps: 0 };
  for (const outcome of outcomes) {
    totals.explicitGaps += outcome.gaps.length;
    for (const area of outcome.coverage) {
      totals.areas += 1;
      if (area.gaps.length > 0) {
        totals.areasWithOpenGaps += 1;
        totals.areaGaps += area.gaps.length;
      }
    }
  }
  return totals;
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
function assessmentComplete(person: BenchmarkPersonResult): boolean {
  return (
    !!person.assessment?.operationId &&
    person.assessment.integrity === "completed" &&
    person.assessment.judge === "completed"
  );
}

function criticalKeys(person: BenchmarkPersonResult): string[] {
  return (
    person.factualReliability.criticalFindingKeys ??
    person.factualReliability.integrityFindings
      .filter((finding) => finding.severity === "critical")
      .map(
        (finding) =>
          finding.fingerprint ?? `${finding.check}:${finding.detail.replace(/\s+/g, " ").trim()}`,
      )
  );
}

function completeCriticalEvidence(person: BenchmarkPersonResult): boolean {
  const reliability = person.factualReliability;
  if (reliability.criticalFindingKeys)
    return reliability.criticalFindingKeys.length === reliability.criticalFindings;
  const findings = reliability.integrityFindings.filter(
    (finding) => finding.severity === "critical",
  );
  return (
    findings.length === reliability.criticalFindings &&
    findings.every((finding) => !!finding.fingerprint)
  );
}

function overclaimKeys(person: BenchmarkPersonResult, wrongPersonOnly = false): string[] {
  return person.factualReliability.overclaims
    .filter((finding) => !wrongPersonOnly || finding.kind === "wrong-person")
    .map((finding) =>
      JSON.stringify(
        [finding.kind, finding.statement, finding.citedQuote, finding.matchedUnjustifiedId].map(
          (value) => value?.replace(/\s+/g, " ").trim() ?? null,
        ),
      ),
    );
}

/** Compare evidence identities as a multiset, so replacement failures cannot cancel each other. */
function introduced(before: string[], after: string[]): number {
  const remaining = new Map<string, number>();
  for (const key of before) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  let added = 0;
  for (const key of after) {
    const count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1);
    else added += 1;
  }
  return added;
}

/** Never infer successful assessment from legacy status or synthesized fallback judgements. */
function completeEvaluation(report: BenchmarkReport): boolean {
  const execution = report.execution;
  if (!execution || execution.status !== "completed" || report.status === "interrupted")
    return false;
  const sameMembers = (expected: string[], actual: string[]) =>
    new Set(expected).size === expected.length &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...expected].sort()) === JSON.stringify([...actual].sort());
  return (
    execution.selected.length > 0 &&
    sameMembers(
      execution.selected,
      report.people.map((person) => person.slug),
    ) &&
    sameMembers(execution.selected, report.selection.evaluated) &&
    sameMembers(execution.selected, Object.keys(report.provenance.referenceVersions)) &&
    execution.evaluated === report.people.length &&
    execution.assessed === report.people.length &&
    report.people.every(
      (person) =>
        assessmentComplete(person) &&
        completeCriticalEvidence(person) &&
        overclaimKeys(person, true).length === person.factualReliability.wrongPersonAttributions &&
        person.mode === report.mode &&
        person.referenceVersion === report.provenance.referenceVersions[person.slug],
    ) &&
    sameMembers(
      execution.scenarioIds,
      (report.collection ?? []).map((result) => result.scenarioId),
    ) &&
    (report.collection ?? []).every((result) => result.assessmentStatus === "completed")
  );
}

/**
 * The labelled slices both reports aggregated, joined on (dimension, key).
 * Each side keeps its own denominator; a group one arm recorded and the other
 * did not stays null on the absent side, because an unmeasured slice is not a
 * zero.
 */
function joinedGroups(
  baseline: BenchmarkReport,
  candidate: BenchmarkReport,
): NonNullable<BenchmarkComparison["groups"]> {
  const before = new Map<string, BenchmarkGroupSummary>();
  for (const group of baseline.groups) before.set(`${group.dimension}\u0000${group.key}`, group);
  const after = new Map<string, BenchmarkGroupSummary>();
  for (const group of candidate.groups) after.set(`${group.dimension}\u0000${group.key}`, group);
  const dimensions = BenchmarkGroupSummarySchema.shape.dimension.options as readonly string[];
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => {
    const [dimensionA = "", valueA = ""] = a.split("\u0000");
    const [dimensionB = "", valueB = ""] = b.split("\u0000");
    return (
      dimensions.indexOf(dimensionA) - dimensions.indexOf(dimensionB) ||
      valueA.localeCompare(valueB)
    );
  });
  const groups: NonNullable<BenchmarkComparison["groups"]> = [];
  for (const key of keys) {
    const baselineGroup = before.get(key);
    const candidateGroup = after.get(key);
    const present = baselineGroup ?? candidateGroup;
    if (!present) throw new Error(`joined group ${key} lost both sides`);
    groups.push({
      dimension: present.dimension,
      key: present.key,
      baseline: baselineGroup
        ? {
            people: baselineGroup.people,
            referenceFacts: baselineGroup.referenceFacts,
            recovered: baselineGroup.recovered,
            ambiguous: baselineGroup.ambiguous,
            criticalFindings: baselineGroup.criticalFindings,
            overclaims: baselineGroup.overclaims,
          }
        : null,
      candidate: candidateGroup
        ? {
            people: candidateGroup.people,
            referenceFacts: candidateGroup.referenceFacts,
            recovered: candidateGroup.recovered,
            ambiguous: candidateGroup.ambiguous,
            criticalFindings: candidateGroup.criticalFindings,
            overclaims: candidateGroup.overclaims,
          }
        : null,
    });
  }
  return groups;
}

/**
 * One side's recorded failures: the people whose result carries a failure
 * beside the attempt codes their operations recorded. Both are the report's
 * own records — the comparison names them rather than counting them into a
 * single number.
 */
function failureBreakdown(
  report: BenchmarkReport,
): NonNullable<BenchmarkComparison["failures"]>["baseline"] {
  const assessmentFailures = report.people.flatMap((person) =>
    person.failure === null ? [] : [{ slug: person.slug, reason: person.failure }],
  );
  const attemptsByCode = new Map<string, number>();
  for (const person of report.people)
    for (const [code, attempts] of Object.entries(person.operational.failuresByCode))
      attemptsByCode.set(code, (attemptsByCode.get(code) ?? 0) + attempts);
  return {
    assessmentFailures,
    researchCodes: [...attemptsByCode.entries()]
      .map(([code, attempts]) => ({ code, attempts }))
      .sort((a, b) => b.attempts - a.attempts || a.code.localeCompare(b.code)),
  };
}

/** The literal judge.ts appends when the exact-claim guard withholds a
 *  verdict; evaluate.ts's own prefix is EVALUATOR_DOWNGRADE_PREFIX. */
const JUDGE_DOWNGRADE_MARKER = "(Downgraded: ";

/**
 * The recorded contradiction (#259): `santander-chair` was credited as
 * recovered while the judge's own rationale said the dossier "does not
 * mention the September 2014 start date". The judge's vocabulary defines a
 * fact stated without the reference's dates as `partial`, so a rationale
 * naming a dated part of the reference as absent cannot also credit a
 * recovery. The rule matches the judge's own negation vocabulary and only
 * when the negated object carries a date-like token, so a rationale that
 * declines to name a source ("does not name the Nobel biography ...") keeps
 * its credit.
 */
const RATIONALE_NEGATIONS = [
  "does not",
  "did not",
  "doesn't",
  "do not",
  "no dossier",
  "without the",
  "lacks",
  "fails to",
];
const DATE_LIKE_TOKEN =
  /\b(?:19|20)\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i;

function rationaleContradictsRecovery(rationale: string): boolean {
  const lower = rationale.toLowerCase();
  for (const negation of RATIONALE_NEGATIONS) {
    for (
      let index = lower.indexOf(negation);
      index !== -1;
      index = lower.indexOf(negation, index + 1)
    ) {
      /* The negated object is the clause right after the marker: a date-like
         token there is the reference's dated content being declared absent. */
      const rest = rationale.slice(index + negation.length, index + negation.length + 60);
      const clause = rest.split(".")[0] ?? rest;
      if (DATE_LIKE_TOKEN.test(clause)) return true;
    }
  }
  return false;
}

/**
 * #259: the comparison credits a positive recovery only when the report's own
 * judgement carries the reference text and the claim excerpt it was checked
 * against — the judge's exact-claim guard verifies the excerpt against the
 * named claim at assessment time, and a verdict naming no claim was never
 * checked — and when the rationale records no withheld verdict. A credit that
 * fails the audit is rejected and named, never silently discounted.
 */
interface RecoveryAudit {
  recorded: number;
  credited: number;
  rejected: {
    slug: string;
    factId: string;
    reason:
      | "no-reference-quote"
      | "no-claim-quote"
      | "no-claim-identity"
      | "withheld-in-rationale"
      | "rationale-contradicts-verdict"
      | "credit-exceeds-checkable-judgements";
  }[];
  /** The verified fact ids per person: the only recoveries the comparison credits. */
  creditedFactIds: Map<string, Set<string>>;
}

function auditRecoveries(report: BenchmarkReport): RecoveryAudit {
  const rejected: RecoveryAudit["rejected"] = [];
  const creditedFactIds = new Map<string, Set<string>>();
  let recorded = 0;
  let credited = 0;
  for (const person of report.people) {
    recorded += person.completeness.recovered;
    const creditedFacts = new Set<string>();
    for (const judgement of person.completeness.judgements) {
      if (judgement.verdict !== "recovered") continue;
      const withheld =
        judgement.rationale.startsWith(EVALUATOR_DOWNGRADE_PREFIX) ||
        judgement.rationale.includes(JUDGE_DOWNGRADE_MARKER);
      const reason: RecoveryAudit["rejected"][number]["reason"] | null = withheld
        ? "withheld-in-rationale"
        : rationaleContradictsRecovery(judgement.rationale)
          ? "rationale-contradicts-verdict"
          : judgement.referenceQuote.trim().length === 0
            ? "no-reference-quote"
            : judgement.claimId === null
              ? "no-claim-identity"
              : (judgement.evidenceQuote ?? "").trim().length === 0
                ? "no-claim-quote"
                : null;
      if (reason === null) creditedFacts.add(judgement.factId);
      else rejected.push({ slug: person.slug, factId: judgement.factId, reason });
    }
    /* A recorded count above its checkable judgements credits something the
       report cannot check at all; the excess is rejected rather than dropped
       in silence. */
    if (person.completeness.recovered > creditedFacts.size)
      rejected.push({
        slug: person.slug,
        factId: "",
        reason: "credit-exceeds-checkable-judgements",
      });
    creditedFactIds.set(person.slug, creditedFacts);
    credited += creditedFacts.size;
  }
  return { recorded, credited, rejected, creditedFactIds };
}

/** What the not-comparable verdict detail may spend on the condition list. */
const CONDITION_DETAIL_BUDGET = MAX_VERDICT_DETAIL - "Not comparable: ".length - 1;

/**
 * The not-comparable detail repeats the conditions that made the pair
 * incomparable. A subset arm against a full population records one
 * reference-version difference per person, so the list can outgrow the
 * comparison schema's `verdictDetail` bound; the detail keeps whole entries
 * and states how many it left out, while the full list stays in
 * `conditionChanges` and in the rendered *Conditions that differed* section,
 * so the refusal renders instead of failing schema validation (#259).
 */
function conditionDetail(changes: string[]): string {
  if (changes.length === 0) return "one of the runs did not complete";
  const kept: string[] = [];
  let used = 0;
  for (const change of changes) {
    const omitted = changes.length - kept.length - 1;
    const marker =
      omitted > 0
        ? `; ${String(omitted)} more recorded condition difference${omitted === 1 ? "" : "s"}`
        : "";
    /* The marker's own length counts against the budget, so the string is
       bounded before it is built rather than sliced after. */
    const separator = kept.length > 0 ? 2 : 0;
    if (used + separator + change.length + marker.length > CONDITION_DETAIL_BUDGET) break;
    kept.push(change);
    used += separator + change.length;
  }
  const omitted = changes.length - kept.length;
  return `${kept.join("; ")}${
    omitted > 0
      ? `; ${String(omitted)} more recorded condition difference${omitted === 1 ? "" : "s"}`
      : ""
  }`;
}

export function compareReports(
  baseline: BenchmarkReport,
  candidate: BenchmarkReport,
): BenchmarkComparison {
  const conditionChanges: string[] = [];
  if (!completeEvaluation(baseline))
    conditionChanges.push(
      "Baseline evaluation is incomplete or lacks explicit assessment evidence",
    );
  if (!completeEvaluation(candidate))
    conditionChanges.push(
      "Candidate evaluation is incomplete or lacks explicit assessment evidence",
    );
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
  note(
    "planning provider",
    baseline.provenance.planningProvider ?? "absent",
    candidate.provenance.planningProvider ?? "absent",
  );
  note(
    "planning model",
    baseline.provenance.planningModel ?? "absent",
    candidate.provenance.planningModel ?? "absent",
  );
  note("mode", baseline.mode, candidate.mode);
  note("network", baseline.provenance.network, candidate.provenance.network);
  /* Both sides' keys: a setting recorded only by the newer report (or only
     by the older one) is still a condition difference, never silence. */
  for (const key of new Set([
    ...Object.keys(baseline.provenance.researchSettings),
    ...Object.keys(candidate.provenance.researchSettings),
  ]))
    note(
      `research setting ${key}`,
      String(baseline.provenance.researchSettings[key] ?? "absent"),
      String(candidate.provenance.researchSettings[key] ?? "absent"),
    );

  /* #281: the support/usefulness phase withholds recovery credit under
     ADR-0067, so its completion profile is a recorded condition like any
     other. A differing profile does not make the runs incomparable — the
     verdict reads only the pairs whose recovery credit is not withheld. */
  const supportProfile = (report: BenchmarkReport) => {
    const counts = { completed: 0, failed: 0, "not-attempted": 0, unrecorded: 0 };
    for (const person of report.people) {
      const status = person.assessment?.phases?.support.status;
      counts[
        status === "completed" || status === "failed" || status === "not-attempted"
          ? status
          : "unrecorded"
      ] += 1;
    }
    return Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${status} ${String(count)}`)
      .join(", ");
  };
  note("support/usefulness assessment", supportProfile(baseline), supportProfile(candidate));
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

  /* #281: a differing support/usefulness profile is a recorded condition like
     any other, but it does not make the runs incomparable — the verdict below
     simply reads only the pairs whose recovery credit is not withheld. */
  const conditionsComparable =
    referenceChanges.length === 0 &&
    JSON.stringify([...baseline.selection.evaluated].sort()) ===
      JSON.stringify([...candidate.selection.evaluated].sort()) &&
    baseline.provenance.judgeProvider === candidate.provenance.judgeProvider &&
    baseline.provenance.corpusVersion === candidate.provenance.corpusVersion &&
    baseline.provenance.judgeModel === candidate.provenance.judgeModel &&
    baseline.provenance.judgeVersion === candidate.provenance.judgeVersion &&
    baseline.mode === candidate.mode &&
    completeEvaluation(baseline) &&
    completeEvaluation(candidate);

  /* #259: a credited recovery the report cannot check against its own
     reference and claim text is rejected before it can move the verdict, and
     the audit says what was recorded against what was verified. */
  const baselineRecovery = auditRecoveries(baseline);
  const candidateRecovery = auditRecoveries(candidate);
  const noteRecoveryAudit = (label: string, audit: RecoveryAudit) => {
    if (audit.rejected.length === 0 && audit.recorded === audit.credited) return;
    const rejected = audit.rejected
      .map((entry) => `${entry.slug}/${entry.factId || "unattributed"} (${entry.reason})`)
      .join(", ");
    conditionChanges.push(
      `${label} recovery audit: ${String(audit.credited)} of ${String(audit.recorded)} credited recoveries verified against their reference and claim text${rejected ? `; rejected ${rejected}` : ""}`.slice(
        0,
        1000,
      ),
    );
  };
  noteRecoveryAudit("Baseline", baselineRecovery);
  noteRecoveryAudit("Candidate", candidateRecovery);

  const baselineBySlug = new Map(baseline.people.map((entry) => [entry.slug, entry]));
  /* Recovery credit is withheld while the assessment phases are incomplete,
     so a zero from an unmeasured side is not evidence (#271, #281): the pair
     flags below say which sides were actually measured. */
  const perPerson: BenchmarkComparison["perPerson"] = [];
  for (const entry of candidate.people) {
    const before = baselineBySlug.get(entry.slug);
    if (!before) continue;
    perPerson.push({
      slug: entry.slug,
      referenceFacts: entry.completeness.referenceFacts,
      baselineRecovered: baselineRecovery.creditedFactIds.get(before.slug)?.size ?? 0,
      candidateRecovered: candidateRecovery.creditedFactIds.get(entry.slug)?.size ?? 0,
      baselineConclusion: before.operational.conclusion,
      candidateConclusion: entry.operational.conclusion,
      /* ADR-0067: recovery credit is withheld while the support/usefulness
         assessment has not completed, so a zero from such a side is unmeasured
         rather than a proven absence. Reports written before the phases field
         existed measured recovery without one, and their counts stay
         vouchable as recorded. */
      baselineAssessed:
        assessmentComplete(before) &&
        (before.assessment?.phases
          ? before.assessment.phases.support.status === "completed"
          : true),
      candidateAssessed:
        assessmentComplete(entry) &&
        (entry.assessment?.phases ? entry.assessment.phases.support.status === "completed" : true),
      newCriticalFindings: introduced(criticalKeys(before), criticalKeys(entry)),
      newWrongPersonAttributions: introduced(
        overclaimKeys(before, true),
        overclaimKeys(entry, true),
      ),
      newOverclaims: introduced(overclaimKeys(before), overclaimKeys(entry)),
    });
  }
  const measured = perPerson.filter((entry) => entry.baselineAssessed && entry.candidateAssessed);
  if (perPerson.length > 0 && measured.length === 0)
    conditionChanges.push(
      "no pair has a measured completeness dimension: every compared person's support/usefulness assessment is incomplete on at least one side, and ADR-0067 withholds their recovery credit",
    );
  const comparable = conditionsComparable && (perPerson.length === 0 || measured.length > 0);
  const excludedPairs = perPerson.filter(
    (entry) => !(entry.baselineAssessed && entry.candidateAssessed),
  );

  const totals = {
    referenceFacts: perPerson.reduce((sum, entry) => sum + entry.referenceFacts, 0),
    baselineRecovered: measured.reduce((sum, entry) => sum + entry.baselineRecovered, 0),
    candidateRecovered: measured.reduce((sum, entry) => sum + entry.candidateRecovered, 0),
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
  const outcomes = (report: BenchmarkReport) => {
    const counts = { completed: 0, bounded: 0, interrupted: 0 };
    for (const person of report.people) counts[person.operational.conclusion] += 1;
    return counts;
  };
  const operational = {
    baselineStatus: baseline.status,
    candidateStatus: candidate.status,
    baseline: outcomes(baseline),
    candidate: outcomes(candidate),
    regressedPeople: perPerson
      .filter(
        (person) =>
          person.baselineConclusion === "completed" && person.candidateConclusion !== "completed",
      )
      .map((person) => person.slug),
  };
  const newIdentityFailures = perPerson.reduce(
    (sum, entry) => sum + (entry.newWrongPersonAttributions ?? 0),
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
    sourceContributions: [
      ...new Set(
        [...baseline.people, ...candidate.people].flatMap((person) =>
          (person.sourceContributions ?? []).map((entry) => entry.family),
        ),
      ),
    ]
      .sort()
      .map((family) => ({
        family,
        baseline: contributionTotals(baseline.people, family, baselineRecovery.creditedFactIds),
        candidate: contributionTotals(candidate.people, family, candidateRecovery.creditedFactIds),
      })),
    totals,
    perPerson,
    groups: joinedGroups(baseline, candidate),
    coverageGaps: {
      baseline: baseline.coverageGaps ? { ...baseline.coverageGaps } : null,
      candidate: candidate.coverageGaps ? { ...candidate.coverageGaps } : null,
    },
    failures: {
      baseline: failureBreakdown(baseline),
      candidate: failureBreakdown(candidate),
    },
    recoveryAudit: {
      baseline: {
        recorded: baselineRecovery.recorded,
        credited: baselineRecovery.credited,
        rejected: baselineRecovery.rejected,
      },
      candidate: {
        recorded: candidateRecovery.recorded,
        credited: candidateRecovery.credited,
        rejected: candidateRecovery.rejected,
      },
    },
    operational,
    verdict,
    verdictDetail: !comparable
      ? `Not comparable: ${conditionDetail(conditionChanges)}.`
      : `Reference coverage: ${gained >= 0 ? "+" : ""}${String(gained)} reference facts recovered out of ${String(totals.referenceFacts)}, read across the ${String(measured.length)} of ${String(perPerson.length)} pairs whose recovery credit is not withheld${excludedPairs.length ? `; for ${excludedPairs.map((entry) => entry.slug).join(", ")}, whose support/usefulness assessment did not complete on one side, ADR-0067 withholds recovery credit` : ""}; ${String(newCritical)} newly introduced critical integrity findings; ${String(newIdentityFailures)} newly introduced wrong-person attributions. Research outcomes are separate: ${String(operational.regressedPeople.length)} people regressed from completed research to bounded or interrupted. Failed run statuses remain unchanged.`,
  });
}

/**
 * How a retained source's version reads in the report.
 *
 * Three states, kept apart because they say different things. A version the
 * route stated is printed. `null` means the route was asked and states none.
 * Absent means the report was written before the field existed, so nobody
 * asked — printing that as "none stated" would put a claim about the route
 * into a report that never measured it (#252).
 */
function renderSourceVersion(source: { sourceVersion?: string | null | undefined }): string {
  const stated = source.sourceVersion;
  /* Absent and `undefined` alike mean nobody asked: the report predates the
     field. `Object.hasOwn` distinguishes them from an explicit null but does
     not narrow the type, so the value is tested directly. */
  if (stated === undefined) return "unmeasured";
  if (stated === null || stated === "") return "none stated";
  return escapeCell(stated);
}

function contributionTotals(
  people: BenchmarkPersonResult[],
  family: NonNullable<BenchmarkPersonResult["sourceContributions"]>[number]["family"],
  creditedFactIds: Map<string, Set<string>>,
) {
  if (people.some((person) => person.sourceContributions === undefined)) return null;
  let peopleCount = 0;
  let retainedSources = 0;
  let citedSources = 0;
  let recoveredFacts = 0;
  let exclusiveRecoveredFacts = 0;
  for (const person of people) {
    const credited = creditedFactIds.get(person.slug);
    for (const entry of person.sourceContributions ?? []) {
      if (entry.family !== family) continue;
      peopleCount += 1;
      retainedSources += entry.sources.length;
      citedSources += entry.sources.filter((source) => source.cited).length;
      /* Only the audit-verified credits count: a rejected credit must not
         reappear as a family contribution. */
      recoveredFacts += entry.recoveredFactIds.filter((id) => credited?.has(id)).length;
      exclusiveRecoveredFacts += entry.exclusiveRecoveredFactIds.filter((id) =>
        credited?.has(id),
      ).length;
    }
  }
  return {
    people: peopleCount,
    retainedSources,
    citedSources,
    recoveredFacts,
    exclusiveRecoveredFacts,
  };
}

/* The usage row reports what the model boundary actually supplied: character
   counts always, provider token halves and charge only when observed. An
   unobserved half serializes as null, never as a fake 0. */
function measuredUsage(usage: NonNullable<BenchmarkReport["provenance"]["usage"]>): string {
  const characters = `${String(usage.inputCharacters)} input characters, ${String(usage.outputCharacters)} output characters`;
  const tokens =
    usage.tokens === "unavailable"
      ? "tokens unavailable from the model boundary"
      : `tokens ${usage.tokens.input === null ? "unavailable" : String(usage.tokens.input)} in / ${usage.tokens.output === null ? "unavailable" : String(usage.tokens.output)} out`;
  const cost =
    usage.cost === "unavailable"
      ? "cost unavailable from the model boundary"
      : `cost $${String(usage.cost)}`;
  return `${characters}; ${tokens}; ${cost}`;
}

/** The readable report. Deliberately plain: it is read in a terminal and in a diff. */
export function renderReport(report: BenchmarkReport, people: BenchmarkPerson[]): string {
  const byPerson = new Map(people.map((person) => [person.slug, person]));
  const lines: string[] = [];
  lines.push(`# Person Research Benchmark — ${report.mode}`);
  lines.push("");
  lines.push(`Run \`${report.runId}\` · **${report.status}** · ${report.statusDetail}`);
  if (report.reassessment) {
    lines.push(
      `Reassessment of run \`${report.reassessment.originalRunId}\`; no research was repeated. Original research conditions and operational outcomes are retained.`,
    );
    lines.push(
      `Assessment: ${report.reassessment.startedAt} to ${report.reassessment.finishedAt}; judge ${report.provenance.judgeVersion}; ${String(report.reassessment.inputCharacters)} input / ${String(report.reassessment.outputCharacters)} output characters. Tokens and cost unavailable.`,
    );
  }
  if (report.execution)
    lines.push(
      `Evaluation execution: ${report.execution.status}; ${String(report.execution.assessed)} / ${String(report.execution.selected.length)} selected people fully assessed. Research failures remain reported separately.`,
    );
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
    ...(report.provenance.planningProvider && report.provenance.planningModel
      ? [
          [
            "Planning provider/model",
            `${report.provenance.planningProvider} · ${report.provenance.planningModel}`,
          ] as [string, string],
        ]
      : []),
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
        ? measuredUsage(report.provenance.usage)
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
  /* Support-failed is the ambiguous count's withheld-for-support part (#271);
     reports written before #271 carry no measurement, shown as an em dash. */
  lines.push(
    "| Person | Industry | Footprint | Recovered / facts | Ambiguous | Support-failed | Critical | Overclaims | Claims | Sources | Families | Conclusion |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of report.people) {
    const person = byPerson.get(result.slug);
    lines.push(
      `| ${result.slug} | ${person?.industry ?? "?"} | ${person?.footprint ?? "?"} | ${String(result.completeness.recovered)} / ${String(result.completeness.referenceFacts)} | ${String(result.completeness.ambiguous)} | ${String(result.completeness.ambiguousSupportAssessmentFailed ?? "—")} | ${String(result.factualReliability.criticalFindings)} | ${String(result.factualReliability.overclaims.length)} | ${String(result.richness.claims)} | ${String(result.richness.sources)} | ${String(result.richness.distinctFamilies)} | ${result.operational.conclusion} |`,
    );
  }
  lines.push("");

  if (report.collection?.length) {
    lines.push("## Capability intersections (r18)");
    lines.push("");
    lines.push(
      "| Scenario | Expected recovered | Active / researched Profiles | Demonstrated / claimed only | Missing expected people | Additional matches for review |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const result of report.collection) {
      lines.push(
        `| ${result.scenarioId} | ${String(result.recoveredMatches.length)} / ${String(result.expectedMatches.length)} | ${String(result.coverage.activeProfiles)} / ${String(result.coverage.researchedProfiles)} | ${String(result.coverage.demonstrated)} / ${String(result.coverage.claimedOnly)} | ${result.missingMatches.join(", ") || "none"} | ${result.additionalMatchesForReview.join(", ") || "none"} |`,
      );
      lines.push("");
      lines.push(`Query categories: ${result.categories.join(" + ")}. ${result.scope}`);
      lines.push("");
    }
    lines.push(
      "The JSON report retains matched claim/work IDs and citation URLs, hashes and quotations. Collection recovery is separate from individual reference-fact counts.",
    );
    lines.push("");
  }

  lines.push("## The four measures, kept separate");
  lines.push("");
  const totals = report.people.reduce(
    (sum, entry) => ({
      facts: sum.facts + entry.completeness.referenceFacts,
      recovered: sum.recovered + entry.completeness.recovered,
      partial: sum.partial + entry.completeness.partial,
      ambiguous: sum.ambiguous + entry.completeness.ambiguous,
      ambiguousSupportAssessmentFailed:
        sum.ambiguousSupportAssessmentFailed +
        (entry.completeness.ambiguousSupportAssessmentFailed ?? 0),
      /* The five judgement verdicts are the whole denominator, so the
         Completeness bullet states every one of them and the outcomes
         reconcile against the fact count on the page itself (#271). */
      missing:
        sum.missing +
        entry.completeness.judgements.filter((judgement) => judgement.verdict === "missing").length,
      contradicted:
        sum.contradicted +
        entry.completeness.judgements.filter((judgement) => judgement.verdict === "contradicted")
          .length,
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
      ambiguousSupportAssessmentFailed: 0,
      missing: 0,
      contradicted: 0,
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
  lines.push(
    `- **Factual reliability** — ${String(totals.verified)} of ${String(totals.citations)} citations verify against their retained source version; ${String(totals.critical)} critical integrity findings; ${String(totals.overclaims)} judged overclaims, of which ${String(totals.wrongPerson)} are wrong-person attributions.`,
  );
  lines.push(
    `- **Completeness** — ${String(totals.recovered)} of ${String(totals.facts)} reference facts recovered, ${String(totals.partial)} partially, ${String(totals.ambiguous)} left ambiguous for review, ${String(totals.ambiguousSupportAssessmentFailed)} of them withheld for an incomplete support/usefulness assessment rather than semantic ambiguity, ${String(totals.contradicted)} contradicted by the reference, and ${String(totals.missing)} still missing.`,
  );
  lines.push(
    `- **Absolute richness** — ${String(totals.claims)} published claims over ${String(totals.sources)} retained sources; reported beside completeness, never folded into it.`,
  );
  /* A dossier whose support/usefulness phases never completed offers no
   judged usefulness signal; averaging its zeros over the population would
   present unavailable as an observed score (#281). The mean runs over the
   people whose support assessment actually completed. */
  const supportAssessed = report.people.filter(
    (entry) => entry.assessment?.phases?.support.status === "completed",
  );
  lines.push(
    supportAssessed.length
      ? `- **Meeting-preparation usefulness** — mean understanding ${(supportAssessed.reduce((sum, entry) => sum + entry.usefulness.understanding, 0) / supportAssessed.length).toFixed(2)} of 3 over ${String(supportAssessed.length)} completed support/usefulness assessments, judged with cited evidence.`
      : `- **Meeting-preparation usefulness** — unavailable: no support/usefulness assessment completed, so the run carries no judged usefulness signal.`,
  );
  lines.push(
    `- **Operational reliability** — ${String(totals.completedOperations)} of ${String(report.people.length)} operations reached their own completion conditions.`,
  );
  lines.push("");

  lines.push("## By group (with denominators)");
  lines.push("");
  lines.push(
    "Reference-source-family groups are cohorts of people whose reference documents include that family; their whole-person recovery is not a production source contribution.",
  );
  lines.push("");
  lines.push(
    "| Dimension | Group | People | Recovered / facts | Ambiguous | Support-failed | Critical | Overclaims |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const group of report.groups)
    lines.push(
      `| ${group.dimension} | ${group.key} | ${String(group.people)} | ${String(group.recovered)} / ${String(group.referenceFacts)} | ${String(group.ambiguous)} | ${String(group.ambiguousSupportAssessmentFailed ?? "—")} | ${String(group.criticalFindings)} | ${String(group.overclaims)} |`,
    );
  lines.push("");

  lines.push("## Actual source-family contributions");
  lines.push("");
  lines.push(
    "These counts follow actual retained source versions and cited claims; multiple retained versions of one URL are not independent sources. Recovered facts exclude critical-invalid citations and judged overclaims; a faithfully recovered self-report remains a self-report. Exclusive recovery means the matched claim cites only that family, not that the family was causally necessary or independent of every other source. A fact may appear in multiple families; do not add family recovery totals.",
  );
  lines.push("");
  lines.push(
    "| Person | Actual family | Retained / cited versions | Cited claims | Recovered / person's facts | Exclusive recovered |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const person of report.people) {
    if (person.sourceContributions === undefined) {
      lines.push(`| ${person.slug} | unmeasured in this report | — | — | — | — |`);
      continue;
    }
    if (person.sourceContributions.length === 0)
      lines.push(
        `| ${person.slug} | no retained sources | 0 / 0 | 0 | 0 / ${String(person.completeness.referenceFacts)} | 0 |`,
      );
    for (const entry of person.sourceContributions)
      lines.push(
        `| ${person.slug} | ${entry.family} | ${String(entry.sources.length)} / ${String(entry.sources.filter((source) => source.cited).length)} | ${String(entry.claimIds.length)} | ${String(entry.recoveredFactIds.length)} / ${String(person.completeness.referenceFacts)} | ${String(entry.exclusiveRecoveredFactIds.length)} |`,
      );
  }
  lines.push("");
  lines.push(
    "The JSON report retains each contributing source URL, hash, upstream index, cited claim IDs and recovered reference-fact IDs, including retained sources that contributed no claims.",
  );
  lines.push("");

  lines.push("## Identity anchors");
  lines.push("");
  lines.push(
    "Retained identity and affiliation registry records (issue #252): the anchor that establishes an identifier belongs to this person, traced to the upstream index and the record's own version. Registry membership on its own does not attribute a linked work or activity to the person; a cited anchor means a claim actually rests on it, not that every fact about the person came from it.",
  );
  lines.push("");
  lines.push("| Person | Source | Upstream index | Source version | Cited |");
  lines.push("| --- | --- | --- | --- | --- |");
  let anyIdentityAnchors = false;
  for (const person of report.people) {
    const anchors = (person.sourceContributions ?? []).find(
      (entry) => entry.family === "identity-affiliation",
    );
    if (!anchors || anchors.sources.length === 0) continue;
    anyIdentityAnchors = true;
    for (const source of anchors.sources)
      lines.push(
        `| ${person.slug} | ${escapeCell(source.url)} | ${source.upstreamIndex ? escapeCell(source.upstreamIndex) : "—"} | ${renderSourceVersion(source)} | ${source.cited ? "yes" : "no"} |`,
      );
  }
  if (!anyIdentityAnchors)
    lines.push(
      "| — | no identity or affiliation registry record retained in this report | — | — | — |",
    );
  lines.push("");

  const judgeAttempts = report.people.flatMap((person) => person.assessment?.modelAttempts ?? []);
  const collectionAttempts =
    report.collection?.flatMap((result) => result.modelAttempts ?? []) ?? [];
  if (judgeAttempts.length || collectionAttempts.length) {
    lines.push("## Observed judge wire attempts");
    lines.push("");
    lines.push(
      "| Assessment | Wire attempts observed | Recovery attempts initiated | Final failed attempts |",
    );
    lines.push("| --- | --- | --- | --- |");
    for (const [label, attempts] of [
      ["Individual people", judgeAttempts],
      ["Collection scenarios", collectionAttempts],
    ] as const) {
      lines.push(
        `| ${label} | ${String(attempts.length)} | ${String(attempts.filter((entry) => entry.observation.outcome === "retrying").length)} | ${String(attempts.filter((entry) => entry.observation.outcome === "failed").length)} |`,
      );
    }
    lines.push("");
    lines.push(
      "The JSON retains correlated, sanitized attempt diagnostics even when a later attempt succeeds. These are observed wire attempts, separate from logical model invocations; uninstrumented boundaries do not supply wire counts. Character usage measures logical request text and returned answers, excluding retried wire payloads.",
    );
    lines.push("");
  }

  const partialJudges = report.people.filter(
    (person) => person.assessment?.phases && person.assessment.judge !== "completed",
  );
  if (partialJudges.length) {
    lines.push(
      "## Incomplete judge phases",
      "",
      "| Person | Reference phase | Support/usefulness phase | Failure |",
      "| --- | --- | --- | --- |",
    );
    for (const person of partialJudges) {
      const phases = person.assessment!.phases!;
      lines.push(
        `| ${person.slug} | ${phases.reference.status} | ${phases.support.status} | ${escapeCell(phases.support.failure ?? phases.reference.failure ?? "Incomplete assessment")} |`,
      );
    }
    lines.push(
      "",
      "Completed reference-stage verdicts and matched evidence remain in assessment.phases.reference.judgements in the JSON/person artifacts. They are provisional; incomplete support assessment receives no positive recovery credit.",
      "",
    );
  }
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
  if (report.leadDispositions) {
    lines.push("## Lead dispositions");
    lines.push("");
    lines.push("| Disposition | Leads | Share |");
    lines.push("| --- | --- | --- |");
    for (const entry of report.leadDispositions.dispositions)
      lines.push(
        `| ${entry.disposition} | ${String(entry.count)} | ${String(Math.round(entry.share * 1000) / 10)}% |`,
      );
    lines.push("");
    lines.push(
      `of ${String(report.leadDispositions.totalLeads)} leads the run's research operations recorded.`,
    );
    lines.push("");
  }
  if (report.coverageGaps) {
    lines.push("## Coverage gaps");
    lines.push("");
    lines.push(
      `${String(report.coverageGaps.areas)} planned coverage areas; ${String(report.coverageGaps.areasWithOpenGaps)} still name open gaps (${String(report.coverageGaps.areaGaps)} in total), and the operations recorded ${String(report.coverageGaps.explicitGaps)} explicit remaining gaps.`,
    );
    lines.push("");
  }
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
  lines.push("## Research outcomes");
  lines.push("");
  lines.push("| Run | Status | Completed | Bounded | Interrupted |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const side of ["baseline", "candidate"] as const) {
    const counts = comparison.operational[side];
    const status =
      side === "baseline"
        ? comparison.operational.baselineStatus
        : comparison.operational.candidateStatus;
    lines.push(
      `| ${side} | ${status} | ${String(counts.completed)} | ${String(counts.bounded)} | ${String(counts.interrupted)} |`,
    );
  }
  lines.push("");
  lines.push(
    `Previously completed research now bounded or interrupted: ${comparison.operational.regressedPeople.join(", ") || "none"}.`,
  );
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
    "| Person | Facts | Baseline recovered | Candidate recovered | Baseline research | Candidate research | New critical | New wrong-person | New overclaims |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of comparison.perPerson)
    lines.push(
      `| ${entry.slug} | ${String(entry.referenceFacts)} | ${entry.baselineAssessed ? String(entry.baselineRecovered) : "unmeasured"} | ${entry.candidateAssessed ? String(entry.candidateRecovered) : "unmeasured"} | ${entry.baselineConclusion} | ${entry.candidateConclusion} | ${String(entry.newCriticalFindings)} | ${String(entry.newWrongPersonAttributions ?? 0)} | ${String(entry.newOverclaims)} |`,
    );
  lines.push("");
  /* A side's recovery credit is withheld while any pair on that side lacks a
     completed assessment (#271, #281): the grouped and source-family tables
     read `unmeasured` for those recovered columns rather than a zero. */
  const baselineCreditMeasured = comparison.perPerson.every((entry) => entry.baselineAssessed);
  const candidateCreditMeasured = comparison.perPerson.every((entry) => entry.candidateAssessed);
  const groups = comparison.groups ?? [];
  if (groups.length) {
    lines.push("## Grouped comparison");
    lines.push("");
    lines.push(
      "The reports' labelled slices, joined on dimension and key, each side with its own denominator. A group one arm did not record stays `unmeasured` rather than zero.",
    );
    lines.push("");
    lines.push(
      "| Dimension | Group | Baseline people | Candidate people | Baseline facts | Candidate facts | Baseline recovered | Candidate recovered | Baseline critical / overclaims | Candidate critical / overclaims |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const group of groups) {
      const before = group.baseline;
      const after = group.candidate;
      const count = (value: number | undefined) =>
        value === undefined ? "unmeasured" : String(value);
      const recovered = (value: number | undefined, measured: boolean) =>
        value === undefined || !measured ? "unmeasured" : String(value);
      lines.push(
        `| ${escapeCell(group.dimension)} | ${escapeCell(group.key)} | ${count(before?.people)} | ${count(after?.people)} | ${count(before?.referenceFacts)} | ${count(after?.referenceFacts)} | ${recovered(before?.recovered, baselineCreditMeasured)} | ${recovered(after?.recovered, candidateCreditMeasured)} | ${before ? `${String(before.criticalFindings)} / ${String(before.overclaims)}` : "unmeasured"} | ${after ? `${String(after.criticalFindings)} / ${String(after.overclaims)}` : "unmeasured"} |`,
      );
    }
    lines.push("");
  }
  if (comparison.recoveryAudit) {
    const audit = comparison.recoveryAudit;
    lines.push("## Recovery audit");
    lines.push("");
    lines.push(
      "Every credited positive recovery is checked against the reference text and the claim excerpt its own judgement names; a credit whose record cannot be checked, or whose rationale records a withheld verdict, is rejected and named rather than discounted quietly. The per-person and total recovery numbers read the audited credits.",
    );
    lines.push("");
    lines.push("| Run | Recorded credits | Audited credits | Rejected |");
    lines.push("| --- | --- | --- | --- |");
    for (const side of ["baseline", "candidate"] as const) {
      const rejected = audit[side].rejected
        .map((entry) => `${entry.slug} / ${entry.factId || "unattributed"} (${entry.reason})`)
        .join("; ");
      lines.push(
        `| ${side} | ${String(audit[side].recorded)} | ${String(audit[side].credited)} | ${escapeCell(rejected) || "none"} |`,
      );
    }
    lines.push("");
  }
  if (comparison.coverageGaps) {
    lines.push("## Coverage gaps");
    lines.push("");
    lines.push(
      "Each report's own open-coverage totals: planned areas against the gaps they still name. A resumed run's totals cover the operations it re-ran, not the people it carried; a side that predates the fields stays `unmeasured`.",
    );
    lines.push("");
    lines.push("| Run | Planned areas | Areas with open gaps | Area gaps | Explicit gaps |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const side of ["baseline", "candidate"] as const) {
      const gaps = comparison.coverageGaps[side];
      lines.push(
        gaps
          ? `| ${side} | ${String(gaps.areas)} | ${String(gaps.areasWithOpenGaps)} | ${String(gaps.areaGaps)} | ${String(gaps.explicitGaps)} |`
          : `| ${side} | unmeasured | unmeasured | unmeasured | unmeasured |`,
      );
    }
    lines.push("");
  }
  if (comparison.failures) {
    const failures = comparison.failures;
    lines.push("## Failures");
    lines.push("");
    if (
      failures.baseline.assessmentFailures.length ||
      failures.candidate.assessmentFailures.length
    ) {
      lines.push(
        "People whose recorded result carries a failure; research statuses stay in the research-outcomes table.",
      );
      lines.push("");
      lines.push("| Run | Person | Recorded failure |");
      lines.push("| --- | --- | --- |");
      for (const side of ["baseline", "candidate"] as const)
        for (const failure of failures[side].assessmentFailures)
          lines.push(`| ${side} | ${failure.slug} | ${escapeCell(failure.reason)} |`);
      lines.push("");
    }
    if (failures.baseline.researchCodes.length || failures.candidate.researchCodes.length) {
      lines.push("| Run | Research failure code | Attempts |");
      lines.push("| --- | --- | --- |");
      for (const side of ["baseline", "candidate"] as const)
        for (const entry of failures[side].researchCodes)
          lines.push(`| ${side} | ${entry.code} | ${String(entry.attempts)} |`);
      lines.push("");
    }
  }
  lines.push("## Actual source-family contribution changes");
  lines.push("");
  lines.push(
    "Recovery follows actual cited sources; families overlap. Exclusive means the matched claim cites one family, not proven causal necessity. Unmeasured legacy contributions stay unknown.",
  );
  lines.push("");
  lines.push(
    "| Family | Baseline retained / cited | Candidate retained / cited | Baseline recovered / exclusive | Candidate recovered / exclusive |",
  );
  lines.push("| --- | --- | --- | --- | --- |");
  /* The family table inherits the same assessment withholding the grouped
     table reads: retained/cited source counts stay measured either way. */
  for (const entry of comparison.sourceContributions ?? []) {
    const sources = (side: typeof entry.baseline) =>
      side ? `${String(side.retainedSources)} / ${String(side.citedSources)}` : "unmeasured";
    const recovered = (side: typeof entry.baseline) =>
      side
        ? `${String(side.recoveredFacts)} / ${String(side.exclusiveRecoveredFacts)}`
        : "unmeasured";
    lines.push(
      `| ${entry.family} | ${sources(entry.baseline)} | ${sources(entry.candidate)} | ${baselineCreditMeasured ? recovered(entry.baseline) : "unmeasured"} | ${candidateCreditMeasured ? recovered(entry.candidate) : "unmeasured"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function escapeCell(value: string): string {
  /* The backslash pass runs first: a value carrying `\|` must render the
     backslash escaped before the pipe pass escapes the pipe, or markdown
     reads the pair as an escaped backslash plus a REAL column delimiter and
     splits the cell (issue #284). */
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300);
}
