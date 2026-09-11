import type { ActionItem, Task, TaskCreateInput } from "@chief-of-staff-demo/shared";
import { actionItemProposal } from "@chief-of-staff-demo/shared";
import type { WorkspaceActionItems } from "./action-items.js";
import { TaskValidationError, type WorkspaceTasks } from "./tasks.js";

/**
 * Promoting one reviewed Action Item into a Task (ADR-0053, issue #178).
 *
 * A function over both Workspace modules rather than a method on either: an
 * Action Item is a proposal and a Task is accepted work, and neither should
 * have to know how the other is stored in order to stay itself. The two writes
 * meet here and nowhere else.
 *
 * Promotion is a decision, not a copy. The review supplies the accepted
 * fields, the Task snapshots them, and the Action Item keeps its own proposal
 * text exactly as extracted — so a later Task edit changes nothing about the
 * Meeting Debrief it came from.
 */
export interface PromotionDeps {
  tasks: WorkspaceTasks;
  actionItems: WorkspaceActionItems;
}

/** What one promotion accepts: the Task fields, and which state to create in. */
export interface PromotionInput extends Partial<TaskCreateInput> {
  /** Create the Task already completed — the meeting's work is already done. */
  completed?: boolean;
  /**
   * The Action Item version the owner reviewed (#355). A promotion decided
   * from an older read than the record now has is refused instead of
   * overwriting the change it never saw.
   */
  expectedVersion?: number;
  /** The proposal revision the owner reviewed, checked against the selection. */
  expectedProposalRevision?: number;
  /**
   * The owner saw that the Debrief this Action Item came from is incomplete
   * and chose to accept this work anyway (#345 §3). Required — exactly, as the
   * boolean `true` — for a review-only record, and recorded with the decision.
   */
  missingContentAcknowledged?: boolean;
}

export interface PromotionResult {
  task: Task;
  actionItem: ActionItem;
  /** False when this call found the promotion already recorded. */
  created: boolean;
}

/**
 * Promote once, whatever happens afterwards. An Action Item already promoted
 * answers with the Task it already has: a retry — a double-clicked button, a
 * reissued request, a client that lost the response — must never produce a
 * second Task for one commitment.
 *
 * The Task is written before the relationship, deliberately. The two files
 * cannot commit as one, so the order is chosen for what an interruption
 * leaves behind: a Task with no relationship is recoverable — the next attempt
 * finds it by its own source and adopts it — while a relationship pointing at
 * no Task would have lost the accepted work itself.
 */
export function promoteActionItem(
  deps: PromotionDeps,
  actionItemId: string,
  input: PromotionInput = {},
): PromotionResult {
  const item = deps.actionItems.get(actionItemId);
  if (!item) {
    throw new TaskValidationError("task-not-found", `No Action Item with id ${actionItemId}`);
  }
  const refusal = deps.actionItems.promotionRefusal(item);
  if (refusal && item.state !== "promoted") {
    throw new TaskValidationError(refusal.code, refusal.message);
  }
  /* A record from an incomplete publication is accepted only by an owner who
     was told what is missing. Nothing else stands in for that answer: not a
     truthy string, not an absent field, and not the fact that the work looks
     complete in itself. */
  if (item.source.reviewOnly === true && input.missingContentAcknowledged !== true) {
    throw new TaskValidationError(
      "action-item-missing-content-acknowledgment",
      "This Action Item comes from an incomplete Debrief. Acknowledge the missing content to accept it.",
    );
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== item.version) {
    throw new TaskValidationError(
      "action-item-version-conflict",
      `That Action Item changed since you read it (expected version ${input.expectedVersion}, current ${item.version}). Reload it and review the change.`,
    );
  }
  if (
    input.expectedProposalRevision !== undefined &&
    input.expectedProposalRevision !== item.selectedRevision
  ) {
    throw new TaskValidationError(
      "action-item-version-conflict",
      `That proposal changed since you read it (expected revision ${input.expectedProposalRevision}, current ${item.selectedRevision}). Reload it and review the change.`,
    );
  }
  if (item.state === "promoted" && item.promotedTaskId !== null) {
    const existing = deps.tasks.get(item.promotedTaskId);
    /* A promoted Action Item stays promoted even when its Task has been
       trashed or permanently deleted: the decision is history, and history
       does not become available again because the work went away. */
    if (existing) {
      return { task: existing, actionItem: item, created: false };
    }
    throw new TaskValidationError(
      "task-not-found",
      "That Action Item was already promoted and its Task no longer exists.",
    );
  }
  /* An interrupted promotion — the Task written, the relationship not — leaves
     a Task whose source names this Action Item and an Action Item still
     pending. Adopting that Task is what makes the retry safe: the two files
     cannot commit as one, so the recovery is to recognize the half that did. */
  const orphans = deps.tasks
    .list({ trashed: false })
    .concat(deps.tasks.list({ trashed: true }))
    .filter((candidate) => candidate.source?.actionItemId === item.id);
  if (orphans.length > 1) {
    throw new TaskValidationError(
      "action-item-recovery-conflict",
      "Multiple Tasks refer to this Action Item. Resolve the conflicting history before promotion.",
    );
  }
  const orphan = orphans[0];
  if (orphan) {
    /* The Action Item ID alone cannot resolve contradictory legacy lineage.
       Keep both records untouched so recovery never invents acceptance (#352). */
    if (
      orphan.source?.kind !== "action-item" ||
      orphan.source.debriefRunId !== item.source.debriefRunId ||
      orphan.source.transcriptId !== item.source.transcriptId ||
      orphan.source.meetingId !== item.source.meetingId
    ) {
      throw new TaskValidationError(
        "action-item-recovery-conflict",
        "The existing Task has conflicting source history. Resolve it before promotion.",
      );
    }
    /* Recovery repairs the relationship, not accepted work. A retry body is
       not authority to complete or edit the existing Task (#352). */
    return {
      task: orphan,
      actionItem: deps.actionItems.recordPromotion(
        item.id,
        orphan.id,
        { taskVersion: orphan.version },
        {
          ...(input.expectedVersion === undefined ? {} : { expectedVersion: item.version }),
          ...(input.missingContentAcknowledged === true
            ? { missingContentAcknowledged: true }
            : {}),
        },
      ),
      created: false,
    };
  }
  const prepared = deps.tasks.prepare(
    {
      title: input.title ?? actionItemProposal(item).title,
      notes: input.notes ?? actionItemProposal(item).notes,
      dueDate: input.dueDate === undefined ? actionItemProposal(item).dueDate : input.dueDate,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.listId === undefined ? {} : { listId: input.listId }),
      responsiblePerson:
        input.responsiblePerson === undefined
          ? actionItemProposal(item).responsiblePerson
          : input.responsiblePerson,
      ...(input.destination === undefined ? {} : { destination: input.destination }),
    },
    {
      kind: "action-item",
      actionItemId: item.id,
      debriefRunId: item.source.debriefRunId,
      transcriptId: item.source.transcriptId,
      meetingId: item.source.meetingId,
    },
  );
  /* The meeting's work may already be done, and a Task created open and then
     completed is two states the Workspace never needs to have held. */
  const task = input.completed === true ? deps.tasks.completedNow(prepared) : prepared;
  /* One publication (#355): the accepted Task, its initial state and the
     Action Item's own decision reach the Workspace together, so there is no
     interval in which the Task exists and nothing says who accepted it. */
  const staged = deps.actionItems.stagePromotion(
    item.id,
    task.id,
    { taskVersion: task.version },
    {
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: item.version }),
      ...(input.missingContentAcknowledged === true ? { missingContentAcknowledged: true } : {}),
    },
  );
  deps.tasks.commitAcceptance(task, staged.all ?? deps.actionItems.list());
  return { task: deps.tasks.get(task.id) ?? task, actionItem: staged.committed, created: true };
}
