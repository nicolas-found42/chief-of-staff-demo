import type {
  ModelTimelineEntry,
  PersonResearchOperationOutcome,
} from "@chief-of-staff-demo/shared";
import { CLAIM_EXTRACTION_CALL_SITE } from "../person-profile/claims.js";
import { EXTRACTION_CALL_SITE } from "../person-profile/research.js";
import { PLANNING_CALL_SITE } from "../person-profile/research-plan.js";

/**
 * The call sites a Person Profile research operation's cost is accounted
 * against (issue #381): dossier extraction, claim extraction and planning.
 *
 * An allowlist rather than a filter over whatever `callSite` a record carries:
 * a call the production path cannot place — an evaluation, a judge, a
 * neighbouring purpose sharing the same model — must stay out of the
 * production totals, or a research operation's bill reads higher than what
 * researching cost.
 */
export const PERSON_PROFILE_CALL_SITES = [
  EXTRACTION_CALL_SITE,
  CLAIM_EXTRACTION_CALL_SITE,
  PLANNING_CALL_SITE,
] as const;

/**
 * Calls and dollars by call site with the exact-repeat estimate (issue #381,
 * Step 0).
 *
 * `exactRepeatCalls` is the reuse opportunity the spec names: entries whose
 * `requestFingerprint` an earlier completed entry in the same group already
 * asked, i.e. repeated exact requests an earlier validated success could have
 * served. A repeat whose predecessors all failed has no validated success to
 * reuse and is a retry, not a candidate; entries without a fingerprint cannot
 * be compared at all.
 */
export interface CallSiteCostSummary {
  callSite: string;
  purpose: string | undefined;
  calls: number;
  dollars: number;
  totalTokens: number;
  exactRepeatCalls: number;
}

/**
 * Summarizes the production call sites only: entries with no call site, or one
 * outside the allowlist, are dropped from every group and every total, because
 * the three-site baseline must not absorb evaluation or neighbouring-purpose
 * charges.
 */
export function summarizeCallSites(
  entries: ModelTimelineEntry[],
  callSites: readonly string[] = PERSON_PROFILE_CALL_SITES,
): CallSiteCostSummary[] {
  const allowed = new Set(callSites);
  const groups = new Map<string, ModelTimelineEntry[]>();
  for (const entry of entries) {
    const callSite = entry.callSite;
    if (callSite === undefined || !allowed.has(callSite)) continue;
    const group = groups.get(callSite);
    if (group === undefined) groups.set(callSite, [entry]);
    else group.push(entry);
  }

  const summaries: CallSiteCostSummary[] = [];
  for (const [callSite, group] of groups) {
    const ordered = [...group].sort((a, b) =>
      a.admittedAt < b.admittedAt ? -1 : a.admittedAt > b.admittedAt ? 1 : 0,
    );
    let dollars = 0;
    let totalTokens = 0;
    let exactRepeatCalls = 0;
    const validatedFingerprints = new Set<string>();
    for (const entry of ordered) {
      dollars += entry.cost.dollars;
      totalTokens += entry.tokens.totalTokens;
      const fingerprint = entry.requestFingerprint;
      if (fingerprint === undefined) continue;
      if (validatedFingerprints.has(fingerprint)) exactRepeatCalls += 1;
      if (entry.outcome === "completed") validatedFingerprints.add(fingerprint);
    }
    summaries.push({
      callSite,
      purpose: ordered[0]?.purpose,
      calls: ordered.length,
      dollars,
      totalTokens,
      exactRepeatCalls,
    });
  }

  return summaries.sort((a, b) => (a.callSite < b.callSite ? -1 : 1));
}

/**
 * Critical-path time separated from summed service time (issue #381, Step 0).
 *
 * `summedServiceMs` is what every model call cost the provider in total;
 * `criticalPathMs` is the wall-clock span actually spent in model service.
 * Concurrent calls make the critical path shorter than the sum, and a baseline
 * that reported only the sum could not tell a wall-clock bound from a bill.
 */
export interface CriticalPathSummary {
  summedServiceMs: number;
  criticalPathMs: number;
  entryCount: number;
}

/**
 * Merges each entry's half-open `[admittedAt, settledAt)` interval and sums
 * the union. An entry whose timestamps do not parse, or whose settle precedes
 * its admission, still contributes its `durationMs` to the sum but no span:
 * a malformed clock reading is not evidence the service never ran.
 */
export function summarizeCriticalPath(entries: ModelTimelineEntry[]): CriticalPathSummary {
  let summedServiceMs = 0;
  const intervals: [start: number, end: number][] = [];
  for (const entry of entries) {
    summedServiceMs += entry.durationMs;
    const start = Date.parse(entry.admittedAt);
    const end = Date.parse(entry.settledAt);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);

  let criticalPathMs = 0;
  let unionStart: number | null = null;
  let unionEnd = 0;
  for (const [start, end] of intervals) {
    if (unionStart === null) {
      unionStart = start;
      unionEnd = end;
    } else if (start <= unionEnd) {
      if (end > unionEnd) unionEnd = end;
    } else {
      criticalPathMs += unionEnd - unionStart;
      unionStart = start;
      unionEnd = end;
    }
  }
  if (unionStart !== null) criticalPathMs += unionEnd - unionStart;

  return { summedServiceMs, criticalPathMs, entryCount: entries.length };
}

/**
 * Cost paired with what the operation actually produced (issue #381, Step 0):
 * published claims, first publication time, and the conclusion that ended it.
 *
 * The pair is the point — a cheaper run that researched less publishes later
 * and less, and read alone it would look like the better run. `totalDollars`
 * covers every entry, not just the production call sites: the operation's
 * model spend is not only what its three sites spent.
 */
export interface UsefulOutputSummary {
  conclusion: string;
  claimsPublished: number;
  modelCalls: number;
  modelCallsReused: number;
  totalDollars: number;
  firstPublishedAt: string | null;
  dollarsPerPublishedClaim: number | null;
}

/**
 * Pairs the outcome with the entry spend. `dollarsPerPublishedClaim` is null
 * when nothing was published — an operation that produced no claims has no
 * per-claim cost to divide, and reporting `Infinity` or `0` would read as
 * cheap rather than empty.
 */
export function summarizeUsefulOutput(
  outcome: PersonResearchOperationOutcome,
  entries: ModelTimelineEntry[],
): UsefulOutputSummary {
  let totalDollars = 0;
  for (const entry of entries) totalDollars += entry.cost.dollars;

  return {
    conclusion: outcome.conclusion,
    claimsPublished: outcome.claimsPublished,
    modelCalls: outcome.modelCalls,
    modelCallsReused: outcome.modelCallsReused ?? 0,
    totalDollars,
    firstPublishedAt: outcome.firstPublishedAt ?? null,
    dollarsPerPublishedClaim:
      outcome.claimsPublished > 0 ? totalDollars / outcome.claimsPublished : null,
  };
}

/**
 * The three Step 0 decision summaries of issue #381 in one report, all three
 * scoped to the production Person Profile call sites: "keep evaluation and
 * neighbouring-purpose charges out of the production three-site totals"
 * applies to the whole report, not only the by-call-site breakdown, so a
 * judge run sharing an operation id never inflates the critical path or the
 * useful-output dollar figure it is meant to be judged against.
 */
export interface PersonProfileCostSummary {
  byCallSite: CallSiteCostSummary[];
  criticalPath: CriticalPathSummary;
  usefulOutput: UsefulOutputSummary;
}

export function buildPersonProfileCostSummary(
  entries: ModelTimelineEntry[],
  outcome: PersonResearchOperationOutcome,
  callSites: readonly string[] = PERSON_PROFILE_CALL_SITES,
): PersonProfileCostSummary {
  const production = entries.filter(
    (entry) => entry.callSite !== undefined && callSites.includes(entry.callSite),
  );
  return {
    byCallSite: summarizeCallSites(production, callSites),
    criticalPath: summarizeCriticalPath(production),
    usefulOutput: summarizeUsefulOutput(outcome, production),
  };
}
