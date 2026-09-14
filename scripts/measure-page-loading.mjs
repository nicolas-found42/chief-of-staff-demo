import { chromium } from "../apps/server/node_modules/playwright-core/index.mjs";

// Run against an explicitly supplied disposable production origin. No provider
// setup or application mutation: measures anonymous pages on an empty Workspace.
const origin = process.argv[2];
if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
  throw new Error("Supply a disposable loopback production origin.");
const browser = await chromium.launch({ headless: true });
try {
  for (let sample = 1; sample <= 3; sample += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.clearBrowserCache");
    for (const [phase, path, link] of [
      ["cold-home", "/"],
      ["warm-home", "/"],
      ["navigate-meetings", "/meetings", "Meeting Wizard"],
      ["navigate-people", "/people", "Person Profiles"],
      ["warm-people-reload", "/people"],
      ["direct-meeting-deep-link", "/meetings/brief"],
      ["return-home", "/"],
    ]) {
      const start = performance.now();
      if (link) {
        await page.evaluate(() => performance.clearResourceTimings());
        await page
          .getByRole("navigation", { name: "Products" })
          .getByRole("link", { name: link, exact: true })
          .click();
      } else await page.goto(origin + path);
      if (path === "/") await page.locator("main h1").first().waitFor({ state: "visible" });
      else
        await page
          .getByRole("heading", {
            name:
              path === "/meetings"
                ? "Meeting Wizard"
                : path === "/meetings/brief"
                  ? "Meeting Brief"
                  : "Person Profiles",
            exact: true,
            level: 1,
          })
          .waitFor({ state: "visible" });
      const headingMs = performance.now() - start;
      await page.waitForLoadState("networkidle");
      const resources = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((entry) => new URL(entry.name).pathname.endsWith(".js"))
          .map((entry) => ({
            path: new URL(entry.name).pathname,
            transferred: entry.transferSize,
            encoded: entry.encodedBodySize,
            decoded: entry.decodedBodySize,
          })),
      );
      console.log(
        JSON.stringify({
          sample,
          phase,
          headingMs: Math.round(headingMs),
          jsTransferred: resources.reduce((sum, item) => sum + item.transferred, 0),
          resources,
        }),
      );
    }
    await context.close();
    for (const [phase, path, heading] of [
      ["cold-direct-meetings", "/meetings", "Meeting Wizard"],
      ["cold-direct-people", "/people", "Person Profiles"],
      ["cold-direct-brief", "/meetings/brief", "Meeting Brief"],
    ]) {
      const direct = await browser.newContext();
      const tab = await direct.newPage();
      const session = await direct.newCDPSession(tab);
      await session.send("Network.enable");
      await session.send("Network.clearBrowserCache");
      const start = performance.now();
      await tab.goto(origin + path);
      await tab.getByRole("heading", { name: heading, exact: true, level: 1 }).waitFor();
      const headingMs = Math.round(performance.now() - start);
      await tab.waitForLoadState("networkidle");
      const resources = await tab.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((entry) => new URL(entry.name).pathname.endsWith(".js"))
          .map((entry) => ({
            path: new URL(entry.name).pathname,
            transferred: entry.transferSize,
            encoded: entry.encodedBodySize,
            decoded: entry.decodedBodySize,
          })),
      );
      console.log(
        JSON.stringify({
          sample,
          phase,
          headingMs,
          jsTransferred: resources.reduce((sum, item) => sum + item.transferred, 0),
          resources,
        }),
      );
      await direct.close();
    }
  }
} finally {
  await browser.close();
}
