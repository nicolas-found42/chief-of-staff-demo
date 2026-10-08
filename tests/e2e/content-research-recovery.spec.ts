import { test, expect } from "./fixture";
import type { ContentResearchIndex } from "@chief-of-staff-demo/shared";

for (const action of [
  { label: "Run Now", path: "run" },
  { label: "Backfill 7d", path: "backfill" },
  { label: "Discover Now", path: "discover" },
]) {
  test(`Content Research updates ${action.label} results without reloading`, async ({ page }) => {
    // Controlled asynchronous API responses isolate the browser's lifecycle;
    // adapter collection and durable reports are covered by the module tests.
    let started = false;
    let readsAfterStart = 0;
    await page.route("**/api/content-research/index", async (route) => {
      const complete = started && ++readsAfterStart >= 2;
      const index: ContentResearchIndex = {
        waiting: { research: null, discovery: null },
        runs: started
          ? [
              {
                runId: "async-research",
                intake: "content-research-daily",
                status: complete ? "done" : "running",
                createdAt: "2026-10-08T12:00:00.000Z",
                summary: complete ? "Research complete" : "Collecting",
              },
            ]
          : [],
        byPerson: complete
          ? [
              {
                personId: "fixture-person",
                personName: "Completed research person",
                reports: [
                  {
                    runId: "async-research",
                    generatedAt: "2026-10-08T12:00:00.000Z",
                    resonanceScoreMax: 0,
                    items: [],
                  },
                ],
              },
            ]
          : [],
      };
      await route.fulfill({ json: index });
    });
    await page.route(`**/api/content-research/${action.path}`, async (route) => {
      started = true;
      await route.fulfill({ json: { runId: "async-research" } });
    });
    await page.goto("/content-research");
    await page.getByRole("button", { name: action.label, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Completed research person", exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Research is running.", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "Show 1 run", exact: true }).click();
    await expect(page.locator(".research-gated-row")).toContainText("done");
    await expect(page.locator(".research-gated-row a")).toHaveAttribute(
      "href",
      "/runs/async-research",
    );
  });
}
