import type { FastifyInstance } from "fastify";
import type {
  MeetingDebriefDetail,
  MeetingDebriefExtraction,
  MeetingDebriefIdentitySummary,
  MeetingDebriefIndex,
  MeetingDebriefIndexEntry,
  MeetingDebriefRunResult,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import {
  MEETING_DEBRIEF_INTAKE,
  MEETING_DEBRIEF_MODULE_ID,
  MEETING_DEBRIEF_MODULE_VERSION,
  type RunMeta,
  type RunSummary,
} from "@chief-of-staff-demo/shared";
import type { HostedModule } from "../../engine/host.js";
import { Runner } from "../../engine/runner.js";
import type { Runs } from "../../runs.js";
import { latestDecisionsByMention } from "./extraction.js";
import {
  meetingDebriefModule,
  type DebriefInput,
  type DebriefCatalogReader,
  type DebriefExtractInput,
  type DebriefIdentityReviewReader,
  type MeetingDebriefModuleDeps,
} from "./module.js";

import type { DebriefIdentityReview } from "./deps.js";
export type { DebriefIdentityReview } from "./deps.js";

export interface MeetingDebriefHostDeps {
  /** Constructed once by the Shell: the run directory has one owner. */
  runs: Runs;
  catalog: DebriefCatalogReader;
  identity: DebriefIdentityReviewReader;
  /** Deterministic extraction seam (tests, hermetic runtimes). */
  extract?: (input: DebriefExtractInput) => Promise<MeetingDebriefExtraction>;
  getCompleteJson?: MeetingDebriefModuleDeps["getCompleteJson"];
  getLlmInfo?: MeetingDebriefModuleDeps["getLlmInfo"];
  log?: (message: string) => void;
}

function parseRunResult(raw: string | null): MeetingDebriefRunResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MeetingDebriefRunResult;
    return typeof parsed.transcriptId === "string" && typeof parsed.debrief === "object"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** The Catalog's review state, summarized for the Debrief surfaces. */
function identitySummary(review: DebriefIdentityReview): MeetingDebriefIdentitySummary {
  const latestDecision = new Map<string, { outcome: string; profileId: string | null }>();
  for (const [mentionId, decision] of latestDecisionsByMention(review.decisions)) {
    latestDecision.set(mentionId, { outcome: decision.outcome, profileId: decision.profileId });
  }
  const resolved: MeetingDebriefIdentitySummary["resolved"] = [];
  const unresolved: MeetingDebriefIdentitySummary["unresolved"] = [];
  for (const mention of review.mentions) {
    const decision = latestDecision.get(mention.id);
    if (
      decision &&
      (decision.outcome === "linked" || decision.outcome === "created") &&
      decision.profileId
    ) {
      resolved.push({
        mentionId: mention.id,
        surfaceText: mention.surfaceText,
        profileId: decision.profileId,
      });
    } else if (!decision || decision.outcome === "unresolved") {
      unresolved.push({ mentionId: mention.id, surfaceText: mention.surfaceText });
    }
  }
  return {
    resolved,
    unresolved,
    organizations: review.organizations.map((organization) => ({
      mentionId: organization.id,
      surfaceText: organization.surfaceText,
    })),
  };
}

/**
 * Meeting Debrief host — what the Shell holds (HostedModule) and what the
 * Transcript Catalog calls when mining completes (`process` / `backfill`,
 * issue #139). Exactly one Run per Transcript revision: a second mining pass
 * finds the Run it already made and starts nothing.
 */
export class MeetingDebriefHost implements HostedModule {
  readonly id = MEETING_DEBRIEF_MODULE_ID;
  readonly version = MEETING_DEBRIEF_MODULE_VERSION;
  private readonly runner: Runner<DebriefInput>;
  private readonly runs: Runs;
  private readonly catalog: DebriefCatalogReader;
  private readonly identity: DebriefIdentityReviewReader;
  /** transcriptId → runId, rebuilt once per process from Runs and the log. */
  private knownRuns: Map<string, string> | null = null;
  /** `process` serializes through one chain, so two passes never race a scan. */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: MeetingDebriefHostDeps) {
    this.runs = deps.runs;
    this.catalog = deps.catalog;
    this.identity = deps.identity;
    this.runner = new Runner({
      runs: deps.runs,
      module: meetingDebriefModule({
        catalog: deps.catalog,
        identity: deps.identity,
        ...(deps.extract ? { extract: deps.extract } : {}),
        ...(deps.getCompleteJson ? { getCompleteJson: deps.getCompleteJson } : {}),
        ...(deps.getLlmInfo ? { getLlmInfo: deps.getLlmInfo } : {}),
      }),
      log: deps.log,
    });
  }

  /** Resolves when every enqueued Run has settled (test seam). */
  idle(): Promise<void> {
    return this.runner.idle();
  }

  start(): void {
    this.runner.startRecoveryLoop();
  }

  stop(): void {
    this.runner.stopRecoveryLoop();
  }
  retryRun(id: string): Promise<RunMeta> {
    return this.runner.retryRun(id);
  }

  /** The Catalog's mining-completion hand-off for one immutable Transcript. */
  process(record: TranscriptRecord): Promise<void> {
    const next = this.chain.then(() => this.processOne(record));
    this.chain = next.catch(() => {});
    return next;
  }

  /** The Catalog's historical hand-off: every registered record, every pass. */
  async backfill(records: TranscriptRecord[]): Promise<void> {
    for (const record of records) {
      await this.process(record);
    }
  }

  private async processOne(record: TranscriptRecord): Promise<void> {
    if (this.knownRunFor(record.id)) return;
    const runId = await this.runner.startRun(
      {
        intake: MEETING_DEBRIEF_INTAKE,
        fileName: record.source.fileName,
        sourceUrl: record.source.sourceUrl,
        externalId: record.id,
      },
      { kind: "fresh", transcriptId: record.id },
    );
    this.knownRuns?.set(record.id, runId);
  }

  private knownRunFor(transcriptId: string): string | null {
    if (this.knownRuns === null) {
      const map = new Map<string, string>();
      for (const summary of this.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs) {
        const meta = this.runs.open(summary.id)?.read();
        if (meta?.externalId) map.set(meta.externalId, summary.id);
      }
      this.knownRuns = map;
    }
    return this.knownRuns.get(transcriptId) ?? null;
  }

  private entryFor(summary: RunSummary): MeetingDebriefIndexEntry | null {
    const meta = this.runs.open(summary.id)?.read();
    if (!meta?.externalId) return null;
    const record = this.catalog.getTranscript(meta.externalId);
    const review = this.identity.reviewFor(meta.externalId);
    const identity = identitySummary(review);
    const extraction = parseRunResult(
      this.runs.open(summary.id)?.readArtifact("result.json") ?? null,
    );
    const linked = record?.occurrence != null;
    const rosterStatus =
      record !== null && record.roster.length > 0 ? "prefilled" : "requires_confirmation";
    return {
      runId: summary.id,
      transcriptId: meta.externalId,
      status: summary.status,
      summary: summary.summary,
      meetingDate: record?.meetingDate ?? null,
      fileName: record?.source.fileName ?? meta.fileName ?? null,
      linked,
      occurrenceKey: record?.occurrence?.occurrenceKey ?? null,
      rosterStatus,
      rosterSize: record?.roster.length ?? 0,
      identity: {
        resolvedCount: identity.resolved.length,
        unresolvedCount: identity.unresolved.length,
        organizationCount: identity.organizations.length,
      },
      reviewReadiness: extraction
        ? rosterStatus === "prefilled"
          ? "ready"
          : "needs_roster"
        : "no_extraction",
    };
  }

  private buildIndex(): MeetingDebriefIndex {
    const entries: MeetingDebriefIndexEntry[] = [];
    for (const summary of this.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs) {
      const entry = this.entryFor(summary);
      if (entry) entries.push(entry);
    }
    return { entries };
  }

  private buildDetail(runId: string): MeetingDebriefDetail | null {
    const summary = this.runs.detail(runId);
    if (!summary || summary.module !== MEETING_DEBRIEF_MODULE_ID) return null;
    const meta = this.runs.open(runId)?.read();
    if (!meta?.externalId) return null;
    const record = this.catalog.getTranscript(meta.externalId);
    const identity = identitySummary(this.identity.reviewFor(meta.externalId));
    const extraction = parseRunResult(this.runs.open(runId)?.readArtifact("result.json") ?? null);
    const linked = record?.occurrence != null;
    const rosterStatus =
      record !== null && record.roster.length > 0 ? "prefilled" : "requires_confirmation";
    return {
      runId,
      transcriptId: meta.externalId,
      status: summary.status,
      summary: summary.summary,
      skipReason: summary.skipReason,
      meetingDate: record?.meetingDate ?? null,
      fileName: record?.source.fileName ?? meta.fileName ?? null,
      sourceUrl: record?.source.sourceUrl ?? null,
      linked,
      occurrence: record?.occurrence
        ? {
            occurrenceKey: record.occurrence.occurrenceKey,
            calendarEventId: record.occurrence.calendarEventId,
          }
        : null,
      roster: record?.roster ?? [],
      speakers: record?.speakers ?? [],
      rosterStatus,
      identity,
      extraction: extraction?.debrief ?? null,
      reviewReadiness: extraction
        ? rosterStatus === "prefilled"
          ? "ready"
          : "needs_roster"
        : "no_extraction",
    };
  }

  routes(app: FastifyInstance): void {
    app.get("/api/meeting-debrief/index", async () => this.buildIndex());
    app.get("/api/meeting-debrief/:runId", async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const detail = this.buildDetail(runId);
      if (!detail) {
        reply.code(404).send({ error: "Unknown Meeting Debrief Run" });
        return;
      }
      return detail;
    });
  }
}
