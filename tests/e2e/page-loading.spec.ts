import { test, expect } from "./fixture";

test("Home defers product code and route failures keep navigation and reload recovery", async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("main h1")).toBeVisible();
  expect(
    scripts.some((url) => /TasksPage|PersonProfileDetailPage|homePrototypeVariants/.test(url)),
  ).toBe(false);
  await page.route("**/assets/PeoplePage-*.js", (route) => route.abort());
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Person Profiles" })
    .click();
  await expect(page.getByRole("heading", { name: "This page could not load" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Products" })).toBeVisible();
  await page.unroute("**/assets/PeoplePage-*.js");
  await page.getByRole("button", { name: "Reload page" }).click();
  await expect(page.getByRole("heading", { name: "Person Profiles", exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Meeting Wizard" })
    .click();
  await expect(page.locator("main h1")).toBeVisible();
  await page.goto("/meetings/brief");
  await expect(page.locator("main h1")).toBeVisible();
  await page.reload();
  await expect(page.locator("main h1")).toBeVisible();
});

test("query-only navigation recovers from an unavailable Home preview", async ({ page }) => {
  await page.route("**/assets/homePrototypeVariants-*.js", (route) => route.abort());
  await page.goto("/?variant=a");
  await expect(page.getByRole("heading", { name: "This page could not load" })).toBeVisible();
  await page.getByRole("link", { name: "Found42 — Chief of Staff", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "This page could not load" })).toHaveCount(0);
  await expect(page.locator("main h1")).toBeVisible();
});
