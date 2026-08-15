import type { CalendarEvent, CalendarEvents } from "@chief-of-staff/contracts";
import { WorkflowError } from "@chief-of-staff/workflow/browser";

export interface CalendarConflict {
  id: string;
  start: string;
  end: string;
  summary: string;
  status: string;
}

export interface CalendarWindow {
  start: string;
  end: string;
}

export interface CalendarQueryResult {
  conflicts: CalendarConflict[];
  windows: CalendarWindow[];
}

function parseIso(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new WorkflowError(
      "INVALID_CONFIGURATION",
      `${label} is not an ISO 8601 date-time: ${value}`
    );
  }
  return ms;
}

/** Format an epoch timestamp as an ISO string with the offset of `timezone`. */
export function formatInTimeZone(epochMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const wall = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  const offsetMs = timezoneOffsetMs(epochMs, timezone);
  const sign = offsetMs >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMs);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  return `${wall}${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Offset of `timezone` relative to UTC for the given instant, in ms. */
export function timezoneOffsetMs(epochMs: number, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - epochMs;
}

const WINDOW_GRID_MINUTES = 30;

/**
 * Compute calendar conflicts and free candidate windows from a calendar
 * dataset. Read-only: never creates or modifies events. Busy and tentative
 * events conflict; free events do not. Candidates are aligned to a 30-minute
 * grid in the target timezone, up to five total, in chronological order.
 */
export function findFreeWindows(
  calendar: CalendarEvents,
  earliestIso: string,
  latestIso: string,
  durationMinutes: number,
  timezone?: string
): CalendarQueryResult {
  const timezoneName = timezone ?? calendar.timezone;
  const earliest = parseIso(earliestIso, "earliest");
  const latest = parseIso(latestIso, "latest");
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new WorkflowError("INVALID_CONFIGURATION", "durationMinutes must be positive");
  }
  if (latest <= earliest) {
    throw new WorkflowError("INVALID_CONFIGURATION", "latest must be after earliest");
  }
  const durationMs = durationMinutes * 60_000;

  const conflicts: Array<{ event: CalendarEvent; start: number; end: number }> = [];
  for (const event of calendar.events) {
    if (event.status === "free") {
      continue;
    }
    const start = parseIso(event.start, `event ${event.id} start`);
    const end = parseIso(event.end, `event ${event.id} end`);
    if (end <= start) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        `event ${event.id} ends before it starts`
      );
    }
    if (end > earliest && start < latest) {
      conflicts.push({ event, start, end });
    }
  }
  conflicts.sort((a, b) => a.start - b.start);

  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = earliest;
  for (const conflict of conflicts) {
    if (conflict.start > cursor) {
      gaps.push({ start: cursor, end: conflict.start });
    }
    cursor = Math.max(cursor, conflict.end);
  }
  if (cursor < latest) {
    gaps.push({ start: cursor, end: latest });
  }

  const windows: CalendarWindow[] = [];
  for (const gap of gaps) {
    if (windows.length >= 5) {
      break;
    }
    const gridMs = WINDOW_GRID_MINUTES * 60_000;
    let candidateStart = Math.ceil(gap.start / gridMs) * gridMs;
    while (windows.length < 5 && candidateStart + durationMs <= gap.end) {
      windows.push({
        start: formatInTimeZone(candidateStart, timezoneName),
        end: formatInTimeZone(candidateStart + durationMs, timezoneName),
      });
      candidateStart += gridMs;
    }
  }

  return {
    conflicts: conflicts.map(({ event }) => ({
      id: event.id,
      start: event.start,
      end: event.end,
      summary: event.summary,
      status: event.status,
    })),
    windows,
  };
}
