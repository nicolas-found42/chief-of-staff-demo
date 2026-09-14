import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixture";

// All names, provenance and long source text in this journey are synthetic.
test("source reader supports long evidence, mobile reading, zoom and correction recovery", async ({
  baseURL,
}) => {
  const extension = await mkdtemp(join(tmpdir(), "source-reader-zoom-"));
  await writeFile(
    join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Evidence zoom verification",
      version: "1.0",
      permissions: ["tabs"],
      background: { service_worker: "worker.js" },
    }),
  );
  await writeFile(
    join(extension, "worker.js"),
    "chrome.runtime.onInstalled.addListener(() => {});",
  );
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    baseURL,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const page = await context.newPage();
    const quote = "Maya designed the scheduler and deployed Atlas to 200 sites.";
    const profile = await (
      await page.request.post("/api/people", {
        data: { fullName: "Maya Chen", primaryEmail: "layout-maya@example.com" },
      })
    ).json();
    const source = {
      id: "synthetic-layout-source",
      title: "Building Atlas: design decisions from the scheduler team",
      url: "https://engineering.example.com/articles/atlas-scheduler",
      author: "Atlas engineering team (synthetic)",
      publishedAt: "2024-02-01",
      retrievedAt: "2026-09-14T16:45:23.767Z",
      family: "engineering.example.com",
      sourceClass: "primary-artifact",
      completeness: "full",
      access: "retrieved",
      extractionCoverage: "full",
      acquisition: "public-web",
      visibility: "public",
      text: `Atlas deployment notes\n\n${quote}\n\nThe team recorded design decisions and operational limits. The passage supports an individual contribution; it does not establish every claim about the project.`,
    };
    const dossier = {
      revision: 1,
      sourceIds: [source.id],
      works: [],
      expertise: [],
      connections: [],
      claims: [
        {
          id: "contribution",
          statement: quote,
          section: "work",
          status: "supported",
          nature: "statement",
          citations: [{ sourceId: source.id, quote }],
        },
      ],
      sections: [
        {
          key: "overview",
          summary: quote,
          state: "incomplete",
          updatedAt: source.retrievedAt,
          gaps: [],
          claimIds: ["contribution"],
        },
      ],
    };
    await page.route(`**/api/people/${profile.id}/dossier`, (route) =>
      route.fulfill({ json: { dossier, research: null } }),
    );
    await page.route(`**/api/people/${profile.id}/dossier-analysis`, (route) =>
      route.fulfill({ json: null }),
    );
    await page.route(`**/api/people/${profile.id}/sources/${source.id}`, (route) =>
      route.fulfill({ json: source }),
    );
    await page.goto(`/people/${profile.id}`);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page
      .getByRole("button", { name: /^Source 1/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "Source evidence" });
    await expect(dialog.getByRole("heading", { name: source.title })).toBeVisible();
    await expect(dialog.getByText(/Source details · Retrieved/)).toContainText("UTC");
    await dialog.getByText(/Source details · Retrieved/).click();
    await expect(dialog.getByText(source.retrievedAt, { exact: true })).toBeVisible();
    await dialog.getByText(/Source details · Retrieved/).click();
    await page.screenshot({ path: test.info().outputPath("reader-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const mobileBounds = await dialog.boundingBox();
    expect(mobileBounds!.y).toBeGreaterThanOrEqual(0);
    expect(mobileBounds!.y + mobileBounds!.height).toBeLessThanOrEqual(844);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath("reader-mobile.png") });
    await page.keyboard.press("Escape");
    source.title += " — " + "extended-title-".repeat(20);
    source.url += "/" + "long-path-".repeat(60);
    source.text +=
      "\n\n" + "unbroken".repeat(300) + "\n\n" + "Further synthetic context. ".repeat(200);
    await page
      .getByRole("button", { name: /^Source 1/ })
      .first()
      .click();
    await expect(dialog.getByRole("heading", { name: source.title })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath("reader-long-content.png") });
    await dialog.getByText("This source is about someone else", { exact: true }).click();
    let fail = true;
    const releaseFailure = Promise.withResolvers<void>();
    await page.route(`**/api/people/${profile.id}/sources/${source.id}/detach`, async (route) => {
      if (fail) {
        await releaseFailure.promise;
        await route.fulfill({ status: 503, json: { error: "Correction temporarily unavailable" } });
      } else await route.fulfill({ json: {} });
    });
    await dialog.getByRole("button", { name: "Remove wrong-person attribution" }).click();
    await expect(dialog.getByRole("button", { name: "Removing attribution…" })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("reader-correction-pending.png") });
    releaseFailure.resolve();
    await expect(dialog.getByRole("alert")).toContainText("Correction temporarily unavailable");
    await dialog.getByRole("alert").scrollIntoViewIfNeeded();
    await dialog.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.screenshot({ path: test.info().outputPath("reader-correction-error.png") });
    fail = false;
    await dialog.getByRole("button", { name: "Remove wrong-person attribution" }).click();
    await expect(dialog).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await page
      .getByRole("button", { name: /^Source 1/ })
      .first()
      .click();
    await expect(dialog.getByRole("heading", { name: source.title })).toBeVisible();
    const zoomBounds = await dialog.boundingBox();
    expect(zoomBounds!.y).toBeGreaterThanOrEqual(0);
    expect(zoomBounds!.y + zoomBounds!.height).toBeLessThanOrEqual(720);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath("reader-zoom.png") });
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const zoom = await worker.evaluate(async (origin) => {
      const chromeApi = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query(query: object): Promise<{ id: number; url: string }[]>;
              setZoom(id: number, factor: number): Promise<void>;
              getZoom(id: number): Promise<number>;
            };
          };
        }
      ).chrome;
      const tab = (await chromeApi.tabs.query({})).find((tab) => tab.url.startsWith(origin))!;
      await chromeApi.tabs.setZoom(tab.id, 2);
      return chromeApi.tabs.getZoom(tab.id);
    }, baseURL);
    expect(zoom).toBe(2);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(640);
    await page
      .getByRole("button", { name: /^Source 1/ })
      .first()
      .click();
    await expect(dialog.getByRole("heading", { name: source.title })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await dialog.getByText("This source is about someone else", { exact: true }).click();
    const correction = dialog.getByRole("button", { name: "Remove wrong-person attribution" });
    await correction.focus();
    await expect(correction).toBeFocused();
    await correction.scrollIntoViewIfNeeded();
    await dialog.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const session = await context.newCDPSession(page);
    const shot = await session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(
      test.info().outputPath("reader-browser-zoom.png"),
      Buffer.from(shot.data, "base64"),
    );
    await session.detach();
    await dialog.getByRole("button", { name: "Close source" }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
    await rm(extension, { recursive: true, force: true });
  }
});
