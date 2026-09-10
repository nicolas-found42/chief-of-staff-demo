import { operationalHandoff } from "../src/helpers/operational-handoff";
import type { ActionItemIndex } from "@chief-of-staff-demo/shared";
import { actionItemProposal } from "@chief-of-staff-demo/shared";
import { test, expect } from "./fixture";
import { confirmMeetingOwner } from "./meeting-owner-fixture";

test.use({ freshWorkspace: true });

test("Home shows only the canonical approval count and review stays on the source Meeting", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  await confirmMeetingOwner(request);
  const index = (await (
    await request.get("/api/action-items?state=pending")
  ).json()) as ActionItemIndex;
  await page.goto("/");
  const indicator = page.getByRole("link", {
    name: `Awaiting approval (${index.items.length})`,
    exact: true,
  });
  await expect(indicator).toBeVisible();
  for (const item of index.items)
    await expect(page.getByText(actionItemProposal(item).title, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create Task", exact: true })).toHaveCount(0);
  await indicator.click();
  await expect(page).toHaveURL(/\/meetings/);
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: "Create Task", exact: true })).toHaveCount(0);
  for (const item of index.items)
    await expect(page.getByText(actionItemProposal(item).title, { exact: true })).toHaveCount(0);
  const item = index.items.find(
    (entry: { source: { meetingId: string | null } }) => entry.source.meetingId,
  )!;
  await page.goto(`/tasks?meetingId=${item.source.meetingId}#action-items`);
  await page.getByRole("link", { name: "Review on source Meeting", exact: true }).click();
  const actions = page.getByRole("region", { name: "Action Items", exact: true });
  await expect(
    actions.getByRole("button", { name: "Create Task", exact: true }).first(),
  ).toBeVisible();
  await actions.getByRole("button", { name: "Dismiss", exact: true }).first().click();
  await expect(actions.getByRole("button", { name: "Undo", exact: true })).toBeFocused();
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: `Awaiting approval (${index.items.length - 1})`, exact: true }),
  ).toBeVisible();
});

test("unavailable source context retains source-scoped canonical review", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  await confirmMeetingOwner(request);
  const { items } = (await (
    await request.get("/api/action-items?state=pending")
  ).json()) as ActionItemIndex;
  const source = items[0].source.debriefRunId;
  await page.route("**/api/action-items?**", async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as ActionItemIndex;
    data.context = Object.fromEntries(
      data.items.map((item: { id: string }) => [item.id, { meeting: null, evidence: null }]),
    );
    await route.fulfill({ response, json: data });
  });
  await page.goto(`/meetings/recovery/${source}`);
  await expect(
    page.getByText("The original Meeting context is unavailable.", { exact: false }),
  ).toBeVisible();
  const actions = page.getByRole("region", { name: "Action Items", exact: true });
  await expect(
    actions.getByRole("heading", { name: actionItemProposal(items[0]).title, exact: true }),
  ).toBeVisible();
  await actions.getByRole("button", { name: "Dismiss", exact: true }).first().click();
  await expect(actions.getByRole("button", { name: "Undo", exact: true })).toBeFocused();
  await actions.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    actions.getByRole("heading", { name: actionItemProposal(items[0]).title, exact: true }),
  ).toBeVisible();
});

test("execution details distinguish inferred criteria and preserve keyboard focus", async ({
  page,
  request,
}) => {
  const fixture = await (await request.post("/api/test/meetings/overview-fixture")).json();
  await confirmMeetingOwner(request);
  await page.route("**/api/action-items?**", async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as ActionItemIndex;
    for (const item of data.items) {
      item.handoff = {
        ...operationalHandoff(),
        commitment: "inferred",
        purpose: "Make the rollout verifiable",
      };
      actionItemProposal(item).notes =
        "Completion [inferred] A recorded successful rollout\nMissing input [inferred]: Deployment access. Suggested retrieval: Ask the deployment administrator";
    }
    await route.fulfill({ response, json: data });
  });
  await page.goto(`/meetings/${fixture.recent[4].id}?tab=debrief`);
  const actions = page.getByRole("region", { name: "Action Items", exact: true });
  await expect(actions.getByText("Inferred commitment", { exact: true }).first()).toBeVisible();
  const disclosure = actions.locator("summary").filter({ hasText: "Execution details" }).first();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(
    actions
      .getByText("Completion [inferred] A recorded successful rollout", { exact: false })
      .first(),
  ).toBeVisible();
  await expect(disclosure).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(disclosure).toBeFocused();
});

test("Home distinguishes zero pending proposals from failed and loading counts", async ({
  page,
  request,
}) => {
  await confirmMeetingOwner(request);
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Awaiting approval (0)", exact: true }),
  ).toBeVisible();
  await page.route("**/api/tasks/overview", (route) =>
    route.fulfill({ status: 503, json: { error: "Count unavailable" } }),
  );
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Count unavailable" })).toBeVisible();
  await expect(page.getByText("Awaiting approval (0)", { exact: true })).toHaveCount(0);
});

test("Home refreshes canonical counts on focus after review in another tab", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  await confirmMeetingOwner(request);
  const { items } = (await (
    await request.get("/api/action-items?state=pending")
  ).json()) as ActionItemIndex;
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: `Awaiting approval (${items.length})`, exact: true }),
  ).toBeVisible();
  await request.post(`/api/action-items/${items[0].id}/dismiss`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("link", { name: `Awaiting approval (${items.length - 1})`, exact: true }),
  ).toBeVisible();
});

test("legacy proposal anchors lead directly to the source Meeting", async ({ page, request }) => {
  await request.post("/api/test/meetings/overview-fixture");
  await confirmMeetingOwner(request);
  const { items } = (await (
    await request.get("/api/action-items?state=pending")
  ).json()) as ActionItemIndex;
  const item = items.find(
    (entry: { source: { meetingId: string | null } }) => entry.source.meetingId,
  )!;
  await page.goto(`/tasks#action-item-${item.id}`);
  await expect(page).toHaveURL(new RegExp(`/meetings/${item.source.meetingId}`));
  await expect(
    page.getByRole("heading", { name: actionItemProposal(item).title, exact: true }),
  ).toBeVisible();
  await request.post(`/api/action-items/${item.id}/dismiss`);
  await page.goto(`/tasks#action-item-${item.id}`);
  await expect(page.locator(`#action-item-${item.id}`)).toBeVisible();
  await expect(page.locator(`#action-item-${item.id}`)).toContainText("Dismissed");
});
