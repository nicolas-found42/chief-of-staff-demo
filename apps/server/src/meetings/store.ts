import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Meeting, MeetingIndex, MeetingParticipant } from "@chief-of-staff-demo/shared";
import { atomicWriteJson } from "../engine/atomic.js";

/**
 * The Workspace's Meetings (ADR-0050).
 *
 * A Workspace resource beside Person Profiles and the Transcript Catalog, not
 * a Module's feature store: the Meeting Brief Generator and the Executive
 * Assistant both consume it, and neither owns it.
 *
 * Like the calendar store beside it, this holds nothing in memory. Every call
 * re-reads the file and writes the whole list back atomically, so a Calendar
 * reconcile and a later Transcript association cannot lose each other's
 * writes.
 */
export class WorkspaceMeetings {
  private readonly dirPath: string;
  private readonly filePath: string;
  private readonly historyPath: string;

  constructor(
    workspaceDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dirPath = join(workspaceDir, "meetings");
    this.filePath = join(this.dirPath, "meetings.json");
    this.historyPath = join(this.dirPath, "history.json");
  }

  list(): Meeting[] {
    return this.read().sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  index(): MeetingIndex {
    const meetings = this.list();
    return { meetings, historyBeginsAt: meetings[0]?.startAt ?? null };
  }

  get(id: string): Meeting | null {
    return this.read().find((meeting) => meeting.id === id) ?? null;
  }

  findByOccurrenceKey(occurrenceKey: string): Meeting | null {
    return this.read().find((meeting) => meeting.occurrenceKey === occurrenceKey) ?? null;
  }

  /** The one-time mark that Calendar history has been collected (issue #152). */
  historyMark(): MeetingHistoryMark | null {
    return readMarkFile(this.historyPath);
  }

  writeHistoryMark(mark: MeetingHistoryMark): void {
    mkdirSync(this.dirPath, { recursive: true });
    atomicWriteJson(this.historyPath, mark);
  }

  /**
   * Record what Calendar currently says about one occurrence. Keyed on the
   * occurrence key so a re-sync updates rather than duplicates, and so the
   * Meeting's own id survives every revision of the event behind it.
   */
  upsertFromCalendar(input: {
    occurrenceKey: string;
    calendarEventId: string;
    occurrenceId: string;
    title: string;
    startAt: string;
    endAt: string;
    participants: MeetingParticipant[];
    cancelled: boolean;
    ineligibleReason: Meeting["ineligibleReason"];
  }): Meeting {
    const meetings = this.read();
    const at = this.now().toISOString();
    const existing = meetings.find((meeting) => meeting.occurrenceKey === input.occurrenceKey);
    const meeting: Meeting = {
      id: existing?.id ?? newMeetingId(this.now()),
      occurrenceKey: input.occurrenceKey,
      calendarEventId: input.calendarEventId,
      occurrenceId: input.occurrenceId,
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
      participants: input.participants,
      cancelled: input.cancelled,
      ineligibleReason: input.ineligibleReason,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    const next = existing
      ? meetings.map((current) => (current.id === meeting.id ? meeting : current))
      : [...meetings, meeting];
    atomicWriteJson(this.filePath, next);
    return meeting;
  }

  private read(): Meeting[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isMeeting) : [];
    } catch {
      return [];
    }
  }
}

/** The one-time mark that the backward Calendar read has run (issue #152). */
export interface MeetingHistoryMark {
  /** When the read ran. */
  collectedAt: string;
  /** The oldest Transcript date the read reached back to. */
  from: string;
}

function readMarkFile(path: string): MeetingHistoryMark | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const mark = parsed as Partial<MeetingHistoryMark>;
    return typeof mark.collectedAt === "string" && typeof mark.from === "string"
      ? { collectedAt: mark.collectedAt, from: mark.from }
      : null;
  } catch {
    return null;
  }
}

function newMeetingId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `meeting_${stamp}_${randomBytes(4).toString("hex")}`;
}

function isMeeting(value: unknown): value is Meeting {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.startAt === "string" &&
    typeof candidate.endAt === "string" &&
    Array.isArray(candidate.participants)
  );
}
