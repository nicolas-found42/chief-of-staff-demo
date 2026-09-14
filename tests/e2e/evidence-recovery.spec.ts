import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixture";

// Delayed/failed HTTP reads exercise the controls in the real built application.
test("source review preserves reading position, keeps background inert, retries and ignores closed requests", async ({
  page,
}) => {
  const quote = "Maya designed the scheduler and deployed Atlas to 200 sites.";
  await page.request.post("/api/test/person-dossier-source", {
    data: {
      url: "https://example.com/review-maya",
      text: `review-maya@example.com. ${quote}`,
      extraction: {
        fullName: "Maya Chen",
        employer: null,
        author: null,
        publishedAt: "2024-02-01",
        sourceClass: "primary-artifact",
        claims: [
          {
            id: "work",
            section: "work",
            statement: quote,
            status: "supported",
            nature: "statement",
            matchConfidence: "high",
            effectiveFrom: null,
            effectiveTo: null,
            citations: [{ sourceId: "source", quote }],
            supports: [],
            supersedes: [],
            changeReason: null,
          },
        ],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      },
    },
  });
  await page.request.patch("/api/people/research/settings", {
    data: { paused: false, profileCalls: 4 },
  });
  const created = await (
    await page.request.post("/api/people", { data: { primaryEmail: "review-maya@example.com" } })
  ).json();
  await page.goto(`/people/${created.id}`);
  const citation = page.getByRole("button", { name: "Source 1", exact: true }).first();
  await expect(citation).toBeVisible({ timeout: 30000 });
  await citation.focus();
  const before = await page.evaluate(() => window.scrollY);
  await citation.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Source evidence" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Retained source" })).toContainText(quote);
  await expect(dialog.getByRole("button", { name: "Close source" })).toBeFocused();
  // Native modal dialogs may let Tab reach browser chrome, but no background app control.
  await page.locator("main a").first().focus();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(citation).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);

  const tabs = page.getByRole("tablist", { name: "Dossier sections" });
  await tabs.getByRole("tab", { name: "Overview", exact: true }).press("End");
  await expect(tabs.getByRole("tab", { name: "Sources", exact: true })).toBeFocused();
  await expect(tabs.getByRole("tab", { name: "Sources", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Overview", exact: true })).toBeFocused();

  let fail = true;
  await page.route("**/api/people/*/sources/*", async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Source temporarily unavailable" }),
      });
    else await route.continue();
  });
  await citation.click();
  await expect(dialog.getByRole("alert")).toContainText("Source could not be loaded");
  fail = false;
  await dialog.getByRole("button", { name: "Retry source" }).click();
  await expect(dialog.getByRole("region", { name: "Retained source" })).toContainText(quote);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("source-reader-mobile.png") });
  await page.keyboard.press("Escape");
  await page.unroute("**/api/people/*/sources/*");

  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/people/*/sources/*", async (route) => {
    started.resolve();
    await release.promise;
    await route.continue();
  });
  await citation.click();
  await started.promise;
  await expect(dialog.getByRole("status")).toHaveText("Loading retained source…");
  await page.keyboard.press("Escape");
  const completed = page.waitForResponse((response) => response.url().includes("/sources/"));
  release.resolve();
  await completed;
  await expect(dialog).toHaveCount(0);
  await page.unroute("**/api/people/*/sources/*");
  await citation.click();
  await dialog.getByText("This source is about someone else", { exact: true }).click();
  await dialog.getByRole("button", { name: "Remove wrong-person attribution" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(citation).toHaveCount(0);

  let historyFails = true;
  await page.route("**/relationship-history", async (route) => {
    if (historyFails)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "History temporarily unavailable" }),
      });
    else await route.continue();
  });
  await page.reload();
  await page.getByRole("tab", { name: "Relationship history", exact: true }).click();
  await expect(page.getByText(/No confirmed Workspace history yet/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry Relationship history" })).toBeVisible();
  historyFails = false;
  await page.getByRole("button", { name: "Retry Relationship history" }).click();
  await expect(page.getByText(/No confirmed Workspace history yet/)).toBeVisible();
});

test("People search recovers from failure without showing outdated filter results", async ({
  page,
}) => {
  await page.request.post("/api/people", {
    data: { fullName: "Ada Example", primaryEmail: "ada@example.com" },
  });
  let fail = true;
  await page.route(/\/api\/people(?:\?.*)?$/, async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Profiles temporarily unavailable" }),
      });
    else await route.continue();
  });
  await page.goto("/people");
  await expect(page.getByRole("alert")).toContainText("Profiles temporarily unavailable");
  await expect(
    page.getByRole("status").filter({ hasText: "Profiles are unavailable" }),
  ).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("link", { name: "Ada Example", exact: true })).toBeVisible();
  await page.getByLabel("Search", { exact: true }).fill("Nobody matches");
  await expect(page.getByText("No Profiles match that search.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ada Example", exact: true })).toHaveCount(0);
});
