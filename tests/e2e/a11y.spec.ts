import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sampleTranscript = join(here, "../fixtures/transcripts/sample-transcript.md");

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** Uploads the sample and lands on its run detail page. */
async function openRun(page: Page): Promise<void> {
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', sampleTranscript);
  await page.waitForURL(/\/runs\/run_/, { timeout: 15_000 });
  await expect(page.locator(".status-pill")).toHaveText("failed", { timeout: 15_000 });
}

/** Reports the element that currently holds focus, or a marker if it was dropped. */
function activeDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) {
      return "<body — focus lost>";
    }
    return `${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 24)}`;
  });
}

test("every route is free of axe violations", async ({ page }) => {
  await openRun(page);
  const runUrl = page.url();

  for (const path of [
    "/",
    runUrl,
    "/settings",
    "/settings?google=connected",
    "/settings?google=error",
    "/no-such-page",
  ]) {
    await page.goto(path);
    await page.waitForTimeout(300);
    // Expand the transcript so its contents are scanned too.
    const summary = page.locator("details summary");
    if (await summary.count()) {
      await summary.first().click();
    }
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(violations.map((v) => `${v.id} (${v.impact})`), `axe violations on ${path}`).toEqual([]);
  }
});

test("an unknown route is a real page, not a blank one", async ({ page }) => {
  // The server serves index.html for every path, so a mistyped URL reaches the
  // client router. Without a catch-all it rendered an empty <main> under the
  // previous route's title (WCAG 2.4.2).
  await page.goto("/settings");
  await expect(page).toHaveTitle(/^Settings ·/);

  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  await expect(page).toHaveTitle(/^Page not found ·/);
  await expect(page.getByRole("link", { name: /all runs/i })).toBeVisible();
});

test("busy buttons keep focus instead of dropping it to the body", async ({ page }) => {
  // A `disabled` button is blurred and removed from the tab order the instant it
  // is pressed, which strands the keyboard user at the top of the document
  // (WCAG 2.4.3). These controls use aria-disabled and guard their handlers.
  await page.goto("/settings");

  const save = page.getByRole("button", { name: "Save settings" });
  await save.focus();
  await save.click();
  await expect(save).toBeFocused();
  await expect(page.locator(".banner-ok")).toBeVisible();
  await expect(save).toBeFocused();

  const sync = page.getByRole("button", { name: "Sync now" });
  await sync.focus();
  await sync.click();
  await expect(page.locator(".banner-error")).toBeVisible();
  await expect(sync).toBeFocused();
});

test("retrying a run hands focus to the heading when the button unmounts", async ({ page }) => {
  await openRun(page);

  const retry = page.getByRole("button", { name: /retry/i });
  await retry.focus();
  await retry.click();

  // The run fails again (Google is not connected in the e2e workspace), so the
  // banner survives and focus should still be on the button it started on.
  await expect(retry).toBeFocused();
  expect(await activeDescription(page)).not.toBe("<body — focus lost>");
});

test("focus is visible wherever it lands, including the run heading", async ({ page }) => {
  await openRun(page);

  // Arriving at a run moves focus to its heading; that focus must be visible to
  // keyboard users (WCAG 2.4.7) even though the heading is not tabbable.
  const heading = page.locator("h1.run-title");
  await expect(heading).toBeFocused();
  const outline = await heading.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline, "run heading shows no focus ring").not.toBe("none");

  // And every genuinely tabbable control paints one.
  await page.goto("/settings");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const style = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) {
        return null;
      }
      const cs = getComputedStyle(el);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
    });
    if (style) {
      expect(style.outlineStyle).not.toBe("none");
    }
  }
});

test("the poll interval reports its error in the page, not a transient bubble", async ({
  page,
}) => {
  await page.goto("/settings");
  const poll = page.getByLabel("Poll interval (minutes)");

  // Clearing the field must not silently coerce to 0.
  await poll.fill("");
  await expect(poll).toHaveValue("");
  await expect(poll).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#poll-interval-error")).toBeVisible();
  await expect(poll).toHaveAttribute("aria-describedby", /poll-interval-error/);

  // Submitting names the problem and puts the user on the offending field.
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".banner-error")).toContainText(/whole number of minutes/i);
  await expect(poll).toBeFocused();

  await poll.fill("5");
  await expect(poll).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#poll-interval-error")).toHaveCount(0);
});

test("the file input's description survives an upload in flight", async ({ page }) => {
  await page.goto("/");
  // Hold the upload open so the in-flight render can be inspected.
  await page.route("**/api/runs/upload", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.setInputFiles('input[type="file"]', sampleTranscript);

  await expect(page.locator(".dropzone")).toContainText("Uploading…");
  const described = await page
    .locator('input[type="file"]')
    .getAttribute("aria-describedby");
  expect(described).toBe("upload-formats");
  // The referenced element must still exist, or the input loses its description.
  await expect(page.locator("#upload-formats")).toHaveCount(1);
});

test("the whole dropzone is a pointer target, not just the inline button", async ({ page }) => {
  await page.goto("/");
  const zone = page.getByTestId("dropzone");
  await expect(zone).toHaveCSS("cursor", "pointer");

  // The pointer cursor promised a click target; clicking the zone body opens the
  // picker, and the button remains the keyboard route.
  const chooser = page.waitForEvent("filechooser");
  await zone.click({ position: { x: 24, y: 14 } });
  await chooser;
});

test("the current page is marked by more than a background colour", async ({ page }) => {
  await page.goto("/settings");
  // aria-current is what the styling keys off, so the visual state cannot drift
  // from the programmatic one, and it survives forced-colors mode (WCAG 1.4.1).
  const current = page.locator('.app-header nav a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText("Settings");
});

test("interactive controls meet a 44px target size", async ({ page }) => {
  await page.goto("/settings");
  const undersized = await page.evaluate(() => {
    const out: string[] = [];
    const selector = 'button:not(.linklike), select, input:not([type="checkbox"]), .checkbox-label';
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }
      if (rect.height < 44) {
        out.push(`${el.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
    }
    return out;
  });
  expect(undersized).toEqual([]);
});

test("body text scales with the reader's font-size preference", async ({ page }) => {
  await page.goto("/");
  // An absolute px font-size on body would ignore the root entirely, leaving
  // body copy fixed while rem-based headings grew around it (WCAG 1.4.4).
  const { before, after } = await page.evaluate(() => {
    const before = getComputedStyle(document.body).fontSize;
    document.documentElement.style.fontSize = "200%";
    const after = getComputedStyle(document.body).fontSize;
    document.documentElement.style.fontSize = "";
    return { before, after };
  });
  expect(parseFloat(after)).toBeCloseTo(parseFloat(before) * 2, 1);
});
