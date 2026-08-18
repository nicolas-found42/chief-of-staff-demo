import { expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sampleTranscript = join(here, "../fixtures/transcripts/sample-transcript.md");

test("upload → run detail shows extraction; google_not_connected path visible", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("dropzone")).toBeVisible();

  await page.setInputFiles('input[type="file"]', sampleTranscript);

  // Single upload navigates straight to the run detail.
  await page.waitForURL(/\/runs\/run_/, { timeout: 15_000 });

  // The mock provider answers instantly; the run then fails at the outputs
  // stage because Google is not connected in the e2e workspace.
  await expect(page.locator(".status-pill")).toHaveText("failed", { timeout: 15_000 });

  // Extraction result is still rendered.
  await expect(page.locator("h2", { hasText: "Summary" })).toBeVisible();
  await expect(page.locator(".card").getByText("Weekly product sync", { exact: false })).toBeVisible();
  await expect(page.locator(".tasks-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".tasks-table").getByRole("cell", { name: "Priya", exact: true })).toBeVisible();
  await expect(page.locator(".draft-card")).toHaveCount(1);
  await expect(page.locator(".draft-card").getByText("Subject: Updated Q3 pricing ahead of your board meeting")).toBeVisible();

  // The google_not_connected path is visible in the events timeline.
  await expect(page.locator(".events-log")).toContainText("google_not_connected");
  await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();

  // Transcript is present in the collapsible.
  const summary = page.locator("details summary", { hasText: "transcript" });
  await summary.click();
  await expect(page.locator(".artifact-pre")).toContainText("Weekly Product Sync");
});

test("settings round-trips with redacted secrets", async ({ page }) => {
  await page.goto("/settings");
  // Exact: "Provider API key" and the "Extraction provider" group also
  // contain the substring "Provider".
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("mock");

  // Secrets are never echoed back: every password input is empty.
  const secretValues = await page.locator('input[type="password"]').evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value)
  );
  expect(secretValues.length).toBeGreaterThan(0);
  expect(secretValues.every((value) => value === "")).toBe(true);

  await page.getByLabel("Task list name").fill("E2E Followups");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".banner-ok")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Task list name")).toHaveValue("E2E Followups");
  await expect(page.getByText("Not connected", { exact: false })).toBeVisible();
});

test("primary actions are reachable and operable by keyboard", async ({ page }) => {
  await page.goto("/");

  // The upload control is a real button, reachable by Tab and fired by Enter.
  const chooseFiles = page.getByRole("button", { name: "choose files" });
  await expect(chooseFiles).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await chooseFiles.press("Enter");
  await chooser;

  // Uploading through that input still routes to the run detail.
  await page.setInputFiles('input[type="file"]', sampleTranscript);
  await page.waitForURL(/\/runs\/run_/, { timeout: 15_000 });

  // Arriving at a run moves focus to its heading rather than dropping it.
  await expect(page.locator("h1.run-title")).toBeFocused();

  // Each route carries its own title.
  await expect(page).toHaveTitle(/· Transcript → Tasks$/);

  // Runs are reachable from the list without a pointer.
  await page.goto("/");
  const runLink = page.locator(".run-link").first();
  await expect(runLink).toBeVisible();
  await runLink.press("Enter");
  await page.waitForURL(/\/runs\/run_/, { timeout: 15_000 });

  // The capped-height log and transcript can be scrolled from the keyboard.
  await expect(page.locator(".events-log")).toHaveAttribute("tabindex", "0");
  await page.locator("details summary").click();
  await expect(page.locator(".artifact-pre")).toHaveAttribute("tabindex", "0");
});

test("the page never scrolls sideways at a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ["/", "/settings"]) {
    await page.goto(path);
    const overflows = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth > root.clientWidth + 1;
    });
    expect(overflows, `${path} scrolls horizontally at 320px`).toBe(false);
  }
});
