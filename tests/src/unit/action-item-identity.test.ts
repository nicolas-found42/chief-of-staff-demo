import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ActionItem } from "@chief-of-staff-demo/shared";
import { actionItemProposal, promotable } from "@chief-of-staff-demo/shared";
import { TaskStore } from "../../../apps/server/src/tasks/store";

/**
 * Action Item identity across the stored-format change of issue #355
 * (MWR-008/009/061). A Workspace written before proposal revisions existed
 * must keep every record it already had: the same opaque ids, the same
 * decisions, and its stored proposal readable as the revision promotion
 * accepts.
 */
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

/** A Workspace holding one Action Item in the shape written before #355. */
function legacyWorkspace(overrides: Record<string, unknown> = {}): TaskStore {
  const root = mkdtempSync(join(tmpdir(), "cos-action-item-identity-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(
    join(root, "tasks/action-items.json"),
    `${JSON.stringify(
      [
        {
          id: "ai_legacy_1",
          source: {
            debriefRunId: "run_legacy",
            transcriptId: "drive_fileA_r1",
            meetingId: "meeting_1",
          },
          extractionRevision: 1,
          evidence: { responsibleMentionId: "m_alice", responsibleSurfaceName: "Alice" },
          proposal: {
            title: "Follow up on the billing fix",
            notes: "",
            dueDate: "2026-08-22",
            responsiblePerson: null,
          },
          state: "pending",
          promotedTaskId: null,
          createdAt: "2026-09-04T09:00:00.000Z",
          updatedAt: "2026-09-04T09:00:00.000Z",
          decidedAt: null,
          ...overrides,
        },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );
  return new TaskStore(root);
}

/** The one record the fixture holds, refused rather than narrowed when it is not. */
function only(items: ActionItem[]): ActionItem {
  expect(items).toHaveLength(1);
  return items[0];
}

it("reads a proposal written before revisions existed as the selected revision", () => {
  const item = only(legacyWorkspace().readActionItems());

  expect(item.id).toBe("ai_legacy_1");
  expect(actionItemProposal(item)).toEqual({
    title: "Follow up on the billing fix",
    notes: "",
    dueDate: "2026-08-22",
    responsiblePerson: null,
  });
  expect(item.selectedRevision).toBe(1);
  expect(item.version).toBe(1);
});

it("says honestly that a legacy proposal's extraction artifact is unknown", () => {
  const item = only(legacyWorkspace().readActionItems());

  expect(item.proposalRevisions[0]?.origin.kind).toBe("legacy-import");
  expect(item.observations[0]?.outputEntryId).toBeNull();
  expect(item.observations[0]?.transcriptChecksum).toBeNull();
});

it("keeps a legacy decision rather than reopening it", () => {
  const item = only(
    legacyWorkspace({
      state: "dismissed",
      decidedAt: "2026-09-05T09:00:00.000Z",
    }).readActionItems(),
  );

  expect(item.state).toBe("dismissed");
  expect(item.decidedAt).toBe("2026-09-05T09:00:00.000Z");
  expect(promotable(item)).toBe(false);
});
