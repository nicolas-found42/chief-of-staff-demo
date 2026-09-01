/** Meeting Debrief — Module-owned types (issue #139, spec #117, ADR-0037/0038). */

import { z } from "zod";

export const MEETING_DEBRIEF_MODULE_ID = "meeting-debrief" as const;
export const MEETING_DEBRIEF_MODULE_VERSION = 1 as const;

/**
 * Fixed Stages for this slice. `review`, `draft` and `tasks` come later (the
 * review workflow and the approval-gated outward writes); nothing outward is
 * written before approval (ADR-0038), so this slice ends after extraction.
 */
export const MEETING_DEBRIEF_STAGES = ["associate", "extract"] as const;
export type MeetingDebriefStage = (typeof MEETING_DEBRIEF_STAGES)[number];

/** The Intake every Debrief Run starts from: the Transcript Catalog's mining. */
export const MEETING_DEBRIEF_INTAKE = "transcript-catalog" as const;

/** How the Run's association stands: Calendar prefill, or manual confirmation. */
export type MeetingDebriefRosterStatus = "prefilled" | "requires_confirmation";

/** Whether the Debrief is ready for the owner's review. */
export type MeetingDebriefReviewReadiness = "ready" | "needs_roster" | "no_extraction";

/** One decision the meeting produced, with the transcript evidence for it. */
export interface MeetingDebriefDecision {
  statement: string;
  /** Transcript quote the decision stands on; null when none was preserved. */
  evidence: string | null;
}

/**
 * One action item with an inferred owner. The owner is a surface name the
 * extraction inferred — never an identity guess. `ownerProfileId` is filled
 * only when the Catalog's identity review state already links the mention the
 * extraction named; ambiguity stays ambiguous.
 */
export interface MeetingDebriefActionItem {
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
}

export interface MeetingDebriefIndex {
  entries: MeetingDebriefIndexEntry[];
}

/** The Debrief detail journey's payload: extraction, roster, identity, readiness. */
export interface MeetingDebriefDetail {
  runId: string;
  transcriptId: string;
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
}
