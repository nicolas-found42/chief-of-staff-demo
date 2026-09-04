import type { MeetingDebriefActionItemRollup } from "@chief-of-staff-demo/shared";
import { describe, expect, it } from "vitest";
import { selectHomeActionItems } from "../../../apps/web/src/homeActionItems";

/**
 * The Meeting Wizard home lists the owner's own open action items (issue
 * #159). Dropping dismissed and completed items is the server rollup's job now
 * (`/api/meeting-debrief/action-items`), so what is left here is whose an item
 * is, what order they read in, and how many.
 *
 * Ownership has two keys, and the second is load-bearing: the Catalog resolves
 * very few mentions to Profiles, so keying on the Profile alone made every
 * unresolved item count as the owner's and the list became everyone's work.
 */

const OWNER = "profile_owner";
const OTHER = "profile_other";
const OWNER_NAME = "Nicolas Alexander";

function item(overrides: Partial<MeetingDebriefActionItemRollup> = {}) {
  return {
    runId: "run",
    meetingId: "meeting",
    index: 0,
    title: "title",
    owner: null,
    ownerProfileId: null,
    dueDate: null,
    ...overrides,
  } satisfies MeetingDebriefActionItemRollup;
}

describe("selectHomeActionItems", () => {
  it("keeps the owner's resolved items and drops another Profile's", () => {
    const items = [
      item({ title: "mine", ownerProfileId: OWNER }),
      item({ title: "theirs", ownerProfileId: OTHER }),
    ];
    expect(selectHomeActionItems(items, OWNER).map((entry) => entry.title)).toEqual(["mine"]);
  });

  it("falls back to the owner's name when the Catalog resolved no Profile", () => {
    const items = [
      item({ title: "mine-by-name", owner: OWNER_NAME }),
      item({ title: "mine-cased", owner: "  nicolas alexander " }),
      item({ title: "theirs-by-name", owner: "Richard Achee" }),
      item({ title: "nobody-named" }),
    ];
    expect(selectHomeActionItems(items, OWNER, OWNER_NAME).map((entry) => entry.title)).toEqual([
      "mine-by-name",
      "mine-cased",
      "nobody-named",
    ]);
  });

  it("lets a resolved Profile outrank the name it was written under", () => {
    const items = [item({ title: "theirs", owner: OWNER_NAME, ownerProfileId: OTHER })];
    expect(selectHomeActionItems(items, OWNER, OWNER_NAME)).toEqual([]);
  });

  it("keeps only unowned items when the owner is unconfirmed", () => {
    const items = [
      item({ title: "unowned" }),
      item({ title: "named", owner: "Richard Achee" }),
      item({ title: "resolved", ownerProfileId: OTHER }),
    ];
    expect(selectHomeActionItems(items, null).map((entry) => entry.title)).toEqual(["unowned"]);
  });

  it("sorts by due date, undated last", () => {
    const items = [
      item({ title: "undated" }),
      item({ title: "later", dueDate: "2026-09-10" }),
      item({ title: "overdue", dueDate: "2026-06-01" }),
    ];
    expect(selectHomeActionItems(items, OWNER).map((entry) => entry.title)).toEqual([
      "overdue",
      "later",
      "undated",
    ]);
  });

  it("caps the list — the home is a short list, not an archive", () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      item({
        title: `item-${index}`,
        index,
        dueDate: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
      }),
    );
    expect(selectHomeActionItems(items, OWNER)).toHaveLength(12);
  });

  it("carries the Meeting and the Run each item came from", () => {
    const items = [item({ runId: "run_7", meetingId: "meeting_7", index: 3 })];
    expect(selectHomeActionItems(items, OWNER)[0]).toMatchObject({
      runId: "run_7",
      meetingId: "meeting_7",
      index: 3,
    });
  });
});
