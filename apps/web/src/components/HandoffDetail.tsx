import type {
  HandoffProvenance,
  MeetingHandoffRecord,
  ResolvedActionItemDependency,
} from "@chief-of-staff-demo/shared";
import {
  handoffDependencyUnresolvedReason,
  handoffNoteRows,
  handoffProvenanceLabel,
} from "@chief-of-staff-demo/shared";
import { Link } from "react-router-dom";

/** A supported claim is what the transcript says; a suggestion is not agreed work. */
const PROVENANCE_CLASS: Record<HandoffProvenance, string> = {
  supported: "status-done",
  explicit: "status-done",
  suggested: "status-skipped",
  inferred: "status-skipped",
  unknown: "status-source",
};

/**
 * The execution detail of one proposal (MWR-046): every purpose, criterion,
 * input and retrieval step carries the provenance it declares, so a method the
 * extraction proposed reads as a suggestion and never as agreed work. A
 * dependency shows what it resolves to — another proposal, an outside
 * description, or the honest reason it names nothing (MWR-048).
 */
export function HandoffDetail({
  handoff,
  references,
  targetTitle,
}: {
  handoff: MeetingHandoffRecord;
  /** The record's dependencies resolved at the Tasks read boundary, when read. */
  references?: ResolvedActionItemDependency[] | undefined;
  /** A resolved Action Item's current title; the reference, never the identity. */
  targetTitle?: ((actionItemId: string) => string | null) | undefined;
}) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {handoffNoteRows(handoff).map((row, index) => {
        const reference =
          row.dependencyIndex === undefined ? undefined : references?.[row.dependencyIndex];
        return (
          <li key={index} style={{ marginBottom: "0.35rem" }}>
            <span className="muted">{row.label}</span>{" "}
            {row.provenance && (
              <span className={`status-badge ${PROVENANCE_CLASS[row.provenance]}`}>
                {handoffProvenanceLabel(row.provenance)}
              </span>
            )}
            <p style={{ margin: "0.1rem 0 0", overflowWrap: "anywhere" }}>{row.text}</p>
            {reference && (
              <p className="muted" style={{ margin: 0 }}>
                {reference.target.kind === "action-item" ? (
                  <>
                    Resolves to{" "}
                    <Link to={`#action-item-${reference.target.actionItemId}`}>
                      {targetTitle?.(reference.target.actionItemId) ?? "another proposal"}
                    </Link>
                    {reference.target.redirectedFrom
                      ? " (reconciled from the proposal it originally named)"
                      : ""}
                  </>
                ) : reference.target.kind === "external" ? (
                  "Outside this Debrief."
                ) : (
                  `Unresolved: ${handoffDependencyUnresolvedReason(reference.target.reason)}.`
                )}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
