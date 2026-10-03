import { createHash } from "node:crypto";
import type {
  BrandProfileRevision,
  OpportunityEarlyFollowUp,
  RankedOpportunity,
  SourceAdapterState,
  SourceItem,
  SourceStoryGroup,
  SourceTarget,
} from "@chief-of-staff-demo/shared";
import {
  GROUPING_PAIR_BUDGET,
  GROUPING_QUESTION_REVISION,
  applyPairVerdicts,
  candidatePairs,
  sameStoryVerdict,
  type StoryGroupingAudit,
  type StoryPairJudger,
} from "./grouping-model.js";

const ELIGIBILITY_WINDOW_MS = 7 * 86_400_000;

type EligibilityExclusionReason =
  | "exact_duplicate"
  | "stale"
  | "archived_target"
  | "prohibited_subject"
  | "inaccessible_evidence"
  | "unsupported_claim";

export interface EligibilityResult {
  items: SourceItem[];
  storyGroups: SourceStoryGroup[];
  exclusions: { sourceItemId: string; reason: EligibilityExclusionReason }[];
}

export interface StoryGroupingOutcome {
  groups: SourceStoryGroup[];
  audit: StoryGroupingAudit;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function prohibitedPhrases(markdown: string): string[] {
  return ["Avoided subjects", "Prohibited claims"].flatMap((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const section = new RegExp(`##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i").exec(
      markdown,
    )?.[1];
    return (section?.match(/^\s*[-*]\s+(.+)$/gm) ?? [])
      .map((line) =>
        line
          .replace(/^\s*[-*]\s+/, "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  });
}

function evidenceText(item: SourceItem): string {
  return [item.title, item.body, item.description, item.transcript]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function accessible(item: SourceItem): boolean {
  try {
    const url = new URL(item.canonicalUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  } catch {
    return false;
  }
  const hasAvailableText = (["title", "body", "description", "transcript"] as const).some(
    (field) => item.completeness[field] === "available",
  );
  return hasAvailableText && evidenceText(item).length >= 20 && item.evidence.length > 0;
}

function storyTokens(item: SourceItem): string[] {
  const source = item.title ?? item.description ?? item.body ?? item.canonicalUrl;
  return [
    ...new Set(
      source
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2 && !/^\d+$/.test(token) && !STOP_WORDS.has(token)),
    ),
  ].sort();
}

const STOP_WORDS = new Set(["the", "and", "for", "from", "with", "that", "this", "what", "into"]);

function storySeed(item: SourceItem): string {
  return item.storyKey?.trim().toLowerCase() || storyTokens(item).slice(0, 16).join("-");
}

/** Deterministic group seed (#502): adapter storyKeys when every member has
 *  one, else the sorted identity seeds of all members. A pure function of
 *  membership, so the same items produce the same canonical key regardless of
 *  collection order. */
function groupSeed(groupItems: SourceItem[]): string {
  const keyed = groupItems.filter((item) => item.storyKey?.trim());
  if (keyed.length === groupItems.length && keyed.length > 0) {
    return [...new Set(keyed.map((item) => item.storyKey!.trim().toLowerCase()))].sort().join("|");
  }
  return groupItems
    .map((item) => item.storyKey?.trim().toLowerCase() || storySeed(item))
    .sort()
    .join("|");
}

function hasUnsupportedClaim(item: SourceItem): boolean {
  if (item.claims?.some((claim) => claim.state === "unsupported")) return true;
  return /\b(?:guarantees?|guaranteed|risk[- ]free|will definitely|always profitable|never fails?)\b/i.test(
    evidenceText(item),
  );
}

export function determineEligibility(input: {
  items: SourceItem[];
  targets: SourceTarget[];
  brandProfile: BrandProfileRevision;
  now: Date;
}): EligibilityResult {
  const activeTargets = new Set(
    input.targets.filter((target) => target.state === "active").map((target) => target.id),
  );
  const prohibited = prohibitedPhrases(input.brandProfile.markdown);
  const cutoff = input.now.getTime() - ELIGIBILITY_WINDOW_MS;
  const externalIds = new Set<string>();
  const canonicalUrls = new Set<string>();
  const items: SourceItem[] = [];
  const exclusions: EligibilityResult["exclusions"] = [];

  for (const item of input.items) {
    const exclude = (reason: EligibilityExclusionReason) =>
      exclusions.push({ sourceItemId: item.id, reason });
    const externalKey = `${item.adapterId}:${item.externalId}`;
    if (externalIds.has(externalKey) || canonicalUrls.has(item.canonicalUrl)) {
      exclude("exact_duplicate");
      continue;
    }
    externalIds.add(externalKey);
    canonicalUrls.add(item.canonicalUrl);
    const observedAt = Date.parse(item.publishedAt ?? item.discoveredAt);
    if (!Number.isFinite(observedAt) || observedAt < cutoff) {
      exclude("stale");
      continue;
    }
    if (!activeTargets.has(item.targetId)) {
      exclude("archived_target");
      continue;
    }
    const normalized = evidenceText(item).toLowerCase();
    if (prohibited.some((phrase) => normalized.includes(phrase))) {
      exclude("prohibited_subject");
      continue;
    }
    if (!accessible(item)) {
      exclude("inaccessible_evidence");
      continue;
    }
    if (hasUnsupportedClaim(item)) {
      exclude("unsupported_claim");
      continue;
    }
    items.push(item);
  }

  /* Deterministic fallback grouping without a semantic judger (#502): items
     with a matching adapter storyKey join that group; everything else stays a
     singleton, so identity never depends on collection order. */
  const keyedGroups = new Map<string, SourceItem[]>();
  const unkeyedItems: SourceItem[] = [];
  for (const item of items) {
    const key = item.storyKey?.trim().toLowerCase();
    if (key) {
      const group = keyedGroups.get(key) ?? [];
      group.push(item);
      keyedGroups.set(key, group);
    } else {
      unkeyedItems.push(item);
    }
  }
  const groupedItems: SourceItem[][] = [
    ...keyedGroups.values(),
    ...unkeyedItems.map((item) => [item]),
  ];
  const storyGroups = groupedItems.map((group) => ({
    canonicalKey: `story-${hash(groupSeed(group))}`,
    sourceItemIds: group.map((item) => item.id),
  }));
  return { items, storyGroups, exclusions };
}

/** Semantic story grouping (#502): deterministic eligibility has run; the
 *  remaining work compares bounded plausible pairs of eligible unkeyed items
 *  for the same specific development. Keyed items keep their exact storyKey
 *  group and never cross into semantic groups; ambiguous, skipped, failed and
 *  over-budget pairs stay separate; a temporary provider failure leaves the
 *  usable deterministic result in place of the affected judgments. */
export async function determineStoryGroups(input: {
  eligibleItems: SourceItem[];
  judger?: StoryPairJudger;
  budget?: number;
}): Promise<StoryGroupingOutcome> {
  const budget = input.budget ?? GROUPING_PAIR_BUDGET;
  const keyedGroups = new Map<string, SourceItem[]>();
  const unkeyedItems: SourceItem[] = [];
  for (const item of input.eligibleItems) {
    const key = item.storyKey?.trim().toLowerCase();
    if (key) {
      const group = keyedGroups.get(key) ?? [];
      group.push(item);
      keyedGroups.set(key, group);
    } else {
      unkeyedItems.push(item);
    }
  }

  const audit: StoryGroupingAudit = {
    questionRevision: GROUPING_QUESTION_REVISION,
    budget,
    eligibleUnkeyedItems: unkeyedItems.length,
    pairsEvaluated: 0,
    pairsSkipped: 0,
    semanticGroups: 0,
    singletonGroups: 0,
    judgerFailures: 0,
    pairs: [],
  };

  const totalPlausiblePairs = candidatePairs(unkeyedItems, {
    budget: Number.POSITIVE_INFINITY,
  }).length;
  const pairs = candidatePairs(unkeyedItems, { budget });
  audit.pairsSkipped = Math.max(0, totalPlausiblePairs - pairs.length);

  const verdicts = new Map<string, { same: number; different: number; ambiguous: number }>();
  if (input.judger && pairs.length > 0) {
    const itemById = new Map(unkeyedItems.map((item) => [item.id, item]));
    for (const [leftId, rightId] of pairs) {
      const verdict = await input.judger({
        left: itemById.get(leftId)!,
        right: itemById.get(rightId)!,
      });
      audit.pairsEvaluated += 1;
      if (verdict === null) {
        audit.judgerFailures += 1;
        continue;
      }
      verdicts.set(`${leftId}|${rightId}`, verdict);
      audit.pairs.push({
        left: leftId,
        right: rightId,
        verdict,
        merged: sameStoryVerdict(verdict, GROUPING_QUESTION_REVISION),
        compared: true,
        questionRevision: GROUPING_QUESTION_REVISION,
      });
    }
  } else {
    audit.pairsSkipped += pairs.length;
  }

  const partitions = applyPairVerdicts(unkeyedItems, pairs, verdicts, GROUPING_QUESTION_REVISION);
  audit.semanticGroups = partitions.filter((group) => group.size > 1).length;
  audit.singletonGroups = partitions.filter((group) => group.size === 1).length;

  const semanticItems = new Map<string, SourceItem>();
  for (const item of unkeyedItems) semanticItems.set(item.id, item);
  const groupItems: SourceItem[][] = [
    ...keyedGroups.values(),
    ...partitions.map((group) => [...group].sort().map((id) => semanticItems.get(id)!)),
  ];
  const groups = groupItems.map((group) => ({
    canonicalKey: `story-${hash(groupSeed(group))}`,
    sourceItemIds: group.map((item) => item.id),
  }));
  return { groups, audit };
}

/** Cool-down reconciliation for regrouped stories (#502): a new semantic
 *  group's canonical key is membership-derived, so added coverage changes the
 *  key. When the base disposition says eligible only because no decision
 *  carries the NEW key, a group whose evidence shares a Source Item URL with
 *  a decision still inside the cooldown window is the same story under a new
 *  key, and the cooldown holds. A key that already matches a recent decision
 *  is left to the base disposition untouched; a demonstrably different story
 *  (no evidence overlap) is never caught by this. */
export function storyGroupCooldownDisposition(
  base: { eligible: false } | { eligible: true; earlyFollowUp: OpportunityEarlyFollowUp | null },
  canonicalKey: string,
  evidenceUrls: string[],
  recentDecisions: { canonicalKey: string; evidenceUrls: string[] }[],
): { eligible: false } | { eligible: true; earlyFollowUp: OpportunityEarlyFollowUp | null } {
  if (!base.eligible) return base;
  if (recentDecisions.some((decision) => decision.canonicalKey === canonicalKey)) return base;
  const evidence = new Set(evidenceUrls);
  const collision = recentDecisions.some((decision) =>
    decision.evidenceUrls.some((url) => evidence.has(url)),
  );
  return collision ? { eligible: false } : base;
}

export function enforceOpportunityIdentity(input: {
  ranked: RankedOpportunity[];
  items: SourceItem[];
  storyGroups: SourceStoryGroup[];
  adapterStates: Map<string, SourceAdapterState>;
}): RankedOpportunity[] {
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const itemByUrl = new Map(input.items.map((item) => [item.canonicalUrl, item]));
  const groupByItem = new Map<string, SourceStoryGroup>();
  for (const group of input.storyGroups) {
    for (const id of group.sourceItemIds) groupByItem.set(id, group);
  }
  const retained = new Map<string, RankedOpportunity>();
  for (const candidate of input.ranked) {
    const referenced = new Set<string>();
    for (const id of candidate.sourceItemIds) if (itemById.has(id)) referenced.add(id);
    for (const url of candidate.sourceUrls) {
      const item = itemByUrl.get(url);
      if (item) referenced.add(item.id);
    }
    const groups = [
      ...new Set([...referenced].map((id) => groupByItem.get(id)).filter(Boolean)),
    ] as SourceStoryGroup[];
    if (groups.length === 0) continue;
    const canonicalKey =
      groups.length === 1
        ? groups[0]!.canonicalKey
        : `story-${hash(
            groups
              .map((group) => group.canonicalKey)
              .sort()
              .join("|"),
          )}`;
    const evidence = input.items.filter((item) =>
      groups.some((group) => group.sourceItemIds.includes(item.id)),
    );
    const normalized: RankedOpportunity = {
      ...candidate,
      id: `opportunity-${hash(`${canonicalKey}|${candidate.angle}`)}`,
      canonicalKey,
      sourceItemIds: evidence.map((item) => item.id),
      sourceUrls: [...new Set(evidence.map((item) => item.canonicalUrl))],
      experimentalEvidence: evidence.some(
        (item) => input.adapterStates.get(item.adapterId) === "experimental",
      ),
    };
    const mergeKey = `${canonicalKey}|${candidate.angle}`;
    const previous = retained.get(mergeKey);
    if (!previous || normalized.confidence > previous.confidence)
      retained.set(mergeKey, normalized);
  }
  return [...retained.values()];
}
