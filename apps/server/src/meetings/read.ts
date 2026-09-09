import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import type {
  ActionItem,
  Meeting,
  MeetingArtifact,
  MeetingReadRow,
  MeetingWorkspaceView,
  MeetingHistoryView,
  TranscriptRecord,
  MeetingBriefRunResult,
  MeetingDebriefRunResult,
  RunMeta,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceMeetings } from "./store.js";
import type { Runs } from "../runs.js";
import type { WorkspaceActionItems } from "../tasks/action-items.js";

interface MeetingReadDeps {
  meetings: WorkspaceMeetings;
  runs: Runs;
  actionItems: WorkspaceActionItems;
  transcripts: () => TranscriptRecord[];
  now: () => Date;
  timezone: () => string;
  canRetry?: (meta: Readonly<RunMeta>) => boolean;
}
interface ArtifactSource {
  meta: Readonly<RunMeta>;
  attemptAt: number;
  result: (Partial<MeetingBriefRunResult> & Partial<MeetingDebriefRunResult>) | null;
}
const emptyArtifact = (): MeetingArtifact => ({
  status: "missing",
  runId: null,
  latestAttempt: null,
  summary: null,
  retryRunId: null,
  explanation: null,
  remedy: null,
});
const recentOrder = (a: Meeting, b: Meeting) =>
  Date.parse(b.endAt || b.startAt) - Date.parse(a.endAt || a.startAt) || a.id.localeCompare(b.id);

/** Read composition over durable owners. Browsing never schedules work. */
export class MeetingRead {
  constructor(private readonly deps: MeetingReadDeps) {}

  private read() {
    const timezone = this.deps.timezone();
    const now = this.deps.now();
    const local = DateTime.fromJSDate(now).setZone(timezone);
    const localToday = local.toISODate()!;
    const partial: string[] = [];
    const safe = <T>(label: string, read: () => T, fallback: T): T => {
      try {
        return read();
      } catch {
        partial.push(`${label} unavailable; other meeting data is still shown.`);
        return fallback;
      }
    };
    const meetings = this.deps.meetings.list();
    const transcripts = safe("Transcripts", this.deps.transcripts, []);
    const pending = safe<ActionItem[] | null>(
      "Action Item counts",
      () => this.deps.actionItems.list({ state: "pending" }),
      null,
    );
    const sources = new Map<string, ArtifactSource[]>();
    const unavailable = new Set<string>();
    for (const module of ["meeting-brief-generator", "meeting-debrief"]) {
      try {
        for (const summary of this.deps.runs.list({ module }).runs) {
          const handle = this.deps.runs.open(summary.id);
          if (!handle) continue;
          const meta = handle.read();
          let result: ArtifactSource["result"] = null;
          try {
            const raw = handle.readArtifact("result.json");
            result = raw ? (JSON.parse(raw) as ArtifactSource["result"]) : null;
          } catch {
            partial.push("A saved artifact is unreadable.");
          }
          const key =
            module === "meeting-brief-generator"
              ? (result?.occurrenceKey ?? meta.externalId)
              : (result?.transcriptId ?? meta.externalId);
          if (!key) continue;
          const groupKey = `${module}:${key}`;
          const held = sources.get(groupKey) ?? [];
          /* A retry keeps its Run identity and creation date (#325). Its
             recorded attempt event, not that creation date, orders failures. */
          const attemptAt = (this.deps.runs.detail(summary.id)?.events ?? [])
            .filter((event) =>
              [
                "created",
                "stage_started",
                "run_failed",
                "run_done",
                "run_reopened",
                "run_blocked",
                "run_resumed",
              ].includes(event.type),
            )
            .reduce(
              (latest, event) => Math.max(latest, Date.parse(event.at)),
              Date.parse(meta.createdAt),
            );
          held.push({ meta, result, attemptAt });
          sources.set(groupKey, held);
        }
      } catch {
        unavailable.add(module);
        partial.push(
          `${module === "meeting-debrief" ? "Debrief" : "Brief"} status unavailable; other meeting data is still shown.`,
        );
      }
    }
    const rows: MeetingReadRow[] = meetings.map((meeting) => {
      const attached = transcripts.filter((t) => t.meetingId === meeting.id);
      const dateOnly =
        meeting.dateOnly ?? (meeting.occurrenceKey === null && meeting.endAt === meeting.startAt);
      const recordedDate = dateOnly
        ? attached.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.meetingDate ?? ""))?.meetingDate
        : null;
      const localDate =
        recordedDate ??
        (dateOnly
          ? meeting.startAt.slice(0, 10)
          : (DateTime.fromISO(meeting.startAt, { zone: timezone }).toISODate() ?? ""));
      const group = dateOnly
        ? localDate <= localToday
          ? "completed"
          : "upcoming"
        : Date.parse(meeting.endAt || meeting.startAt) <= now.getTime()
          ? "completed"
          : Date.parse(meeting.startAt) <= now.getTime()
            ? "in-progress"
            : "upcoming";
      const briefSources = meeting.occurrenceKey
        ? (sources.get(`meeting-brief-generator:${meeting.occurrenceKey}`) ?? [])
        : [];
      const debriefSources = attached.flatMap((t) => sources.get(`meeting-debrief:${t.id}`) ?? []);
      const brief = this.artifact(briefSources, "brief", meeting, now);
      const debrief = this.artifact(debriefSources, "debrief", meeting, now);
      if (!attached.length && debrief.status === "missing")
        debrief.status = partial.some((p) => p.startsWith("Transcripts"))
          ? "unavailable"
          : "no-transcript";
      if (unavailable.has("meeting-brief-generator")) brief.status = "unavailable";
      if (unavailable.has("meeting-debrief")) debrief.status = "unavailable";
      return {
        ...meeting,
        localDate,
        dateOnly,
        group,
        brief,
        debrief,
        pendingCount: pending
          ? pending.filter((p) => p.source.meetingId === meeting.id).length
          : null,
      };
    });
    const historyBeginsAt =
      [...rows].sort(
        (a, b) => a.localDate.localeCompare(b.localDate) || a.id.localeCompare(b.id),
      )[0]?.localDate ?? null;
    return {
      rows,
      pending,
      local,
      localToday,
      timezone,
      historyBeginsAt,
      partial: [...new Set(partial)],
    };
  }

  private artifact(
    sources: ArtifactSource[],
    kind: "brief" | "debrief",
    meeting: Meeting,
    now: Date,
  ): MeetingArtifact {
    const sorted = [...sources].sort(
      (a, b) =>
        Date.parse(b.meta.createdAt) - Date.parse(a.meta.createdAt) ||
        b.meta.id.localeCompare(a.meta.id),
    );
    const latest = [...sources].sort(
      (a, b) => b.attemptAt - a.attemptAt || b.meta.id.localeCompare(a.meta.id),
    )[0];
    const successful = sorted.find((s) =>
      kind === "brief" ? Boolean(s.result?.meetingBrief) : Boolean(s.result?.debrief),
    );
    const artifact = emptyArtifact();
    if (successful) {
      artifact.status = "ready";
      artifact.runId = successful.meta.id;
      artifact.summary =
        (kind === "brief"
          ? successful.result?.meetingBrief?.summary
          : successful.result?.debrief?.summary
        )?.slice(0, 320) ?? null;
    }
    if (!latest) return artifact;
    const attempt =
      latest.meta.status === "failed"
        ? "failed"
        : latest.meta.status === "pending"
          ? "queued"
          : ["running", "blocked"].includes(latest.meta.status)
            ? "processing"
            : null;
    if (attempt) {
      if (!successful) artifact.status = attempt;
      artifact.latestAttempt = attempt;
    }
    if (attempt === "failed") {
      const deliveryFailure =
        kind === "brief" &&
        Boolean(latest.result?.meetingBrief) &&
        latest.meta.failedStage === "deliver";
      const historicalBrief =
        kind === "brief" &&
        (meeting.cancelled ||
          meeting.ineligibleReason !== null ||
          !meeting.occurrenceKey ||
          Date.parse(meeting.startAt) <= now.getTime());
      artifact.explanation = deliveryFailure
        ? "Brief ready. Email delivery failed; the Brief remains readable."
        : historicalBrief
          ? "Brief preparation is no longer available for this past or ineligible meeting."
          : `${kind === "brief" ? "Brief preparation" : "Debrief extraction"} failed. Try again or check the workflow settings.`;
      artifact.retryRunId =
        !historicalBrief && this.deps.canRetry?.(latest.meta) ? latest.meta.id : null;
      if (latest.meta.connectionState && latest.meta.connectionState !== "connected") {
        artifact.retryRunId = null;
        artifact.explanation = `Reconnect Google in Settings before retrying this ${kind === "brief" ? "Brief" : "Debrief"}.`;
      }
      artifact.remedy = "/settings";
    }
    return artifact;
  }

  workspace(): MeetingWorkspaceView {
    const read = this.read();
    const { rows, pending, localToday, timezone, local, historyBeginsAt, partial } = read;
    const upcomingFrom = local.plus({ days: 1 }).toISODate()!;
    const upcomingTo = local.plus({ days: 7 }).toISODate()!;
    const starts = new Map(rows.map((meeting) => [meeting.id, Date.parse(meeting.startAt)]));
    const groups = new Map<string | null, ActionItem[]>();
    for (const item of pending ?? []) {
      const key = rows.some((m) => m.id === item.source.meetingId) ? item.source.meetingId : null;
      const held = groups.get(key) ?? [];
      held.push(item);
      groups.set(key, held);
    }
    const proposalGroups = [...groups]
      .map(([meetingId, items]) => {
        const meeting = rows.find((m) => m.id === meetingId);
        return {
          meetingId,
          title: meeting?.title ?? "Source meeting unavailable",
          date: meeting?.localDate ?? null,
          count: items.length,
          items: items.slice(0, 3),
        };
      })
      .sort(
        (a, b) =>
          (b.date ?? "").localeCompare(a.date ?? "") ||
          (starts.get(b.meetingId ?? "") ?? 0) - (starts.get(a.meetingId ?? "") ?? 0) ||
          (a.meetingId ?? "").localeCompare(b.meetingId ?? ""),
      );
    return {
      localToday,
      timezone,
      historyBeginsAt,
      partial,
      today: rows.filter((m) => !m.cancelled && m.localDate === localToday),
      recent: rows
        .filter((m) => !m.cancelled && m.group === "completed")
        .sort(recentOrder)
        .slice(0, 5),
      upcoming: rows
        .filter((m) => !m.cancelled && m.localDate >= upcomingFrom && m.localDate <= upcomingTo)
        .slice(0, 5),
      upcomingFrom,
      upcomingTo,
      proposals: pending
        ? {
            total: pending.length,
            meetingCount: proposalGroups.filter((g) => g.meetingId !== null).length,
            missingSourceCount: groups.get(null)?.length ?? 0,
            groups: [
              ...proposalGroups.filter((g) => g.meetingId !== null).slice(0, 5),
              ...proposalGroups.filter((g) => g.meetingId === null),
            ],
          }
        : null,
    };
  }

  registerRoutes(app: FastifyInstance): void {
    app.get("/api/meetings/workspace", async () => this.workspace());
    app.get("/api/meetings/:meetingId/read", async (request, reply) => {
      const { meetingId } = request.params as { meetingId: string };
      const read = this.read();
      const meeting = read.rows.find((m) => m.id === meetingId);
      if (!meeting) return reply.code(404).send({ error: "Meeting not found." });
      return {
        meeting,
        localToday: read.localToday,
        timezone: read.timezone,
        partial: read.partial,
      };
    });
    app.get("/api/meetings/history", async (request, reply) => {
      const query = request.query as {
        search?: string;
        from?: string;
        to?: string;
        includeCancelled?: string;
        page?: string;
      };
      const validDate = (date: string) =>
        /^\d{4}-\d{2}-\d{2}$/.test(date) && DateTime.fromISO(date).isValid;
      if (
        (query.from && !validDate(query.from)) ||
        (query.to && !validDate(query.to)) ||
        (query.from && query.to && query.from > query.to)
      )
        return reply.code(400).send({ error: "Choose valid dates with From on or before To." });
      const read = this.read();
      const retained = read.rows.filter((m) => m.group === "completed");
      const search = query.search?.trim().toLowerCase() ?? "";
      const filtered = retained
        .filter(
          (m) =>
            (query.includeCancelled === "true" || !m.cancelled) &&
            (!query.from || m.localDate >= query.from) &&
            (!query.to || m.localDate <= query.to) &&
            (!search ||
              [m.title, ...m.participants.flatMap((p) => [p.displayName ?? "", p.email])].some(
                (value) => value.toLowerCase().includes(search),
              )),
        )
        .sort(recentOrder);
      const pageSize = 25;
      const page = Math.min(
        Math.max(1, Math.floor(Number(query.page)) || 1),
        Math.max(1, Math.ceil(filtered.length / pageSize)),
      );
      const view: MeetingHistoryView = {
        meetings: filtered.slice((page - 1) * pageSize, page * pageSize),
        total: filtered.length,
        page,
        pageSize,
        retainedTotal: retained.length,
        historyBeginsAt: read.historyBeginsAt,
        localToday: read.localToday,
        timezone: read.timezone,
        partial: read.partial,
      };
      return view;
    });
  }
}
