import { test, expect } from "./fixture";

test("History distinguishes empty history, filters and pages retained Meetings, and restores filters after navigation", async ({
  page,
  request,
}) => {
  await page.goto("/meetings/history");
  await expect(page.getByText("No recorded meeting history yet.", { exact: true })).toBeVisible();
  expect((await request.post("/api/test/meetings/history-fixture")).ok()).toBe(true);
  await page.reload();
  await expect(page.getByText("27 meetings · Page 1 of 2", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: /^History session/ }) }),
  ).toHaveCount(25);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText("27 meetings · Page 2 of 2", { exact: true })).toBeVisible();
  const link = page.getByRole("link", { name: /^History session/ }).first();
  const title = await link.textContent();
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: title! })).toBeVisible();
  await page.goBack();
  await expect(page.getByText("27 meetings · Page 2 of 2", { exact: true })).toBeVisible();
  await page.getByLabel("Search meetings").fill("ALEX@EXAMPLE.COM");
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page.getByText("27 meetings · Page 1 of 2", { exact: true })).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill("2026-09-01");
  await page.getByLabel("To", { exact: true }).fill("2026-09-01");
  await expect(page.getByText("27 meetings · Page 1 of 2", { exact: true })).toBeVisible();
  await page.getByLabel("Include cancelled").check();
  await expect(page.getByText("28 meetings · Page 1 of 2", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Include cancelled")).toBeChecked();
  await expect(page.getByLabel("Search meetings")).toHaveValue("ALEX@EXAMPLE.COM");
  await page.getByLabel("From", { exact: true }).fill("2026-09-02");
  await expect(page.getByRole("alert")).toContainText("From is on or before To");
  await page.getByRole("link", { name: "Clear filters", exact: true }).click();
  await page.getByLabel("Search meetings").fill("not in the record");
  await expect(page.getByText("No meetings match these filters.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Clear filters", exact: true }).click();
  await expect(page.getByText("27 meetings · Page 1 of 2", { exact: true })).toBeVisible();
});
