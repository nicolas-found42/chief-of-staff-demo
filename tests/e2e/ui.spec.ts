import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function pairingCode(): string {
  return readFileSync(join(REPO_ROOT, ".e2e-fixture", "pairing-code.txt"), "utf8").trim();
}

async function pair(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/#/setup");
  const urlInput = page.getByLabel("Service URL");
  await urlInput.fill("http://127.0.0.1:4580");
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByTestId("connection-status")).toContainText("connected", { timeout: 10_000 });
  await page.getByLabel("Pairing code").fill(pairingCode());
  await page.getByRole("button", { name: "Pair with service" }).click();
  await expect(page.getByTestId("pairing-status")).toContainText("paired", { timeout: 10_000 });
}

test("setup: pairing success, invalid code, and service unavailable", async ({ page }) => {
  await page.goto("/#/setup");
  const urlInput = page.getByLabel("Service URL");
  await urlInput.fill("http://127.0.0.1:4580");
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByTestId("connection-status")).toContainText("connected");

  await page.getByLabel("Pairing code").fill("000000");
  await page.getByRole("button", { name: "Pair with service" }).click();
  await expect(page.getByTestId("pairing-status")).toContainText(/invalid|expired/i);

  await page.getByLabel("Pairing code").fill(pairingCode());
  await page.getByRole("button", { name: "Pair with service" }).click();
  await expect(page.getByTestId("pairing-status")).toContainText("paired");

  // Unavailable service: bad URL shows remediation + offline fallback URL.
  await urlInput.fill("http://127.0.0.1:4599");
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByTestId("connection-status")).toContainText(/unreachable|could not/i);
  await expect(page.getByTestId("offline-fallback")).toContainText("http://127.0.0.1:4317/");
});

test("works at a GitHub Pages-style project subpath", async ({ page }) => {
  await page.goto("/chief-of-staff-local/#/setup");
  await expect(page.getByLabel("Service URL")).toBeVisible();
  // Relative-base assets load: the app must render its shell.
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByTestId("ui-commit-sha")).toContainText("UI");
  await expect(page.getByTestId("service-version")).toContainText("In-browser engine");
});

test("upload, active run, parallel branches, failure surface, artifact preview", async ({ page }) => {
  await pair(page);
  await page.goto("/#/runs");
  const upload = page.getByLabel("Upload transcript");
  await upload.setInputFiles(join(REPO_ROOT, "fixtures", "transcripts", "golden-meeting.txt"));
  await expect(page.getByTestId("upload-status")).toContainText(/started|claimed/i, { timeout: 15_000 });
  await expect(page.getByTestId("run-summary").first()).toContainText("golden-meeting.txt", { timeout: 30_000 });
  await expect(page.getByTestId("run-summary").first()).toContainText("Succeeded", { timeout: 30_000 });

  await page.getByTestId("run-summary").first().getByRole("link").or(page.getByTestId("run-summary").first().locator("a")).first().click();
  await expect(page.getByTestId("run-detail")).toBeVisible();
  await expect(page.getByTestId("step-row").filter({ hasText: "eitxht" })).toContainText("succeeded");
  // Three parallel branches with stable task indices.
  for (const taskIndex of ["0", "1", "2"]) {
    await expect(page.getByTestId("task-branch").filter({ hasText: `Task ${taskIndex}` })).toBeVisible();
  }
  // Draft artifact preview renders markdown safely.
  await page.getByTestId("artifact-link").filter({ hasText: "Draft" }).first().click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Delivery timeline update");
});

test("no API key value or absolute local path reaches the DOM in service mode", async ({ page }) => {
  await pair(page);
  const keys = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(keys).not.toContain("OPENROUTER_API_KEY");
  expect(keys).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  const dom = await page.content();
  expect(dom).not.toContain("OPENROUTER_API_KEY");
  expect(dom).not.toMatch(/[A-Za-z]:\\[A-Za-z]/);
  expect(dom).not.toContain("/Users/");
});

test("keyboard-only flow reaches every control", async ({ page }) => {
  await page.goto("/#/setup");
  // The nav links precede the form in DOM order; start at the URL input and
  // verify the setup controls follow in sequence.
  await page.getByLabel("Service URL").focus();
  await expect(page.getByLabel("Service URL")).toBeFocused();
  await page.getByLabel("Service URL").fill("http://127.0.0.1:4580");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Check connection" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("connection-status")).toContainText("connected", { timeout: 10_000 });
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Pairing code")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Pair with service" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pairing-status")).toContainText(/invalid|expired/i);
});
test("automated accessibility checks pass on setup and runs pages", async ({ page }) => {
  await pair(page);
  const setupScan = await new AxeBuilder({ page }).analyze();
  expect(setupScan.violations.filter((v) => v.impact !== "minor")).toEqual([]);
  await page.goto("/#/runs");
  const runsScan = await new AxeBuilder({ page }).analyze();
  expect(runsScan.violations.filter((v) => v.impact !== "minor")).toEqual([]);
});
