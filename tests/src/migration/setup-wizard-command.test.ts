import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "guided-setup-command-"));
  roots.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
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
  writeFileSync(join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n');
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
  */api/migration/status*) printf '%s' '{"onboarding":{"complete":true}}' ;;
  */api/meetings/workspace)
    if [ "\${RESULT_READY:-0}" = 1 ]; then
      printf '%s' '{"intakeReadiness":{"verdict":"ready"},"today":[{"debrief":{"status":"ready"}}],"recent":[],"upcoming":[]}'
    else
      printf '%s' '{"intakeReadiness":{"verdict":"waiting"},"today":[],"recent":[],"upcoming":[]}'
    fi ;;
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
    options: { defaultEnv?: boolean; healthFail?: boolean; ready?: boolean } = {},
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
  expect(run.stdout).toContain("first Debrief is still waiting");
  expect(run.stdout).not.toContain("✓ Setup complete");
  expect(readFileSync(join(f.root, ".env"), "utf8")).toContain(
    "OPENAI_API_KEY=synthetic-provider-key",
  );
  expect(existsSync(f.workspace)).toBe(false);
});

it("transfers legacy credentials without re-entry, then resumes from the migrated state", () => {
  const f = fixture(true);
  const first = f.run("\ny\n\ny\ny\n\n\n", { ready: true });

  expect(first.status).toBe(0);
  expect(first.stdout).toContain("transfer without re-entry");
  expect(first.stdout).toContain("✓ Setup complete");
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

  const second = f.run("\ny\n\ny\n\ny\n\n\n", { ready: true });
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
  const resumed = f.run("\ny\n\ny\n\ny\n\n\n", { ready: true });
  expect(resumed.status).toBe(0);
  expect(resumed.stdout).toContain("✓ Setup complete");
  expect(resumed.stdout).not.toContain("Installation API key for openai:");
});
