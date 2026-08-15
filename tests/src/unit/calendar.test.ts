import { describe, expect, it } from "vitest";
import { findFreeWindows, formatInTimeZone } from "@chief-of-staff/agents";
import type { CalendarEvents } from "@chief-of-staff/contracts";

const calendar: CalendarEvents = {
  timezone: "America/New_York",
  events: [
    {
      id: "event-1",
      start: "2026-08-17T10:00:00-04:00",
      end: "2026-08-17T10:30:00-04:00",
      summary: "Busy",
      status: "busy",
    },
    {
      id: "event-2",
      start: "2026-08-17T14:00:00-04:00",
      end: "2026-08-17T15:30:00-04:00",
      summary: "Tentative planning block",
      status: "tentative",
    },
    {
      id: "event-3",
      start: "2026-08-17T16:00:00-04:00",
      end: "2026-08-17T16:15:00-04:00",
      summary: "Optional standup",
      status: "free",
    },
  ],
};
describe("calendar free windows", () => {
  it("reports conflicts and candidate windows in order", () => {
    const result = findFreeWindows(
      calendar,
      "2026-08-17T09:00:00-04:00",
      "2026-08-17T17:00:00-04:00",
      30
    );
    expect(result.conflicts.map((c) => c.id)).toEqual(["event-1", "event-2"]);
    // event-3 is free and must not conflict.
    expect(result.conflicts.map((c) => c.id)).not.toContain("event-3");
    expect(result.windows).toHaveLength(5);
    // Free time before the first busy event yields windows from the query start.
    expect(result.windows[0].start).toBe("2026-08-17T09:00:00-04:00");
    // The gap right after the busy block starts at 10:30.
    expect(result.windows.map((w) => w.start)).toContain("2026-08-17T10:30:00-04:00");
    const starts = result.windows.map((w) => w.start);
    expect(starts).toEqual([...starts].sort());
    // No candidate overlaps the tentative 14:00-15:30 block.
    for (const window of result.windows) {
      const startMs = Date.parse(window.start);
      expect(startMs < Date.parse("2026-08-17T14:00:00-04:00")).toBe(true);
    }
  });

  it("aligns candidates to a 30-minute grid in the target timezone", () => {
    const result = findFreeWindows(
      { timezone: "UTC", events: [] },
      "2026-08-17T09:12:00Z",
      "2026-08-17T11:00:00Z",
      30
    );
    expect(result.windows[0].start).toBe("2026-08-17T09:30:00+00:00");
  });

  it("handles DST transitions correctly in America/New_York", () => {
    // Fall back: 2026-11-01 02:00 EDT -> 01:00 EST. The wall-clock hour
    // 01:00-01:59 occurs twice: once as EDT (-04:00), once as EST (-05:00).
    const fallBack: CalendarEvents = {
      timezone: "America/New_York",
      events: [
        {
          id: "fall",
          start: "2026-11-01T01:00:00-04:00",
          end: "2026-11-01T02:00:00-04:00",
          summary: "Busy across the repeated hour",
          status: "busy",
        },
      ],
    };
    const result = findFreeWindows(
      fallBack,
      "2026-11-01T00:00:00-04:00",
      "2026-11-01T06:00:00-05:00",
      30
    );
    // Before the event everything is EDT.
    expect(result.windows[0].start).toBe("2026-11-01T00:00:00-04:00");
    expect(result.windows[0].end).toBe("2026-11-01T00:30:00-04:00");
    // After the event (06:00Z) the same instant is 01:00 EST: the second
    // occurrence of the 01:00 wall-clock hour, formatted with the EST offset.
    expect(result.windows[2].start).toBe("2026-11-01T01:00:00-05:00");
    expect(result.windows[2].end).toBe("2026-11-01T01:30:00-05:00");
    // Spring forward: 07:00Z is 03:00 EDT on 2026-03-08.
    expect(formatInTimeZone(Date.parse("2026-03-08T07:00:00Z"), "America/New_York")).toBe(
      "2026-03-08T03:00:00-04:00"
    );
  });

  it("formats instants with the timezone offset including DST", () => {
    expect(formatInTimeZone(Date.parse("2026-01-15T12:00:00Z"), "America/New_York")).toBe(
      "2026-01-15T07:00:00-05:00"
    );
    expect(formatInTimeZone(Date.parse("2026-07-15T12:00:00Z"), "America/New_York")).toBe(
      "2026-07-15T08:00:00-04:00"
    );
  });

  it("rejects invalid ranges", () => {
    expect(() =>
      findFreeWindows(calendar, "2026-08-17T10:00:00-04:00", "2026-08-17T09:00:00-04:00", 30)
    ).toThrow(/latest must be after earliest/);
    expect(() =>
      findFreeWindows(calendar, "2026-08-17T09:00:00-04:00", "2026-08-17T17:00:00-04:00", 0)
    ).toThrow(/durationMinutes/);
  });

  it("never creates or modifies events (pure function)", () => {
    const snapshot = JSON.stringify(calendar);
    findFreeWindows(calendar, "2026-08-17T09:00:00-04:00", "2026-08-17T17:00:00-04:00", 30);
    expect(JSON.stringify(calendar)).toBe(snapshot);
  });
});
