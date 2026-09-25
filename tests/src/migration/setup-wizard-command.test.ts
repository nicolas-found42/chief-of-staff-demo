import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(legacy = false, workspaceName = "workspace") {
  const root = mkdtempSync(join(tmpdir(), "guided-setup-command-"));
  roots.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const workspace = join(root, workspaceName);
  const envFile = join(root, "installation.env");
  const backup = join(root, "backup");
  mkdirSync(scripts);
  mkdirSync(bin);
  copyFileSync(join(REPO, "scripts/setup-wizard.sh"), join(scripts, "setup-wizard.sh"));
  copyFileSync(
    join(REPO, "scripts/migrate-installation-credentials.mts"),
    join(scripts, "migrate-installation-credentials.mts"),
  );
  copyFileSync(join(REPO, "scripts/start-workspace.py"), join(scripts, "start-workspace.py"));
  writeFileSync(join(scripts, "workspace-backup.mts"), "");
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  writeFileSync(
    join(bin, "docker"),
    '#!/bin/sh\nprintf "%s | workspace=%s app_port=%s relay_port=%s\\n" "$*" "$WORKSPACE_DIR" "$APP_PORT" "$RELAY_PORT" >> "$CALL_LOG"\n',
  );
  writeFileSync(join(bin, "open"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
for url do :; done
case "$url" in
  */api/health) [ "\${HEALTH_FAIL:-0}" = 0 ] ;;
  */api/config.installation) printf '%s' '{"googleClient":{"state":"configured"},"providerKeys":{"openai":{"state":"configured"}}}' ;;
  */api/google/status) printf '%s' '{"state":"connected"}' ;;
  */api/migration/status*)
    if [ "\${RESULT_UNAVAILABLE:-0}" = 1 ]; then
      printf '%s' '{"onboarding":{"complete":true,"guidedSetup":{"stages":[{"id":"first-result","state":"unavailable"}]}}}'
    elif [ "\${RESULT_READY:-0}" = 1 ]; then
      printf '%s' '{"onboarding":{"complete":true,"guidedSetup":{"stages":[{"id":"first-result","state":"confirmed"}]}}}'
    else
      printf '%s' '{"onboarding":{"complete":true,"guidedSetup":{"stages":[{"id":"first-result","state":"waiting"}]}}}'
    fi ;;
  */api/meetings/workspace)
    printf '%s' '{"intakeReadiness":{"verdict":"ready"},"today":[],"recent":[],"upcoming":[]}' ;;
  *) exit 1 ;;
esac
`,
  );
  for (const tool of ["docker", "open", "curl", "sleep"]) chmodSync(join(bin, tool), 0o755);

  if (legacy) {
    mkdirSync(workspace);
    const files = {
      "config.json": `${JSON.stringify({
        provider: "openai",
        model: "preserved-model",
        apiKey: "synthetic-old-provider-key",
        google: {
          clientId: "synthetic-old-google-id",
          clientSecret: "synthetic-old-google-secret",
          refreshToken: "workspace-owned-token",
        },
      })}\n`,
      "owner-note.txt": "preserved unrelated record\n",
    };
    for (const [name, contents] of Object.entries(files))
      writeFileSync(join(workspace, name), contents);
    const captured = join(backup, "backup", "workspace");
    mkdirSync(captured, { recursive: true });
    const entries = Object.entries(files).map(([name, contents]) => {
      writeFileSync(join(captured, name), contents);
      return {
        path: name,
        bytes: Buffer.byteLength(contents),
        sha256: createHash("sha256").update(contents).digest("hex"),
      };
    });
    const capturedAt = "2026-09-24T12:00:00.000Z";
    writeFileSync(
      join(backup, "backup", "manifest.json"),
      JSON.stringify({ version: 1, capturedAt, canonicalHash: "0".repeat(64), files: entries }),
    );
    writeFileSync(
      join(backup, "result.json"),
      JSON.stringify({
        status: "captured-and-restored-twice",
        capturedAt,
        fileCount: entries.length,
      }),
    );
  }
  const callLog = join(root, "calls.log");
  const run = (
    input: string,
    options: {
      defaultEnv?: boolean;
      healthFail?: boolean;
      ready?: boolean;
      unavailable?: boolean;
    } = {},
  ) => {
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      WORKSPACE_DIR: workspace,
      BACKUP_DESTINATION: backup,
      BACKUP_RESULT: join(backup, "result.json"),
      CALL_LOG: callLog,
      HEALTH_FAIL: options.healthFail ? "1" : "0",
      RESULT_READY: options.ready ? "1" : "0",
      RESULT_UNAVAILABLE: options.unavailable ? "1" : "0",
      ...(options.defaultEnv ? {} : { ENV_FILE: envFile }),
    };
    if (options.defaultEnv) delete env.ENV_FILE;
    return spawnSync("bash", [join(scripts, "setup-wizard.sh")], {
      cwd: REPO,
      env,
      input,
      encoding: "utf8",
      timeout: 30000,
    });
  };
  return { root, workspace, envFile, callLog, run };
}

it("starts with the documented default and reports a truthful first-result wait", () => {
  const f = fixture();
  const run = f.run(
    "\ny\ny\nsynthetic-google-id\nsynthetic-google-secret\nopenai\nsynthetic-provider-key\n\n\n",
    {
      defaultEnv: true,
    },
  );

  expect(run.status).toBe(0);
  expect(run.stdout).toContain("Stage 10/10 · Verify the first result");
  expect(run.stdout.match(/Stage \d+ status:/g)).toHaveLength(10);
  expect(run.stdout).toContain("Stage 10 status: waiting for first Debrief");
  expect(run.stdout).toContain("first Debrief is still waiting");
  expect(run.stdout).not.toContain("✓ Setup complete");
  expect(readFileSync(join(f.root, ".env"), "utf8")).toContain(
    "OPENAI_API_KEY=synthetic-provider-key",
  );
  expect(readdirSync(f.workspace)).toEqual([]);
});

it("isolates an overridden Workspace and gives its Compose stack separate ports", () => {
  const f = fixture(false, "disposable-workspace");
  const run = f.run(
    "\ny\ny\nsynthetic-google-id\nsynthetic-google-secret\nopenai\nsynthetic-provider-key\n\n\n",
    { defaultEnv: true },
  );

  expect(run.status).toBe(0);
  const invocation = readFileSync(f.callLog, "utf8");
  expect(invocation).toContain("-p chief-setup-");
  expect(invocation).toContain(`workspace=${f.workspace}`);
  expect(invocation).toContain("app_port=44317 relay_port=44318");
  expect(readFileSync(`${f.workspace}.installation.env`, "utf8")).toContain(
    "OPENAI_API_KEY=synthetic-provider-key",
  );
  expect(existsSync(join(f.root, ".env"))).toBe(false);
  expect(run.stdout).toContain("first Debrief is still waiting");
});

it("reports an unavailable first-result check instead of claiming it is waiting", () => {
  const f = fixture();
  const run = f.run(
    "\ny\ny\nsynthetic-google-id\nsynthetic-google-secret\nopenai\nsynthetic-provider-key\n\n\n",
    { unavailable: true },
  );

  expect(run.status).toBe(1);
  expect(run.stdout).toContain("Stage 10 status: unavailable");
  expect(run.stdout).not.toContain("first Debrief is still waiting");
});

it("resumes fresh setup after the app created config without asking for migration", () => {
  const f = fixture();
  const first = f.run(
    "\ny\ny\nsynthetic-google-id\nsynthetic-google-secret\nopenai\nsynthetic-provider-key\n",
    { healthFail: true },
  );
  expect(first.status).toBe(1);
  writeFileSync(
    join(f.workspace, "config.json"),
    JSON.stringify({
      provider: "openai",
      model: "configured-model",
      google: { refreshToken: null },
    }),
  );

  const resumed = f.run("\ny\ny\n\n\n", { ready: true });
  expect(resumed.status).toBe(0);
  expect(resumed.stdout).toContain("✓ Setup complete");
  expect(resumed.stdout).toContain("No legacy credentials require transfer");
  expect(resumed.stdout).not.toContain("Required Workspace backup\n  The app must be stopped");
  expect(readFileSync(f.envFile, "utf8")).toContain("OPENAI_API_KEY=synthetic-provider-key");
});

it("transfers legacy credentials without re-entry, then resumes from the migrated state", () => {
  const f = fixture(true);
  const first = f.run("\ny\n\ny\ny\n\n\n", { ready: true });

  expect(first.status).toBe(0);
  expect(first.stdout).toContain("transfer without re-entry");
  expect(first.stdout).toContain("✓ Setup complete");
  expect(first.stdout.match(/Stage \d+ status:/g)).toHaveLength(10);
  expect(first.stdout).toContain("Stage 10 status: confirmed");
  expect(first.stdout).not.toContain("synthetic-old-provider-key");
  expect(readFileSync(f.envFile, "utf8")).toContain("OPENAI_API_KEY=synthetic-old-provider-key");
  expect(JSON.parse(readFileSync(join(f.workspace, "config.json"), "utf8"))).toMatchObject({
    provider: "openai",
    model: "preserved-model",
    google: { refreshToken: "workspace-owned-token" },
  });
  expect(readFileSync(join(f.workspace, "owner-note.txt"), "utf8")).toBe(
    "preserved unrelated record\n",
  );

  const second = f.run("\ny\ny\n\n\n\n", { ready: true });
  expect(second.status).toBe(0);
  expect(second.stdout).toContain("✓ Setup complete");
  expect(second.stdout).not.toContain("Installation API key for openai:");
});

it("refuses conflicting legacy destinations during the read-only check", () => {
  const f = fixture(true);
  writeFileSync(f.envFile, "OPENAI_API_KEY=conflicting-key\n");
  const before = readFileSync(join(f.workspace, "config.json"), "utf8");
  const run = f.run("\ny\n\n");

  expect(run.status).toBe(1);
  expect(run.stdout).toContain("migration check failed");
  expect(readFileSync(join(f.workspace, "config.json"), "utf8")).toBe(before);
  expect(readFileSync(f.envFile, "utf8")).toBe("OPENAI_API_KEY=conflicting-key\n");
  expect(existsSync(f.callLog)).toBe(false);
});

it("reuses existing installation values and verifies a ready first Debrief", () => {
  const f = fixture();
  const installed =
    "GOOGLE_CLIENT_ID=installed-id\nGOOGLE_CLIENT_SECRET=installed-secret\nOPENAI_API_KEY=installed-key\nUNRELATED=keep\n";
  writeFileSync(f.envFile, installed);
  const run = f.run("\ny\ny\nopenai\n\n\n", { ready: true });

  expect(run.status).toBe(0);
  expect(run.stdout).toContain("✓ Setup complete");
  expect(run.stdout).not.toContain("Installation API key for openai:");
  expect(readFileSync(f.envFile, "utf8")).toBe(installed);
});

it("rejects a relative installation path before writing or restarting", () => {
  const f = fixture();
  const run = spawnSync("bash", [join(f.root, "scripts/setup-wizard.sh")], {
    cwd: REPO,
    env: {
      ...process.env,
      WORKSPACE_DIR: f.workspace,
      ENV_FILE: "relative-installation.env",
      BACKUP_RESULT: join(f.root, "backup/result.json"),
    },
    input: "\n",
    encoding: "utf8",
  });

  expect(run.status).toBe(1);
  expect(run.stdout).toContain("paths must be absolute");
  expect(existsSync(join(REPO, "relative-installation.env"))).toBe(false);
});

it("resumes after a failed health check without re-entering transferred credentials", () => {
  const f = fixture(true);
  const failed = f.run("\ny\n\ny\ny\n", { healthFail: true });
  expect(failed.status).toBe(1);
  expect(failed.stdout).toContain("app did not become healthy");
  expect(readFileSync(f.envFile, "utf8")).toContain("OPENAI_API_KEY=synthetic-old-provider-key");
  const resumed = f.run("\ny\ny\n\n\n\n", { ready: true });
  expect(resumed.status).toBe(0);
  expect(resumed.stdout).toContain("✓ Setup complete");
  expect(resumed.stdout).not.toContain("Installation API key for openai:");
});
