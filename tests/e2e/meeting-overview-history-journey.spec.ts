import { test, expect } from "./fixture";

test("recent results and contextual review survive a failed Brief and a later failed Debrief", async ({
  page,
  request,
}) => {
  const seeded = await request.post("/api/test/meetings/overview-fixture");
  expect(seeded.ok()).toBe(true);
  const fixture = (await seeded.json()) as {
    todayId: string;
    briefRunId: string;
    recent: { id: string; runId: string; transcriptId: string }[];
  };
  await page.goto("/meetings");
  const today = page.getByRole("region", { name: "Today", exact: true });
  const recent = page.getByRole("region", { name: "Recent meetings", exact: true });
  await expect(today.getByRole("link", { name: "Today's planning", exact: true })).toBeVisible();
  await expect(today).toContainText("Brief failed");
  await expect(today).not.toContainText("47");
  await expect(recent.getByRole("link", { name: "Debrief ready", exact: true })).toHaveCount(5);
  await expect(
    page.getByText("47 pending action items from 5 meetings", { exact: true }),
  ).toBeVisible();
  await page.route(`**/api/runs/${fixture.briefRunId}/retry`, (route) =>
    route.fulfill({ status: 503, json: { error: "retry unavailable" } }),
  );
  await today.getByRole("button", { name: "Retry brief", exact: true }).click();
  await expect(today.getByRole("status")).toContainText("Brief retry failed");
  await expect(recent.getByRole("link", { name: "Debrief ready", exact: true })).toHaveCount(5);
  const latest = fixture.recent[4];
  expect(
    (
      await request.post("/api/test/meetings/failed-debrief", {
        data: { transcriptId: latest.transcriptId },
      })
    ).ok(),
  ).toBe(true);
  await expect(recent).toContainText("Latest attempt failed");
  const latestRow = recent.getByRole("listitem").filter({ hasText: "September 5 planning" });
  await latestRow.getByRole("link", { name: "Debrief ready", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/meetings/${latest.id}\\?tab=debrief`));
  await expect(page.getByText("We agreed on the September 5 plan.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open the full debrief", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/meeting-debrief/${latest.runId}`));
  await page.goto("/meetings");
  await page.getByRole("link", { name: "Review 11 action items", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks\\?meetingId=${latest.id}#action-items`));
  await expect(page.getByText(/From Sep 5, 2026/).first()).toBeVisible();
  await expect(page.getByText(/Proposed due Sep 6, 2026 — in the past/).first()).toBeVisible();
  const proposal = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Follow up tomorrow 5-0", exact: true }) });
  await expect(proposal).toContainText("Unassigned");
  await proposal.getByText("Original evidence", { exact: true }).click();
  await expect(proposal).toContainText("Stored excerpt and timestamp unavailable");
  await proposal.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.goto("/meetings");
  await expect(
    page.getByText("46 pending action items from 5 meetings", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Review 10 action items", exact: true }).click();
  await page
    .getByRole("region", { name: "Dismissed", exact: true })
    .getByRole("button", { name: "Restore to pending", exact: true })
    .click();
  await page.goto("/meetings");
  await expect(
    page.getByText("47 pending action items from 5 meetings", { exact: true }),
  ).toBeVisible();
  await page.goto(`/tasks?meetingId=${fixture.recent[3].id}#action-items`);
  const withEvidence = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Follow up tomorrow 4-1", exact: true }) });
  await withEvidence.getByText("Original evidence", { exact: true }).click();
  await expect(withEvidence.getByRole("blockquote")).toHaveText("Bob: I will follow up tomorrow.");
  await expect(withEvidence).toContainText("00:15");
  const messages = await (await request.get("/api/test/meeting-brief/fake-gmail/messages")).json();
  expect(messages.messages).toHaveLength(0);
});
