import type {
  AdapterDiagnostic,
  ContentDraft,
  ContentPack,
  ContentScoutRunResult,
  ContentShortlist,
  OpportunityBrief,
  RankedOpportunity,
  RunMeta,
  SourceAdapterState,
  SourceItem,
  SourceCollectionAttemptReceipt,
  SourceTarget,
} from "@chief-of-staff-demo/shared";
import {
  CONTENT_SCOUT_DRAFT_TARGETS_V1,
  CONTENT_SCOUT_MODULE_ID,
  CONTENT_SCOUT_MODULE_VERSION,
} from "@chief-of-staff-demo/shared";
import { StageFailure, type RetryPlan, type ShellModule } from "../../engine/module.js";
import type { RunContext } from "../../engine/module.js";
import type { RunOutcome } from "../../runs.js";
import type {
  DraftGenerator,
  NotionPublisher,
  OpportunityRanker,
  SourceAdapter,
  SourceCollectionResult,
} from "./ports.js";
import type { ContentScoutStore } from "./store.js";
import { collectSourceTargets, type CollectedSourceTargetProgress } from "./collection.js";
import { sanitizeDiagnosticRoute } from "./diagnostics.js";
import { determineEligibility, enforceOpportunityIdentity } from "./eligibility.js";
import {
  CONTENT_SCOUT_MAX_COMMENTS,
  filterPromisingItems,
  selectDiverseComments,
} from "./enrichment.js";

export const CONTENT_SCOUT_INTAKE = "daily-intake";

export type ContentScoutInput =
  | { kind: "intake"; invocation: "manual" | "scheduled" }
  | { kind: "selection"; opportunityIds: string[] }
  | { kind: "skip" };

export interface ContentScoutModuleDeps {
  store: ContentScoutStore;
  adapters: SourceAdapter[];
  ranker: OpportunityRanker;
  draftGenerator?: DraftGenerator;
  notionPublisher?: NotionPublisher;
  supersede?: (oldRunId: string, newRunId: string) => void;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  retainEvidenceTranscript?: (id: string, text: string) => void;
  recordSanitizedDiagnostic?: (id: string, contentType: string, body: string) => void;
  intakeCompleted?: (period: string | null) => void;
  shortlistSize?: () => number;
}

function collectionStart(target: SourceTarget, now: Date): string {
  const overlapMs = target.lastSuccessfulAt === null ? 7 * 86_400_000 : 48 * 3_600_000;
  const anchor = target.lastSuccessfulAt
    ? new Date(target.lastSuccessfulAt).getTime()
    : now.getTime();
  return new Date(anchor - overlapMs).toISOString();
}

function duration(diagnostic: AdapterDiagnostic): number {
  const started = Date.parse(diagnostic.startedAt);
  const finished = Date.parse(diagnostic.finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? finished - started
    : 0;
}

function laterSuccessfulRequest(
  current: ContentScoutRunResult["adapters"][number]["lastSuccessfulRequest"],
  candidate: ContentScoutRunResult["adapters"][number]["lastSuccessfulRequest"],
) {
  if (!current) return candidate;
  if (!candidate) return current;
  return Date.parse(candidate.at) >= Date.parse(current.at) ? candidate : current;
}

function addAdapterResult(
  rows: ContentScoutRunResult["adapters"],
  input: {
    target: SourceTarget;
    adapter: SourceAdapter;
    result: SourceCollectionResult;
    attempts: SourceCollectionAttemptReceipt[];
  },
): void {
  const attemptDurationMs = input.attempts.reduce(
    (total, attempt) => total + (attempt.diagnostic ? duration(attempt.diagnostic) : 0),
    0,
  );
  const durationMs = attemptDurationMs || duration(input.result.diagnostic);
  const errorClassifications = input.result.kind === "failed" ? [input.result.outcome] : [];
  const successfulRequest =
    input.result.kind === "completed"
      ? {
          at: input.result.diagnostic.finishedAt,
          route: input.result.diagnostic.route,
        }
      : input.target.lastSuccessfulAt
        ? {
            at: input.target.lastSuccessfulAt,
            route: sanitizeDiagnosticRoute(input.target.url),
          }
        : null;
  const existing = rows.find((row) => row.adapterId === input.adapter.id);
  if (!existing) {
    rows.push({
      adapterId: input.adapter.id,
      state: input.adapter.state,
      targetsAttempted: 1,
      outcome: input.result.outcome,
      itemsFound: input.result.items.length,
      durationMs,
      retries: input.result.diagnostic.retries,
      lastSuccessfulRequest: successfulRequest,
      errorClassifications,
      affectedCapabilities: [...input.result.diagnostic.affectedCapabilities],
      attempts: [...input.attempts],
    });
    return;
  }
  existing.targetsAttempted += 1;
  existing.itemsFound += input.result.items.length;
  existing.durationMs += durationMs;
  existing.retries += input.result.diagnostic.retries;
  existing.lastSuccessfulRequest =
    laterSuccessfulRequest(existing.lastSuccessfulRequest, successfulRequest) ?? null;
  existing.errorClassifications = [
    ...new Set([...(existing.errorClassifications ?? []), ...errorClassifications]),
  ];
  existing.affectedCapabilities = [
    ...new Set([...existing.affectedCapabilities, ...input.result.diagnostic.affectedCapabilities]),
  ];
  existing.attempts.push(...input.attempts);
  if (input.result.kind === "failed") existing.outcome = input.result.outcome;
  else if (existing.errorClassifications.length === 0 && input.result.items.length > 0) {
    existing.outcome = "items_found";
  }
}

function adapterWarningCount(rows: ContentScoutRunResult["adapters"]): number {
  return rows.filter((row) => (row.errorClassifications?.length ?? 0) > 0).length;
}

function reconcileAttemptHistory(
  rows: ContentScoutRunResult["adapters"],
  attempts: SourceCollectionAttemptReceipt[],
): void {
  for (const row of rows) {
    const adapterAttempts = attempts.filter((attempt) => attempt.adapterId === row.adapterId);
    if (adapterAttempts.length === 0) continue;
    row.attempts = adapterAttempts;
    row.targetsAttempted = new Set(adapterAttempts.map((attempt) => attempt.targetId)).size;
    row.retries = adapterAttempts.length - row.targetsAttempted;
    const measuredDuration = adapterAttempts.reduce(
      (total, attempt) => total + (attempt.diagnostic ? duration(attempt.diagnostic) : 0),
      0,
    );
    if (measuredDuration > 0) row.durationMs = measuredDuration;
  }
}

function parseArtifact<T>(ctx: RunContext, name: string): T | null {
  const raw = ctx.readFile(name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function packId(runId: string, opportunityId: string): string {
  return `${runId}--${safePart(opportunityId)}`;
}

function briefArtifact(id: string): string {
  return `brief-${safePart(id)}.json`;
}

function draftArtifact(pack: string, targetId: string): string {
  return `draft-${safePart(pack)}-${safePart(targetId)}.json`;
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await work(items[index]!);
    }
  });
  await Promise.all(workers);
}

function readRunResult(ctx: RunContext): ContentScoutRunResult {
  return (
    parseArtifact<ContentScoutRunResult>(ctx, "result.json") ?? {
      adapters: [],
      shortlist: { opportunityCount: 0, omittedCount: 0 },
      warnings: 0,
    }
  );
}

function packProgress(pack: ContentPack, missingDraftTargets: string[], missingPages: string[]) {
  return {
    id: pack.id,
    opportunityId: pack.opportunityId,
    generated: pack.draftIds.length,
    published: pack.notionPages.length,
    total: CONTENT_SCOUT_DRAFT_TARGETS_V1.length,
    missingDraftTargets,
    missingNotionPages: missingPages,
  };
}

const MAX_TRANSCRIPT_CHARS = 12_000;

function evidenceStrength(
  item: SourceItem,
  adapterState: SourceAdapterState | undefined,
  now: Date,
): number {
  let score = 0;
  if (item.completeness.title === "available") score += 3;
  else if (item.completeness.title === "failed") score -= 1;
  if (item.completeness.body === "available") score += 3;
  else if (item.completeness.body === "failed") score -= 1;
  if (item.completeness.description === "available") score += 1;
  if (item.completeness.transcript === "available") score += 2;
  else if (item.completeness.transcript === "failed") score -= 1;
  if (item.completeness.comments === "available") score += 1;
  else if (item.completeness.comments === "failed") score -= 1;
  if (item.evidence.length > 0) score += 1;
  if (item.body && item.body.length > 1000) score += 2;
  else if (item.body && item.body.length > 500) score += 1;
  if (adapterState === "available") score += 2;
  const published = Date.parse(item.publishedAt ?? item.discoveredAt);
  if (Number.isFinite(published)) {
    const ageHours = (now.getTime() - published) / 3_600_000;
    if (ageHours <= 24) score += 3;
    else if (ageHours <= 48) score += 2;
    else if (ageHours <= 7 * 24) score += 1;
  }
  if (item.claims?.some((claim) => claim.state === "supported")) score += 1;
  return score;
}

function isQualifyingSourceItem(item: SourceItem): boolean {
  try {
    const url = new URL(item.canonicalUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  } catch {
    return false;
  }
  const hasAvailableText = (["title", "body", "description", "transcript"] as const).some(
    (field) => item.completeness[field] === "available",
  );
  const text = [item.title, item.body, item.description, item.transcript]
    .filter(Boolean)
    .join("\n")
    .trim();
  return hasAvailableText && text.length >= 20 && item.evidence.length > 0;
}

function boundSourceItem(item: SourceItem): SourceItem {
  let transcript = item.transcript;
  if (typeof transcript === "string" && transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  }
  let comments = item.comments;
  if (comments.length > CONTENT_SCOUT_MAX_COMMENTS) {
    comments = selectDiverseComments(comments, CONTENT_SCOUT_MAX_COMMENTS);
  }
  if (transcript === item.transcript && comments === item.comments) return item;
  return { ...item, transcript, comments };
}

function selectStrongestEvidence(input: {
  qualifying: SourceItem[];
  adapterStates: Map<string, SourceAdapterState>;
  now: Date;
}): SourceItem[] {
  const scored = input.qualifying
    .map((item) => ({
      item,
      score: evidenceStrength(item, input.adapterStates.get(item.adapterId), input.now),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftTime = Date.parse(left.item.publishedAt ?? left.item.discoveredAt);
      const rightTime = Date.parse(right.item.publishedAt ?? right.item.discoveredAt);
      if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) {
        return rightTime - leftTime;
      }
      return left.item.id.localeCompare(right.item.id);
    })
    .map((entry) => boundSourceItem(entry.item));
  return scored.slice(0, 8);
}

function extractGroundedClaims(evidence: SourceItem[]): { claim: string; sourceUrls: string[] }[] {
  const claimMap = new Map<string, Set<string>>();
  for (const item of evidence) {
    if (item.claims?.length) {
      let usedSupported = false;
      for (const entry of item.claims) {
        if (entry.state !== "supported") continue;
        const text = entry.text.trim();
        if (!text) continue;
        if (text === item.title?.trim()) continue;
        const urls = entry.sourceUrls.length ? entry.sourceUrls : [item.canonicalUrl];
        if (!claimMap.has(text)) claimMap.set(text, new Set());
        for (const url of urls) claimMap.get(text)!.add(url);
        claimMap.get(text)!.add(item.canonicalUrl);
        usedSupported = true;
      }
      if (usedSupported) continue;
    }
    const sourceText = item.body ?? item.description ?? "";
    const sentences = sourceText
      .split(/[.!?]\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 20);
    let claimed = 0;
    for (const sentence of sentences) {
      if (sentence === item.title?.trim()) continue;
      if (!claimMap.has(sentence)) claimMap.set(sentence, new Set());
      claimMap.get(sentence)!.add(item.canonicalUrl);
      claimed += 1;
      if (claimed >= 2) break;
    }
    if (claimed === 0) {
      const fallback = (item.body ?? item.description ?? item.title ?? "").trim();
      if (fallback.length >= 20 && fallback !== item.title?.trim()) {
        if (!claimMap.has(fallback)) claimMap.set(fallback, new Set());
        claimMap.get(fallback)!.add(item.canonicalUrl);
      } else if (fallback.length >= 20) {
        if (!claimMap.has(fallback)) claimMap.set(fallback, new Set());
        claimMap.get(fallback)!.add(item.canonicalUrl);
      }
    }
  }
  if (claimMap.size === 0) {
    for (const item of evidence) {
      const fallback = (item.title ?? item.description ?? "Source evidence").trim();
      if (!fallback) continue;
      if (!claimMap.has(fallback)) claimMap.set(fallback, new Set());
      claimMap.get(fallback)!.add(item.canonicalUrl);
      break;
    }
  }
  return [...claimMap.entries()].map(([claim, urls]) => ({ claim, sourceUrls: [...urls] }));
}

/** Content Scout orchestration behind the ContentScoutHost interface. */
export function contentScoutModule(deps: ContentScoutModuleDeps): ShellModule<ContentScoutInput> {
  const writeProgress = (
    ctx: RunContext,
    packs: ContentPack[],
    missingDrafts: Map<string, string[]>,
    missingPages: Map<string, string[]>,
  ): void => {
    const result = readRunResult(ctx);
    result.packs = packs.map((pack) =>
      packProgress(pack, missingDrafts.get(pack.id) ?? [], missingPages.get(pack.id) ?? []),
    );
    ctx.writeFile("result.json", `${JSON.stringify(result, null, 2)}\n`);
  };

  const freezeBrief = (
    ctx: RunContext,
    opportunity: RankedOpportunity,
    shortlist: ContentShortlist,
    items: SourceItem[],
  ): OpportunityBrief => {
    const contentPackId = packId(ctx.runId, opportunity.id);
    const id = `brief-${contentPackId}`;
    const artifact = briefArtifact(id);
    const existing = parseArtifact<OpportunityBrief>(ctx, artifact);
    if (existing) return existing;
    const profile = deps.store.brandProfile(shortlist.brandProfileRevisionId);
    if (!profile) {
      throw new StageFailure(
        "brand_profile_revision_missing",
        "The Brand Profile revision used for this shortlist is missing; the draft cannot be reproduced safely.",
      );
    }
    const mapped = opportunity.sourceItemIds
      .map((sourceId) => items.find((item) => item.id === sourceId))
      .filter((item): item is SourceItem => item !== undefined);
    const qualifying = mapped.filter(isQualifyingSourceItem);
    const adapterStates = new Map(deps.adapters.map((adapter) => [adapter.id, adapter.state]));
    const evidence = selectStrongestEvidence({ qualifying, adapterStates, now: deps.now() });
    if (evidence.length < 3) {
      throw new StageFailure(
        "insufficient_evidence",
        `Insufficient evidence: the selected opportunity has only ${evidence.length} qualifying Source Items; at least 3 are required for an evidence-complete brief.`,
      );
    }
    const claims = extractGroundedClaims(evidence);
    const allowedUrls = new Set(evidence.map((item) => item.canonicalUrl));
    const groundedClaims = claims.filter((entry) =>
      entry.sourceUrls.every((url) => allowedUrls.has(url)),
    );
    if (groundedClaims.length === 0) {
      throw new StageFailure(
        "insufficient_evidence",
        "No factual claim could be grounded to the qualifying evidence; the brief cannot be created.",
      );
    }
    const frozenOpportunity: RankedOpportunity = structuredClone(opportunity);
    frozenOpportunity.experimentalEvidence = evidence.some(
      (item) => adapterStates.get(item.adapterId) === "experimental",
    );
    const brief: OpportunityBrief = {
      id,
      runId: ctx.runId,
      contentPackId,
      createdAt: deps.now().toISOString(),
      opportunity: frozenOpportunity,
      sourceItems: evidence,
      claims: groundedClaims,
      brandProfileRevisionId: profile.id,
      brandProfileMarkdown: profile.markdown,
    };
    for (const item of evidence) {
      if (item.transcript) {
        deps.retainEvidenceTranscript?.(`${safePart(id)}-${safePart(item.id)}`, item.transcript);
      }
    }
    ctx.writeFile(artifact, `${JSON.stringify(brief, null, 2)}\n`);
    return brief;
  };

  const selectedRun = async (ctx: RunContext, opportunityIds: string[]): Promise<RunOutcome> => {
    const shortlist = parseArtifact<ContentShortlist>(ctx, "shortlist.json");
    const sourceItems = parseArtifact<SourceItem[]>(ctx, "source-items.json") ?? [];
    const enrichedItems = parseArtifact<SourceItem[]>(ctx, "enriched-source-items.json") ?? [];
    const enrichedById = new Map(enrichedItems.map((item) => [item.id, item]));
    const items =
      sourceItems.length > 0
        ? sourceItems.map((item) => enrichedById.get(item.id) ?? item)
        : enrichedItems;
    if (!shortlist) {
      throw new StageFailure(
        "shortlist_missing",
        "The immutable shortlist artifact is missing; this Run cannot safely resume.",
      );
    }
    const selected = opportunityIds.map((id) => {
      const found = shortlist.opportunities.find((opportunity) => opportunity.id === id);
      if (!found) throw new Error(`Opportunity is absent from the shortlist: ${id}`);
      return found;
    });
    const packs = deps.store.listContentPacks().filter((pack) => pack.runId === ctx.runId);
    const packById = new Map(packs.map((pack) => [pack.id, pack]));
    const missingDrafts = new Map<string, string[]>();
    const missingPages = new Map<string, string[]>();

    await ctx.stage("draft", async () => {
      if (!deps.draftGenerator) {
        throw new StageFailure(
          "draft_generator_unconfigured",
          "Choose a model provider before drafting a Content Pack.",
        );
      }
      for (const opportunity of selected) {
        const brief = freezeBrief(ctx, opportunity, shortlist, items);
        const existing =
          packById.get(brief.contentPackId) ??
          ({
            id: brief.contentPackId,
            runId: ctx.runId,
            opportunityId: opportunity.id,
            opportunityTitle: opportunity.title,
            briefId: brief.id,
            createdAt: deps.now().toISOString(),
            draftIds: [],
            notionPageKeys: [],
            notionPages: [],
            status: "partial",
          } satisfies ContentPack);
        packById.set(existing.id, existing);
        const failed: string[] = [];
        await mapLimit(CONTENT_SCOUT_DRAFT_TARGETS_V1, 4, async (target) => {
          const draftId = `${existing.id}:${target.id}:v${target.version}`;
          const artifact = draftArtifact(existing.id, target.id);
          if (parseArtifact<ContentDraft>(ctx, artifact)) {
            if (!existing.draftIds.includes(draftId)) existing.draftIds.push(draftId);
            return;
          }
          try {
            const generated = await deps.draftGenerator!.generate({
              idempotencyKey: draftId,
              brief,
              target,
            });
            const draft: ContentDraft = {
              id: draftId,
              contentPackId: existing.id,
              target,
              createdAt: deps.now().toISOString(),
              copy: generated.copy,
              productionNotes: generated.productionNotes,
              reviewNotes: generated.reviewNotes,
            };
            ctx.writeFile(artifact, `${JSON.stringify(draft, null, 2)}\n`);
            existing.draftIds.push(draftId);
            ctx.event("content_draft_generated", {
              contentPackId: existing.id,
              draftTarget: target.id,
            });
          } catch (error) {
            failed.push(target.id);
            ctx.event("content_draft_failed", {
              contentPackId: existing.id,
              draftTarget: target.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        missingDrafts.set(existing.id, failed);
        deps.store.saveContentPack(existing);
      }
      const current = [...packById.values()];
      writeProgress(ctx, current, missingDrafts, missingPages);
      const allMissing = [...missingDrafts.values()].flat();
      if (allMissing.length > 0) {
        throw new StageFailure(
          `missing_draft_targets:${allMissing.join(",")}`,
          `${allMissing.length} Draft Target${allMissing.length === 1 ? " is" : "s are"} missing. Retry creates only the missing drafts.`,
        );
      }
    });

    await ctx.stage("publish", async () => {
      if (!deps.notionPublisher) {
        throw new StageFailure(
          "notion_unconfigured",
          "Connect your Notion integration and choose a content calendar before publication.",
        );
      }
      for (const opportunity of selected) {
        const id = packId(ctx.runId, opportunity.id);
        const pack = packById.get(id)!;
        const brief = parseArtifact<OpportunityBrief>(ctx, briefArtifact(pack.briefId))!;
        const failed: string[] = [];
        await mapLimit(CONTENT_SCOUT_DRAFT_TARGETS_V1, 4, async (target) => {
          const key = `${pack.id}:${target.id}:v${target.version}`;
          if (pack.notionPageKeys.includes(key)) return;
          const draft = parseArtifact<ContentDraft>(ctx, draftArtifact(pack.id, target.id));
          if (!draft) {
            failed.push(target.id);
            return;
          }
          try {
            const page =
              (await deps.notionPublisher!.findDraftPage(key, draft)) ??
              (await deps.notionPublisher!.createDraftPage({
                idempotencyKey: key,
                draft,
                brief,
              }));
            pack.notionPageKeys.push(key);
            pack.notionPages.push({ key, draftId: draft.id, ...page });
            deps.store.saveContentPack(pack);
            ctx.event("notion_page_published", {
              contentPackId: pack.id,
              draftTarget: target.id,
              pageId: page.id,
            });
          } catch (error) {
            failed.push(target.id);
            ctx.event("notion_page_failed", {
              contentPackId: pack.id,
              draftTarget: target.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        missingPages.set(pack.id, failed);
        pack.status =
          pack.draftIds.length === CONTENT_SCOUT_DRAFT_TARGETS_V1.length &&
          pack.notionPageKeys.length === CONTENT_SCOUT_DRAFT_TARGETS_V1.length
            ? "complete"
            : "partial";
        deps.store.saveContentPack(pack);
      }
      const current = [...packById.values()];
      writeProgress(ctx, current, missingDrafts, missingPages);
      const allMissing = [...missingPages.values()].flat();
      if (allMissing.length > 0) {
        throw new StageFailure(
          `missing_notion_pages:${allMissing.join(",")}`,
          `${allMissing.length} Notion page${allMissing.length === 1 ? " is" : "s are"} missing. Retry creates only the missing pages.`,
        );
      }
      deps.store.clearPendingAction(ctx.runId);
    });

    const active = deps.store.activeShortlist();
    if (
      active?.runId === ctx.runId &&
      active.opportunities.some((item) => item.state === "ready")
    ) {
      await ctx.stage("selection", async () => {
        ctx.wait({
          reason: "Ready opportunities remain. Choose up to three or skip this shortlist.",
          timeout: { kind: "none" },
        });
      });
    }

    return {
      status: "done",
      summary: `${selected.length} complete Content Pack${selected.length === 1 ? "" : "s"}`,
      detail: { contentPacks: selected.length },
    };
  };

  return {
    id: CONTENT_SCOUT_MODULE_ID,
    version: CONTENT_SCOUT_MODULE_VERSION,

    failureHint(stage): string {
      if (stage === "collect") {
        return "No Available Source Adapter completed. Check Sources and adapter diagnostics, then retry.";
      }
      if (stage === "rank") {
        return "The collected evidence could not be ranked into a shortlist. Retry the Run.";
      }
      if (stage === "draft") {
        return "Some Content Drafts are missing. Successful immutable drafts were preserved; retry creates only missing targets.";
      }
      if (stage === "publish") {
        return "Some Notion pages are missing. Local drafts and existing pages were preserved; retry creates only missing pages.";
      }
      return "Content Scout could not finish this Run.";
    },

    planRetry(meta: Readonly<RunMeta>): RetryPlan<ContentScoutInput> | null {
      if (meta.intake !== CONTENT_SCOUT_INTAKE || meta.status !== "failed") return null;
      const action = deps.store.pendingAction(meta.id);
      if (action?.kind === "selection") {
        return {
          fromStage: meta.failedStage ?? "draft",
          reason: "selected_opportunities_are_durable",
          input: { kind: "selection", opportunityIds: action.opportunityIds },
        };
      }
      return {
        fromStage: meta.failedStage ?? "collect",
        reason: "failed_collection_stage",
        input: { kind: "intake", invocation: "manual" },
      };
    },

    planResume(meta) {
      if (meta.intake !== CONTENT_SCOUT_INTAKE || meta.status !== "blocked") return null;
      const action = deps.store.pendingAction(meta.id);
      if (action?.kind === "selection") {
        return {
          fromStage: "draft",
          reason: "person_selected_opportunities",
          input: { kind: "selection", opportunityIds: action.opportunityIds },
        };
      }
      return action?.kind === "skip"
        ? { fromStage: "selection", reason: "person_skipped_shortlist", input: { kind: "skip" } }
        : null;
    },

    planRecovery(meta) {
      if (
        meta.intake !== CONTENT_SCOUT_INTAKE ||
        (meta.status !== "pending" && meta.status !== "running")
      )
        return null;
      const action = deps.store.pendingAction(meta.id);
      if (action?.kind === "selection") {
        return {
          fromStage: meta.failedStage ?? "draft",
          reason: "durable_selection_survived_restart",
          input: { kind: "selection", opportunityIds: action.opportunityIds },
        };
      }
      return {
        fromStage: meta.failedStage ?? "collect",
        reason: "orphaned_content_scout_run",
        input: { kind: "intake", invocation: "scheduled" },
      };
    },

    async run(ctx, input): Promise<RunOutcome> {
      if (input.kind === "selection") {
        return await selectedRun(ctx, input.opportunityIds);
      }
      if (input.kind === "skip") {
        deps.store.clearPendingAction(ctx.runId);
        return { status: "skipped", reason: "The shortlist was skipped." };
      }

      let brandProfile = deps.store.currentBrandProfile();
      const targets = deps.store.listSourceTargets().filter((target) => target.state === "active");
      const rows: ContentScoutRunResult["adapters"] = [];
      const diagnostics: AdapterDiagnostic[] = [];
      const items: SourceItem[] = [];
      let availableCompleted = 0;
      let enrichmentWarnings = 0;

      await ctx.stage("collect", async () => {
        if (!brandProfile) {
          throw new StageFailure(
            "brand_profile_missing",
            "Create and accept a Brand Profile before running Content Scout.",
          );
        }
        const progress =
          parseArtifact<CollectedSourceTargetProgress[]>(ctx, "collection-progress.json") ?? [];
        const attemptReceipts =
          parseArtifact<SourceCollectionAttemptReceipt[]>(ctx, "collection-attempts.json") ?? [];
        for (const prior of progress.flatMap((entry) => entry.attempts)) {
          if (
            !attemptReceipts.some(
              (candidate) =>
                candidate.targetId === prior.targetId && candidate.attempt === prior.attempt,
            )
          ) {
            attemptReceipts.push(prior);
          }
        }
        if (progress.length > 0) {
          ctx.writeFile(
            "collection-attempts.json",
            `${JSON.stringify(attemptReceipts, null, 2)}\n`,
          );
        }
        const attemptOffsets = Object.fromEntries(
          targets.map((target) => [
            target.id,
            Math.max(
              0,
              ...attemptReceipts
                .filter((receipt) => receipt.targetId === target.id)
                .map((receipt) => receipt.attempt),
            ),
          ]),
        );
        const collected = await collectSourceTargets({
          targets,
          adapters: deps.adapters,
          now: deps.now,
          sleep: deps.sleep,
          collectionStart,
          previous: progress,
          attemptOffsets,
          attemptCompleted: ({ target, result, attempts }) => {
            const receipt = attempts.at(-1)!;
            if (result.diagnosticBody) {
              deps.recordSanitizedDiagnostic?.(
                `${ctx.runId}-${safePart(target.id)}-${receipt.attempt}`,
                result.diagnosticBody.contentType,
                result.diagnosticBody.body,
              );
            }
            if (result.kind === "completed") {
              deps.store.recordCollectionSuccess(
                target.id,
                result.checkpoint,
                result.conditional ?? target.conditional,
              );
            }
            const persistedResult: SourceCollectionResult = { ...result };
            delete persistedResult.diagnosticBody;
            const progressEntry = {
              targetId: target.id,
              result: persistedResult,
              attempts,
            } satisfies CollectedSourceTargetProgress;
            const existingProgress = progress.findIndex((entry) => entry.targetId === target.id);
            if (existingProgress === -1) progress.push(progressEntry);
            else progress[existingProgress] = progressEntry;
            ctx.writeFile("collection-progress.json", `${JSON.stringify(progress, null, 2)}\n`);
            if (
              !attemptReceipts.some(
                (candidate) =>
                  candidate.targetId === target.id && candidate.attempt === receipt.attempt,
              )
            ) {
              attemptReceipts.push(receipt);
            }
            ctx.writeFile(
              "collection-attempts.json",
              `${JSON.stringify(attemptReceipts, null, 2)}\n`,
            );
          },
        });
        for (const { target, adapter, result, attempts } of collected) {
          diagnostics.push(result.diagnostic);
          items.push(...result.items);
          addAdapterResult(rows, { target, adapter, result, attempts });
          for (const attempt of attempts) {
            ctx.event("source_adapter_attempted", {
              adapterId: adapter.id,
              targetId: target.id,
              attempt: attempt.attempt,
              outcome: attempt.outcome,
              backoffMs: attempt.backoffMs,
            });
          }
          if (result.kind === "completed") {
            if (adapter.state === "available") availableCompleted += 1;
            ctx.event("source_adapter_completed", {
              adapterId: adapter.id,
              targetId: target.id,
              outcome: result.outcome,
              itemsFound: result.items.length,
            });
          } else {
            ctx.event("source_adapter_failed", {
              adapterId: adapter.id,
              targetId: target.id,
              outcome: result.outcome,
            });
          }
        }
        ctx.writeFile("source-items.json", `${JSON.stringify(items, null, 2)}\n`);
        ctx.writeFile("adapter-diagnostics.json", `${JSON.stringify(diagnostics, null, 2)}\n`);
        ctx.writeFile("collection-attempts.json", `${JSON.stringify(attemptReceipts, null, 2)}\n`);
        reconcileAttemptHistory(rows, attemptReceipts);
        ctx.writeFile(
          "result.json",
          `${JSON.stringify(
            {
              adapters: rows,
              shortlist: { opportunityCount: 0, omittedCount: 0 },
              warnings: adapterWarningCount(rows),
            } satisfies ContentScoutRunResult,
            null,
            2,
          )}\n`,
        );
        if (availableCompleted === 0) {
          throw new StageFailure(
            "no_available_adapter_completed",
            "No Available Source Adapter completed. Check Sources and adapter diagnostics, then retry.",
          );
        }
      });

      await ctx.stage("rank", async () => {
        brandProfile ??= deps.store.currentBrandProfile();
        const eligibility = determineEligibility({
          items,
          targets: deps.store.listSourceTargets(),
          brandProfile: brandProfile!,
          now: deps.now(),
        });
        ctx.writeFile("eligibility.json", `${JSON.stringify(eligibility, null, 2)}\n`);

        const { promising, discarded } = filterPromisingItems({
          items: eligibility.items,
          targets: deps.store.listSourceTargets(),
          brandProfile: brandProfile!,
          now: deps.now(),
        });
        ctx.writeFile("promising-items.json", `${JSON.stringify(promising, null, 2)}\n`);
        ctx.writeFile("discarded-items.json", `${JSON.stringify(discarded, null, 2)}\n`);

        for (const adapter of deps.adapters) {
          if (!adapter.enrich) continue;
          const owned = promising.filter((item) => item.adapterId === adapter.id);
          if (owned.length === 0) continue;
          try {
            const enriched = await adapter.enrich(owned);
            const replacements = new Map(enriched.map((item) => [item.id, item]));
            for (let index = 0; index < promising.length; index += 1) {
              const replacement = replacements.get(promising[index]!.id);
              if (replacement) promising[index] = replacement;
            }
            for (const item of enriched) {
              if (item.comments.length > CONTENT_SCOUT_MAX_COMMENTS) {
                item.comments = selectDiverseComments(item.comments, CONTENT_SCOUT_MAX_COMMENTS);
              }
            }
          } catch (error) {
            enrichmentWarnings += 1;
            const message = error instanceof Error ? error.message : String(error);
            ctx.event("enrichment_failed", { adapterId: adapter.id, error: message });
            for (const item of owned) {
              item.completeness = {
                ...item.completeness,
                transcript:
                  item.completeness.transcript === "unsupported" ? "unsupported" : "failed",
                comments: item.completeness.comments === "unsupported" ? "unsupported" : "failed",
              };
            }
          }
        }
        ctx.writeFile("enriched-source-items.json", `${JSON.stringify(promising, null, 2)}\n`);

        const enrichedItemsById = new Map(promising.map((item) => [item.id, item]));
        const rankedItems = eligibility.items.map((item) => enrichedItemsById.get(item.id) ?? item);
        const sourceUrlByItemId = new Map(rankedItems.map((item) => [item.id, item.canonicalUrl]));
        const ranked = enforceOpportunityIdentity({
          ranked: await deps.ranker.rank({
            brandProfile: brandProfile!,
            items: rankedItems,
            storyGroups: eligibility.storyGroups,
            limit: 10,
          }),
          items: rankedItems,
          storyGroups: eligibility.storyGroups,
          adapterStates: new Map(deps.adapters.map((adapter) => [adapter.id, adapter.state])),
        }).flatMap((opportunity) => {
          const sourceItemReferences = opportunity.sourceItemIds.flatMap((id) => {
            const canonicalUrl = sourceUrlByItemId.get(id);
            return canonicalUrl ? [{ id, canonicalUrl }] : [];
          });
          const disposition = deps.store.opportunityCooldownDisposition(
            opportunity,
            sourceItemReferences,
          );
          return disposition.eligible
            ? [
                {
                  ...opportunity,
                  earlyFollowUp: disposition.earlyFollowUp,
                  sourceItemReferences,
                },
              ]
            : [];
        });
        const shown = ranked.slice(0, deps.shortlistSize?.() ?? 5);
        const shortlist: ContentShortlist = {
          runId: ctx.runId,
          createdAt: deps.now().toISOString(),
          brandProfileRevisionId: brandProfile!.id,
          opportunities: shown.map((opportunity) => ({
            ...opportunity,
            state: "ready",
            decision: null,
          })),
          omittedCount: Math.max(0, ranked.length - shown.length),
          supersededByRunId: null,
        };
        const previous = deps.store.installShortlist(shortlist);
        if (previous && previous.runId !== ctx.runId) {
          deps.supersede?.(previous.runId, ctx.runId);
        }
        ctx.writeFile("shortlist.json", `${JSON.stringify(shortlist, null, 2)}\n`);
        const runResult = readRunResult(ctx);
        runResult.adapters = rows;
        runResult.shortlist = {
          opportunityCount: shown.length,
          omittedCount: shortlist.omittedCount,
        };
        runResult.warnings = adapterWarningCount(rows) + enrichmentWarnings;
        ctx.writeFile("result.json", `${JSON.stringify(runResult, null, 2)}\n`);
        ctx.event("shortlist_ranked", {
          opportunities: shown.length,
          omitted: shortlist.omittedCount,
        });
        deps.intakeCompleted?.(ctx.meta().externalId);
      });

      await ctx.stage("selection", async () => {
        ctx.wait({
          reason: "Choose up to three opportunities or skip this shortlist.",
          timeout: { kind: "none" },
        });
      });
      throw new Error("selection wait unexpectedly returned");
    },
  };
}
