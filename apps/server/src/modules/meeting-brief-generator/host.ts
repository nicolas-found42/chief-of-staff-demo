/* eslint-disable @typescript-eslint/no-unnecessary-condition -- host bridges optional Module deps and ConfigStore that may be absent in tests */
import type { FastifyInstance } from "fastify";
import {
  MEETING_BRIEF_INTAKE,
  MEETING_BRIEF_MODULE_ID,
  type RunMeta,
  MEETING_BRIEF_MODULE_VERSION,
  type MeetingBriefEvent,
  type MeetingBriefIndex,
  type MeetingBriefIndexEntry,
  type MeetingBriefPersonProfileReadModel,
  type MeetingBriefRunResult,
  type MeetingBriefUpcoming,
  meetingBriefOccurrenceIdentity,
  normalizeInternalDomains,
  parseMeetingBriefOccurrenceKey,
} from "@chief-of-staff-demo/shared";
import type { HostedModule } from "../../engine/host.js";
import { Runner, RunNotRetryableError } from "../../engine/runner.js";
import type { Runs } from "../../runs.js";
import { DurableClock, type DurableSchedule } from "../../engine/durableClock.js";
import {
  meetingBriefModule,
  type MeetingBriefInput,
  type MeetingBriefModuleDeps,
} from "./module.js";
import { HubSpotConnection } from "./hubspot/connection.js";
import type { HubSpotApi } from "./hubspot/client.js";
import type { MeetingBriefEnrichmentProviders } from "./enrichment/enrich.js";
import {
  MeetingBriefCalendarStore,
  type CalendarProvider,
  type MeetingBriefCalendarState,
  FakeCalendarProvider,
} from "./calendar.js";
import {
  ensureCalendarWatch,
  MEETING_BRIEF_CALENDAR_ID,
  occurrenceKeyFor,
  reconcileCalendar,
} from "./intake.js";
import { materialFingerprint } from "./revision.js";
import { type StoredSnapshot } from "./snapshot.js";
import type { ConfigStore } from "../../config.js";
import type { WorkspacePersonProfiles } from "../../person-profile/profiles.js";

export interface MeetingBriefHostDeps {
  runs: Runs;
  workspaceDir: string;
  now?: () => Date;
  log?: (message: string) => void;
  enrich?: MeetingBriefModuleDeps["enrich"];
  completeBrief?: MeetingBriefModuleDeps["completeBrief"];
  getCompleteJson?: MeetingBriefModuleDeps["getCompleteJson"];
  gmailDeliveryProvider?: MeetingBriefModuleDeps["gmailDeliveryProvider"];
  calendarProvider?: CalendarProvider;
  /**
   * What a Run does with Calendar. The provider above always drives Intake
   * reconciliation and watch renewal; this decides whether a Run sees it at all,
   * because most hosts want Calendar for Intake and nothing more.
   * - "snapshot": Calendar is authoritative. A failed read fails the snapshot
   *   Stage and a missing occurrence is an explicit skip. Delivery rechecks too,
   *   since a Run that holds the provider always rechecks before it sends.
   * - "recheck": the provider reaches delivery only; a failed snapshot read is
   *   best-effort and falls back to the Intake event.
   * Omitted, a Run never receives the provider.
   */
  calendarUse?: "snapshot" | "recheck";
  configStore?: ConfigStore;
  getInternalDomains?: () => string[];
  getOwnerEmail?: () => string | null;
  isOwnerProfileConfirmed?: () => boolean;
  enrichmentProviders?: MeetingBriefEnrichmentProviders;
  hubSpotConnection?: HubSpotConnection;
  personProfiles?: Pick<WorkspacePersonProfiles, "consumerState">;
}
/**
 * The one place snapshot.json is turned into a value. Null means the Run has no
 * snapshot or the file will not parse; every caller reads that as "nothing known
 * about this Run" and falls back to the Run result.
 */
function parseSnapshot(raw: string | null | undefined): StoredSnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSnapshot;
  } catch {
    return null;
  }
}

/**
 * The material fingerprint a Run froze at snapshot time. Reading it back beats
 * rebuilding the frozen event and re-fingerprinting it: the stored value is what
 * the Run actually compared against, and it cannot drift from `materialSnapshot`'s
 * field list. Null when the snapshot is missing or predates the field, which the
 * callers read as "cannot prove this revision is immaterial" and let the Run proceed.
 */
function storedFingerprint(snapshot: StoredSnapshot | null): string | null {
  return typeof snapshot?.materialFingerprint === "string" ? snapshot.materialFingerprint : null;
}

function isMeetingBriefEvent(value: unknown): value is MeetingBriefEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.occurrenceId === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.startAt === "string"
  );
}

class MeetingBriefRegenerationConflict extends Error {
  readonly code = "meeting-brief-profile-refresh-not-required";

  constructor(runId: string) {
    super(`Meeting Brief has no stale Person Profile consumers: ${runId}`);
    this.name = "MeetingBriefRegenerationConflict";
  }
}

function toUpcoming(schedule: {
  key: string;
  dueAt: string;
  input: unknown;
}): MeetingBriefUpcoming | null {
  const input = schedule.input;
  if (!isMeetingBriefEvent(input)) return null;
  return {
    occurrenceKey: schedule.key,
    eventId: input.eventId,
    occurrenceId: input.occurrenceId,
    version: input.version,
    summary: input.summary,
    startAt: input.startAt,
    dueAt: schedule.dueAt,
  };
}

/**
 * Meeting Brief Generator host — Module-owned Intake schedule store (Workspace-backed)
 * + Module host integration (issue://82, ADR-0032) + Calendar reconciliation (issue://83, ADR-0031).
 *
 * - Seeded fixture event enters durable Intake schedule (DurableClock, file-backed).
 * - Wakes at due time via real Runner/Runs store/durable clock/Workspace, creates
 *   exactly one Run at due time with 4 Stages, completes via injected fakes.
 * - No future blocked Run.
 * - Intake reconciles Calendar current state (header-only wake-ups never mistaken for data) via injectable CalendarProvider.
 * - Primary Calendar push channel persistence: local state for channel identity/token/resource/expiration/syncToken, durable replace before expiration.
 * - Incremental sync after each relay wake-up, startup + invalid-sync recovery triggers bounded reconciliation, duplicate harmless.
 * - Surface renders upcoming (Intake schedules) and completed Run state via public host behavior (Cross-Run index derived on read).
 *
 * Production providers are supplied by the composition root; tests inject bounded fakes.
 */
export class MeetingBriefHost implements HostedModule {
  readonly id = MEETING_BRIEF_MODULE_ID;
  readonly version = MEETING_BRIEF_MODULE_VERSION;

  private readonly runner: Runner<MeetingBriefInput>;
  private readonly clock: DurableClock;
  private readonly calendarStore: MeetingBriefCalendarStore;
  private readonly calendarProvider: CalendarProvider;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private lastFullSyncAt: Date | null = null;
  private maintenanceInProgress = false;
  private readonly fullSyncIntervalMs = 6 * 60 * 60 * 1000;
  private readonly hubSpotConnection: HubSpotConnection | null;
  private readonly getHubSpotApi: (() => HubSpotApi | null) | null;
  private readonly profileRegenerations = new Map<string, Promise<string>>();
  constructor(private readonly deps: MeetingBriefHostDeps) {
    this.now = deps.now ?? (() => new Date());
    this.clock = new DurableClock(deps.workspaceDir, this.now);
    this.calendarStore = new MeetingBriefCalendarStore(deps.workspaceDir);
    this.calendarProvider = deps.calendarProvider ?? new FakeCalendarProvider();
    // HubSpot wiring — per-user private-app token, Shell stores secret (issue://86)
    if (deps.hubSpotConnection) {
      this.hubSpotConnection = deps.hubSpotConnection;
    } else if (deps.configStore) {
      this.hubSpotConnection = new HubSpotConnection(deps.configStore);
    } else {
      this.hubSpotConnection = null;
    }
    if (deps.enrichmentProviders?.getHubSpotApi !== undefined) {
      this.getHubSpotApi = deps.enrichmentProviders.getHubSpotApi;
    } else if (this.hubSpotConnection) {
      const connection = this.hubSpotConnection;
      this.getHubSpotApi = () => connection.api();
    } else {
      this.getHubSpotApi = () => null;
    }
    const enrichmentProviders: MeetingBriefEnrichmentProviders = {
      ...deps.enrichmentProviders,
      getHubSpotApi: this.getHubSpotApi,
    };
    const module = meetingBriefModule({
      now: this.now,
      ...(deps.enrich ? { enrich: deps.enrich } : {}),
      ...(deps.completeBrief ? { completeBrief: deps.completeBrief } : {}),
      ...(deps.getCompleteJson ? { getCompleteJson: deps.getCompleteJson } : {}),
      ...(deps.gmailDeliveryProvider ? { gmailDeliveryProvider: deps.gmailDeliveryProvider } : {}),
      enrichmentProviders,
      getInternalDomains: () => this.getInternalDomains(),
      getOwnerEmail: () => this.getOwnerEmail(),
      ...(deps.isOwnerProfileConfirmed
        ? { isOwnerProfileConfirmed: deps.isOwnerProfileConfirmed }
        : {}),
      ...(deps.calendarProvider && deps.calendarUse
        ? { calendarProvider: this.calendarProvider }
        : {}),
      ...(deps.calendarUse === "snapshot" ? { calendarSnapshotRequired: true } : {}),
      ...(deps.personProfiles
        ? {
            personProfileConsumerState: deps.personProfiles.consumerState.bind(deps.personProfiles),
          }
        : {}),
    });
    this.runner = new Runner({ runs: deps.runs, module, now: this.now, log: deps.log });
  }

  retryRun(id: string): Promise<RunMeta> {
    const detail = this.deps.runs.detail(id);
    const requiresRegeneration = detail?.events.some(
      (event) =>
        event.type === "brief_delivery_blocked" &&
        event.detail?.reason === "person_profile_refresh_required",
    );
    if (requiresRegeneration) {
      this.deps.runs.open(id)?.appendEvent("retry_refused", {
        condition: "profile_refresh_requires_new_run",
      });
      return Promise.reject(
        new RunNotRetryableError(
          id,
          "module_declined",
          "Profile-derived claims require regeneration into a new immutable Brief",
        ),
      );
    }
    return this.runner.retryRun(id);
  }

  idle(): Promise<void> {
    return this.runner.idle();
  }

  // -------------------------------------------------------------------------
  // Internal helpers — Internal Domains & owner email resolution (issue://83)
  // -------------------------------------------------------------------------

  /** Normalized Internal Domains (case-insensitive after email parsing). */
  getInternalDomains(): string[] {
    if (this.deps.getInternalDomains) {
      return normalizeInternalDomains(this.deps.getInternalDomains());
    }
    if (this.deps.configStore) {
      try {
        const fromConfig =
          this.deps.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID).internalDomains;
        return normalizeInternalDomains(fromConfig);
      } catch {
        // config not loaded yet
      }
    }
    return [];
  }

  getOwnerEmail(): string | null {
    if (this.deps.getOwnerEmail) return this.deps.getOwnerEmail();
    return null;
  }

  /** Persist normalized Internal Domains via ConfigStore (issue://83). */
  setInternalDomains(domains: string[]): string[] {
    const normalized = normalizeInternalDomains(domains);
    if (this.deps.configStore) {
      const current = this.deps.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID);
      // Preserve other future fields (guest profile/hubspot) by merging
      const next = { ...current, internalDomains: normalized };
      this.deps.configStore.setModuleConfig(MEETING_BRIEF_MODULE_ID, next);
    }
    return normalized;
  }

  // -------------------------------------------------------------------------
  // Durable Intake schedule API (occurrences + Calendar reconciliation)
  // -------------------------------------------------------------------------

  /** `parseSnapshot` for a Run this caller has no handle on. */
  private readSnapshot(runId: string): StoredSnapshot | null {
    return parseSnapshot(this.deps.runs.open(runId)?.readArtifact("snapshot.json"));
  }

  /** Durably schedule a meeting occurrence (Intake schedule, not a Run). */
  scheduleOccurrence(event: MeetingBriefEvent, dueAt: Date): void {
    const key = occurrenceKeyFor(event);
    this.clock.schedule({
      module: MEETING_BRIEF_MODULE_ID,
      key,
      dueAt: dueAt.toISOString(),
      input: event,
    });
  }

  listUpcoming(): MeetingBriefUpcoming[] {
    return this.clock
      .list(MEETING_BRIEF_MODULE_ID)
      .map(toUpcoming)
      .filter((value): value is MeetingBriefUpcoming => value !== null)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  /** Cross-Run index derived on read (ADR-0005) — never a second copy. */
  index(): MeetingBriefIndex {
    const upcoming = this.listUpcoming();
    const briefs: MeetingBriefIndexEntry[] = [];
    const cancellations = new Map(
      this.calendarStore
        .load()
        .cancellations.map((cancellation) => [cancellation.occurrenceKey, cancellation]),
    );
    for (const summary of this.deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs) {
      const detail = this.deps.runs.detail(summary.id);
      if (!detail) continue;
      const result = detail.result as MeetingBriefRunResult | null;
      const handle = this.deps.runs.open(summary.id);
      const snapshot = parseSnapshot(handle?.readArtifact("snapshot.json"));
      const meta = handle?.read();
      const externalKey = meta?.externalId ?? null;
      const occurrenceKey = result?.occurrenceKey ?? snapshot?.occurrenceKey ?? externalKey;
      if (!occurrenceKey) continue;
      const externalIdentity = externalKey ? parseMeetingBriefOccurrenceKey(externalKey) : null;
      const eventId =
        result?.eventId ?? snapshot?.eventId ?? externalIdentity?.eventId ?? "unknown";
      const occurrenceId =
        result?.occurrenceId ??
        snapshot?.occurrenceId ??
        externalIdentity?.occurrenceId ??
        "unknown";
      briefs.push({
        runId: detail.id,
        createdAt: detail.createdAt,
        status: detail.status,
        eventId,
        occurrenceId,
        occurrenceKey,
        eventVersion: result?.eventVersion ?? snapshot?.version ?? "unknown",
        meetingBrief: result?.meetingBrief ?? null,
        delivery: result?.delivery ?? null,
        supersedes: result?.supersedes ?? snapshot?.supersedesRunId ?? null,
      });
      if (
        result?.deliverySkippedReason === "cancelled" ||
        result?.deliverySkippedReason === "occurrence_not_found"
      ) {
        cancellations.set(result.occurrenceKey, {
          occurrenceKey: result.occurrenceKey,
          eventId: result.eventId,
          occurrenceId: result.occurrenceId,
          version: result.eventVersion,
          summary: result.meetingBrief.logistics.title,
          cancelledAt: detail.createdAt,
        });
      }
    }
    briefs.sort((a, b) => {
      if (a.supersedes === b.runId) return -1;
      if (b.supersedes === a.runId) return 1;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
    return { upcoming, briefs, cancellations: [...cancellations.values()] };
  }

  // -------------------------------------------------------------------------
  // Calendar channel + sync persistence (issue://83)
  // -------------------------------------------------------------------------

  getCalendarState(): MeetingBriefCalendarState {
    return this.calendarStore.load();
  }

  /** Ensure the primary Calendar push channel exists and is not expiring soon (durable replace before expiration). */
  async ensureCalendarWatch(): Promise<void> {
    const args: Parameters<typeof ensureCalendarWatch>[0] = {
      provider: this.calendarProvider,
      store: this.calendarStore,
      now: this.now(),
      calendarId: MEETING_BRIEF_CALENDAR_ID,
    };
    if (this.deps.log) args.log = this.deps.log;
    await ensureCalendarWatch(args);
  }

  /**
   * Reconcile Calendar current state against Intake schedules.
   * Header-only wake-ups never mistaken for data — we fetch Calendar after each wake-up.
   * Bounded reconciliation on invalid sync.
   */
  async reconcileCalendar(options: { forceFullSync?: boolean } = {}): Promise<{
    scheduled: number;
    removed: number;
    invalidSyncRecovered: boolean;
  }> {
    const args: Parameters<typeof reconcileCalendar>[0] = {
      provider: this.calendarProvider,
      store: this.calendarStore,
      clock: this.clock,
      ownerEmail: () => this.getOwnerEmail(),
      now: this.now(),
      calendarId: MEETING_BRIEF_CALENDAR_ID,
      forceFullSync: options.forceFullSync ?? false,
    };
    if (this.deps.log) args.log = this.deps.log;
    return reconcileCalendar(args);
  }

  /**
   * Simulate a relay wake-up (header-only) — reconciles Calendar incremental sync.
   * Payload is ignored (never mistaken for data); we fetch current Calendar state.
   * Duplicate wake-ups are harmless (idempotent).
   */
  async handleRelayWakeUp(_messages?: unknown): Promise<{
    scheduled: number;
    removed: number;
    invalidSyncRecovered: boolean;
  }> {
    void _messages;
    // Ensure channel is still valid before incremental sync (durable replace before expiration)
    await this.ensureCalendarWatch().catch(() => {
      // best-effort; reconciliation still tries
    });
    return this.reconcileCalendar();
  }

  /**
   * Check durable Intake schedules whose dueAt <= now, create exactly one Run per
   * due occurrence using the real Runner/Runs, and remove the schedule.
   * Idempotent: duplicate wake-ups for the same version are no-ops (ADR-0033).
   * Material change detection (ADR-0033): ignored metadata never creates a revision.
   * Revision linking: material change after completed Run creates linked Run (supersedes).
   */
  async processDueSchedules(now = this.now()): Promise<string[]> {
    const due = this.clock.due(now);
    const created: string[] = [];
    for (const record of due) {
      if (record.module !== MEETING_BRIEF_MODULE_ID) continue;
      const runId = await this.startBriefForSchedule(record);
      if (runId) created.push(runId);
    }
    return created;
  }

  /**
   * Turn one durable schedule into a Run, applying the supersession and
   * fingerprint rules that decide whether this occurrence still deserves one.
   * Returns the Run id, or null when the schedule was spent without a Run.
   */
  private async startBriefForSchedule(record: DurableSchedule): Promise<string | null> {
    const key = record.key;
    const input = record.input;
    if (!isMeetingBriefEvent(input)) {
      this.clock.remove(record.module, key);
      return null;
    }
    const related = this.deps.runs
      .list({ module: MEETING_BRIEF_MODULE_ID })
      .runs.map((r) => {
        const handle = this.deps.runs.open(r.id);
        const meta = handle?.read();
        const detail = this.deps.runs.detail(r.id);
        const result = detail?.result as MeetingBriefRunResult | null;
        return { id: r.id, meta, detail, result };
      })
      .filter((r) => r.meta?.externalId === key);
    const activeRuns = related.filter(
      (r) => r.meta && ["pending", "running", "blocked"].includes(r.meta.status),
    );
    if (activeRuns.length > 0) {
      const sameVersionActive = activeRuns.some((r) => {
        const snap = this.readSnapshot(r.id);
        if (snap) return snap.version === input.version;
        return r.result?.eventVersion === input.version;
      });
      if (sameVersionActive) {
        this.clock.remove(record.module, key);
        return null;
      }
      const hasNonQuietActive = activeRuns.some(
        (r) => !(r.meta?.status === "blocked" && r.meta.wait?.reason === "quiet_period"),
      );
      if (hasNonQuietActive) {
        // Defer revision while prior Run is still enriching/composing/delivering (non-quiet)
        return null;
      }
      // All active are quiet_period waits — allow new revision to supersede and reset quiet period
    }

    const duplicateVersion = related.some((r) => {
      const snap = this.readSnapshot(r.id);
      if (snap?.version === input.version) return true;
      return r.result?.eventVersion === input.version;
    });
    if (duplicateVersion) {
      this.clock.remove(record.module, key);
      return null;
    }

    const doneRuns = related.filter((r) => r.meta?.status === "done" && r.result);
    let latestDone: (typeof doneRuns)[number] | null = null;
    for (const r of doneRuns) {
      if (
        !latestDone ||
        (r.meta &&
          latestDone.meta &&
          Date.parse(r.meta.createdAt) > Date.parse(latestDone.meta.createdAt))
      ) {
        latestDone = r;
      }
    }
    if (latestDone && latestDone.result) {
      const prevFingerprint = storedFingerprint(this.readSnapshot(latestDone.id));
      if (prevFingerprint) {
        const curFingerprint = materialFingerprint(input);
        if (prevFingerprint === curFingerprint) {
          this.clock.remove(record.module, key);
          return null;
        }
      }
    }

    // Ignored-metadata dedup against newest blocked/active snapshot (quiet period)
    {
      let newestActive: (typeof related)[number] | null = null;
      for (const r of related) {
        if (r.meta && ["pending", "running", "blocked"].includes(r.meta.status)) {
          if (
            !newestActive ||
            (r.meta &&
              newestActive.meta &&
              Date.parse(r.meta.createdAt) > Date.parse(newestActive.meta.createdAt))
          ) {
            newestActive = r;
          }
        }
      }
      if (newestActive) {
        const activeFingerprint = storedFingerprint(this.readSnapshot(newestActive.id));
        if (activeFingerprint) {
          const curFingerprint = materialFingerprint(input);
          if (activeFingerprint === curFingerprint) {
            this.clock.remove(record.module, key);
            return null;
          }
        }
      }
    }

    // Quiet-period supersession: if a prior revision is blocked on quiet wait, supersede it directly
    const quietBlocked = related.filter(
      (r) => r.meta?.status === "blocked" && r.meta.wait?.reason === "quiet_period",
    );
    let supersedesRunId: string | null;
    if (quietBlocked.length > 0) {
      let latestQuiet = quietBlocked[0]!;
      for (const r of quietBlocked) {
        if (Date.parse(r.meta!.createdAt) > Date.parse(latestQuiet.meta!.createdAt))
          latestQuiet = r;
      }
      supersedesRunId = latestQuiet.id;
    } else {
      supersedesRunId = latestDone?.id ?? null;
    }
    const runInput: MeetingBriefInput = {
      ...input,
      occurrenceKey: key,
      ...(supersedesRunId ? { supersedesRunId } : {}),
    };
    const runId = await this.runner.startRun(
      {
        intake: MEETING_BRIEF_INTAKE,
        sourceUrl: null,
        externalId: key,
      },
      runInput,
    );
    this.clock.remove(record.module, key);
    return runId;
  }

  /**
   * Prepare a scheduled occurrence now rather than at its due time — the
   * Module's manual Run. It takes the same path a due schedule does, so
   * supersession, versioning and dedup behave identically.
   */
  async prepareNow(occurrenceKey: string): Promise<string | null> {
    const record = this.clock
      .list(MEETING_BRIEF_MODULE_ID)
      .find((schedule) => schedule.key === occurrenceKey);
    if (!record) throw new Error(`Meeting occurrence is not scheduled: ${occurrenceKey}`);
    return this.startBriefForSchedule(record);
  }

  /**
   * Explicitly regenerate a stale immutable Brief in a new Run. The old Run is
   * never reopened or rewritten: its frozen event remains the input receipt,
   * while enrichment and composition execute again against current Profile truth.
   */
  async regenerateRun(runId: string): Promise<string> {
    const active = this.profileRegenerations.get(runId);
    if (active) return active;

    const existing = this.deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs.find((run) => {
      const result = this.deps.runs.detail(run.id)?.result as
        MeetingBriefRunResult | null | undefined;
      return result?.profileRefreshOf === runId;
    });
    if (existing) {
      const resolved = Promise.resolve(existing.id);
      this.profileRegenerations.set(runId, resolved);
      return resolved;
    }

    const handle = this.deps.runs.open(runId);
    const meta = handle?.read();
    const detail = this.deps.runs.detail(runId);
    if (!handle || meta?.module !== MEETING_BRIEF_MODULE_ID || !detail?.result)
      throw new Error(`Meeting Brief Run not found: ${runId}`);
    const snapshotRaw = handle.readArtifact("snapshot.json");
    if (!snapshotRaw)
      throw new Error(`Meeting Brief cannot be regenerated without its snapshot: ${runId}`);
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(snapshotRaw);
    } catch {
      throw new Error(`Meeting Brief snapshot is not readable: ${runId}`);
    }
    if (!isMeetingBriefEvent(snapshot))
      throw new Error(`Meeting Brief snapshot is incomplete: ${runId}`);
    const result = detail.result as MeetingBriefRunResult;
    const hasStaleConsumer = this.profileReadModel(result).consumers.some(
      ({ state }) => state?.refreshRequired === true,
    );
    if (!hasStaleConsumer) throw new MeetingBriefRegenerationConflict(runId);
    const storedOccurrenceKey = (snapshot as unknown as { occurrenceKey?: unknown }).occurrenceKey;
    const occurrenceKey =
      typeof storedOccurrenceKey === "string"
        ? storedOccurrenceKey
        : meetingBriefOccurrenceIdentity(snapshot.eventId, snapshot.occurrenceId).occurrenceKey;
    const regeneration = this.runner.startRun(
      {
        intake: MEETING_BRIEF_INTAKE,
        sourceUrl: null,
        externalId: meta.externalId ?? occurrenceKey,
      },
      {
        ...snapshot,
        occurrenceKey,
        supersedesRunId: runId,
        profileRefreshOf: runId,
      },
    );
    this.profileRegenerations.set(runId, regeneration);
    try {
      return await regeneration;
    } catch (error) {
      if (this.profileRegenerations.get(runId) === regeneration)
        this.profileRegenerations.delete(runId);
      throw error;
    }
  }

  private profileReadModel(result: MeetingBriefRunResult): MeetingBriefPersonProfileReadModel {
    return {
      consumers: (result.personProfileLinks ?? []).map((link) => ({
        link,
        state:
          this.deps.personProfiles?.consumerState(link.profileId, link.profileRevision) ?? null,
      })),
    };
  }

  /** Recovery scans due records on boot (covers ADR-0032 without blocked Runs) + bounded Calendar reconciliation (issue://83). */
  async recover(): Promise<number> {
    const runsRecovered = await this.runner.recoverRuns();
    // Calendar channel renewal + bounded full look-ahead (startup establishes 90-day horizon)
    try {
      await this.ensureCalendarWatch();
    } catch {
      // provider may be fake or not configured — ignore
    }
    try {
      await this.reconcileCalendar({ forceFullSync: true });
      this.lastFullSyncAt = new Date(this.now());
    } catch {
      // Calendar unavailable — durable schedules remain, recovery still returns
    }
    const due = this.clock.due(this.now());
    if (due.length > 0) {
      await this.processDueSchedules(this.now());
    }
    return runsRecovered;
  }

  /** Periodic maintenance: watch renewal, bounded full reconcile on cadence, and due schedules. Avoids overlapping ticks. */
  async maintenanceTick(now = this.now()): Promise<void> {
    if (this.maintenanceInProgress) return;
    this.maintenanceInProgress = true;
    try {
      await this.ensureCalendarWatch().catch(() => {});
      const shouldFullSync =
        this.lastFullSyncAt === null ||
        now.getTime() - this.lastFullSyncAt.getTime() >= this.fullSyncIntervalMs;
      if (shouldFullSync) {
        try {
          await this.reconcileCalendar({ forceFullSync: true });
          this.lastFullSyncAt = new Date(now);
        } catch {
          // ignore — next tick will retry
        }
      }
      await this.processDueSchedules(now);
    } finally {
      this.maintenanceInProgress = false;
    }
  }

  start(): void {
    this.runner.startRecoveryLoop();
    void this.recover();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.maintenanceTick(), 30_000);
    this.timer.unref();
  }

  stop(): void {
    this.runner.stopRecoveryLoop();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Live Module (issue://92) — Settings/Intake plus Cross-Run index. The
  async routes(app: FastifyInstance): Promise<void> {
    app.post("/api/meeting-brief/runs/:id/regenerate", async (request, reply) => {
      const { id } = request.params as { id: string };
      const detail = this.deps.runs.detail(id);
      if (detail?.module !== MEETING_BRIEF_MODULE_ID) {
        reply.code(404);
        return { error: "meeting-brief-run-not-found" };
      }
      try {
        const runId = await this.regenerateRun(id);
        reply.code(202);
        return { runId };
      } catch (error) {
        reply.code(409);
        return {
          error:
            error instanceof MeetingBriefRegenerationConflict
              ? error.code
              : "meeting-brief-regeneration-unavailable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });

    app.get("/api/meeting-brief/runs/:id/profile-consumers", async (request, reply) => {
      const { id } = request.params as { id: string };
      const detail = this.deps.runs.detail(id);
      const result = detail?.result as MeetingBriefRunResult | null | undefined;
      if (detail?.module !== MEETING_BRIEF_MODULE_ID || !result) {
        reply.code(404);
        return { error: "meeting-brief-run-not-found" };
      }
      return this.profileReadModel(result);
    });

    // GET /api/meeting-brief/index — Cross-Run index derived on read (ADR-0005)
    app.get("/api/meeting-brief/index", async () => {
      return this.index();
    });

    // GET /api/meetings/overview — the Meeting Wizard read projection (spec
    // Implementation Decision 3, kept separate per Decision 9): a read over
    // Calendar occurrences and Brief state that links sibling records
    // without owning a combined lifecycle record. Brief and Debrief remain
    // separate lifecycles (ADR-0043).
    app.get("/api/meetings/overview", async () => {
      return this.index();
    });

    // GET /api/meeting-brief/config — normalized Internal Domains only.
    app.get("/api/meeting-brief/config", async () => {
      return { internalDomains: this.getInternalDomains() };
    });

    // PUT /api/meeting-brief/config — configure normalized Internal Domains
    app.put("/api/meeting-brief/config", async (request, reply) => {
      const body = request.body as { internalDomains?: unknown } | undefined;
      if (!body || !Array.isArray(body.internalDomains)) {
        return reply.code(400).send({ error: "internalDomains must be an array of strings" });
      }
      if (!body.internalDomains.every((d) => typeof d === "string")) {
        return reply.code(400).send({ error: "internalDomains must be strings" });
      }
      const normalized = this.setInternalDomains(body.internalDomains);
      // After domain change, re-reconcile Calendar so eligibility reflects new domains
      try {
        await this.reconcileCalendar({ forceFullSync: true });
      } catch {
        // ignore reconciliation failure — config still persisted
      }
      return { internalDomains: normalized };
    });

    // POST /api/meeting-brief/reconcile — manual trigger (for Settings "Check calendar" or tests)
    app.post("/api/meeting-brief/reconcile", async (request) => {
      const body = (request.body as { forceFullSync?: unknown } | undefined) ?? {};
      const forceFullSync = body.forceFullSync === true;
      try {
        const result = await this.reconcileCalendar({ forceFullSync });
        return { ...result, upcoming: this.listUpcoming() };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
          upcoming: this.listUpcoming(),
        };
      }
    });

    // GET /api/meeting-brief/calendar/status — channel + sync state (no token secret)
    /* The Module's manual Run: prepare an upcoming brief without waiting for
       its scheduled prep time. */
    app.post("/api/meeting-brief/prepare", async (request, reply) => {
      const body = (request.body as { occurrenceKey?: unknown } | undefined) ?? {};
      const occurrenceKey = typeof body.occurrenceKey === "string" ? body.occurrenceKey : "";
      if (!occurrenceKey) {
        reply.code(400).send({ error: "occurrenceKey is required" });
        return;
      }
      try {
        const runId = await this.prepareNow(occurrenceKey);
        return { runId, upcoming: this.listUpcoming() };
      } catch (error) {
        reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });

    app.get("/api/meeting-brief/calendar/status", async () => {
      const state = this.getCalendarState();
      return {
        channel: state.channel
          ? {
              channelId: state.channel.channelId,
              resourceId: state.channel.resourceId,
              expiration: state.channel.expiration,
              calendarId: state.channel.calendarId,
            }
          : null,
        syncToken: state.syncToken ? `${state.syncToken.slice(0, 6)}…` : null,
        hasToken: Boolean(state.channel?.token),
        lastSyncAt: state.lastSyncAt,
      };
    });
  }
}
