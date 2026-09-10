import type { ActionItemIndex } from "@chief-of-staff-demo/shared";
import { actionItemProposal } from "@chief-of-staff-demo/shared";
import { test, expect } from "./fixture";
import { confirmMeetingOwner } from "./meeting-owner-fixture";

/**
 * Reviewing a proposal the Workspace cannot promote on its own (issue #355).
 * A corrected proposal and an unresolved relationship are questions for the
 * owner, so the surface asks them instead of offering a Create Task the
 * server would refuse.
 */
test.use({ freshWorkspace: true });

/** The first pending proposal that belongs to a Meeting, with its Meeting. */
async function firstPending(request: {
  get: (url: string) => Promise<{ json: () => Promise<unknown> }>;
}) {
  const index = (await (
    await request.get("/api/action-items?state=pending")
  ).json()) as ActionItemIndex;
  const item = index.items.find((entry) => entry.source.meetingId);
  expect(item, "the fixture proposed at least one Action Item on a Meeting").toBeDefined();
  return item!;
}

test("a corrected proposal asks which wording to accept before it can become a Task", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  await confirmMeetingOwner(request);
  const item = await firstPending(request);
  const corrected = await request.post(`/api/action-items/${item.id}/correct-proposal`, {
    data: {
      content: {
        title: "Corrected wording",
        notes: actionItemProposal(item).notes,
        dueDate: null,
        responsiblePerson: null,
      },
      expectedVersion: item.version,
    },
  });
  expect(corrected.status()).toBe(200);

  await page.goto(`/meetings/${item.source.meetingId!}#action-items`);
  const row = page.locator(`#action-item-${item.id}`);
  const question = row.getByRole("group", { name: "Corrected proposal", exact: true });
  await expect(question).toBeVisible();
  await expect(row.getByRole("button", { name: "Create Task", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();

  await question.getByRole("button", { name: "Accept the correction", exact: true }).click();

  await expect(row.getByRole("heading", { name: "Corrected wording", exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Create Task", exact: true })).toBeVisible();
});

test("a proposal that may repeat earlier work waits for the owner to say what it is", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  await confirmMeetingOwner(request);
  const item = await firstPending(request);
  const unresolved = await request.post(`/api/action-items/${item.id}/reconcile`, {
    data: { disposition: "unresolved", expectedVersion: item.version },
  });
  expect(unresolved.status()).toBe(200);

  await page.goto(`/meetings/${item.source.meetingId!}#action-items`);
  const row = page.locator(`#action-item-${item.id}`);
  const question = row.getByRole("group", {
    name: "Possible repeat of earlier work",
    exact: true,
  });
  await expect(question).toBeVisible();
  await expect(row.getByRole("button", { name: "Create Task", exact: true })).toHaveCount(0);

  await question.getByRole("button", { name: "Separate work", exact: true }).click();

  await expect(question).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Create Task", exact: true })).toBeVisible();
});
