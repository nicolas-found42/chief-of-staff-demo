import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixture";

test("automatic dossier journey — add, research, inspect source, and query demonstrated work", async ({
  page,
}) => {
  const quote = "Maya designed the scheduler and deployed Atlas to 200 sites.";
  const extraction = {
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
        effectiveFrom: "2024-02-01",
        effectiveTo: null,
        citations: [{ sourceId: "source", quote }],
        supports: [],
        supersedes: [],
        changeReason: null,
      },
    ],
    works: [
      {
        id: "atlas",
        title: "Atlas",
        url: "https://example.com/atlas",
        kind: "system",
        startedAt: "2024-02-01",
        endedAt: null,
        claimIds: ["work"],
        contribution: {
          text: "Designed the scheduler and deployed the system",
          claimIds: ["work"],
        },
        teamContribution: null,
        authority: [{ role: "executed", claimIds: ["work"] }],
        scale: [
          {
            value: 200,
            unit: "sites",
            scope: "Atlas deployment",
            date: "2024-02-01",
            claimIds: ["work"],
          },
        ],
        constraints: [],
        outcomes: [],
      },
    ],
    expertise: [
      {
        category: "deployment",
        originalWording: "deployed Atlas to 200 sites",
        support: "demonstrated",
        workIds: ["atlas"],
        claimIds: ["work"],
      },
    ],
    connections: [],
    sections: [],
  };
  await page.request.post("/api/test/person-dossier-source", {
    data: {
      url: "https://example.com/maya",
      text: `Maya Chen — maya@example.com. ${quote}`,
      extraction,
    },
  });
  await page.request.patch("/api/people/research/settings", {
    data: { paused: false, profileCalls: 4, dailyCalls: 100 },
  });
  await page.goto("/people/new");
  await page.getByLabel("Email or profile URL").fill("maya@example.com");
  await page.getByRole("button", { name: "Add and research" }).click();
  await expect(page).toHaveURL(/\/people\/person_/);
  await page.getByRole("tab", { name: "Body of work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Atlas", exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText("200 sites", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Evidence 1", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Retained source" })).toContainText(quote);
  await page.getByRole("button", { name: "Close source" }).click();
  await page.getByRole("tab", { name: "Relationship history", exact: true }).click();
  await expect(page.getByText(/No confirmed Workspace history yet/)).toBeVisible();
  const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(scan.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto("/people");
  await page.getByText("Find expertise and work across Profiles", { exact: true }).click();
  await page.getByLabel("Capabilities required together").fill("deployment");
  await page.getByRole("button", { name: "Search dossiers", exact: true }).click();
  await expect(page.getByText(/1 demonstrated matches/)).toBeVisible();
  await expect(page.getByRole("blockquote").first()).toContainText(quote);
});
