import { expect, test } from "./fixture";

/**
 * The identifier entry form on /people/new, driven the way people actually
 * drive it (2026-09-15 Person Profile audit, F11/F12/F14). The three defects
 * here share one surface and one submission path: the field was not in a form
 * so Enter did nothing, a transport failure rendered the browser's own
 * exception string, and the button announced itself disabled while still
 * activating. The validation feedback the audit found genuinely good is
 * asserted alongside each, so none of these fixes is allowed to remove it.
 */

test("audit F11: Enter in the identifier field submits exactly as the button does", async ({
  page,
}) => {
  await page.goto("/people/new");
  const field = page.getByLabel("Email or profile URL");

  // Malformed input, submitted with the keyboard alone.
  await field.fill("not-a-real-url !!! ???");
  await field.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Not an email address or a profile URL");
  /* The refusal still echoes the input and offers an example — the part the
     audit rated a strength. */
  await expect(page.getByRole("alert")).toContainText("not-a-real-url !!! ???");
  await expect(page).toHaveURL(/\/people\/new$/);

  // The button reaches the same outcome for the same input.
  const keyboardRefusal = await page.getByRole("alert").textContent();
  await page.reload();
  await page.getByLabel("Email or profile URL").fill("not-a-real-url !!! ???");
  await page.getByRole("button", { name: "Add and research" }).click();
  await expect(page.getByRole("alert")).toHaveText(keyboardRefusal!);

  // And a valid identifier submitted by Enter creates and opens the Profile.
  await page.reload();
  await page.getByLabel("Email or profile URL").fill("https://github.com/keyboard-only");
  await page.getByLabel("Email or profile URL").press("Enter");
  await expect(page).toHaveURL(/\/people\/person_[a-z0-9-]+$/);
});

test("audit F14: the empty-field button announces what it actually does, and still explains the problem", async ({
  page,
}) => {
  await page.goto("/people/new");
  const button = page.getByRole("button", { name: "Add and research" });

  /* Announced availability matches activation: it is operable, focusable, and
     says so. Previously it reported aria-disabled while activating anyway. */
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.focus();
  await expect(button).toBeFocused();

  /* The validation message survives, and costs no round trip. */
  let lookupRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/people/lookup")) lookupRequests += 1;
  });
  await button.click();
  await expect(page.getByRole("alert")).toContainText(
    "Enter an email address or a profile URL to search for.",
  );
  expect(lookupRequests).toBe(0);
  await expect(page).toHaveURL(/\/people\/new$/);
});

test("audit F12: a blocked request explains itself and the form recovers when the block lifts", async ({
  page,
}) => {
  await page.goto("/people/new");
  const field = page.getByLabel("Email or profile URL");
  const button = page.getByRole("button", { name: "Add and research" });

  await page.route("**/api/people/lookup/accept", async (route) => {
    await route.abort("failed");
  });
  await field.fill("https://github.com/recovers-after-block");
  await button.click();

  const alert = page.getByRole("alert");
  /* Not the raw exception the browser threw. */
  await expect(alert).not.toHaveText("Failed to fetch");
  await expect(alert).toContainText("did not reach the app");
  await expect(alert).toContainText("nothing was saved");
  await expect(alert).toContainText(/try again/i);

  /* No phantom success and no stuck spinner: the page did not move, and the
     control is ready for another attempt with the input still in place. */
  await expect(page).toHaveURL(/\/people\/new$/);
  await expect(button).toHaveText("Add and research");
  await expect(field).toHaveValue("https://github.com/recovers-after-block");
  await expect(field).toBeEditable();

  // Removing the block is all recovery takes.
  await page.unroute("**/api/people/lookup/accept");
  await button.click();
  await expect(page).toHaveURL(/\/people\/person_[a-z0-9-]+$/);
});
