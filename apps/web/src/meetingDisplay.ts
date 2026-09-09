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
