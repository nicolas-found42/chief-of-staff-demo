import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/**
 * The Person Profiles browser journey (spec #117, Testing Decisions): the same
 * observable operations the API and module-interface tests exercise — search
 * the list, create a Profile explicitly, open its stable detail route, and
 * step back to an exact historical revision — driven through the real UI over
 * a hermetic Workspace. No provider is configured, so creation records only
 * what the owner typed.
 */
async function scanForViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, results.violations.map((v) => v.id).join(", ")).toEqual([]);
}

test("person profiles journey — nav → search → create → detail → revision history", async ({
  page,
}) => {
  // 1. The product area is reachable from explicit navigation, not the Module bar.
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Person Profiles" })
    .click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByRole("heading", { level: 1, name: "Person Profiles" })).toBeFocused();
  await expect(page.getByText("No Profiles yet — create the first one.")).toBeVisible();

  // 2. Manual creation is explicit and validates identity inputs.
  await page.getByRole("link", { name: "New profile" }).click();
  await expect(page).toHaveURL(/\/people\/new$/);
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByRole("alert")).toContainText("at least a full name or an email address");

  await page.getByLabel("Full name").fill("Grace Hopper");
  await page.getByLabel("Primary email").fill("grace@example.com");
  await page.getByLabel("Role").fill("Rear Admiral");
  await page.getByLabel("Current employer").fill("US Navy");
  await page.getByLabel("Background").fill("Pioneered compilers.");
  await page.getByRole("button", { name: "Create profile" }).click();

  // 3. The detail route is stable and shows the auditable first revision.
  await expect(page).toHaveURL(/\/people\/person_[0-9a-f]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Grace Hopper" })).toBeVisible();
  await expect(page.getByText("Revision 1 (current)")).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "grace@example.com" })).toBeVisible();
  await expect(page.getByText("Pioneered compilers.")).toBeVisible();
  await expect(page.getByText("No enrichment diagnostics recorded.")).toBeVisible();

  // The test seam appends a second revision — a factual correction is a later
  // slice — so the journey can step back to a genuinely historical one.
  const profileId = new URL(page.url()).pathname.split("/").pop()!;
  const seeded = await page.request.post("/api/test/seed-person-revision", {
    data: { profileId, role: "Professor of Computer Science" },
  });
  expect(seeded.ok()).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("definition").filter({ hasText: "Professor of Computer Science" }),
  ).toBeVisible();
  // A direct load of the same URL is the same Profile: the route is the resource.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Grace Hopper" })).toBeVisible();

  // 4. Search finds the Profile; a miss says so.
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Person Profiles" })
    .click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByRole("cell", { name: "Grace Hopper" })).toBeVisible();
  await page.getByLabel("Search").fill("nobody-at-all");
  await expect(page.getByText("No Profiles match that search.")).toBeVisible();
  await page.getByLabel("Search").fill("grace");
  await expect(page.getByRole("cell", { name: "Grace Hopper" })).toBeVisible();

  // 5. The revision history links to the exact recorded revision.
  await page.getByRole("cell", { name: "Grace Hopper" }).getByRole("link").click();
  await page.getByRole("button", { name: "Revision 1", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Viewing revision 1 exactly as it was recorded",
  );
  await expect(page).toHaveURL(/\/people\/person_[0-9a-f]+\?revision=1$/);
  await expect(page.getByRole("definition").filter({ hasText: "Rear Admiral" })).toBeVisible();
  await page.getByRole("button", { name: /Back to the current revision/ }).click();
  await expect(
    page.getByRole("definition").filter({ hasText: "Professor of Computer Science" }),
  ).toBeVisible();

  // 6. The routes the page-wide scans do not walk yet are still axe-clean.
  await page.goto("/people/new");
  await scanForViolations(page);
  await page.goto(`/people/${profileId}`);
  await scanForViolations(page);
});
