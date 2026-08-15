/**
 * E2E fixture service: ServiceRuntime + ApiServer in replay mode with a
 * pre-provisioned profile, a known pairing code, and the golden fixtures.
 * Runs from the built service dist; `npm run build` must have run.
 */
import { Workspace } from "@chief-of-staff/workflow";
import { ServiceRuntime } from "@chief-of-staff/service";
import { ApiServer } from "@chief-of-staff/service";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, ".e2e-fixture");

if (existsSync(FIXTURE_DIR)) {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
}
mkdirSync(FIXTURE_DIR, { recursive: true });
const workspaceDir = join(FIXTURE_DIR, "workspace");
mkdirSync(join(workspaceDir, "config"), { recursive: true });
writeFileSync(
  join(workspaceDir, "config", "profile.json"),
  JSON.stringify({
    name: "Ada Lovelace",
    title: "Chief of Staff",
    company: "Analytical Engines Inc.",
    writingStyle: "I am concise in my communication, polite but direct. I prefer shorter emails.",
    focusAreas: ["Customer success", "Product quality", "Operational efficiency"],
  })
);
writeFileSync(
  join(workspaceDir, "config", "app.json"),
  JSON.stringify({
    maxParallelTasks: 4,
    watchDebounceMs: 100,
    maxTranscriptBytes: 26_214_400,
    allowedUiOrigins: ["http://127.0.0.1:4581", "http://localhost:5173"],
  })
);

const workspace = new Workspace(workspaceDir);
const runtime = new ServiceRuntime({
  workspace,
  repoRoot: REPO_ROOT,
  mode: "replay",
  fixturesDir: join(REPO_ROOT, "fixtures", "llm"),
  developerMode: true,
  logger: { info() {}, warn() {}, error: (m) => console.error(`[fixture-service] ${m}`) },
});
await runtime.start();
const code = runtime.issuePairingCode();
writeFileSync(join(FIXTURE_DIR, "pairing-code.txt"), code);
const server = new ApiServer({
  runtime,
  host: "127.0.0.1",
  port: 4580,
  log: (m) => console.error(`[fixture-service] ${m}`),
});
await server.start();
console.log(`FIXTURE SERVICE READY code=${code}`);
