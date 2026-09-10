import { createHash } from "node:crypto";
import type {
  ActionItem,
  MeetingDebriefActionItem,
  MeetingDebriefEmailOptions,
  MeetingDebriefEmailPreview,
  MeetingDebriefExtraction,
  MeetingDebriefReviewState,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { actionItemProposal } from "@chief-of-staff-demo/shared";
import { composeExternalDebriefBody } from "./externalBody.js";

/** Identity matching is delegated to the canonical Action Item owner. */
export type DebriefActionItemReader = (input: {
  debriefRunId: string;
  transcriptId: string;
  meetingId: string | null;
  actionItems: MeetingDebriefActionItem[];
}) => { current: (ActionItem | null)[]; earlier: ActionItem[] };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * ADR-0078: use the canonical owner's identities for default inclusion without
 * letting review availability gate reading. An unavailable join is disclosed;
 * earlier proposals remain explicit choices rather than silently disappearing.
 */
export function emailOptions(
  runId: string,
  record: TranscriptRecord,
  extraction: MeetingDebriefExtraction,
  read: DebriefActionItemReader | null,
): MeetingDebriefEmailOptions {
  let joined: ReturnType<DebriefActionItemReader> | null = null;
  try {
    joined =
      read?.({
        debriefRunId: runId,
        transcriptId: record.id,
        meetingId: record.meetingId ?? null,
        actionItems: extraction.actionItems,
      }) ?? null;
  } catch {
    /* Explicit unavailable state, never a dismissal. */
  }
  const candidates: MeetingDebriefEmailOptions["candidates"] = extraction.actionItems.map(
    (proposal, index) => {
      const item = joined?.current[index];
      return {
        // A missing reader cannot claim a canonical identity. This explicit, stable
        // fallback binds only this proposal until the owner can resolve it again.
        id: item?.id ?? `unavailable_${digest({ runId, proposal })}`,
        title: proposal.title,
        owner: proposal.owner,
        dueDate: proposal.dueDate,
        earlier: false,
        reviewState: item?.state ?? "unavailable",
        includedByDefault: item?.state !== "dismissed",
      };
    },
  );
  for (const item of joined?.earlier ?? [])
    candidates.push({
      id: item.id,
      title: actionItemProposal(item).title,
      owner: item.evidence.responsibleSurfaceName,
      dueDate: actionItemProposal(item).dueDate,
      earlier: true,
      reviewState: item.state,
      includedByDefault: false,
    });
  const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
  return {
    candidates: unique,
    unavailableReview: unique.some((candidate) => candidate.reviewState === "unavailable"),
  };
}

/**
 * One composer supplies both the visible preview and the approved output (#327).
 * Binding its inputs prevents a changed extraction or roster from authorizing
 * different mail, while the persisted snapshot keeps provider retries identical.
 */
export function emailPreview(
  runId: string,
  record: TranscriptRecord,
  extraction: MeetingDebriefExtraction,
  state: MeetingDebriefReviewState,
  owner: string | null,
  options: MeetingDebriefEmailOptions,
  selectedIds: string[],
): MeetingDebriefEmailPreview {
  const selected = new Set(selectedIds);
  if (
    selected.size !== selectedIds.length ||
    selectedIds.some((id) => !options.candidates.some((candidate) => candidate.id === id))
  )
    throw new Error("Email choices changed. Refresh the preview and review your selections.");
  const candidates = options.candidates.filter((candidate) => selected.has(candidate.id));
  const body = composeExternalDebriefBody(
    {
      ...extraction,
      actionItems: candidates.map((candidate) => ({
        title: candidate.title,
        owner: candidate.owner,
        dueDate: candidate.dueDate,
        ownerMentionId: null,
        ownerProfileId: null,
      })),
    },
    [],
  );
  const to = [
    ...state.roster.entries.filter((entry) => entry.email !== owner).map((entry) => entry.email),
    ...state.recipients.additional.map((entry) => entry.email),
  ];
  const subject = `Meeting debrief — ${record.source.fileName}`;
  return {
    version: 1,
    subject,
    body,
    to,
    selectedIds: candidates.map((candidate) => candidate.id),
    unavailableReview: options.unavailableReview,
    revision: digest({
      runId,
      extraction,
      roster: state.roster,
      recipients: state.recipients,
      owner,
      candidates,
      subject,
      body,
      to,
    }),
  };
}
