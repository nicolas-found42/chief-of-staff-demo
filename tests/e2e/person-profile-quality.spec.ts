import { expect, test } from "./fixture";

test("audit F5: the headline does not combine independently sourced, undated role and employer", async ({
  page,
}) => {
  await page.goto("/people/new");
  await page.getByLabel("Email or profile URL").fill("headline@example.com");
  await page.getByRole("button", { name: "Add and research" }).click();
  await expect(page).toHaveURL(/\/people\/person_/);
  const path = new URL(page.url()).pathname;
  await page.route(`**/api${path}`, async (route) => {
    const response = await route.fetch();
    const profile = await response.json();
    await route.fulfill({
      response,
      json: {
        ...profile,
        fullName: "Example Person",
        role: "Past operations",
        currentEmployer: "Example Labs",
        researchFacts: {
          role: { value: "Past operations", sourceIds: ["past"], effectiveFrom: null },
          currentEmployer: { value: "Example Labs", sourceIds: ["present"], effectiveFrom: null },
        },
      },
    });
  });
  await page.reload();
  const headline = page
    .getByRole("heading", { name: "Example Person", exact: true })
    .locator("xpath=following-sibling::p[1]");
  await expect(headline).toContainText("Example Labs");
  await expect(headline).not.toContainText("Past operations");
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test(`audit F13/F15: readable evidence and discoverable sections at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const email = `layout-${viewport.width}@example.com`;
    const quotes = ["Morgan built Atlas.", "Morgan deployed Nova."];
    await page.request.post("/api/test/person-dossier-source", {
      data: {
        url: `https://example.com/layout-${viewport.width}`,
        text: `${email}. ${quotes.join(" ")}`,
        extraction: {
          fullName: null,
          employer: null,
          author: null,
          publishedAt: null,
          sourceClass: "primary-artifact",
          claims: quotes.map((quote, index) => ({
            id: `layout-${index}`,
            section: "work",
            statement: quote.slice(0, -1),
            status: "supported",
            nature: "statement",
            matchConfidence: "high",
            effectiveFrom: null,
            effectiveTo: null,
            citations: [{ sourceId: "source", quote }],
            supports: [],
            supersedes: [],
            changeReason: null,
          })),
          works: [],
          expertise: [],
          connections: [],
          sections: [],
        },
      },
    });
    await page.request.patch("/api/people/research/settings", { data: { paused: false } });
    await page.goto("/people/new");
    await page.getByLabel("Email or profile URL").fill(email);
    await page.getByRole("button", { name: "Add and research" }).click();
    await expect(page).toHaveURL(/\/people\/person_/);
    await expect(page.locator("#dossier-panel > p").first()).toHaveText(
      "Morgan built Atlas. Morgan deployed Nova.",
    );
    const evidence = page.locator("#dossier-panel .dossier-citation");
    const first = await evidence.nth(0).boundingBox();
    const second = await evidence.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height + 4);
    for (const link of [evidence.nth(0), evidence.nth(1)]) {
      await link.click();
      await expect(page.getByRole("region", { name: "Retained source" })).toBeVisible();
      await page.getByRole("button", { name: "Close source" }).click();
    }
    const tabs = page.getByRole("tablist", { name: "Dossier sections" });
    expect(await tabs.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const next = page.getByRole("button", { name: "More dossier sections" });
    await expect(next).toBeVisible();
    const before = await tabs.evaluate((element) => element.scrollLeft);
    await next.click();
    await expect.poll(() => tabs.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before);
    const firstTab = page.getByRole("tab", { name: "Overview", exact: true });
    await firstTab.focus();
    await firstTab.press("End");
    const sources = page.getByRole("tab", { name: "Sources", exact: true });
    await expect(sources).toBeFocused();
    await expect(sources).toHaveAttribute("aria-selected", "true");
    const insideStrip = async () =>
      sources.evaluate((element) => {
        const tab = element.getBoundingClientRect();
        const strip = element.parentElement!.getBoundingClientRect();
        return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
      });
    await expect.poll(insideStrip).toBe(true);
    await sources.press("Home");
    await expect(firstTab).toBeFocused();
    const allTabs = page.getByRole("tab");
    const tabCount = await allTabs.count();
    for (let index = 0; index < tabCount; index += 1) {
      const current = allTabs.nth(index);
      await expect(current).toBeFocused();
      await expect(current).toHaveAttribute("aria-selected", "true");
      await expect
        .poll(() =>
          current.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const strip = element.parentElement!.getBoundingClientRect();
            return box.left >= strip.left - 1 && box.right <= strip.right + 1;
          }),
        )
        .toBe(true);
      await current.press("ArrowRight");
    }
    for (let index = 0; index < tabCount; index += 1) {
      const current = allTabs.nth(index);
      await current.click();
      await expect(current).toHaveAttribute("aria-selected", "true");
    }
    await firstTab.click();
    await page.screenshot({
      path: testInfo.outputPath(`layout-${viewport.width}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
