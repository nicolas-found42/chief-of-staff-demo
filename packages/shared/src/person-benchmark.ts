import { z } from "zod";
import { PERSON_SOURCE_FAMILIES, type PersonSourceFamily } from "./person-research.js";

/**
 * The Person Research Benchmark (issue #228).
 *
 * A Benchmark Person is an independently researched reference for one public
 * person: dated facts, each anchored to a retained excerpt of a real dated
 * source, plus the conclusions that evidence does *not* justify. References
 * describe a strong research outcome, so a fact the application cannot
 * currently acquire stays in the reference and becomes a visible target.
 * Nothing here is generated from the application's own answers.
 */

/**
 * The twenty dossier depth requirements from issue #204, kept verbatim in
 * meaning so a benchmark fact can name the requirement it exercises and the
 * collection can be checked for coverage of all twenty.
 */
export const BENCHMARK_DOSSIER_REQUIREMENTS = {
  r1: "Personal contribution distinguished from team output",
  r2: "Sourced operating magnitudes with unit, scope and date",
  r3: "Claimed and demonstrated expertise in one taxonomy",
  r4: "Counterparties, relation type, shared work and dates",
  r5: "Documented constraint environments",
  r6: "Work followed after departure",
  r7: "Dated history of problem areas and focus",
  r8: "Writing and thinking separated from building",
  r9: "Independent verifiers and the exact assertion verified",
  r10: "Per-section freshness and explicit gaps",
  r11: "Deciding, recommending and executing distinguished",
  r12: "Unsuccessful work and postmortems",
  r13: "Repeated collaboration evidenced by distinct shared work",
  r14: "Third-party credit and acknowledgments",
  r15: "Dated governance, funding and advisory ties",
  r16: "Dated observed artifacts by kind",
  r17: "Individually dated domain crossings",
  r18: "Capability intersections reported with denominators",
  r19: "Documented availability constraints",
  r20: "Source composition and single-source dependency",
} as const;
export type BenchmarkDossierRequirement = keyof typeof BENCHMARK_DOSSIER_REQUIREMENTS;
export const BenchmarkDossierRequirementSchema = z.enum(
  Object.keys(BENCHMARK_DOSSIER_REQUIREMENTS) as [
    BenchmarkDossierRequirement,
    ...BenchmarkDossierRequirement[],
  ],
);

/** The industry groups the collection is deliberately balanced across. */
export const BENCHMARK_INDUSTRY_GROUPS = {
  healthcare: "Healthcare",
  education: "Education",
  finance: "Finance and professional services",
  manufacturing: "Manufacturing and logistics",
  construction: "Construction and property",
  retail: "Retail and hospitality",
  agriculture: "Agriculture and food",
  media: "Media and creative work",
  government: "Government and nonprofits",
  technology: "Technology and telecommunications",
} as const;
export type BenchmarkIndustryGroup = keyof typeof BENCHMARK_INDUSTRY_GROUPS;

/**
 * How the person's public evidence is shaped. Easy, richly documented cases
 * cannot conceal systematic failure, so the collection deliberately carries
 * the awkward shapes as their own labelled kind.
 */
export const BenchmarkFootprintSchema = z.enum([
  "rich",
  "ordinary",
  "sparse",
  "ambiguous",
  "social-first",
  "video-first",
  "records-first",
]);
export type BenchmarkFootprint = z.infer<typeof BenchmarkFootprintSchema>;

/**
 * Whether the application can plausibly acquire the fact's support today.
 * Authoring records the honest answer; the evaluator reports recovery split
 * both ways so a reference that exceeds current coverage drives work instead
 * of being quietly deleted to make a run look better.
 */
export const BenchmarkAcquisitionSchema = z.enum(["app-supported", "beyond-current-coverage"]);

/**
 * A retained excerpt of one real, dated source.
 *
 * The excerpt is what makes the reference judgeable without re-fetching the
 * web: fixed-document mode feeds these through the production reader, and the
 * deterministic integrity checks verify every reference quote occurs in one.
 */
export const BenchmarkReferenceDocumentSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  url: z.string().max(4000),
  title: z.string().min(1).max(500),
  publisher: z.string().max(300),
  /** The source's own publication date, when it states one. */
  publishedAt: z.string().max(40).nullable(),
  /** When this excerpt was retained. Immutable once a version is published. */
  retrievedAt: z.string().max(40),
  family: z.enum(
    Object.keys(PERSON_SOURCE_FAMILIES) as [PersonSourceFamily, ...PersonSourceFamily[]],
  ),
  sourceClass: z.enum(["self-report", "independent-account", "primary-artifact"]),
  language: z.string().max(20),
  /** SHA-256 of `excerpt`; a corrected excerpt is a new reference version. */
  hash: z.string().length(64),
  /** A bounded excerpt retained under quotation. Never a whole work. */
  excerpt: z.string().min(1).max(20000),
  /** Why retaining this excerpt is permitted. */
  rights: z.enum(["short-quotation", "public-record", "open-licence", "public-domain"]),
  note: z.string().max(1000).optional(),
});
export type BenchmarkReferenceDocument = z.infer<typeof BenchmarkReferenceDocumentSchema>;

/** One reference fact: what strong research should recover, and from where. */
export const BenchmarkReferenceFactSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  /** Which of the twenty dossier requirements this fact exercises. */
  requirements: z.array(BenchmarkDossierRequirementSchema).min(1).max(6),
  section: z.enum([
    "overview",
    "career",
    "work",
    "expertise",
    "ideas",
    "connections",
    "recognition",
    "context",
  ]),
  /** The fact itself, stated as a reader would want it. */
  statement: z.string().min(1).max(2000),
  /** Dates the fact holds for, where the source states them. */
  effectiveFrom: z.string().max(40).nullable(),
  effectiveTo: z.string().max(40).nullable(),
  /** Verbatim support. Every quote must occur in the named document. */
  support: z
    .array(z.object({ documentId: z.string().max(80), quote: z.string().min(8).max(4000) }))
    .min(1)
    .max(6),
  importance: z.enum(["core", "supporting"]),
  acquisition: BenchmarkAcquisitionSchema,
  /** Why this fact is beyond current coverage, when it is. */
  note: z.string().max(1000).optional(),
});
export type BenchmarkReferenceFact = z.infer<typeof BenchmarkReferenceFactSchema>;

/**
 * A conclusion the evidence does not justify. A dossier asserting one of these
 * is an overclaim, not a bonus: the evaluator counts it against factual
 * reliability rather than rewarding the extra volume.
 */
export const BenchmarkUnjustifiedConclusionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  statement: z.string().min(1).max(2000),
  /** Why the available evidence does not establish it. */
  why: z.string().min(1).max(2000),
  kind: z.enum([
    "scope-inflation",
    "wrong-person",
    "unsupported-inference",
    "stale-as-current",
    "team-output-as-personal",
  ]),
});
export type BenchmarkUnjustifiedConclusion = z.infer<typeof BenchmarkUnjustifiedConclusionSchema>;

/**
 * What live research is allowed to see. Realistic lookup inputs only: the
 * reference facts, the expected source list and the evaluator's judgments are
 * never visible to the pipeline under test.
 */
export const BenchmarkLookupSchema = z.object({
  fullName: z.string().min(1).max(200),
  employerHint: z.string().max(200).nullable(),
  profileUrls: z.array(z.string().max(4000)).max(4),
  emails: z.array(z.string().max(320)).max(2),
});
export type BenchmarkLookup = z.infer<typeof BenchmarkLookupSchema>;

export const BenchmarkPersonSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
  /** Immutable version of this reference; a corrected fact bumps it. */
  referenceVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
  displayName: z.string().min(1).max(200),
  industry: z.enum(
    Object.keys(BENCHMARK_INDUSTRY_GROUPS) as [BenchmarkIndustryGroup, ...BenchmarkIndustryGroup[]],
  ),
  role: z.string().min(1).max(200),
  region: z.string().min(1).max(120),
  /** BCP-47-ish primary language of the person's public evidence. */
  language: z.string().min(2).max(20),
  footprint: BenchmarkFootprintSchema,
  /** True only for the fictional adversarial fixtures, which say so loudly. */
  fictional: z.boolean().default(false),
  lookup: BenchmarkLookupSchema,
  /** What establishes that a document is about this person and not a namesake. */
  identityAnchors: z.array(z.string().min(1).max(1000)).min(1).max(12),
  /** Namesakes and near-matches whose achievements must not be absorbed. */
  confusableWith: z.array(z.string().min(1).max(500)).max(10).default([]),
  documents: z.array(BenchmarkReferenceDocumentSchema).min(1).max(40),
  facts: z.array(BenchmarkReferenceFactSchema).min(1).max(120),
  unjustified: z.array(BenchmarkUnjustifiedConclusionSchema).max(20).default([]),
  /**
   * Dimensions honestly unavailable for this person. Authoring records them
   * rather than manufacturing a fact to fill the requirement checklist.
   */
  unavailable: z
    .array(
      z.object({
        requirement: BenchmarkDossierRequirementSchema,
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(20)
    .default([]),
  /** Corrections traced to their evidence, newest last. */
  corrections: z
    .array(
      z.object({
        at: z.string().max(40),
        referenceVersion: z.string().max(40),
        change: z.string().min(1).max(2000),
        evidence: z.string().min(1).max(2000),
      }),
    )
    .max(40)
    .default([]),
});
export type BenchmarkPerson = z.infer<typeof BenchmarkPersonSchema>;

/* ------------------------------------------------------------------ */
/* Evaluation results                                                   */
/* ------------------------------------------------------------------ */

export const BenchmarkModeSchema = z.enum(["live-discovery", "fixed-documents"]);
export type BenchmarkMode = z.infer<typeof BenchmarkModeSchema>;

/**
 * A deterministic integrity finding. These cannot be overridden by the judge:
 * a citation that does not occur in its retained source version is a broken
 * record whatever a model thinks of the sentence it supports.
 */
export const BenchmarkIntegrityFindingSchema = z.object({
  check: z.enum([
    "citation-quote-present",
    "citation-source-retained",
    "citation-source-version",
    "claim-status-supported",
    "work-claim-reference",
    "private-evidence-isolation",
    "reference-quote-present",
  ]),
  severity: z.enum(["critical", "major", "minor"]),
  subject: z.string().max(500),
  detail: z.string().max(2000),
});
export type BenchmarkIntegrityFinding = z.infer<typeof BenchmarkIntegrityFindingSchema>;

/**
 * One semantic judgment about one reference fact, always carrying the
 * reference text and the evaluated evidence it rests on. `ambiguous` is a
 * first-class verdict: an uncertain model decision is surfaced for review
 * rather than rounded into a pass or a fail.
 */
export const BenchmarkJudgementSchema = z.object({
  factId: z.string().max(80),
  verdict: z.enum(["recovered", "partial", "missing", "contradicted", "ambiguous"]),
  /** The reference quote the judgment was made against. */
  referenceQuote: z.string().max(4000),
  /** The dossier text the judge matched, when it found one. */
  evidenceQuote: z.string().max(4000).nullable(),
  /** The dossier claim the evidence came from, when one applies. */
  claimId: z.string().max(200).nullable(),
  rationale: z.string().max(2000),
  reviewRequired: z.boolean(),
});
export type BenchmarkJudgement = z.infer<typeof BenchmarkJudgementSchema>;

/** A dossier statement the judge found unsupported by its own citations. */
export const BenchmarkOverclaimSchema = z.object({
  claimId: z.string().max(200),
  statement: z.string().max(2000),
  kind: z.enum([
    "scope-inflation",
    "wrong-person",
    "unsupported-inference",
    "stale-as-current",
    "team-output-as-personal",
    "invented-evidence",
  ]),
  citedQuote: z.string().max(4000).nullable(),
  rationale: z.string().max(2000),
  /** Set when this matches a reference's recorded unjustified conclusion. */
  matchedUnjustifiedId: z.string().max(80).nullable(),
  reviewRequired: z.boolean(),
});
export type BenchmarkOverclaim = z.infer<typeof BenchmarkOverclaimSchema>;

/**
 * The four measured families, kept separate on purpose: there is no overall
 * score, so a large but unreliable dossier cannot average its way to a pass.
 */
export const BenchmarkPersonResultSchema = z.object({
  slug: z.string().max(80),
  referenceVersion: z.string().max(40),
  mode: BenchmarkModeSchema,
  /** Set when this person's evaluation could not be completed. */
  failure: z.string().max(2000).nullable(),
  factualReliability: z.object({
    /** Claims whose citations verify against their retained source version. */
    verifiedCitations: z.number().int().nonnegative(),
    totalCitations: z.number().int().nonnegative(),
    integrityFindings: z.array(BenchmarkIntegrityFindingSchema).max(200),
    criticalFindings: z.number().int().nonnegative(),
    overclaims: z.array(BenchmarkOverclaimSchema).max(100),
    wrongPersonAttributions: z.number().int().nonnegative(),
    contradictedFacts: z.number().int().nonnegative(),
  }),
  completeness: z.object({
    referenceFacts: z.number().int().nonnegative(),
    recovered: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    /** Split by whether the app can plausibly acquire the support today. */
    byAcquisition: z.record(
      z.string().max(40),
      z.object({
        total: z.number().int().nonnegative(),
        recovered: z.number().int().nonnegative(),
      }),
    ),
    byRequirement: z.record(
      z.string().max(10),
      z.object({
        total: z.number().int().nonnegative(),
        recovered: z.number().int().nonnegative(),
      }),
    ),
    judgements: z.array(BenchmarkJudgementSchema).max(200),
  }),
  /** Absolute volume, reported next to completeness rather than folded in. */
  richness: z.object({
    claims: z.number().int().nonnegative(),
    works: z.number().int().nonnegative(),
    expertise: z.number().int().nonnegative(),
    connections: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    distinctFamilies: z.number().int().nonnegative(),
    /** Distinct upstream indexes behind those sources, where known. */
    distinctUpstreamIndexes: z.number().int().nonnegative(),
    sectionsWithGroundedSummary: z.number().int().nonnegative(),
  }),
  usefulness: z.object({
    /** 0–3 each, judged with cited evidence. Never summed with the rest. */
    understanding: z.number().int().min(0).max(3),
    remainingQuestions: z.number().int().min(0).max(3),
    conversationReadiness: z.number().int().min(0).max(3),
    rationale: z.string().max(4000),
    reviewRequired: z.boolean(),
  }),
  operational: z.object({
    conclusion: z.enum(["completed", "interrupted", "bounded"]),
    rounds: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    sourcesRetained: z.number().int().nonnegative(),
    leadsInvestigated: z.number().int().nonnegative(),
    leadsUnresolved: z.number().int().nonnegative(),
    failuresByCode: z.record(z.string().max(60), z.number().int().nonnegative()),
    coverageGaps: z.array(z.string().max(1000)).max(60),
    elapsedMilliseconds: z.number().nonnegative(),
  }),
});
export type BenchmarkPersonResult = z.infer<typeof BenchmarkPersonResultSchema>;

/**
 * Everything needed to attribute a change to the research change under test.
 * Absent measurements stay absent — an invented token count would defeat the
 * purpose of recording usage at all.
 */
export const BenchmarkProvenanceSchema = z.object({
  corpusVersion: z.string().max(80),
  referenceVersions: z.record(z.string().max(80), z.string().max(40)),
  pipeline: z.enum(["incumbent", "expanded"]),
  researchProvider: z.string().max(80),
  researchModel: z.string().max(200),
  judgeProvider: z.string().max(80),
  judgeModel: z.string().max(200),
  judgeVersion: z.string().max(40),
  promptVersion: z.string().max(40),
  collectorVersions: z.record(z.string().max(120), z.string().max(40)),
  researchSettings: z.record(z.string().max(80), z.union([z.string(), z.number(), z.boolean()])),
  network: z.enum(["live", "fixed-documents", "offline"]),
  /** Only present when the model boundary actually reported usage. */
  usage: z
    .object({
      inputCharacters: z.number().int().nonnegative(),
      outputCharacters: z.number().int().nonnegative(),
      tokens: z.literal("unavailable"),
      cost: z.literal("unavailable"),
    })
    .optional(),
  startedAt: z.string().max(40),
  finishedAt: z.string().max(40),
  host: z.string().max(200),
});
export type BenchmarkProvenance = z.infer<typeof BenchmarkProvenanceSchema>;

/** Aggregation over a labelled slice of the collection, with denominators. */
export const BenchmarkGroupSummarySchema = z.object({
  dimension: z.enum(["industry", "role", "footprint", "language", "region", "source-family"]),
  key: z.string().max(120),
  people: z.number().int().nonnegative(),
  referenceFacts: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  criticalFindings: z.number().int().nonnegative(),
  overclaims: z.number().int().nonnegative(),
});
export type BenchmarkGroupSummary = z.infer<typeof BenchmarkGroupSummarySchema>;

export const BenchmarkReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().max(80),
  /** A run that failed or was interrupted says so; it never reports stale output. */
  status: z.enum(["completed", "failed", "interrupted"]),
  statusDetail: z.string().max(2000),
  mode: BenchmarkModeSchema,
  selection: z.object({
    requested: z.array(z.string().max(80)).max(200),
    evaluated: z.array(z.string().max(80)).max(200),
    skipped: z.array(z.object({ slug: z.string().max(80), reason: z.string().max(500) })).max(200),
  }),
  provenance: BenchmarkProvenanceSchema,
  people: z.array(BenchmarkPersonResultSchema).max(200),
  groups: z.array(BenchmarkGroupSummarySchema).max(400),
  /** Reference facts nobody recovered: the concrete follow-up target list. */
  remainingMisses: z
    .array(
      z.object({
        slug: z.string().max(80),
        factId: z.string().max(80),
        statement: z.string().max(2000),
        acquisition: BenchmarkAcquisitionSchema,
        requirements: z.array(BenchmarkDossierRequirementSchema).max(6),
        explanation: z.string().max(2000),
      }),
    )
    .max(2000),
});
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;

/** Two reports compared under a fixed reference and judge configuration. */
export const BenchmarkComparisonSchema = z.object({
  schemaVersion: z.literal(1),
  baselineRunId: z.string().max(80),
  candidateRunId: z.string().max(80),
  /** Conditions that differed between the runs; empty means comparable. */
  conditionChanges: z.array(z.string().max(1000)).max(40),
  comparable: z.boolean(),
  totals: z.object({
    referenceFacts: z.number().int().nonnegative(),
    baselineRecovered: z.number().int().nonnegative(),
    candidateRecovered: z.number().int().nonnegative(),
    baselineCriticalFindings: z.number().int().nonnegative(),
    candidateCriticalFindings: z.number().int().nonnegative(),
    baselineOverclaims: z.number().int().nonnegative(),
    candidateOverclaims: z.number().int().nonnegative(),
  }),
  perPerson: z
    .array(
      z.object({
        slug: z.string().max(80),
        referenceFacts: z.number().int().nonnegative(),
        baselineRecovered: z.number().int().nonnegative(),
        candidateRecovered: z.number().int().nonnegative(),
        newCriticalFindings: z.number().int().nonnegative(),
        newOverclaims: z.number().int().nonnegative(),
      }),
    )
    .max(200),
  /** The acceptance question: more recovery, no new critical failures. */
  verdict: z.enum(["improved", "regressed", "unchanged", "not-comparable"]),
  verdictDetail: z.string().max(2000),
});
export type BenchmarkComparison = z.infer<typeof BenchmarkComparisonSchema>;
