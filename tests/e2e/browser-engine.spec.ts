import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Force the in-browser engine into replay mode so the golden run needs no
 * network or real API key; the fixtures are bundled into the build. */
async function enableReplay(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("chief-of-staff-replay", "1");
  });
  await page.goto("/#/setup");
}

test("runs the golden transcript end-to-end in the browser", async ({ page }) => {
  await enableReplay(page);
  // No key yet: the status surfaces it and runs are blocked.
  await expect(page.getByTestId("browser-key-status")).toContainText("no key yet");

  // Paste a key: it must be used verbatim and persisted immediately.
  await page.getByLabel("OpenRouter API key").fill("sk-or-v1-test-only-key-000000000000");
  await expect(page.getByTestId("browser-key-status")).toContainText("key set");

  // Fill the required profile through the Setup UI.
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByLabel("Your title").fill("Chief of Staff");
  await page.getByLabel("Your company").fill("Analytical Engines Inc.");
  await page.getByLabel("Writing style").fill("I am concise in my communication, polite but direct.");
  await page.getByLabel("Key focus areas").fill("Customer success\nProduct quality");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  await expect(page.getByTestId("connection-status")).toBeVisible();
  // Upload the golden transcript; the engine runs locally in the page.
  await page.goto("/#/runs");
  const upload = page.getByLabel("Upload transcript");
  await upload.setInputFiles(join(REPO_ROOT, "fixtures", "transcripts", "golden-meeting.txt"));
  await expect(page.getByTestId("run-summary").first()).toContainText("golden-meeting.txt", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("run-summary").first()).toContainText("Succeeded", {
    timeout: 30_000,
  });

  // Parallel task branches and the draft artifact preview render.
  await page
    .getByTestId("run-summary")
    .first()
    .getByRole("link")
    .or(page.getByTestId("run-summary").first().locator("a"))
    .first()
    .click();
  await expect(page.getByTestId("run-detail")).toBeVisible();
  for (const taskIndex of ["0", "1", "2"]) {
    await expect(page.getByTestId("task-branch").filter({ hasText: `Task ${taskIndex}` })).toBeVisible();
  }
  await page.getByTestId("artifact-link").filter({ hasText: "Draft" }).first().click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Delivery timeline update");

  // The key never appears in the DOM, only in local storage where it belongs.
  const dom = await page.content();
  expect(dom).not.toContain("sk-or-v1-test-only-key");
  const stored = await page.evaluate(() => localStorage.getItem("chief-of-staff-openrouter-key"));
  expect(stored).toBe("sk-or-v1-test-only-key-000000000000");
});

test("persists the pasted key across reloads", async ({ page }) => {
  await page.goto("/#/setup");
  await page.getByLabel("OpenRouter API key").fill("sk-or-v1-persisted-key-111111111111");
  await page.reload();
  await expect(page.getByLabel("OpenRouter API key")).toHaveValue("sk-or-v1-persisted-key-111111111111");
  await expect(page.getByTestId("browser-key-status")).toContainText("key set");
});
