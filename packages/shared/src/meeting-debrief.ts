/** Meeting Debrief — Module-owned types (issues #139/#140, spec #117, ADR-0037/0038). */

import { z } from "zod/v3";
import type {
  TranscriptAssociation,
  TranscriptOccurrence,
  TranscriptRosterPerson,
  TranscriptSpeakerIdentityMapping,
  TranscriptTimeAnchor,
} from "./transcript.js";
import type { OperationBudgetSnapshot } from "./model-admission.js";

export const MEETING_DEBRIEF_MODULE_ID = "meeting-debrief" as const;
export const MEETING_DEBRIEF_MODULE_VERSION = 2 as const;

/**
 * Fixed Stages for this Module. `review` is the durable owner wait and
 * `regenerate` the audited re-extraction Stage (issue #140, ADR-0037/0038);
 * the approval-gated outward writes (`draft`, `tasks`) come in the next
 * slice, so nothing outward is written before approval.
 */
export const MEETING_DEBRIEF_STAGES = ["associate", "extract", "review", "regenerate"] as const;
export type MeetingDebriefStage = (typeof MEETING_DEBRIEF_STAGES)[number];

/** The Intake every Debrief Run starts from: the Transcript Catalog's mining. */
export const MEETING_DEBRIEF_INTAKE = "transcript-catalog" as const;

/** How the Run's association stands: Calendar prefill, or manual confirmation. */
export type MeetingDebriefRosterStatus = "prefilled" | "requires_confirmation";

/** Whether the Debrief is ready for the owner's review. */
/**
 * How a Debrief stands for the one thing that still needs the owner: the
 * outward writes. Nothing gates reading or using a Debrief any more, so this
 * describes publishing readiness only — `needs_roster` means the attendee
 * list is not settled enough to address a draft to, not that the Debrief is
 * unfinished.
 */
export type MeetingDebriefReviewReadiness = "ready" | "needs_roster" | "no_extraction";

/**
 * Immutable snapshot of context at extraction time (#342, #356, MWR-043).
 * Freezes source, association, meeting occurrence, time anchor, roster,
 * and identity review state before model work so later changes to Calendar
 * or decisions cannot rewrite historical context.
 */
export interface ExtractionContextSnapshot {
  version: 1;
  capturedAt: string;
  source: {
    transcriptId: string;
    sourceSystem: string;
    externalFileId: string;
    fileName: string;
    checksum: string | null;
    observedRevision: number;
    extractorVersion: number;
  };
  association: TranscriptAssociation | null;
  meetingId: string | null;
  occurrence: TranscriptOccurrence | null;
  timeAnchor: TranscriptTimeAnchor | null;
  roster: TranscriptRosterPerson[];
  speakers: string[];
  speakerIdentityMappings: TranscriptSpeakerIdentityMapping[];
  identityReview: {
    mentionCount: number;
    decisionCount: number;
    organizationCount: number;
  };
}
/**
 * Unreviewed Runs expire to `skipped` this many days after the review wait
 * started (ADR-0038). A number of policy, fixed in version 1 of the review
 * slice and unconfigured, like the four-hour Brief lead time.
 */
export const MEETING_DEBRIEF_REVIEW_EXPIRY_DAYS = 30 as const;

/** Why the Run ended when its review window elapsed. */
export const MEETING_DEBRIEF_EXPIRED_REASON = "debrief_expired_unreviewed" as const;

/** One whole field the review may regenerate (ADR-0037: regenerated, never edited). */
export const MEETING_DEBRIEF_FIELDS = [
  "summary",
  "decisions",
  "actionItems",
  "openQuestions",
  "effectivenessEvidence",
  "coachingAdvice",
] as const;
export type MeetingDebriefField = (typeof MEETING_DEBRIEF_FIELDS)[number];

/**
 * One confirmed roster entry. The owner is resolved live against the
 * confirmed owner identity, never stored — it can change between reviews.
 */
export interface MeetingDebriefRosterEntry {
  email: string;
  displayName: string | null;
  /** The Profile this attendee was bound to at roster confirmation; null while unbound. */
  profileId: string | null;
  profileRevision: number | null;
}

/** One non-attendee recipient: an explicit confirmed Profile selection with a verified email. */
export interface MeetingDebriefRecipient {
  profileId: string;
  profileRevision: number;
  email: string;
}

/** Why the review surface cannot approve yet. Stable codes the UI renders. */
export type MeetingDebriefApprovalBlocker =
  "owner-identity-unconfirmed" | "roster-unconfirmed" | `attendee-unverified-email:${string}`;

/**
 * The Module-owned review state of one Debrief Run (issue #140), stored as
 * the Run's `review.json`. The Run is the log; this record is the review's
 * durable state, and approval locks every field of it.
 */
export interface MeetingDebriefReviewState {
  version: 1;
  /** Missing on historical records; only an explicit preview supplies this snapshot. */
  email?: MeetingDebriefEmailPreview | null;
  runId: string;
  roster: {
    status: "unconfirmed" | "confirmed";
    confirmedAt: string | null;
    entries: MeetingDebriefRosterEntry[];
  };
  recipients: {
    additional: MeetingDebriefRecipient[];
  };
  review: {
    /** Action-item indexes the owner dismissed. Never become Google Tasks (issue #158). */
    droppedActionItems: number[];
    /** Action-item indexes the owner marked done. Local until a Google Task exists (issue #158). */
    completedActionItems: number[];
  };
  /** The pending owner action the Run resumes for; null while it simply waits. */
  request: { kind: "regenerate"; field: MeetingDebriefField } | { kind: "approve" } | null;
  /** Set once by approval; terminal for every review mutation afterwards. */
  approval: { approvedAt: string } | null;
}

/** The review half of the Debrief detail journey's payload. */
export interface MeetingDebriefReviewView {
  /**
   * `published` once the Gmail draft has been created; `extracted` before
   * that. A Debrief is never "awaiting review" — it finishes when it is
   * extracted — and never expires.
   */
  state: "extracted" | "published";
  approvedAt: string | null;
  /** Locked reviewed output retained for retry after a provider failure. */
  email?: MeetingDebriefEmailPreview | null;
  /**
   * The Gmail draft this Debrief created, or null when none exists (issue
   * #182). A draft, never a sent message: `url` opens it in Gmail for the
   * owner to finish and send themselves.
   */
  draft: { draftId: string; url: string; recipientCount: number; createdAt?: string } | null;
  roster: {
    status: "unconfirmed" | "confirmed";
    confirmedAt: string | null;
    entries: MeetingDebriefRosterEntry[];
  };
  /** Derived: confirmed attendees other than the owner, each bound to a Profile. */
  automaticRecipients: MeetingDebriefRecipient[];
  /** Explicit non-attendee recipients, each an explicit confirmed Profile selection. */
  additionalRecipients: MeetingDebriefRecipient[];
  /** What the extraction suggested from follow-up context; each needs explicit confirmation. */
  suggestedRecipients: Array<{ name: string; email: string | null }>;
  /** Why approval is blocked right now; empty when ready. */
  approvalBlockers: MeetingDebriefApprovalBlocker[];
  /** Set when this Run re-extracts a transcript that already has an approved Debrief. */
  duplicateWarning: { approvedRunId: string } | null;
}

/** One decision the meeting produced, with the transcript evidence for it. */
export interface MeetingDebriefDecision {
  statement: string;
  /** Transcript quote the decision stands on; null when none was preserved. */
  evidence: string | null;
}

/**
 * How one handoff detail stands against the transcript (MWR-046, spec #347).
 *
 * `supported` and `suggested` are what this build produces: a supported
 * purpose, criterion, input or retrieval step cites the occurrences it stands
 * on, while a suggested one is the extraction's own proposal and nobody agreed
 * to it. `explicit` and `inferred` are the labels a record written before
 * provenance existed carried for those same two claims — imported verbatim
 * rather than translated, because the record's own word is the evidence of
 * what it claimed, and its stored occurrences were never recorded.
 * `unknown` means no provenance was recorded at all.
 */
export const HandoffProvenanceSchema = z.enum([
  "supported",
  "suggested",
  "unknown",
  "explicit",
  "inferred",
]);
export type HandoffProvenance = z.infer<typeof HandoffProvenanceSchema>;

/** The two claims a record written before provenance existed could make. */
export type LegacyHandoffBasis = "explicit" | "inferred";

/** One transcript occurrence a handoff detail stands on, as its evidence does. */
export const HandoffSourceSchema = z.strictObject({
  quote: z.string(),
  speaker: z.string().nullable(),
  timestamp: z.string().nullable(),
});
export type HandoffSource = z.infer<typeof HandoffSourceSchema>;

/**
 * One purpose, criterion, input or retrieval step: the text as the extraction
 * wrote it, what its provenance is, and the occurrences a supported claim
 * stands on. The occurrences are grounded against the transcript before the
 * handoff leaves the Module, so a claim cannot carry a quotation its source
 * does not say.
 */
export const HandoffDetailSchema = z.strictObject({
  text: z.string(),
  provenance: HandoffProvenanceSchema,
  /** Non-empty exactly when `provenance` claims the transcript supports it. */
  sources: z.array(HandoffSourceSchema),
});
export type HandoffDetail = z.infer<typeof HandoffDetailSchema>;

/**
 * Why a dependency carries no resolved identity. Each is a fact about the
 * checked output rather than a guess: `ambiguous-title` is two entries sharing
 * the wording, `not-extracted` is no entry carrying it, `self-reference` is the
 * dependency naming its own entry, `not-resolved` is a record or artifact that
 * never had targets written, `missing-record` is a resolved mapping whose
 * Action Item is no longer in the Workspace, and `redirect-cycle` is a
 * reconciliation chain pointing back at itself.
 */
export const HandoffDependencyUnresolvedSchema = z.enum([
  "ambiguous-title",
  "not-extracted",
  "self-reference",
  "not-resolved",
  "missing-record",
  "redirect-cycle",
]);
export type HandoffDependencyUnresolved = z.infer<typeof HandoffDependencyUnresolvedSchema>;

/**
 * What one dependency names. `output` is the checked output entry itself — the
 * stable identity inside this Run's result — which is what the Workspace then
 * resolves to the Action Item and proposal revision it materialized as
 * (MWR-048). Display titles are labels; this is the reference.
 */
export const HandoffDependencyTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("output"), outputEntryId: z.string() }),
  z.strictObject({ kind: z.literal("unresolved"), reason: HandoffDependencyUnresolvedSchema }),
  z.strictObject({ kind: z.literal("external") }),
]);
export type HandoffDependencyTarget = z.infer<typeof HandoffDependencyTargetSchema>;

/** Source responsibility and execution context are distinct from a Task's Responsible Person. */
export const MeetingHandoffSchema = z.strictObject({
  version: z.literal(2),
  commitment: z.enum(["explicit", "inferred"]),
  purpose: HandoffDetailSchema,
  responsibility: z.strictObject({
    names: z.array(z.string()),
    basis: z.enum(["explicit", "inferred", "unknown"]),
    reason: z.string(),
  }),
  completionCriteria: z.array(HandoffDetailSchema),
  requiredInputs: z.array(HandoffDetailSchema),
  missingInputs: z.array(
    z.strictObject({ information: HandoffDetailSchema, obtainBy: HandoffDetailSchema }),
  ),
  dependencies: z.array(
    z.strictObject({
      /** The transcript's own words for what this depends on; kept verbatim. */
      actionTitle: z.string(),
      condition: z.string(),
      provenance: HandoffProvenanceSchema,
      sources: z.array(HandoffSourceSchema),
      /**
       * What the extraction says this names: another proposal in this same
       * extraction, or something outside it. The Module resolves `extracted`
       * against the checked output and never invents a target for `external`.
       */
      references: z.enum(["extracted", "external"]),
      /**
       * The stable identity the dependency resolved to, written by
       * materialization against the checked output. Absent in the artifact the
       * extraction produced and in records written before targets existed; a
       * reader treats absence as unresolved rather than guessing.
       */
      target: HandoffDependencyTargetSchema.optional(),
    }),
  ),
  timing: z.strictObject({
    kind: z.enum(["deadline", "trigger", "unspecified"]),
    stated: z.string(),
    referenceDate: z.string().nullable(),
    reasoning: z.string(),
  }),
  evidence: z.array(HandoffSourceSchema),
  statusReasoning: z.string(),
});
export type MeetingHandoff = z.infer<typeof MeetingHandoffSchema>;

/**
 * A handoff as a Workspace or Run stored it before provenance existed (version
 * 1): purpose and inputs are plain text, and each labelled detail carries
 * `explicit`/`inferred` instead of provenance and occurrences. Read through the
 * accessors in `handoff-notes.ts`, never written by this build.
 */
export interface StoredMeetingHandoff {
  version: 1;
  commitment: "explicit" | "inferred";
  purpose: string;
  responsibility: {
    names: string[];
    basis: "explicit" | "inferred" | "unknown";
    reason: string;
  };
  completionCriteria: Array<{ text: string; basis: LegacyHandoffBasis }>;
  requiredInputs: string[];
  missingInputs: Array<{
    information: string;
    obtainBy: string;
    basis: LegacyHandoffBasis;
  }>;
  dependencies: Array<{
    actionTitle: string;
    condition: string;
    basis: LegacyHandoffBasis;
  }>;
  timing: {
    kind: "deadline" | "trigger" | "unspecified";
    stated: string;
    referenceDate: string | null;
    reasoning: string;
  };
  evidence: HandoffSource[];
  statusReasoning: string;
}

/** Every handoff shape a record or artifact may carry. */
export type MeetingHandoffRecord = MeetingHandoff | StoredMeetingHandoff;

/**
 * One action item with an inferred owner. The owner is a surface name the
 * extraction inferred — never an identity guess. `ownerProfileId` is filled
 * only when the Catalog's identity review state already links the mention the
 * extraction named; ambiguity stays ambiguous.
 */
export interface MeetingDebriefActionItem {
  handoff?: MeetingHandoffRecord | undefined;
  title: string;
  owner: string | null;
  /** The Catalog mention the owner refers to, when the extraction identified one. */
  ownerMentionId: string | null;
  /** Resolved by the Debrief from Catalog review state — never guessed. */
  ownerProfileId: string | null;
  /** Optional due date as an ISO date; null when none was stated. */
  dueDate: string | null;
}

export interface MeetingDebriefOpenQuestion {
  question: string;
  /** Who raised it, as a surface name; null when unclear. */
  raisedBy: string | null;
}

/** The complete structured retrospective of one meeting. */
export interface MeetingDebriefExtraction {
  version: 1;
  summary: string;
  decisions: MeetingDebriefDecision[];
  actionItems: MeetingDebriefActionItem[];
  openQuestions: MeetingDebriefOpenQuestion[];
  /** Evidence the meeting worked or did not — stays in Meeting Wizard. */
  effectivenessEvidence: string;
  /** Coaching advice for the workspace owner — stays in Meeting Wizard. */
  coachingAdvice: string;
  /**
   * Non-attendee people follow-up context implies should receive the
   * retrospective. A suggestion is never a recipient: the review surface
   * confirms each explicitly against a Profile with a verified email.
   */
  suggestedRecipients: Array<{ name: string; email: string | null }>;
}

/**
 * Strict model Result Shape (ADR-0029/0030): every adapter response is
 * validated here before it is used. There is no field for a Gmail draft, a
 * Task, or any other outward write — the extraction cannot carry one.
 */
export const MeetingDebriefExtractionSchema = z.strictObject({
  version: z.literal(1),
  summary: z.string().min(1),
  decisions: z.array(
    z.strictObject({
      statement: z.string().min(1),
      evidence: z.string().min(1).nullable(),
    }),
  ),
  actionItems: z.array(
    z.strictObject({
      handoff: MeetingHandoffSchema.optional(),
      title: z.string().min(1),
      owner: z.string().min(1).nullable(),
      ownerMentionId: z.string().min(1).nullable(),
      /** The model leaves this null; the Debrief resolves it from Catalog review state. */
      ownerProfileId: z.string().min(1).nullable(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
    }),
  ),
  openQuestions: z.array(
    z.strictObject({
      question: z.string().min(1),
      raisedBy: z.string().min(1).nullable(),
    }),
  ),
  effectivenessEvidence: z.string(),
  coachingAdvice: z.string(),
  suggestedRecipients: z.array(
    z.strictObject({
      name: z.string().min(1),
      /** Only an address stated in the transcript; never invented. */
      email: z.string().min(1).nullable(),
    }),
  ),
});

/** What one finished Debrief Run holds in its `result.json`. */
export interface MeetingDebriefRunResult {
  version: 1;
  transcriptId: string;
  extractedAt: string;
  debrief: MeetingDebriefExtraction;
}

/** Identity review state consumed for one transcript, as the Catalog holds it. */
export interface MeetingDebriefIdentitySummary {
  /** Mentions whose Catalog review decision links or creates a Profile. */
  resolved: Array<{ mentionId: string; surfaceText: string; profileId: string }>;
  /** Mentions still unresolved or ambiguous — shown as review state, never guessed. */
  unresolved: Array<{ mentionId: string; surfaceText: string }>;
  /** Organization mentions observed in the transcript. */
  organizations: Array<{ mentionId: string; surfaceText: string }>;
}

/** One row of the Debrief list in Meeting Wizard. */
export interface MeetingDebriefIndexEntry {
  runId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to (issue #153); null until placed. */
  meetingId: string | null;
  status: "pending" | "running" | "blocked" | "done" | "failed" | "skipped";
  summary: string | null;
  meetingDate: string | null;
  fileName: string | null;
  /** Whether the transcript is Calendar-linked (occurrence association known). */
  linked: boolean;
  occurrenceKey: string | null;
  rosterStatus: MeetingDebriefRosterStatus;
  rosterSize: number;
  identity: { resolvedCount: number; unresolvedCount: number; organizationCount: number };
  reviewReadiness: MeetingDebriefReviewReadiness;
  /** The Run's review state; null before the review record exists. */
  reviewState: "published" | null;
  rosterConfirmed: boolean;
  recipientCount: number;
}

export interface MeetingDebriefIndex {
  entries: MeetingDebriefIndexEntry[];
}

/** The Debrief detail journey's payload: extraction, roster, identity, readiness. */
export interface MeetingDebriefDetail {
  runId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to (issue #153); null until placed. */
  meetingId: string | null;
  status: MeetingDebriefIndexEntry["status"];
  summary: string | null;
  skipReason: string | null;
  meetingDate: string | null;
  fileName: string | null;
  sourceUrl: string | null;
  linked: boolean;
  occurrence: { occurrenceKey: string; calendarEventId: string | null } | null;
  roster: Array<{ displayName: string | null; email: string }>;
  speakers: string[];
  rosterStatus: MeetingDebriefRosterStatus;
  identity: MeetingDebriefIdentitySummary;
  extraction: MeetingDebriefExtraction | null;
  reviewReadiness: MeetingDebriefReviewReadiness;
  /** The review workflow's view; null before the Run holds a review record. */
  review: MeetingDebriefReviewView | null;
  budget?: OperationBudgetSnapshot | null | undefined;
  interrupted?: boolean | undefined;
}

/** Email inclusion is independent of canonical Task review. */
export interface MeetingDebriefEmailCandidate {
  id: string;
  title: string;
  owner: string | null;
  dueDate: string | null;
  earlier: boolean;
  reviewState: "pending" | "promoted" | "dismissed" | "unavailable";
  includedByDefault: boolean;
}

export interface MeetingDebriefEmailOptions {
  candidates: MeetingDebriefEmailCandidate[];
  unavailableReview: boolean;
}

/** Exact server-composed draft and binding to the inputs the owner reviewed. */
export interface MeetingDebriefEmailPreview {
  version: 1;
  subject: string;
  body: string;
  to: string[];
  selectedIds: string[];
  revision: string;
  unavailableReview: boolean;
}
