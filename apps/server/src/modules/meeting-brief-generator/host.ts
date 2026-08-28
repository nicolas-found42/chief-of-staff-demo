/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { FastifyInstance } from "fastify";
import type { RunMeta } from "@chief-of-staff-demo/shared";
import {
  GUEST_PROFILE_PROVIDER_NAME,
  GUEST_PROFILE_PROVIDER_ID,
  MEETING_BRIEF_INTAKE,
  MEETING_BRIEF_MODULE_ID,
  MEETING_BRIEF_MODULE_VERSION,
  type MeetingBriefFixtureEvent,
  type MeetingBriefIndex,
  type MeetingBriefIndexEntry,
  type MeetingBriefRunResult,
  type MeetingBriefUpcoming,
  normalizeInternalDomains,
} from "@chief-of-staff-demo/shared";
import type { HostedModule } from "../../engine/host.js";
import { Runner } from "../../engine/runner.js";
import type { Runs } from "../../runs.js";
import { DurableClock } from "../../engine/durableClock.js";
import {
  meetingBriefModule,
  type MeetingBriefInput,
  type MeetingBriefModuleDeps,
} from "./module.js";
import { GuestProfileConnection } from "./connections/profile.js";
import { createHttpGuestProfileProvider, type GuestProfileProvider } from "./profile/provider.js";
import type { GmailProvider } from "./google/gmail.js";
import type { CalendarHistoryProvider } from "./google/calendarHistory.js";
import type { DriveProvider } from "./google/drive.js";
import {
  MeetingBriefCalendarStore,
  type CalendarEvent,
  type CalendarProvider,
  type MeetingBriefCalendarState,
  FakeCalendarProvider,
} from "./calendar.js";
import {
  computeDueTime,
  ensureCalendarWatch,
  MEETING_BRIEF_CALENDAR_ID,
  reconcileCalendar,
} from "./intake.js";
import { materialFingerprint } from "./revision.js";
import type { ConfigStore } from "../../config.js";

export interface MeetingBriefHostDeps {
  runs: Runs;
  workspaceDir: string;
  now?: () => Date;
  log?: (message: string) => void;
  enrich?: MeetingBriefModuleDeps["enrich"];
  completeBrief?: MeetingBriefModuleDeps["completeBrief"];
  deliver?: MeetingBriefModuleDeps["deliver"];
  calendarProvider?: CalendarProvider;
  configStore?: ConfigStore;
  ownerEmail?: string | null;
  getInternalDomains?: () => string[];
  getOwnerEmail?: () => string | null;
  guestProfileConnection?: GuestProfileConnection;
  profileProvider?: GuestProfileProvider | null;
  gmailProvider?: GmailProvider | null;
  calendarHistoryProvider?: CalendarHistoryProvider | null;
  driveProvider?: DriveProvider | null;
  internalDomains?: string[];
}
function occurrenceKeyFor(event: MeetingBriefFixtureEvent): string {
  return `${event.eventId}::${event.occurrenceId}`;
}

function isFixtureEvent(value: unknown): value is MeetingBriefFixtureEvent {
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

function toUpcoming(schedule: {
  key: string;
  dueAt: string;
  input: unknown;
}): MeetingBriefUpcoming | null {
  const input = schedule.input;
  if (!isFixtureEvent(input)) return null;
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
 * - Surface renders upcoming (Intake schedules) and completed fixture state via public host behavior (Cross-Run index derived on read).
 *
 * Planned until production providers are connected — not registered as live in `main.ts` yet.
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
  private readonly guestProfileConnection: GuestProfileConnection | null;
  private readonly profileProvider: GuestProfileProvider | null;

  constructor(private readonly deps: MeetingBriefHostDeps) {
    this.now = deps.now ?? (() => new Date());
    this.clock = new DurableClock(deps.workspaceDir, this.now);
    this.calendarStore = new MeetingBriefCalendarStore(deps.workspaceDir);
    this.calendarProvider = deps.calendarProvider ?? new FakeCalendarProvider();
    if (deps.guestProfileConnection) {
      this.guestProfileConnection = deps.guestProfileConnection;
    } else if (deps.configStore) {
      this.guestProfileConnection = new GuestProfileConnection(deps.configStore, null, this.now);
    } else {
      this.guestProfileConnection = null;
    }
    if (deps.profileProvider !== undefined) {
      this.profileProvider = deps.profileProvider;
    } else if (this.guestProfileConnection) {
      const connection = this.guestProfileConnection;
      const dynamic: GuestProfileProvider = {
        id: GUEST_PROFILE_PROVIDER_ID,
        async lookup(input) {
          const current = connection.providerForCurrentConfig();
          if (!current) throw new Error("Guest Profile not configured");
          return current.lookup(input);
        },
      };
      this.profileProvider = dynamic;
    } else {
      this.profileProvider = createHttpGuestProfileProvider();
    }
    const status = this.guestProfileConnection?.status();
    const resolvedApiKey = (() => {
      if (!deps.configStore) return undefined;
      try {
        const cfg = deps.configStore.get().modules["meeting-brief-generator"] as unknown as {
          guestProfile?: { apiKey: string };
        };
        return cfg.guestProfile?.apiKey ?? undefined;
      } catch {
        return undefined;
      }
    })();
    const module = meetingBriefModule({
      now: this.now,
      ...(deps.enrich ? { enrich: deps.enrich } : {}),
      ...(deps.completeBrief ? { completeBrief: deps.completeBrief } : {}),
      ...(deps.deliver ? { deliver: deps.deliver } : {}),
      ...(this.profileProvider ? { profileProvider: this.profileProvider } : {}),
      ...(status?.endpoint ? { guestProfileEndpoint: status.endpoint } : {}),
      ...(resolvedApiKey ? { guestProfileApiKey: resolvedApiKey } : {}),
      ...(deps.gmailProvider ? { gmailProvider: deps.gmailProvider } : {}),
      ...(deps.calendarHistoryProvider ? { calendarHistoryProvider: deps.calendarHistoryProvider } : {}),
      ...(deps.driveProvider ? { driveProvider: deps.driveProvider } : {}),
      ...(deps.internalDomains ? { internalDomains: deps.internalDomains } : {}),
      getInternalDomains: () => this.getInternalDomains(),
      getOwnerEmail: () => this.getOwnerEmail(),
      calendarProvider: this.calendarProvider,
      invalidateIndex: () => {},
    });
    this.runner = new Runner({ runs: deps.runs, module, now: this.now, log: deps.log });
  }

  retryRun(id: string): Promise<RunMeta> {
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
          this.deps.configStore.get().modules["meeting-brief-generator"].internalDomains;
        return normalizeInternalDomains(fromConfig);
      } catch {
        // config not loaded yet
      }
    }
    return [];
  }

  getOwnerEmail(): string | null {
    if (this.deps.getOwnerEmail) return this.deps.getOwnerEmail();
    if (this.deps.ownerEmail !== undefined) return this.deps.ownerEmail;
    // Fallback: try to read from configStore? ownerEmail comes from Google connection; for fixture null is fine.
    return null;
  }

  /** Persist normalized Internal Domains via ConfigStore (issue://83). */
  setInternalDomains(domains: string[]): string[] {
    const normalized = normalizeInternalDomains(domains);
    if (this.deps.configStore) {
      const current = this.deps.configStore.get().modules["meeting-brief-generator"];
      // Preserve other future fields (guest profile/hubspot) by merging
      const next = { ...current, internalDomains: normalized };
      this.deps.configStore.setModuleConfig("meeting-brief-generator", next);
    }
    return normalized;
  }

  // -------------------------------------------------------------------------
  // Durable Intake schedule API (fixture + calendar reconciliation)
  // -------------------------------------------------------------------------

  /** Durably schedule a fixture occurrence (Intake schedule, not a Run). */
  scheduleOccurrence(event: MeetingBriefFixtureEvent, dueAt: Date): void {
    const key = occurrenceKeyFor(event);
    this.clock.schedule({
      module: MEETING_BRIEF_MODULE_ID,
      key,
      dueAt: dueAt.toISOString(),
      input: event,
    });
  }

  /** Convenience: 4-hour preparation offset fixture (or immediate if inside window). */
  scheduleFixture(event: MeetingBriefFixtureEvent): void {
    const due = computeDueTime(event.startAt, this.now());
    this.scheduleOccurrence(event, due);
  }

  removeOccurrence(eventId: string, occurrenceId: string): void {
    this.clock.remove(MEETING_BRIEF_MODULE_ID, `${eventId}::${occurrenceId}`);
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
    for (const summary of this.deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs) {
      const detail = this.deps.runs.detail(summary.id);
      if (!detail) continue;
      const result = detail.result as MeetingBriefRunResult | null;
      if (!result || typeof result !== "object" || !("occurrenceKey" in result)) {
        continue;
      }
      briefs.push({
        runId: detail.id,
        createdAt: detail.createdAt,
        status: detail.status,
        eventId: result.eventId,
        occurrenceId: result.occurrenceId,
        occurrenceKey: result.occurrenceKey,
        eventVersion: result.eventVersion,
        meetingBrief: result.meetingBrief,
        delivery: result.delivery,
        supersedes: result.supersedes ?? null,
      });
    }
    return { upcoming, briefs };
  }

  // -------------------------------------------------------------------------
  // Calendar channel + sync persistence (issue://83)
  // -------------------------------------------------------------------------

  getCalendarState(): MeetingBriefCalendarState {
    return this.calendarStore.load();
  }

  getCalendarProvider(): CalendarProvider {
    return this.calendarProvider;
  }

  getCalendarStore(): MeetingBriefCalendarStore {
    return this.calendarStore;
  }

  getClock(): DurableClock {
    return this.clock;
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
      internalDomains: this.getInternalDomains(),
      ownerEmail: this.getOwnerEmail(),
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
      const key = record.key;
      const input = record.input;
      if (!isFixtureEvent(input)) {
        this.clock.remove(record.module, key);
        continue;
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

      const inFlight = related.some(
        (r) => r.meta && ["pending", "running", "blocked"].includes(r.meta.status),
      );
      if (inFlight) {
        const sameVersionInFlight = related.some((r) => {
          if (!r.meta || !["pending", "running", "blocked"].includes(r.meta.status)) return false;
          const snapRaw = this.deps.runs.open(r.id)?.readArtifact("snapshot.json");
          if (snapRaw) {
            try {
              const snap = JSON.parse(snapRaw) as { version?: string };
              return snap.version === input.version;
            } catch {
              return false;
            }
          }
          const res = r.result;
          return res?.eventVersion === input.version;
        });
        if (sameVersionInFlight) {
          this.clock.remove(record.module, key);
        }
        continue;
      }

      const duplicateVersion = related.some((r) => r.result?.eventVersion === input.version);
      if (duplicateVersion) {
        this.clock.remove(record.module, key);
        continue;
      }

      const doneRuns = related.filter((r) => r.meta?.status === "done" && r.result);
      let latestDone: (typeof doneRuns)[number] | null = null;
      for (const r of doneRuns) {
        if (
          !latestDone ||
          (r.meta && latestDone.meta && Date.parse(r.meta.createdAt) < Date.parse(r.meta.createdAt))
        ) {
          latestDone = r;
        }
      }
      if (latestDone && latestDone.result) {
        const prevSnapRaw = this.deps.runs.open(latestDone.id)?.readArtifact("snapshot.json");
        let prevFingerprint: string | null = null;
        if (prevSnapRaw) {
          try {
            const prevSnap = JSON.parse(prevSnapRaw) as Record<string, unknown> & {
              summary: string;
              description: string;
              startAt: string;
              endAt: string;
              location: string | null;
              conferenceLink: string | null;
              attachments: string[];
              organizer: { email: string } | undefined;
              attendees: unknown[];
            };
            const synthetic = {
              summary: String(prevSnap.summary ?? ""),
              description: prevSnap.description as string | undefined,
              startAt: String(prevSnap.startAt),
              endAt: String(prevSnap.endAt),
              location: prevSnap.location,
              conferenceLink: prevSnap.conferenceLink,
              organizer: prevSnap.organizer as { email: string } | undefined,
              attendees:
                (prevSnap.attendees as {
                  email: string;
                  responseStatus: string;
                  organizer?: boolean;
                  resource?: boolean;
                }[]) ?? [],
              attachments: (prevSnap.attachments) ?? [],
            } as unknown as CalendarEvent;
            prevFingerprint = materialFingerprint(synthetic);
          } catch {
            prevFingerprint = null;
          }
        }
        if (prevFingerprint) {
          const curFingerprint = materialFingerprint(input);
          if (prevFingerprint === curFingerprint) {
            this.clock.remove(record.module, key);
            continue;
          }
        }
      }

      const supersedesRunId = latestDone?.id ?? null;
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
      created.push(runId);
    }
    return created;
  }

  /** Recovery scans due records on boot (covers ADR-0032 without blocked Runs) + bounded Calendar reconciliation (issue://83). */
  async recover(): Promise<number> {
    const runsRecovered = await this.runner.recoverRuns();
    // Calendar channel renewal + bounded reconciliation (startup recovery)
    try {
      await this.ensureCalendarWatch();
    } catch {
      // provider may be fake or not configured — ignore
    }
    try {
      await this.reconcileCalendar();
    } catch {
      // Calendar unavailable — durable schedules remain, recovery still returns
    }
    const due = this.clock.due(this.now());
    if (due.length > 0) {
      await this.processDueSchedules(this.now());
    }
    return runsRecovered;
  }

  start(): void {
    this.runner.startRecoveryLoop();
    void this.recover();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.processDueSchedules(), 30_000);
    this.timer.unref();
  }

  stop(): void {
    this.runner.stopRecoveryLoop();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Keep Module planned — but expose narrow Settings/Intake + Guest Profile surface via host routes (issue://83,87).
  async routes(app: FastifyInstance): Promise<void> {
    app.get("/api/meeting-brief/guest-profile/status", async () => {
      if (!this.guestProfileConnection) {
        return {
          provider: GUEST_PROFILE_PROVIDER_NAME,
          endpoint: null,
          apiKeyHint: "",
          state: "unconfigured" as const,
          lastVerifiedAt: null,
          lastCheck: null,
        };
      }
      return this.guestProfileConnection.status();
    });

    app.post("/api/meeting-brief/guest-profile/connect", async (request, reply) => {
      if (!this.guestProfileConnection) {
        reply.code(500).send({ error: "Guest Profile connection not configured" });
        return;
      }
      const body = request.body as { endpoint?: string; apiKey?: string };
      try {
        const status = this.guestProfileConnection.connect(body.endpoint ?? "", body.apiKey ?? "");
        return status;
      } catch (e) {
        reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
    });

    app.post("/api/meeting-brief/guest-profile/disconnect", async () => {
      if (!this.guestProfileConnection) {
        return {
          provider: GUEST_PROFILE_PROVIDER_NAME,
          endpoint: null,
          apiKeyHint: "",
          state: "unconfigured" as const,
          lastVerifiedAt: null,
          lastCheck: null,
        };
      }
      return this.guestProfileConnection.disconnect();
    });

    app.post("/api/meeting-brief/guest-profile/check", async () => {
      if (!this.guestProfileConnection) {
        return {
          state: "unconfigured" as const,
          detail: "Guest Profile not configured",
          checkedAt: this.now().toISOString(),
        };
      }
      return this.guestProfileConnection.verifySetup();
    });

    // GET /api/meeting-brief/index — Cross-Run index derived on read (ADR-0005)
    app.get("/api/meeting-brief/index", async () => {
      return this.index();
    });

    // GET /api/meeting-brief/config — normalized Internal Domains
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
