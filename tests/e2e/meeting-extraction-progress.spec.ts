import type { MeetingDetailView } from "@chief-of-staff-demo/shared";
import { test, expect } from "./fixture";

test.use({ freshWorkspace: true });

test("a pending or failed extraction never presents zero as the final action item count", async ({
  page,
  request,
}) => {
  const seeded = await request.post("/api/test/meetings/overview-fixture");
  expect(seeded.ok()).toBe(true);
  const fixture = (await seeded.json()) as { recent: { id: string }[] };
  const meetingId = fixture.recent[0].id;
  let state: "processing" | "failed" | "ready" = "processing";
  await page.route(`**/api/meetings/${meetingId}/read`, async (route) => {
    const response = await route.fetch();
    const view = (await response.json()) as MeetingDetailView;
    view.meeting.pendingCount = 0;
    view.meeting.debrief.status = state;
    await route.fulfill({ response, json: view });
  });
  await page.goto(`/meetings/${meetingId}?tab=debrief`);
  await expect(page.getByText("Extracting action items…", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review 0 action items", exact: true })).toHaveCount(
    0,
  );
  state = "failed";
  await expect(
    page.getByText("Action items unavailable — debrief extraction failed.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Review 0 action items", exact: true })).toHaveCount(
    0,
  );
  state = "ready";
  await expect(
    page.getByRole("link", { name: "Review 0 action items", exact: true }),
  ).toBeVisible();
});
