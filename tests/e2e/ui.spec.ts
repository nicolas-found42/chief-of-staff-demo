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
  // The pill shows prose, not the stored token (WCAG 3.1.3).
  await expect(page.locator(".status-pill")).toHaveText("Failed", { timeout: 15_000 });

  // Extraction result is still rendered.
  await expect(page.locator("h2", { hasText: "Summary" })).toBeVisible();
  await expect(page.locator(".card").getByText("Weekly product sync", { exact: false })).toBeVisible();
  await expect(page.locator(".tasks-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".tasks-table").getByRole("cell", { name: "Priya", exact: true })).toBeVisible();
  await expect(page.locator(".draft-card")).toHaveCount(1);
  // Header and value are a dt/dd pair, so the label is associated rather than
  // merely adjacent — the value is read from the <dd> that follows its term.
  const subject = page.locator(".draft-headers dt", { hasText: "Subject:" });
  await expect(subject).toBeVisible();
  await expect(subject.locator("+ dd")).toHaveText(
    "Updated Q3 pricing ahead of your board meeting"
  );

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

test("an unconfigured workspace gets the setup steps, not two bare fields", async ({ page }) => {
  await page.goto("/settings");

  // The four one-time console steps, in the order the console forces them.
  const steps = page.locator(".setup-steps > li");
  await expect(steps).toHaveCount(4);
  await expect(page.getByRole("link", { name: "Enable the Tasks API" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Enable the Gmail API" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the consent screen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create the OAuth client" })).toBeVisible();

  // The redirect URI is built from the port the server is actually on. This
  // suite runs on 4319, so a value hardcoded to 4317 — as the UI used to carry —
  // fails here.
  await expect(page.locator(".setup-copy > code").last()).toHaveText(
    "http://localhost:4319/api/google/callback"
  );

  // Both scopes are shown, and offered to copy so neither has to be typed out.
  await expect(page.locator(".setup-copy > code")).toHaveText([
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/gmail.compose",
    "http://localhost:4319/api/google/callback",
  ]);
  // Three Copy buttons on one page, each naming what it copies rather than
  // leaving a screen reader with "Copy, Copy, Copy" (WCAG 2.4.6).
  await expect(page.locator(".copy-button")).toHaveCount(3);
  for (const name of [
    "Copy https://www.googleapis.com/auth/tasks",
    "Copy https://www.googleapis.com/auth/gmail.compose",
    "Copy Redirect URI",
  ]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }

  // The sign-in button is the last step, and it is a real Google-branded button.
  await expect(page.getByRole("button", { name: /Save and sign in with Google/ })).toBeVisible();
});

test("signing in without a client id reports Google's refusal in the page", async ({ page }) => {
  await page.goto("/settings");

  // Pressing sign-in with nothing filled in saves an empty client and asks the
  // server for a consent URL, which it refuses. That refusal has to land as
  // readable text, not a console error (WCAG 3.3.1).
  const signIn = page.getByRole("button", { name: /Save and sign in with Google/ });
  await signIn.focus();
  await signIn.click();
  await expect(page.locator(".banner-error")).toContainText(/not configured/i);
  // The control the user pressed keeps focus rather than dropping it (WCAG 2.4.3).
  await expect(signIn).toBeFocused();
});

test("the runs page says Google is not set up before a run can fail on it", async ({ page }) => {
  await page.goto("/");
  const banner = page.locator(".banner-warn");
  await expect(banner).toContainText(/Google is not connected yet/);
  // And routes to the place that fixes it.
  await banner.getByRole("link", { name: "Set up Google" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator(".setup-steps")).toBeVisible();
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
