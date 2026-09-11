import { describe, expect, it } from "vitest";
import type { Meeting } from "@chief-of-staff-demo/shared";
import {
  meetingTimeAnchor,
  referenceDaysForAnchor,
} from "../../../apps/server/src/meetings/timeAnchor";

/**
 * The evidenced meeting-time anchor (issue #356, ADR-0082). Relative timing in
 * speech is resolved against the day the meeting actually fell on, which needs
 * both an evidenced instant and the zone that instant is a day in. Neither is
 * guessed: no anchor means relative dates stay words.
 */
function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting_a",
    occurrenceKey: "evt_a::2026-06-18T15:00:00Z",
    calendarEventId: "evt_a",
    occurrenceId: "2026-06-18T15:00:00Z",
    title: "Internal planning",
    startAt: "2026-06-18T15:00:00.000Z",
    endAt: "2026-06-18T16:00:00.000Z",
    timeZone: "Europe/Berlin",
    participants: [],
    cancelled: false,
    ineligibleReason: null,
    createdAt: "2026-06-18T09:00:00.000Z",
    updatedAt: "2026-06-18T09:00:00.000Z",
    ...overrides,
  };
}

describe("meetingTimeAnchor", () => {
  it("anchors on the Calendar occurrence and its recorded zone", () => {
    expect(meetingTimeAnchor(meeting())).toEqual({
      date: "2026-06-18",
      timeZone: "Europe/Berlin",
      basis: "calendar-occurrence",
    });
  });

  it("reads the civil date in the meeting's own zone, not the host's", () => {
    /* 22:30 UTC is already the next day in Auckland. The day a person means by
       "today" is the day they were in, so the zone decides it. */
    const anchor = meetingTimeAnchor(
      meeting({ startAt: "2026-06-18T22:30:00.000Z", timeZone: "Pacific/Auckland" }),
    );

    expect(anchor?.date).toBe("2026-06-19");
  });

  it("refuses an anchor when no zone was recorded", () => {
    expect(meetingTimeAnchor(meeting({ timeZone: null }))).toBeNull();
  });

  it("refuses an anchor for a Meeting only a Transcript attests to", () => {
    /* A Meeting a Transcript owns has a start derived from the file, not an
       evidenced occurrence, so it grounds nothing. */
    expect(
      meetingTimeAnchor(
        meeting({ occurrenceKey: null, calendarEventId: null, occurrenceId: null }),
      ),
    ).toBeNull();
  });

  it("refuses an anchor when there is no Meeting at all", () => {
    expect(meetingTimeAnchor(null)).toBeNull();
  });

  it("refuses a zone this runtime does not know", () => {
    expect(meetingTimeAnchor(meeting({ timeZone: "Mars/Olympus" }))).toBeNull();
  });
});

describe("referenceDaysForAnchor", () => {
  it("computes 8 civil days without 24-hour shifting across month boundaries", () => {
    const anchor = meetingTimeAnchor(
      meeting({ startAt: "2026-02-27T10:00:00.000Z", timeZone: "UTC" }),
    );
    expect(anchor).not.toBeNull();
    const days = referenceDaysForAnchor(anchor!);
    expect(days).toHaveLength(8);
    expect(days[0]?.date).toBe("2026-02-27");
    expect(days[1]?.date).toBe("2026-02-28");
    expect(days[2]?.date).toBe("2026-03-01");
    expect(days[7]?.date).toBe("2026-03-06");
  });
});
