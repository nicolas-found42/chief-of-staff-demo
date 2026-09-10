import type { MeetingHandoff } from "./meeting-debrief.js";

/** Initial editable execution notes; the source handoff remains immutable on the Action Item. */
export function handoffNotes(handoff: MeetingHandoff): string {
  return [
    `Commitment: ${handoff.commitment}`,
    `Purpose: ${handoff.purpose || "Not stated"}`,
    `Responsibility [${handoff.responsibility.basis}]: ${handoff.responsibility.names.join(", ") || "Unassigned"}. ${handoff.responsibility.reason}`,
    ...handoff.completionCriteria.map((item) => `Completion [${item.basis}] ${item.text}`),
    ...handoff.requiredInputs.map((input) => `Required input: ${input}`),
    ...handoff.missingInputs.map(
      (input) =>
        `Missing input [${input.basis}]: ${input.information}. Suggested retrieval: ${input.obtainBy}`,
    ),
    ...handoff.dependencies.map(
      (dependency) =>
        `Dependency [${dependency.basis}]: ${dependency.actionTitle}. ${dependency.condition}`,
    ),
    `Timing: ${handoff.timing.stated || "Not stated"}. ${handoff.timing.reasoning}${handoff.timing.referenceDate ? ` Reference meeting date: ${handoff.timing.referenceDate}.` : ""}`,
    `Status: ${handoff.statusReasoning || "Not stated"}`,
    ...(handoff.evidence.length === 0
      ? ["Evidence: No verified transcript quote available; review against the source."]
      : []),
    ...handoff.evidence.map(
      (source) =>
        `Evidence${source.speaker ? ` — ${source.speaker}` : ""}${source.timestamp ? ` at ${source.timestamp}` : ""}: "${source.quote}"`,
    ),
  ].join("\n");
}
