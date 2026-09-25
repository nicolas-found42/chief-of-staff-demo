import type { MeetingIntakeReadiness } from "@chief-of-staff-demo/shared";

export function meetingIntakeMessage(readiness: MeetingIntakeReadiness): string {
  switch (readiness.verdict) {
    case "provider-required":
      return "Choose a model provider and install its credential before a Debrief can run.";
    case "google-required":
      return "Connect Google so the app can read the selected transcript folder.";
    case "folder-required":
      return "Choose the Google Drive folder that contains your meeting transcripts.";
    case "polling-required":
      return "Enable Drive polling so new transcripts are noticed automatically.";
    case "consent-required":
      return "Allow the app to read and process the selected transcript folder.";
    case "intake-running":
      return "Transcript Intake is checking the selected folder.";
    case "intake-paused":
      return "Transcript Intake is paused; no new transcript is being processed.";
    case "waiting-for-transcript":
      return "Transcript Intake is ready and waiting for a transcript in the selected Google Drive folder.";
    case "intake-failed":
      return "Transcript Intake needs attention before a Debrief can run.";
    case "ready":
      return "Transcript Intake is ready. Return here after a transcript is catalogued.";
  }
}

/** Date-only provenance must keep its recorded day in every browser timezone (#325).
 * Noon UTC is only a formatting anchor, never an inferred Meeting start time.
 */
export function meetingDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
}
/** Keep proposed historical deadlines visibly distinct from new instructions (#325). */
export function proposedDue(date: string | null, today: string): string {
  return date
    ? `Proposed due ${meetingDate(date)}${date < today ? " — in the past" : ""}`
    : "No proposed due date";
}
