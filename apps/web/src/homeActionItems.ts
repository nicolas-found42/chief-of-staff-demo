import type { MeetingDebriefDetail } from "@chief-of-staff-demo/shared";

/** One open action item for the Meeting Wizard home rollup (issue #159). */
export interface HomeActionItem {
  runId: string;
  meetingId: string | null;
  index: number;
  title: string;
  owner: string | null;
  dueDate: string | null;
}

/**
 * The home's action-item rollup: the owner's or owner-unresolved items that
 * are still open and not dismissed, across Debriefs reviewed or not (issue
 * #159). Done and dismiss are the #158 read-model states — a dismissed item
 * never lists, and a done item lists only while neither its local done nor
 * its Google Task says complete. An item resolved to someone else's Profile
 * is theirs, never the owner's; an unresolved owner counts as the owner's
 * until the Catalog says otherwise.
 */
export function selectHomeActionItems(
  details: MeetingDebriefDetail[],
  ownerProfileId: string | null,
): HomeActionItem[] {
  const items: HomeActionItem[] = [];
  for (const detail of details) {
    const extraction = detail.extraction;
    if (!extraction) continue;
    const dropped = new Set(detail.review?.droppedActionItems ?? []);
    const doneLocal = new Set(detail.review?.completedActionItems ?? []);
    const tasks = new Map(
      (detail.review?.actionItemTasks ?? []).map((entry) => [entry.index, entry.completed]),
    );
    extraction.actionItems.forEach((item, index) => {
      if (dropped.has(index)) return;
      if (item.ownerProfileId !== null && item.ownerProfileId !== ownerProfileId) return;
      const done = tasks.has(index) ? tasks.get(index)! : doneLocal.has(index);
      if (done) return;
      items.push({
        runId: detail.runId,
        meetingId: detail.meetingId,
        index,
        title: item.title,
        owner: item.owner,
        dueDate: item.dueDate,
      });
    });
  }
  return items;
}
