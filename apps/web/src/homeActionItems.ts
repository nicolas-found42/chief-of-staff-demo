import type { MeetingDebriefActionItemRollup } from "@chief-of-staff-demo/shared";

/** One open action item for the Meeting Wizard home rollup (issue #159). */
export interface HomeActionItem {
  runId: string;
  meetingId: string | null;
  index: number;
  title: string;
  owner: string | null;
  dueDate: string | null;
}

/** The rollup is the owner's short list, not an archive of every meeting. */
const MAX_HOME_ACTION_ITEMS = 12;

/** Loose name equality: case and surrounding space only, never initials. */
function sameName(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/**
 * The home's action-item rollup: the owner's own open, undismissed items
 * across every Debrief (issue #159).
 *
 * Ownership is read from the Profile the Catalog resolved, and — when it
 * resolved none — from the owner's name as the extraction stated it. The
 * name fallback is load-bearing: identity resolution rarely resolves
 * anything, and keying on the Profile alone made every unresolved item count
 * as the owner's, so the rollup listed the whole company's work. An item
 * naming somebody else is theirs whether or not a Profile was resolved.
 *
 * Done and dismiss are the #158 read-model states — a dismissed item never
 * lists, and a done item lists only while neither its local done nor its
 * Google Task says complete.
 */
export function selectHomeActionItems(
  rollup: MeetingDebriefActionItemRollup[],
  ownerProfileId: string | null,
  ownerName: string | null = null,
): HomeActionItem[] {
  const items = rollup
    .filter((item) => {
      if (item.ownerProfileId !== null) return item.ownerProfileId === ownerProfileId;
      /* Named somebody, and it was not the owner. Only an item with no owner
         at all is treated as possibly theirs. */
      return item.owner === null || sameName(item.owner, ownerName);
    })
    .map((item): HomeActionItem => ({
      runId: item.runId,
      meetingId: item.meetingId,
      index: item.index,
      title: item.title,
      owner: item.owner,
      dueDate: item.dueDate,
    }));
  /* Soonest due first, undated last: an overdue item is the reason to look at
     this list, and an undated one is not a deadline. */
  items.sort((left, right) => {
    if (left.dueDate === right.dueDate) return 0;
    if (left.dueDate === null) return 1;
    if (right.dueDate === null) return -1;
    return left.dueDate.localeCompare(right.dueDate);
  });
  return items.slice(0, MAX_HOME_ACTION_ITEMS);
}
