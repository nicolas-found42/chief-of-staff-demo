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
 * - `reconciliations`: every recorded relationship to earlier work, appended
 *   rather than replaced, so a changed decision keeps the one it changed.
 * - `amendments`: suggested changes to an already promoted Task, which only
 *   the owner's own Task edit can apply.
 */

import type {
  HandoffDependencyTarget,
  HandoffDependencyUnresolved,
  HandoffProvenance,
  MeetingHandoffRecord,
  ResponsibilityClaim,
} from "./meeting-debrief.js";
import type { TaskResponsiblePerson } from "./task.js";

/**
 * Pending until the owner decides. Promotion and dismissal are the two
 * decisions; both are recorded here rather than in the Meeting Debrief, so a
 * decision survives re-extraction of the Debrief it came from.
 */
export type ActionItemState = "pending" | "promoted" | "dismissed";
/**
 * Whether automatic promotion would answer for one proposal, and why not when
 * it would not (#360). Reported beside the proposal so the owner reads the
 * reason rather than a policy setting: "restricted in this release", "not the
 * owner's own commitment", "a later turn completed it" and the rest each name
 * a different answer.
 */
export interface ActionItemAutomationView {
  eligible: boolean;
  /** Stable machine code — `eligible` when nothing declined it. */
  code: string;
  /** Why automation declined, in words the review surface shows. */
  reason: string;
}

/** Where the proposal came from. Every reference may later be unavailable. */
export interface ActionItemSource {
  debriefRunId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to; null until one is placed. */
  meetingId: string | null;
  /**
   * Set when the revision this record came from was exposed incomplete (#345,
   * ADR-0085). A review-only lineage never gains automatic eligibility, and
   * promoting one of its Action Items is the owner's own decision — taken with
   * an explicit acknowledgment of the content that is missing. Absent on
   * records materialized from a complete publication.
   */
  reviewOnly?: boolean;
  /**
   * The lineage/policy reservation the Debrief recorded before it asked the
   * model anything, carried with the record (#360, #358). It is a fact about
   * the operation rather than something re-derived later, so a replay, a
   * restart and a later enablement all reach the same verdict: `first` is the
   * only claim that can authorize automation, and an absent reservation is
   * honestly unknown — legacy, or an older writer — which never authorizes
   * either.
   */
  promotion?: {
    claim: "first" | "review-only" | "unknown";
    basis: string;
    operationId: string | null;
    reservedAt: string;
    /** The automatic-promotion authorization facts in force when it was reserved. */
    authorization: {
      released: boolean;
      enabledAt: string | null;
      preference: string;
      basis: string;
    } | null;
  };
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
      /** sha256 of the entry payload as it was checked, so the mapping is derivable. */
      payloadChecksum: string;
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
  decidedBy: "owner" | "extraction";
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
  /**
   * Recorded on a promotion of a review-only Action Item: the owner answered
   * the missing-content question when they accepted this work (#345 §3).
   */
  missingContentAcknowledged?: boolean;
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
  handoff?: MeetingHandoffRecord;
  /**
   * The structured responsibility claim this proposal was checked under
   * (issue #360). Absent on every record materialized from an extraction that
   * produced only the handoff — legacy, or a claim the pipeline could not
   * support — and its absence is what keeps such a record review-only.
   */
  responsibilityClaim?: ResponsibilityClaim | undefined;
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
  /**
   * Every relationship to earlier work that was recorded, oldest first. A
   * later decision is appended: the owner deciding a proposal is separate
   * work and then that it is the same work again is two decisions, and the
   * first one is what the second one changed.
   */
  reconciliations: ActionItemReconciliation[];
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

/** One dependency of a checked entry, as the materialization resolved it. */
export interface ActionItemDependencyMapping {
  /** Position in the checked dependency list, so a wording cannot move it. */
  index: number;
  /** The transcript's own words for the target, kept verbatim. */
  wording: string;
  /** The stable identity it resolved to, or the honest reason it did not. */
  target: HandoffDependencyTarget;
}

/**
 * One materialization mapping (#355, MWR-010): the versioned key of a checked
 * output entry and the Action Item it is now, so a replay returns the same
 * record and never allocates a second one.
 *
 * Derived from the records rather than stored beside them. An index committed
 * separately can be lost by the crash that follows the records reaching the
 * Workspace, and the replay would then propose the obligation a second time;
 * the record carries everything the key needs, so there is nothing to lose.
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
  /**
   * The entry's dependencies, resolved to stable output identities against the
   * checked output it came from (#347, MWR-048). Recorded with the mapping so
   * the publication manifest carries the same dependency map the record does.
   */
  dependencies: ActionItemDependencyMapping[];
}

/** What one stored dependency resolves to against the records held now. */
export type ResolvedActionItemDependencyTarget =
  | {
      kind: "action-item";
      /** The record it named. A later rename does not move it. */
      actionItemId: string;
      /** The revision it resolved to when the reference was recorded. */
      proposalRevision: number;
      /**
       * The Action Item the reference originally named, when reconciliation
       * redirected it. The original identity is retained, never replaced.
       */
      redirectedFrom: string | null;
    }
  | {
      kind: "unresolved";
      reason: HandoffDependencyUnresolved;
    }
  | { kind: "external" };

/**
 * One dependency read at the Tasks boundary (#347, MWR-048): the transcript's
 * words, condition and provenance preserved, plus what it resolves to now. A
 * reference is a proposal/evidence reference — it never schedules, gates or
 * blocks a Task (ADR-0054).
 */
export interface ResolvedActionItemDependency {
  wording: string;
  condition: string;
  provenance: HandoffProvenance;
  target: ResolvedActionItemDependencyTarget;
}

/** The Action Item queue as the Tasks product reads it. */
export interface ActionItemIndex {
  /** Per-proposal automatic-promotion verdicts, when a policy surface is composed. */
  automation?: Record<string, ActionItemAutomationView>;
  items: ActionItem[];
  context?: Record<string, ActionItemContext>;
  /**
   * Each proposal's dependencies, resolved against the records held now
   * (#347, MWR-048). A sibling map rather than a field on the record: the
   * resolution is a projection of the stored reference, and the stored record
   * is never rewritten to carry it.
   */
  dependencies?: Record<string, ResolvedActionItemDependency[]>;
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

/** The relationship that stands now, or null while none was recorded. */
export function currentReconciliation(item: ActionItem): ActionItemReconciliation | null {
  return item.reconciliations.at(-1) ?? null;
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
    currentReconciliation(item)?.disposition !== "unresolved" &&
    !selectionPending(item)
  );
}
