import { chromium, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { confirmMeetingOwner } from "./meeting-owner-fixture";
import { test, expect, serverOrigin } from "./fixture";

test.use({ freshWorkspace: true, trace: "on" });

async function layout(page: Page, info: TestInfo, name: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    name,
  ).toBe(true);
  const outside = await page
    .getByRole("main")
    .locator("button, input, select, textarea")
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
        })
        .map((element) => element.textContent || element.id),
    );
  expect(outside, `${name}: clipped controls`).toEqual([]);
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(audit.violations, `${name}: accessibility`).toEqual([]);
  if (name.startsWith("zoom-")) {
    const session = await page.context().newCDPSession(page);
    const shot = await session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(info.outputPath(`${name}.png`), Buffer.from(shot.data, "base64"));
    await session.detach();
  } else await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: "image/png" });
}

test("cold overview journey meets cumulative automated interaction budgets", async ({
  page,
  request,
}, info) => {
  await request.post("/api/test/meetings/overview-fixture");
  await confirmMeetingOwner(request);
  const start = performance.now();
  await page.goto("/meetings");
  await page
    .getByRole("region", { name: "Recent meetings", exact: true })
    .getByRole("link", { name: "September 5 planning", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "September 5 planning" })).toBeVisible();
  const opened = performance.now() - start;
  expect(opened).toBeLessThan(10_000);
  await expect(page.getByText("We agreed on the September 5 plan.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Decisions", exact: true })).toContainText(
    "Proceed with plan 5",
  );
  const actions = page.getByRole("region", { name: "Action Items", exact: true });
  await expect(
    actions.getByRole("heading", { name: "Follow up tomorrow 5-0", exact: true }),
  ).toBeVisible();
  const outcomes = performance.now() - start;
  expect(outcomes).toBeLessThan(30_000);
  await actions.getByRole("button", { name: "Create Task", exact: true }).first().click();
  await expect(actions.getByLabel("Title", { exact: true })).toHaveValue("Follow up tomorrow 5-0");
  await expect(actions.getByLabel("Title", { exact: true })).toBeFocused();
  await expect(actions).toContainText("Task Destination: Local only · Inbox");
  const controls = performance.now() - start;
  expect(controls).toBeLessThan(60_000);
  const timing = {
    opened,
    outcomes,
    controls,
    units: "milliseconds",
    clock: "monotonic; cumulative from overview navigation",
    scope: "automated interaction, not human learnability",
  };
  await writeFile(info.outputPath("interaction-budgets.json"), JSON.stringify(timing, null, 2));
  await info.attach("automated-interaction-budgets", {
    path: info.outputPath("interaction-budgets.json"),
    contentType: "application/json",
  });
  await actions.getByLabel("Title", { exact: true }).fill("Keep this local correction");
  await actions.getByText("More options", { exact: true }).click();
  await actions.getByLabel("Notes", { exact: true }).fill("Retain the reviewed context");
  await actions.getByLabel("Title", { exact: true }).focus();
  await page.reload();
  await expect(actions.getByLabel("Notes", { exact: true })).toBeVisible();
  await expect(actions.getByLabel("Notes", { exact: true })).toHaveValue(
    "Retain the reviewed context",
  );
  await expect(actions.getByLabel("Title", { exact: true })).toHaveValue(
    "Keep this local correction",
  );
  await expect(actions.getByLabel("Title", { exact: true })).toBeFocused();
  expect(
    (await (await request.get("/api/test/meeting-debrief/drafts")).json()).drafts,
  ).toHaveLength(0);
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 960, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`reading, empty, failure and email layouts at ${viewport.width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await (await request.post("/api/test/meetings/overview-fixture")).json();
    await request.post(`/api/meeting-debrief/${fixture.recent[4].runId}/roster`, {
      data: {
        entries: [
          { displayName: "Alice", email: "alice@example.com" },
          { displayName: "Bob", email: "bob@example.com" },
        ],
      },
    });
    await page.goto(`/meetings/${fixture.recent[4].id}?tab=debrief`);
    await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
    if (viewport.width === 1280) {
      await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeInViewport();
      await expect(page.getByRole("tab", { name: "Debrief", exact: true })).toBeInViewport();
    }
    await layout(page, info, "dense-reading");
    const actions = page.getByRole("region", { name: "Action Items", exact: true });
    await actions.getByRole("button", { name: "Create Task", exact: true }).first().click();
    await layout(page, info, "task-form");
    await actions.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Create email draft", exact: true }).click();
    await layout(page, info, "attendees");
    await page.getByRole("button", { name: "Preview and create", exact: true }).click();
    await page.getByRole("button", { name: "Update preview", exact: true }).click();
    await expect(page.getByLabel("Email body preview")).toContainText(
      "We agreed on the September 5 plan.",
    );
    await layout(page, info, "email-preview");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Create email draft", exact: true }),
    ).toBeFocused();
    await page.getByRole("tab", { name: "Brief", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("link", { name: "Read the available Debrief", exact: true }),
    ).toBeVisible();
    await layout(page, info, "empty-brief");
    await page.goto(`/meetings/${fixture.todayId}?tab=brief`);
    await expect(page.getByRole("button", { name: "Retry brief", exact: true })).toBeVisible();
    await layout(page, info, "failed-brief");
  });
}

test("actual 200 percent browser zoom keeps reading and email controls operable", async ({
  request,
}, info) => {
  test.setTimeout(120_000);
  const fixture = await (await request.post("/api/test/meetings/overview-fixture")).json();
  await request.post(`/api/meeting-debrief/${fixture.recent[4].runId}/roster`, {
    data: {
      entries: [
        { displayName: "Alice", email: "alice@example.com" },
        { displayName: "Bob", email: "bob@example.com" },
      ],
    },
  });
  const extension = await mkdtemp(join(tmpdir(), "meeting-zoom-"));
  // Real tab zoom through Chromium's extension API; no CSS zoom, pinch scale or DPR substitute.
  await writeFile(
    join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Acceptance zoom",
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
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const page = await context.newPage();
    await page.goto(`${serverOrigin}/meetings/${fixture.recent[4].id}?tab=debrief`);
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
    }, serverOrigin);
    expect(zoom).toBe(2);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(640);
    await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
    await layout(page, info, "zoom-200-reading");
    await page.getByRole("button", { name: "Create email draft", exact: true }).click();
    await layout(page, info, "zoom-200-attendees");
    await page.getByRole("button", { name: "Preview and create", exact: true }).click();
    await page.getByRole("button", { name: "Update preview", exact: true }).click();
    await expect(page.getByLabel("Email body preview")).toBeVisible();
    await layout(page, info, "zoom-200-preview");
  } finally {
    await context.close();
    await rm(extension, { recursive: true, force: true });
  }
});
