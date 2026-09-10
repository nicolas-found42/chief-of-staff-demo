/**
 * One proposed commitment a Meeting Debrief extracted, materialized as a
 * durable Workspace record (ADR-0053, issue #177; identity contract from
 * issue #355).
 *
 * An Action Item is not a Task and never becomes one implicitly. Its identity
 * is opaque and allocated once: it is never derived from a title, an owner, a
 * date, an array position, a Run or a quotation. Distinct obligations may look
 * identical on screen — same words, same owner, same day, even the same spoken
 * turn — and still be two records, because collapsing them would lose one of
 * them.
 *
 * What the record carries:
 *
 * - `proposalRevisions`: immutable, append-only content. A correction is a new
 *   revision; the previous one stays readable, and promotion never silently
 *   picks up content the owner has not reviewed.
 * - `observations`: immutable evidence occurrences — which Transcript revision
 *   an extraction read, and where in it the obligation sat. Two identical
 *   quotations are two observations, distinguished by their locator.
 * - `decisions`: who decided what, against which record versions.
 * - `reconciliation`: the recorded relationship to earlier work, or the
 *   explicit statement that none was decided.
 * - `amendments`: suggested changes to an already promoted Task, which only
 *   the owner's own Task edit can apply.
 */

import type { MeetingHandoff } from "./meeting-debrief.js";
import type { TaskResponsiblePerson } from "./task.js";

/**
 * Pending until the owner decides. Promotion and dismissal are the two
 * decisions; both are recorded here rather than in the Meeting Debrief, so a
 * decision survives re-extraction of the Debrief it came from.
 */
export type ActionItemState = "pending" | "promoted" | "dismissed";

/** Where the proposal came from. Every reference may later be unavailable. */
export interface ActionItemSource {
  debriefRunId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to; null until one is placed. */
  meetingId: string | null;
}

/**
 * What the extraction stood on. References into the Transcript Catalog's own
 * review state rather than copied text: the evidence is re-readable from its
 * source while the source exists, and honestly missing when it does not.
 */
export interface ActionItemEvidence {
  /** The Catalog mention the extraction held responsible; null when none. */
  responsibleMentionId: string | null;
  /** The surface name the extraction inferred; null when nobody was named. */
  responsibleSurfaceName: string | null;
}

/**
 * The Task fields a proposal revision carries. Editable during review —
 * nothing here has been accepted yet, and editing a proposal never rewrites
 * the Meeting Debrief's own extracted text.
 */
export interface ActionItemProposal {
  title: string;
  notes: string;
  /** Date-only `YYYY-MM-DD`; null when the meeting stated none. */
  dueDate: string | null;
  responsiblePerson: TaskResponsiblePerson | null;
}

/**
 * Where one proposal revision came from. The extraction variant names the
 * materialization entry that produced it, so the checked artifact and the
 * local candidate alias survive into the Workspace record instead of being
 * reconstructible only from display content.
 */
export type ActionItemProposalOrigin =
  | {
      kind: "extraction";
      debriefRunId: string;
      transcriptId: string;
      meetingId: string | null;
      materializationKey: string;
      outputEntryId: string;
      /** Local extraction accounting only; never a Workspace identity. */
      candidateAlias: string | null;
    }
  | {
      /** Imported from a Workspace that predates proposal revisions. */
      kind: "legacy-import";
      debriefRunId: string | null;
      /** What is honestly unknown about the original extraction. */
      note: string;
    }
  | { kind: "owner-correction"; correctedRevision: number };

/** Immutable content of one revision. Appended, never rewritten. */
export interface ActionItemProposalRevision {
  /** 1-based and monotonic per Action Item. */
  revision: number;
  content: ActionItemProposal;
  origin: ActionItemProposalOrigin;
  /** Which extraction of the source Run produced this content. */
  extractionRevision: number;
  createdAt: string;
}

/**
 * One immutable evidence occurrence: a quotation inside one Transcript
 * revision. `locator` distinguishes repeated identical quotations — a quote
 * alone cannot, and a shared timestamp cannot either.
 */
export interface ActionItemOccurrence {
  locator: string;
  timestamp: string | null;
  quote: string | null;
}

/** What one extraction observed, and where. Immutable once recorded. */
export interface ActionItemSourceObservation {
  id: string;
  /** The proposal revision this observation supports. */
  proposalRevision: number;
  transcriptId: string;
  /** The source revision the extraction read; null when it is unknown. */
  transcriptObservedRevision: number | null;
  transcriptChecksum: string | null;
  occurrence: ActionItemOccurrence;
  /** The immutable extraction artifact and its output entry, when known. */
  artifactId: string | null;
  outputEntryId: string | null;
  candidateAliases: string[];
  notedAt: string;
}

/**
 * What the extraction's proposal means next to the work already held.
 *
 * - `unresolved`: the extraction found earlier work that may be the same
 *   obligation. Promotion waits for the owner.
 * - `distinct-new-work`: the owner decided this is separate work.
 * - `new-commitment`: a repetition of dismissed or completed work, taken on
 *   again deliberately — the earlier decision stands, and this is new work.
 * - `evidence-of-historical`: this observation is evidence about an earlier
 *   Action Item; the record states that explicitly and is not promotable.
 */
export type ActionItemDisposition =
  "unresolved" | "distinct-new-work" | "new-commitment" | "evidence-of-historical";

/** Record-versions a decision was made against (#355 expected versions). */
export interface ActionItemVersions {
  actionItemVersion: number;
  proposalRevision: number;
  /** The Task a decision concerned, and its version; null when none did. */
  taskId: string | null;
  taskVersion: number | null;
}

/** One recorded reconciliation decision, separate from the owner's own decision. */
export interface ActionItemReconciliation {
  id: string;
  /** The revision the decision was made on. */
  proposalRevision: number;
  debriefRunId: string | null;
  disposition: ActionItemDisposition;
  /**
   * `evidence-of-historical`: the earlier Action Item this record is evidence
   * for. Also visible as `reconciledInto` on the record itself.
   */
  targetActionItemId: string | null;
  /** Earlier Action Items the extraction considered, for the owner to choose from. */
  candidateActionItemIds: string[];
  decidedBy: "owner" | "extraction" | "exact-lineage";
  decidedAt: string;
  versions: ActionItemVersions;
}

/** What a decision did. History, not a projection that can be rewritten. */
export type ActionItemDecisionKind =
  | "promote"
  | "dismiss"
  | "restore"
  | "select-proposal"
  | "reconcile"
  | "attach-evidence"
  | "correct-proposal"
  | "suggest-amendment"
  | "apply-amendment"
  | "decline-amendment";

/** One recorded decision: what, when, by whom, against which versions. */
export interface ActionItemDecisionRecord {
  at: string;
  /** Who made the decision. This Workspace has one trusted local user. */
  actor: string;
  kind: ActionItemDecisionKind;
  proposalRevision: number;
  versions: ActionItemVersions;
}

/**
 * A suggested change to an already promoted Task (issue #355). The extraction
 * never edits accepted work: it proposes field-level differences, and only the
 * owner's ordinary Task edit — bound to the Task version it was shown — can
 * apply them.
 */
export interface ActionItemAmendmentSuggestion {
  id: string;
  taskId: string;
  /** The proposal revision suggesting the change. */
  proposalRevision: number;
  /** Only the fields the proposal would change. */
  fields: Partial<ActionItemProposal>;
  /** The Task version the suggestion was computed against. */
  observedTaskVersion: number;
  status: "suggested" | "applied" | "declined";
  createdAt: string;
  resolvedAt: string | null;
}

export interface ActionItem {
  handoff?: MeetingHandoff;
  /**
   * Opaque Workspace identity, allocated once and stored with the record.
   * Nothing derives it: not content, not position, not a Run.
   */
  id: string;
  source: ActionItemSource;
  /** Which extraction of this Run produced the current proposal. The first is 1. */
  extractionRevision: number;
  evidence: ActionItemEvidence;
  /** Immutable proposal content, append-only. */
  proposalRevisions: ActionItemProposalRevision[];
  /** The revision the owner selected. Promotion accepts this content. */
  selectedRevision: number;
  /**
   * The highest revision the owner has reviewed. A correction raises the
   * latest revision above this watermark, which is what makes a promotion of
   * unreviewed content impossible rather than merely discouraged.
   */
  reviewedThrough: number;
  observations: ActionItemSourceObservation[];
  decisions: ActionItemDecisionRecord[];
  /** The recorded relationship to earlier work; null while none was needed. */
  reconciliation: ActionItemReconciliation | null;
  /**
   * Set when this record exists only as evidence about another one: it points
   * at the record it is evidence for and is not promotable.
   */
  reconciledInto: string | null;
  amendments: ActionItemAmendmentSuggestion[];
  /** Monotonic per record. Every write advances it; commands bind it. */
  version: number;
  state: ActionItemState;
  /** The Task a promotion created; null while pending or dismissed. */
  promotedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the owner promoted or dismissed it; null while pending. */
  decidedAt: string | null;
}

/**
 * One persisted materialization mapping (#355, MWR-010): the versioned key of
 * a checked output entry and the Action Item it is now, so a replay returns
 * the same record and never allocates a second one.
 */
export interface ActionItemMaterializationMapping {
  /**
   * `materialization:v1:<debriefRunId>:<outputEntryId>`. The key names the
   * immutable artifact scope and the entry, never display content.
   */
  key: string;
  debriefRunId: string;
  outputEntryId: string;
  candidateAlias: string | null;
  /** sha256 of the entry payload as it was checked. */
  payloadChecksum: string;
  actionItemId: string;
  proposalRevision: number;
  allocatedAt: string;
}

/** The Action Item queue as the Tasks product reads it. */
export interface ActionItemIndex {
  items: ActionItem[];
  context?: Record<string, ActionItemContext>;
}

/** Stored provenance resolved at the Tasks read boundary; no external evidence fetch. */
export interface ActionItemContext {
  meeting: { id: string; title: string; date: string } | null;
  evidence: { quote: string; timestamp: string | null } | null;
}

/**
 * The content promotion accepts: the revision the owner selected. Reading it
 * through this function is what keeps the proposal a revision rather than a
 * field someone can quietly overwrite.
 */
export function actionItemProposal(item: ActionItem): ActionItemProposal {
  const revision = item.proposalRevisions.find((entry) => entry.revision === item.selectedRevision);
  return revision?.content ?? item.proposalRevisions[0]!.content;
}

/** The newest revision. Higher than `reviewedThrough` while a correction waits. */
export function latestProposalRevision(item: ActionItem): number {
  return item.proposalRevisions.reduce((max, entry) => Math.max(max, entry.revision), 0);
}

/** True while a correction exists that the owner has not reviewed yet. */
export function selectionPending(item: ActionItem): boolean {
  return item.reviewedThrough < latestProposalRevision(item);
}

/**
 * Whether promotion may proceed. Unresolved reconciliation and unreviewed
 * corrections wait for the owner; a record that is evidence about another one
 * is never promotable. This is the eligibility rule the promotion command and
 * the review surface both read.
 */
export function promotable(item: ActionItem): boolean {
  return (
    item.state === "pending" &&
    item.reconciledInto === null &&
    item.reconciliation?.disposition !== "unresolved" &&
    !selectionPending(item)
  );
}
