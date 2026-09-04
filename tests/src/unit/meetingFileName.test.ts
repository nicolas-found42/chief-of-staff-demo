import { describe, expect, it } from "vitest";
import { meetingFileNameMeta } from "../../../apps/server/src/text/meetingFileName";

/**
 * A Transcript's file name is the primary evidence for its Meeting (issue
 * #153): the title and, when present, the full timestamp.
 */
describe("meetingFileNameMeta", () => {
  it("recovers the title and timestamp from a Fireflies export name", () => {
    expect(meetingFileNameMeta("Team Sync-2026-06-18T13-00-00.000Z.mp3")).toEqual({
      title: "Team Sync",
      timestamp: "2026-06-18T13:00:00.000Z",
      namesTime: true,
    });
  });

  it("recovers a leading date and time with the title that follows", () => {
    expect(meetingFileNameMeta("2026-06-18 13.00 Team Sync.txt")).toEqual({
      title: "Team Sync",
      timestamp: "2026-06-18T13:00:00.000Z",
      namesTime: true,
    });
  });

  it("recovers a trailing date as midnight UTC with the title before it", () => {
    expect(meetingFileNameMeta("Team Sync 2026-06-18.txt")).toEqual({
      title: "Team Sync",
      timestamp: "2026-06-18T00:00:00.000Z",
      // Midnight is padding here, not a time the name stated.
      namesTime: false,
    });
  });

  it("recovers a plain title with no timestamp", () => {
    expect(meetingFileNameMeta("Team Sync notes.txt")).toEqual({
      title: "Team Sync notes",
      timestamp: null,
      namesTime: false,
    });
  });

  it("returns neither title nor timestamp for a name carrying neither", () => {
    expect(meetingFileNameMeta("12345.mp3")).toEqual({
      title: null,
      timestamp: null,
      namesTime: false,
    });
  });

  it("keeps the timestamp when the remainder carries no words", () => {
    expect(meetingFileNameMeta("2026-06-18.txt")).toEqual({
      title: null,
      timestamp: "2026-06-18T00:00:00.000Z",
      namesTime: false,
    });
  });
});
