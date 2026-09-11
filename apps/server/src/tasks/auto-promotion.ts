import type {
  ActionItem,
  AutomaticPromotionAuthorizationFacts,
  Task,
} from "@chief-of-staff-demo/shared";
import { actionItemProposal } from "@chief-of-staff-demo/shared";
import type { ActionItemMaterialization, WorkspaceActionItems } from "./action-items.js";
import { promoteActionItem } from "./promotion.js";
import { promotionEligibility } from "./promotion-eligibility.js";
import type { WorkspaceTasks } from "./tasks.js";

/**
 * Automatic promotion of the owner's own commitments (ADR-0053/0083, issues
 * #181/#360).
 *
 * The Workspace default is Stage all: a model proposal waits for a person.
 * `auto-create-mine` is the owner's deliberate exception, and everything here
 * exists to keep that exception narrow enough to be safe — the cases it
 * refuses are the point of it, not gaps in it.
 *
 * Automatic promotion never decides anything a review could not; it only
 * decides sooner. So it declines every case where the answer is not already
 * obvious, and since #360 "obvious" means a *supported responsibility claim*
 * (the owner's own commitment, or a request they unambiguously accepted, for
 * this exact obligation, with nothing later changing it) recorded under an
 * operation that was reserved while automation was authorized. A saved
 * preference, a high confidence, a handoff alone or an older contract version
 * authorizes nothing.
 *
 * Eligibility is read from the record, never from live settings: the
 * reservation travels on the Action Item, so a restart, a replay or a later
 * enablement reaches the verdict the operation was reserved under.
 */
export interface AutoPromotionDeps {
  tasks: WorkspaceTasks;
  actionItems: WorkspaceActionItems;
  /**
   * The authorization in force now: the release restriction, the owner's
   * explicit enablement and the saved preference. Read once per materialization
   * so a prerequisite that changed since the reservation yields review instead
   * of a silent new decision (#343 §6). It never authorizes anything the
   * reservation did not.
   */
  authorization: () => AutomaticPromotionAuthorizationFacts;
  /**
   * Deliver one committed Task to its configured external destination. The
   * local write has already happened when this is called, so a rejected
   * promise is recorded on the link and never costs the Task (ADR-0056).
   */
  deliver?: (taskId: string) => Promise<Task>;
  log?: (message: string) => void;
}

/**
 * Materialize one extraction's proposals, then promote the ones every guard
 * allows. One function rather than two calls at the composition seam:
 * eligibility depends on what the queue held *before* this materialization —
 * whether this Transcript has been extracted before at all — and a caller
 * that had to remember to read that first would eventually forget.
 *
 * The answer is the materialized Action Items, in materialization order, with
 * whatever state this call left them in.
 */
export function materializeUnderPolicy(
  deps: AutoPromotionDeps,
  input: ActionItemMaterialization,
): ActionItem[] {
  const first = firstExtractionRunId(deps.actionItems, input);
  const materialized = deps.actionItems.materialize(input);
  /* A later extraction of the same Transcript is regeneration, and
     regeneration always stages: the owner has already reviewed this
     Transcript's proposals once, and automation must not answer for them a
     second time. */
  if (first !== null && first !== input.debriefRunId) {
    deps.log?.(`automatic promotion withheld: ${input.debriefRunId} regenerates ${first}`);
    return materialized;
  }
  const live = deps.authorization();
  return materialized.map((item) => promoteIfEligible(deps, item, live));
}

/**
 * The Debrief Run that first extracted this Transcript, or null when nothing
 * has. Taken from the stored queue rather than from a flag on the Run: the
 * queue is what survives a restart mid-promotion, so asking it is what makes
 * a resumed materialization reach the same verdict as the interrupted one.
 */
function firstExtractionRunId(
  actionItems: WorkspaceActionItems,
  input: ActionItemMaterialization,
): string | null {
  const held = actionItems.list({ transcriptId: input.transcriptId });
  return held[0]?.source.debriefRunId ?? null;
}

/**
 * Promote one Action Item if every guard holds, and answer with the record
 * either way. Failure to promote is never an error: this is an optimization
 * over a review the owner can still perform, so an item that cannot be
 * promoted automatically is simply an item still waiting for them.
 */
function promoteIfEligible(
  deps: AutoPromotionDeps,
  item: ActionItem,
  live: AutomaticPromotionAuthorizationFacts,
): ActionItem {
  const proposal = actionItemProposal(item);
  const decision = promotionEligibility(
    item,
    live,
    deps.tasks.findDuplicates({
      title: proposal.title,
      dueDate: proposal.dueDate,
      responsiblePerson: proposal.responsiblePerson,
    }).length > 0,
  );
  if (!decision.eligible) {
    /* Only an operation that expected automation is worth a line: a Stage all
       Workspace declines every proposal by design, and the review surface
       already shows the reason beside the proposal. */
    if (item.source.promotion?.claim === "first")
      deps.log?.(
        `automatic promotion declined for ${item.id}: ${decision.code} (${decision.reason})`,
      );
    return item;
  }
  try {
    /* Open, never completed: automation may accept a commitment the meeting
       made, but it may not invent the news that the work is already done. */
    const result = promoteActionItem(
      { tasks: deps.tasks, actionItems: deps.actionItems },
      item.id,
      {},
    );
    /* The Task has committed. Delivery is a second, separate step whose
       failure lands on the External Task Link, so an outage after this point
       costs a representation and never the accepted work itself. */
    if (deps.deliver && result.task.destination.provider !== "local") {
      void deps.deliver(result.task.id).catch((error: unknown) => {
        deps.log?.(`automatic delivery failed for ${result.task.id}: ${String(error)}`);
      });
    }
    return result.actionItem;
  } catch (error) {
    deps.log?.(`automatic promotion declined for ${item.id}: ${String(error)}`);
    return item;
  }
}
