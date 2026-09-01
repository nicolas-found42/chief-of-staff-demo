import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const workspace = mkdtempSync(join(tmpdir(), "tf-e2e-"));
mkdirSync(join(workspace, "runs"), { recursive: true });
writeFileSync(
  join(workspace, "config.json"),
  JSON.stringify(
    {
      provider: "mock",
      model: "",
      apiKey: "",
      tasklistName: "Meeting Followups",
      google: {
        clientId: "",
        clientSecret: "",
        refreshToken: null,
        lastConnectedAt: null,
        hasExpiredBefore: false,
      },
      drive: { enabled: false, folderId: "", folderName: "", pollIntervalMinutes: 2 },
      ollama: { baseUrl: "http://127.0.0.1:11434" },
      /* The hermetic server holds the Content Scout clock just before its due
         times: a 30-second scheduler tick that fires a scheduled daily-intake
         Run (blocked forever until a decision) or a weekly Discovery Run would
         otherwise interleave scheduled Runs and Source Suggestions into any
         journey that takes longer than one tick after a Brand Profile and an
         active Source Target exist. Journeys drive Scout and Discovery
         explicitly, so the schedule stays production-defaulted in the app and
         parked here only. */
      modules: {
        "content-scout": {
          dailyTime: "23:59",
          weeklyDiscoveryDay: 7,
          weeklyDiscoveryTime: "23:59",
        },
      },
    },
    null,
    2,
  ),
);
copyFileSync(join(root, "tests/fixtures/mock-result.json"), join(workspace, "mock-result.json"));

const child = spawn(process.execPath, [join(root, "apps/server/dist/main.js")], {
  cwd: root,
  env: { ...process.env, PORT: "4319", WORKSPACE_DIR: workspace, ENABLE_TEST_SEED: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});

const stop = () => {
  child.kill("SIGTERM");
};
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
child.on("exit", (code) => {
  process.exit(code ?? 0);
});
