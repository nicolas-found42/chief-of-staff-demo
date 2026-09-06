import { createHash } from "node:crypto";
import {
  BENCHMARK_DOSSIER_REQUIREMENTS,
  type BenchmarkMode,
  type BenchmarkPerson,
  type BenchmarkPersonResult,
  type PersonProfile,
  type PersonResearchOperationOutcome,
} from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../llm/providers.js";
import type { PublicSearch, PublicSearchResult } from "../source-adapters/search.js";
import type { BrowserRenderer } from "../source-adapters/browser.js";
import {
  composePersonProfiles,
  type PersonProfilesComposition,
} from "../person-profile/composition.js";
import type { readPersonSource } from "../person-profile/research-readers.js";
import { isolatedLookup } from "./corpus.js";
import { checkIntegrity, criticalCount } from "./integrity.js";
import { judgePerson } from "./judge.js";

/**
 * What the evaluator needs to run one Benchmark Person through production.
 *
 * There is deliberately no research implementation here: the evaluator builds
 * the ordinary Person Profiles composition over an isolated Workspace and asks
 * it for an operation. Everything it measures is what the product actually
 * did (#228: "the evaluator must not maintain a second discovery, attribution,
 * extraction or dossier-synthesis implementation").
 */
export interface EvaluationPorts {
  /** A temporary directory. Never a live Workspace. */
  workspaceDir: string;
  search: PublicSearch;
  complete: () => CompleteJson;
  plan?: () => CompleteJson;
  /** The separately configured semantic judge. */
  judge: CompleteJson;
  render?: BrowserRenderer;
  /** Seed and reader overrides, used to reconstruct the incumbent pipeline. */
  seeds?: (profile: PersonProfile) => string[];
  readSource?: typeof readPersonSource;
  /** Bounds handed to the operation, recorded in the report's provenance. */
  settings?: { profileCalls?: number; profileMilliseconds?: number; readConcurrency?: number };
}

/**
 * Fixed-document mode.
 *
 * Discovery is replaced by the person's own retained reference excerpts, and
 * reading returns those excerpts verbatim at their real URLs. Everything after
 * the read — identity matching, extraction, attribution, publication — is the
 * production path, so a gap here is a downstream failure rather than a search
 * failure. The reference *facts* are never exposed: only the documents.
 */
function fixedDocumentPorts(person: BenchmarkPerson): {
  search: PublicSearch;
  readSource: typeof readPersonSource;
} {
  const documents = person.documents;
  const search: PublicSearch = async (query) => {
    const words = query
      .replace(/["']/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2);
    const results: PublicSearchResult[] = documents
      .filter((document) => {
        const haystack = `${document.title} ${document.excerpt}`.toLowerCase();
        return words.length === 0 || words.some((word) => haystack.includes(word));
      })
      .map((document) => ({
        url: document.url,
        title: document.title,
        snippet: document.excerpt.slice(0, 400),
      }));
    return results;
  };
  const readSource: typeof readPersonSource = async (url, snippet) => {
    const document = documents.find((entry) => entry.url === url);
    if (!document)
      return {
        text: snippet,
        completeness: "unavailable",
        access: "failed",
        outboundUrls: [],
        family: "documents-publishers",
        route: "fixed-document",
        upstreamIndex: null,
        publishedAt: null,
        author: null,
        anchors: [],
        provenanceNote: "Not part of this person's retained reference corpus.",
        finalUrl: url,
      };
    return {
      text: document.excerpt,
      completeness: "partial",
      access: "retrieved",
      outboundUrls: [],
      family: document.family,
      route: "fixed-document",
      upstreamIndex: document.publisher,
      publishedAt: document.publishedAt,
      author: null,
      anchors: [],
      provenanceNote: `Retained reference excerpt of ${document.url}, ${document.rights}.`,
      finalUrl: document.url,
    };
  };
  return { search, readSource };
}

export interface PersonEvaluation {
  result: BenchmarkPersonResult;
  /** The operation record behind the result, for the failure breakdown. */
  operation: PersonResearchOperationOutcome | null;
}

/**
 * Evaluate one Benchmark Person.
 *
 * The order matters: research runs first with no access to the reference, then
 * the deterministic integrity checks run over what it produced, and only then
 * does the judge see anything. A failed integrity check is recorded whatever
 * the judge later says about the same claim.
 */
export async function evaluatePerson(
  person: BenchmarkPerson,
  mode: BenchmarkMode,
  ports: EvaluationPorts,
): Promise<PersonEvaluation> {
  const startedAt = Date.now();
  const fixed = mode === "fixed-documents" ? fixedDocumentPorts(person) : null;
  const people: PersonProfilesComposition = composePersonProfiles({
    workspaceDir: ports.workspaceDir,
    search: fixed?.search ?? ports.search,
    complete: ports.complete,
    ...(ports.plan ? { plan: ports.plan } : {}),
    ...(ports.render && !fixed ? { render: ports.render } : {}),
    /* One seam, two uses: fixed-document mode replaces retrieval with the
       retained excerpts, and the incumbent baseline replaces it with the two
       readers that pipeline had. Everything downstream stays production. */
    researchTestPorts: {
      ...(fixed
        ? { readSource: fixed.readSource }
        : ports.readSource
          ? { readSource: ports.readSource }
          : {}),
      ...(ports.seeds ? { seeds: ports.seeds } : {}),
    },
    confirmedTranscripts: () => [],
    transcriptStillConfirmed: () => false,
    researchEnabled: () => true,
  });
  people.queue.configure({
    paused: false,
    concurrency: 1,
    ...(ports.settings?.profileCalls !== undefined
      ? { profileCalls: ports.settings.profileCalls }
      : {}),
    ...(ports.settings?.profileMilliseconds !== undefined
      ? { profileMilliseconds: ports.settings.profileMilliseconds }
      : {}),
    ...(ports.settings?.readConcurrency !== undefined
      ? { readConcurrency: ports.settings.readConcurrency }
      : {}),
  });

  let failure: string | null = null;
  let operation: PersonResearchOperationOutcome | null = null;
  const profile = people.research.startFor(isolatedLookup(person));
  try {
    operation = await people.research.runNow(profile.id);
  } catch (error) {
    failure = `Research failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }

  if (!operation || operation.conclusion !== "completed")
    failure ??= `Research ${operation?.conclusion ?? "interrupted"} before the operation completed.`;

  const dossier = people.research.dossier(profile.id, "private");
  const sources = people.research.sources(profile.id);
  const integrity = checkIntegrity(dossier, sources, people.research.dossier(profile.id, "public"));

  let judged;
  try {
    judged = await judgePerson(ports.judge, person, dossier, sources);
  } catch (error) {
    failure ??= `Judge failed: ${error instanceof Error ? error.message : "unknown error"}`;
    judged = {
      judgements: person.facts.map((fact) => ({
        factId: fact.id,
        verdict: "ambiguous" as const,
        referenceQuote: fact.support[0]?.quote ?? fact.statement,
        evidenceQuote: null,
        claimId: null,
        rationale: "The judge did not return a usable verdict for this run.",
        reviewRequired: true,
      })),
      overclaims: [],
      usefulness: {
        understanding: 0,
        remainingQuestions: 0,
        conversationReadiness: 0,
        rationale: "Not assessed: the judge failed for this person.",
        reviewRequired: true,
      },
    };
  }

  const verdicts = judged.judgements;
  const counted = (verdict: string) =>
    verdicts.filter((judgement) => judgement.verdict === verdict).length;
  const recoveredIds = new Set(
    verdicts.filter((judgement) => judgement.verdict === "recovered").map((j) => j.factId),
  );

  const byAcquisition: BenchmarkPersonResult["completeness"]["byAcquisition"] = {};
  for (const fact of person.facts) {
    const bucket = (byAcquisition[fact.acquisition] ??= { total: 0, recovered: 0 });
    bucket.total += 1;
    if (recoveredIds.has(fact.id)) bucket.recovered += 1;
  }
  const byRequirement: BenchmarkPersonResult["completeness"]["byRequirement"] = {};
  for (const fact of person.facts)
    for (const requirement of fact.requirements) {
      const bucket = (byRequirement[requirement] ??= { total: 0, recovered: 0 });
      bucket.total += 1;
      if (recoveredIds.has(fact.id)) bucket.recovered += 1;
    }

  const failuresByCode: Record<string, number> = {};
  for (const attempt of operation?.attempts ?? [])
    if (attempt.outcome === "failed")
      failuresByCode[attempt.code] = (failuresByCode[attempt.code] ?? 0) + 1;

  const result: BenchmarkPersonResult = {
    slug: person.slug,
    referenceVersion: person.referenceVersion,
    mode,
    failure,
    factualReliability: {
      verifiedCitations: integrity.verifiedCitations,
      totalCitations: integrity.totalCitations,
      integrityFindings: integrity.findings.slice(0, 200),
      criticalFindings: criticalCount(integrity.findings),
      overclaims: judged.overclaims,
      wrongPersonAttributions: judged.overclaims.filter((entry) => entry.kind === "wrong-person")
        .length,
      contradictedFacts: counted("contradicted"),
    },
    completeness: {
      referenceFacts: person.facts.length,
      recovered: counted("recovered"),
      partial: counted("partial"),
      missing: counted("missing"),
      ambiguous: counted("ambiguous"),
      byAcquisition,
      byRequirement,
      judgements: verdicts,
    },
    richness: {
      claims: dossier?.claims.length ?? 0,
      works: dossier?.works.length ?? 0,
      expertise: dossier?.expertise.length ?? 0,
      connections: dossier?.connections.length ?? 0,
      sources: sources.length,
      distinctFamilies: new Set(sources.map((source) => source.evidenceFamily ?? "unclassified"))
        .size,
      /* Independence is counted from the upstream index, not the hostname:
         several wrappers over one index are one piece of evidence. */
      distinctUpstreamIndexes: new Set(
        sources.map((source) => source.upstreamIndex ?? source.family),
      ).size,
      sectionsWithGroundedSummary: (dossier?.sections ?? []).filter(
        (section) => section.claimIds.length > 0,
      ).length,
    },
    usefulness: judged.usefulness,
    operational: {
      conclusion: operation?.conclusion ?? "interrupted",
      rounds: operation?.rounds ?? 0,
      requests: operation?.requests ?? 0,
      modelCalls: operation?.modelCalls ?? 0,
      sourcesRetained: operation?.sourcesRetained ?? 0,
      leadsInvestigated: (operation?.leads ?? []).filter(
        (lead) => lead.disposition === "investigated",
      ).length,
      leadsUnresolved: (operation?.leads ?? []).filter(
        (lead) => lead.disposition === "pending" || lead.disposition === "interrupted",
      ).length,
      failuresByCode,
      coverageGaps: operation?.gaps ?? [],
      elapsedMilliseconds: Date.now() - startedAt,
    },
  };
  return { result, operation };
}

/** A stable run identity from what the run was actually over. */
export function runId(corpusVersion: string, mode: BenchmarkMode, startedAt: string): string {
  return createHash("sha256")
    .update(`${corpusVersion}:${mode}:${startedAt}`)
    .digest("hex")
    .slice(0, 16);
}

/** The requirement label, for reports that name a requirement by its id. */
export function requirementLabel(requirement: string): string {
  return (
    (BENCHMARK_DOSSIER_REQUIREMENTS as Partial<Record<string, string>>)[requirement] ?? requirement
  );
}
