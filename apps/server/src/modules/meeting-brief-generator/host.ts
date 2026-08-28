import type { FastifyInstance } from "fastify";
import type { RunMeta } from "@chief-of-staff-demo/shared";
import {
  MEETING_BRIEF_INTAKE,
  MEETING_BRIEF_MODULE_ID,
  MEETING_BRIEF_MODULE_VERSION,
  type MeetingBriefFixtureEvent,
  type MeetingBriefIndex,
  type MeetingBriefIndexEntry,
  type MeetingBriefRunResult,
  type MeetingBriefUpcoming,
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

export interface MeetingBriefHostDeps {
  runs: Runs;
  workspaceDir: string;
  now?: () => Date;
  log?: (message: string) => void;
  enrich?: MeetingBriefModuleDeps["enrich"];
  completeBrief?: MeetingBriefModuleDeps["completeBrief"];
  deliver?: MeetingBriefModuleDeps["deliver"];
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
 * + Module host integration (issue://82, ADR-0032).
 *
 * - Seeded fixture event enters durable Intake schedule (DurableClock, file-backed).
 * - Wakes at due time via real Runner/Runs store/durable clock/Workspace, creates
 *   exactly one Run at due time with 4 Stages, completes via injected fakes.
 * - No future blocked Run.
 * - Surface renders upcoming (Intake schedules) and completed fixture state via
 *   public host behavior (Cross-Run index derived on read).
 *
 * Planned until production providers are connected — not registered as live in `main.ts`.
 */
export class MeetingBriefHost implements HostedModule {
  readonly id = MEETING_BRIEF_MODULE_ID;
  readonly version = MEETING_BRIEF_MODULE_VERSION;

  private readonly runner: Runner<MeetingBriefInput>;
  private readonly clock: DurableClock;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: MeetingBriefHostDeps) {
    this.now = deps.now ?? (() => new Date());
    this.clock = new DurableClock(deps.workspaceDir, this.now);
    const module = meetingBriefModule({
      now: this.now,
      ...(deps.enrich ? { enrich: deps.enrich } : {}),
      ...(deps.completeBrief ? { completeBrief: deps.completeBrief } : {}),
      ...(deps.deliver ? { deliver: deps.deliver } : {}),
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
    const start = Date.parse(event.startAt);
    const due = new Date(start - 4 * 60 * 60 * 1000);
    const effective = due.getTime() <= this.now().getTime() ? this.now() : due;
    this.scheduleOccurrence(event, effective);
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

  /**
   * Check durable Intake schedules whose dueAt <= now, create exactly one Run per
   * due occurrence using the real Runner/Runs, and remove the schedule.
   * Idempotent: duplicate wake-ups for the same version are no-ops (ADR-0033).
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
      const existing = this.deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs.some((r) => {
        const handle = this.deps.runs.open(r.id);
        const meta = handle?.read();
        if (!meta || meta.externalId !== key) return false;
        const detail = this.deps.runs.detail(r.id);
        const result = detail?.result as MeetingBriefRunResult | null;
        if (result && result.eventVersion === input.version) return true;
        if (!result) return true;
        return false;
      });
      if (existing) {
        this.clock.remove(record.module, key);
        continue;
      }
      const runInput: MeetingBriefInput = {
        ...input,
        occurrenceKey: key,
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

  /** Recovery scans due records on boot (covers ADR-0032 without blocked Runs). */
  async recover(): Promise<number> {
    const runsRecovered = await this.runner.recoverRuns();
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

  // Keep Module planned — no routes exposed as live. Host surface is via public methods above.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  routes(_app: FastifyInstance): void {}
}
