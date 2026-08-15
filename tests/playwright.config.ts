import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:4581",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: "node e2e/start-fixture-service.mjs",
      url: "http://127.0.0.1:4580/v1/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "node e2e/serve-static.mjs",
      url: "http://127.0.0.1:4581/index.html",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
