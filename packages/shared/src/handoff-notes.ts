import type {
  HandoffDependencyTarget,
  HandoffDependencyUnresolved,
  HandoffDetail,
  HandoffProvenance,
  MeetingHandoffRecord,
} from "./meeting-debrief.js";

/**
 * How one handoff record reads: the current shape, or the one a Workspace or
 * Run stored before provenance existed. Displaying and snapshotting go through
 * these accessors so a record written then keeps its own labels — `explicit`
 * and `inferred` are imported verbatim, unlabelled purpose and inputs are
 * `unknown`, and no older claim is upgraded to a support it never recorded.
 */

/** Whether the provenance claims the transcript states this detail. */
export function handoffProvenanceIsSupported(provenance: HandoffProvenance): boolean {
  return provenance === "supported" || provenance === "explicit";
}

/**
 * The word the detail's badge shows: the record's own provenance, capitalized.
 * A record written before provenance existed keeps its own word rather than
 * being renamed — `Inferred` is the label a person reviewed then, and the
 * review surface reporting `Suggested` instead would be reporting a provenance
 * the record never carried.
 */
export function handoffProvenanceLabel(provenance: HandoffProvenance): string {
  return `${provenance.charAt(0).toUpperCase()}${provenance.slice(1)}`;
}

/** Why a dependency carries no identity, in words the review surface can show. */
export function handoffDependencyUnresolvedReason(reason: HandoffDependencyUnresolved): string {
  switch (reason) {
    case "ambiguous-title":
      return "two proposals share that title";
    case "not-extracted":
      return "no proposal in this Debrief matched";
    case "self-reference":
      return "it names itself";
    case "not-resolved":
      return "no stable reference was recorded";
    case "missing-record":
      return "the record it named is no longer held";
    case "redirect-cycle":
      return "its reference points back at itself";
  }
}

/** The purpose as a detail, from either record shape. */
export function handoffPurpose(handoff: MeetingHandoffRecord): HandoffDetail {
  if (handoff.version === 1) {
    return { text: handoff.purpose, provenance: "unknown", sources: [] };
  }
  return handoff.purpose;
}

/** The completion criteria as details, from either record shape. */
export function handoffCompletionCriteria(handoff: MeetingHandoffRecord): HandoffDetail[] {
  if (handoff.version === 1) {
    return handoff.completionCriteria.map((item) => ({
      text: item.text,
      provenance: item.basis,
      sources: [],
    }));
  }
  return handoff.completionCriteria;
}

/** The required inputs as details, from either record shape. */
export function handoffRequiredInputs(handoff: MeetingHandoffRecord): HandoffDetail[] {
  if (handoff.version === 1) {
    return handoff.requiredInputs.map((input) => ({
      text: input,
      provenance: "unknown",
      sources: [],
    }));
  }
  return handoff.requiredInputs;
}

/** The missing inputs with their retrieval steps, from either record shape. */
export function handoffMissingInputs(
  handoff: MeetingHandoffRecord,
): Array<{ information: HandoffDetail; obtainBy: HandoffDetail }> {
  if (handoff.version === 1) {
    return handoff.missingInputs.map((input) => ({
      information: { text: input.information, provenance: input.basis, sources: [] },
      /* The older record's one label described the gap, never the retrieval
         step — which its own notes always presented as a suggestion. Importing
         the gap's word here would upgrade a proposed method to agreed work. */
      obtainBy: { text: input.obtainBy, provenance: "inferred", sources: [] },
    }));
  }
  return handoff.missingInputs;
}

/** One dependency with its target normalized: absent means nothing resolved it. */
export interface HandoffDependencyView {
  wording: string;
  condition: string;
  provenance: HandoffProvenance;
  sources: HandoffDetail["sources"];
  target: HandoffDependencyTarget;
}

/** The dependencies with their targets, from either record shape. */
export function handoffDependencies(handoff: MeetingHandoffRecord): HandoffDependencyView[] {
  if (handoff.version === 1) {
    /* An older record named a title and nothing else: it is never resolved
       against the records held today, because a name that meant one Action
       Item then may be a different one now. */
    return handoff.dependencies.map((dependency) => ({
      wording: dependency.actionTitle,
      condition: dependency.condition,
      provenance: dependency.basis,
      sources: [],
      target: { kind: "unresolved", reason: "not-resolved" } as const,
    }));
  }
  return handoff.dependencies.map((dependency) => ({
    wording: dependency.actionTitle,
    condition: dependency.condition,
    provenance: dependency.provenance,
    sources: dependency.sources,
    target: dependency.target ?? ({ kind: "unresolved", reason: "not-resolved" } as const),
  }));
}

/**
 * One line of the execution detail as both the review surface and the accepted
 * Task snapshot read it. `provenance` is null on the rows that declare none —
 * timing, status and evidence are the checked facts, not proposed details.
 */
export interface HandoffNoteRow {
  label: string;
  text: string;
  provenance: HandoffProvenance | null;
  /** A dependency's recorded target, when the row is a dependency. */
  target?: HandoffDependencyTarget;
  /** Which dependency of the record this row is, so a reference can be attached. */
  dependencyIndex?: number;
}

/**
 * The execution detail, structured. One projection for the review surface and
 * the Task snapshot both, so the suggestion a person reads in the Meeting page
 * is the same suggestion the accepted Task keeps.
 */
export function handoffNoteRows(handoff: MeetingHandoffRecord): HandoffNoteRow[] {
  const rows: HandoffNoteRow[] = [
    { label: "Commitment", text: handoff.commitment, provenance: null },
  ];
  const purpose = handoffPurpose(handoff);
  rows.push({
    label: "Purpose",
    text: purpose.text || "Not stated",
    provenance: purpose.provenance,
  });
  rows.push({
    label: "Responsibility",
    text: `${handoff.responsibility.names.join(", ") || "Unassigned"}. ${handoff.responsibility.reason}`,
    provenance: handoff.responsibility.basis,
  });
  for (const criterion of handoffCompletionCriteria(handoff)) {
    rows.push({ label: "Completion", text: criterion.text, provenance: criterion.provenance });
  }
  for (const input of handoffRequiredInputs(handoff)) {
    rows.push({ label: "Required input", text: input.text, provenance: input.provenance });
  }
  for (const input of handoffMissingInputs(handoff)) {
    rows.push({
      label: "Missing input",
      text: input.information.text,
      provenance: input.information.provenance,
    });
    rows.push({
      /* A retrieval step is a suggestion unless the transcript states it: the
         label says which, so nobody reads a proposed method as agreed work. */
      label: handoffProvenanceIsSupported(input.obtainBy.provenance)
        ? "Retrieval"
        : "Suggested retrieval",
      text: input.obtainBy.text,
      provenance: input.obtainBy.provenance,
    });
  }
  handoffDependencies(handoff).forEach((dependency, index) => {
    rows.push({
      label: "Dependency",
      text: `${dependency.wording}. ${dependency.condition}`,
      provenance: dependency.provenance,
      target: dependency.target,
      dependencyIndex: index,
    });
  });
  rows.push({
    label: "Timing",
    text: `${handoff.timing.stated || "Not stated"}. ${handoff.timing.reasoning}${handoff.timing.referenceDate ? ` Reference meeting date: ${handoff.timing.referenceDate}.` : ""}`,
    provenance: null,
  });
  rows.push({
    label: "Status",
    text: handoff.statusReasoning || "Not stated",
    provenance: null,
  });
  if (handoff.evidence.length === 0) {
    rows.push({
      label: "Evidence",
      text: "No verified transcript quote available; review against the source.",
      provenance: null,
    });
  }
  for (const source of handoff.evidence) {
    const location = [source.speaker, source.timestamp ? `at ${source.timestamp}` : null]
      .filter((part): part is string => part !== null)
      .join(" ");
    rows.push({
      label: "Evidence",
      text: `${location ? `${location}: ` : ""}"${source.quote}"`,
      provenance: null,
    });
  }
  return rows;
}

/** What a row becomes in the accepted Task's notes. */
function noteLine(row: HandoffNoteRow): string {
  if (row.provenance === null) return `${row.label}: ${row.text}`;
  const separator = row.label === "Completion" ? " " : ": ";
  const resolution =
    row.target === undefined || row.target.kind === "output"
      ? ""
      : row.target.kind === "external"
        ? " (outside this Debrief)"
        : ` (unresolved: ${handoffDependencyUnresolvedReason(row.target.reason)})`;
  return `${row.label} [${row.provenance}]${separator}${row.text}${resolution}`;
}

/** Initial editable execution notes; the source handoff remains immutable on the Action Item. */
export function handoffNotes(handoff: MeetingHandoffRecord): string {
  return handoffNoteRows(handoff).map(noteLine).join("\n");
}
