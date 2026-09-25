import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Explicit installation-credential migration (#480), driven only through the
 * operator command. Every fixture is private and temporary; the command sees a
 * stopped app through the already-verified backup receipt.
 */

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/migrate-installation-credentials.mts", import.meta.url),
);
const roots: string[] = [];

type Provider = "openrouter" | "openai" | "anthropic" | "gemini";

const GOOGLE_CLIENT_ID = "legacy-google-id.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "legacy-google-secret-7f3a";
const LEGACY_API_KEY = "legacy-provider-key-91bc";
const REFRESH_TOKEN = "workspace-refresh-token-22de";
const UNRELATED_ENV = "UNRELATED_SETTING=preserve-me-exactly\n# keep this comment too\n";

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function legacyWorkspace(
  provider: Provider,
  options: { apiKey?: string | null; googleCredentials?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "installation-credential-migration-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, "config.json"),
    `${JSON.stringify(
      {
        provider,
        model: `${provider}-preserved-model`,
        models: { [provider]: { evaluationJudge: `${provider}-judge` } },
        ...(options.apiKey === null ? {} : { apiKey: options.apiKey ?? LEGACY_API_KEY }),
        tasklistName: "Preserved task list",
        google: {
          ...(options.googleCredentials === false
            ? {}
            : { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }),
          refreshToken: REFRESH_TOKEN,
          lastConnectedAt: "2026-09-20T10:00:00.000Z",
          hasExpiredBefore: true,
        },
        drive: {
          enabled: true,
          folderId: "preserved-folder",
          folderName: "Preserved Transcripts",
          pollIntervalMinutes: 7,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(workspace, "owner-note.txt"), "unrelated Workspace data\n", "utf8");
  return workspace;
}

function acceptedBackup(workspace: string, files: Record<string, string>): string {
  const backup = join(workspace, "..", "accepted-backup");
  const capturedWorkspace = join(backup, "backup", "workspace");
  mkdirSync(capturedWorkspace, { recursive: true });
  const inventory = Object.entries(files)
    .map(([path, contents]) => {
      const bytes = Buffer.from(contents);
      writeFileSync(join(capturedWorkspace, path), bytes);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const capturedAt = "2026-09-24T12:00:00.000Z";
  const canonicalHash = sha256(workspace);
  writeFileSync(
    join(backup, "backup", "manifest.json"),
    JSON.stringify({ version: 1, capturedAt, files: inventory, canonicalHash }),
    "utf8",
  );
  writeFileSync(
    join(backup, "result.json"),
    JSON.stringify({
      fileCount: inventory.length,
      capturedAt,
      status: "captured-and-restored-twice",
      formatMigration: false,
    }),
    "utf8",
  );
  return join(backup, "result.json");
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return result;
}

function envSnapshot(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function envValues(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function runMigration(
  operation: "check" | "apply",
  workspace: string,
  env: string,
  backupResult: string,
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const childEnv = { ...process.env };
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
  ])
    delete childEnv[name];
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      SCRIPT,
      operation,
      "--workspace",
      workspace,
      "--env",
      env,
      "--backup-result",
      backupResult,
    ],
    { encoding: "utf8", env: { ...childEnv, ...envOverrides } },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function holdWorkspaceWriterLock(workspace: string): Promise<ChildProcess> {
  const code = [
    "import fcntl, os, sys, time",
    "descriptor = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)",
    "fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "print('ready', flush=True)",
    "time.sleep(30)",
  ].join(";");
  const child = spawn("python3", ["-c", code, join(workspace, ".writer.lock")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.stdout.once("error", reject);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`writer-lock helper exited ${code}`)));
  });
  return child;
}

function fixture(
  provider: Provider,
  options: { apiKey?: string | null; googleCredentials?: boolean; env?: string } = {},
): { workspace: string; env: string; backupResult: string } {
  const workspace = legacyWorkspace(provider, {
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.googleCredentials === undefined
      ? {}
      : { googleCredentials: options.googleCredentials }),
  });
  const config = readFileSync(join(workspace, "config.json"), "utf8");
  const backupResult = acceptedBackup(workspace, {
    "config.json": config,
    "owner-note.txt": "unrelated Workspace data\n",
  });
  const env = join(workspace, "..", "installation.env");
  writeFileSync(env, options.env ?? UNRELATED_ENV, "utf8");
  return { workspace, env, backupResult };
}

function expectNoSecretOutput(result: { stdout: string; stderr: string }): void {
  for (const secret of [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, LEGACY_API_KEY, REFRESH_TOKEN]) {
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }
}

describe("installation credential migration command", () => {
  it("checks a verified legacy Workspace without changing source or destination", () => {
    const { workspace, env, backupResult } = fixture("anthropic");
    const sourceBefore = snapshot(workspace);
    const envBefore = envSnapshot(env);

    const result = runMigration("check", workspace, env, backupResult);

    expect(result.status).toBe(0);
    expect(snapshot(workspace)).toEqual(sourceBefore);
    expect(envSnapshot(env)).toBe(envBefore);
    expectNoSecretOutput(result);
  });

  it("rejects a relative installation environment path", () => {
    const { workspace, env, backupResult } = fixture("openrouter");

    const result = runMigration("check", workspace, relative(process.cwd(), env), backupResult);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("env-path-must-be-absolute");
    expectNoSecretOutput(result);
  });

  it("refuses to store installation credentials inside the Workspace", () => {
    const { workspace, backupResult } = fixture("openrouter");
    const env = join(workspace, "installation.env");
    const sourceBefore = snapshot(workspace);

    const result = runMigration("apply", workspace, env, backupResult);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("env-path-outside-workspace-required");
    expectNoSecretOutput(result);
    expect(snapshot(workspace)).toEqual(sourceBefore);
    expect(existsSync(env)).toBe(false);
  });

  it("refuses apply while the supported app writer lock is held", async () => {
    const { workspace, env } = fixture("openrouter");
    const lockPath = join(workspace, ".writer.lock");
    writeFileSync(lockPath, "", "utf8");
    const backupResult = acceptedBackup(workspace, {
      "config.json": readFileSync(join(workspace, "config.json"), "utf8"),
      "owner-note.txt": "unrelated Workspace data\n",
      ".writer.lock": "",
    });
    const sourceBefore = snapshot(workspace);
    const envBefore = envSnapshot(env);
    const holder = await holdWorkspaceWriterLock(workspace);

    try {
      const result = runMigration("apply", workspace, env, backupResult);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("workspace-writer-active");
      expectNoSecretOutput(result);
      expect(snapshot(workspace)).toEqual(sourceBefore);
      expect(envSnapshot(env)).toBe(envBefore);
    } finally {
      const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
      holder.kill("SIGTERM");
      await exited;
    }
  });

  it.each([
    ["openrouter", "OPENROUTER_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
  ] as const)("routes the exact legacy key for %s to %s", (provider, variable) => {
    const { workspace, env, backupResult } = fixture(provider);

    const result = runMigration("apply", workspace, env, backupResult);

    expect(result.status).toBe(0);
    expectNoSecretOutput(result);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(envValues(env)).toMatchObject({
      UNRELATED_SETTING: "preserve-me-exactly",
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      [variable]: LEGACY_API_KEY,
    });
    expect(readFileSync(env, "utf8")).toContain("# keep this comment too");

    const config = JSON.parse(readFileSync(join(workspace, "config.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(config).not.toHaveProperty("apiKey");
    expect(config.google).toEqual({
      refreshToken: REFRESH_TOKEN,
      lastConnectedAt: "2026-09-20T10:00:00.000Z",
      hasExpiredBefore: true,
    });
    expect(config).toMatchObject({
      provider,
      model: `${provider}-preserved-model`,
      models: { [provider]: { evaluationJudge: `${provider}-judge` } },
      tasklistName: "Preserved task list",
      drive: {
        enabled: true,
        folderId: "preserved-folder",
        folderName: "Preserved Transcripts",
        pollIntervalMinutes: 7,
      },
    });
    expect(readFileSync(join(workspace, "owner-note.txt"), "utf8")).toBe(
      "unrelated Workspace data\n",
    );
  });

  it("is idempotent after exact migration and leaves destination bytes unchanged on rerun", () => {
    const { workspace, env, backupResult } = fixture("gemini");
    expect(runMigration("apply", workspace, env, backupResult).status).toBe(0);
    const sourceAfterFirst = snapshot(workspace);
    const envAfterFirst = envSnapshot(env);

    const rerun = runMigration("apply", workspace, env, backupResult);

    expect(rerun.status).toBe(0);
    expectNoSecretOutput(rerun);
    expect(snapshot(workspace)).toEqual(sourceAfterFirst);
    expect(envSnapshot(env)).toBe(envAfterFirst);
    expect(envValues(env).GEMINI_API_KEY).toBe(LEGACY_API_KEY);
  });

  it("creates a missing mode-600 env destination while preserving unrelated workspace data", () => {
    const { workspace, env, backupResult } = fixture("openai");
    rmSync(env);

    const result = runMigration("apply", workspace, env, backupResult);

    expect(result.status).toBe(0);
    expectNoSecretOutput(result);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(envValues(env)).toEqual({
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      OPENAI_API_KEY: LEGACY_API_KEY,
    });
    expect(readFileSync(join(workspace, "owner-note.txt"), "utf8")).toBe(
      "unrelated Workspace data\n",
    );
  });

  it("treats a fresh Workspace with no legacy fields as an idempotent no-op", () => {
    const { workspace, env } = fixture("openrouter", {
      apiKey: null,
      googleCredentials: false,
    });
    const withoutLegacyCredentials = readFileSync(join(workspace, "config.json"), "utf8");
    const refreshedBackup = acceptedBackup(workspace, {
      "config.json": withoutLegacyCredentials,
      "owner-note.txt": "unrelated Workspace data\n",
    });
    const sourceBefore = snapshot(workspace);
    const envBefore = envSnapshot(env);

    const result = runMigration("apply", workspace, env, refreshedBackup);

    expect(result.status).toBe(0);
    expect(snapshot(workspace)).toEqual(sourceBefore);
    expect(envSnapshot(env)).toBe(envBefore);
  });

  it("removes empty superseded fields without inventing destination credentials", () => {
    const { workspace, env } = fixture("openrouter", {
      apiKey: null,
      googleCredentials: false,
    });
    const configPath = join(workspace, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.apiKey = "";
    config.google = { clientId: "", clientSecret: "", refreshToken: REFRESH_TOKEN };
    writeFileSync(configPath, JSON.stringify(config), "utf8");
    const refreshedBackup = acceptedBackup(workspace, {
      "config.json": readFileSync(configPath, "utf8"),
      "owner-note.txt": "unrelated Workspace data\n",
    });
    const envBefore = envSnapshot(env);

    const result = runMigration("apply", workspace, env, refreshedBackup);

    expect(result.status).toBe(0);
    expectNoSecretOutput(result);
    expect(envSnapshot(env)).toBe(envBefore);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    const migrated = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(migrated).not.toHaveProperty("apiKey");
    expect(migrated.google).toEqual({ refreshToken: REFRESH_TOKEN });
  });

  it.each([
    ["openrouter", "OPENROUTER_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
  ] as const)("refuses a conflicting %s destination", (provider, variable) => {
    const conflict = `${variable}=different-installed-key\nUNRELATED_SETTING=keep\n`;
    const { workspace, env, backupResult } = fixture(provider, { env: conflict });
    const sourceBefore = snapshot(workspace);
    const envBefore = envSnapshot(env);

    const result = runMigration("apply", workspace, env, backupResult);

    expect(result.status).toBe(1);
    expectNoSecretOutput(result);
    expect(snapshot(workspace)).toEqual(sourceBefore);
    expect(envSnapshot(env)).toBe(envBefore);
  });

  it("finds a destination conflict during the read-only check", () => {
    const { workspace, env, backupResult } = fixture("openai", {
      env: "OPENAI_API_KEY=a-different-key\nUNRELATED_SETTING=keep\n",
    });
    const sourceBefore = snapshot(workspace);
    const envBefore = envSnapshot(env);

    const result = runMigration("check", workspace, env, backupResult);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("destination-credential-conflict");
    expectNoSecretOutput(result);
    expect(snapshot(workspace)).toEqual(sourceBefore);
    expect(envSnapshot(env)).toBe(envBefore);
  });

  it.each([
    ["check", "different-exported-key"],
    ["apply", "different-exported-key"],
    ["check", ""],
    ["apply", ""],
  ] as const)(
    "refuses effective process credential %s with value %j",
    (operation, exportedValue) => {
      const { workspace, env, backupResult } = fixture("openai");
      const sourceBefore = snapshot(workspace);
      const envBefore = envSnapshot(env);

      const result = runMigration(operation, workspace, env, backupResult, {
        OPENAI_API_KEY: exportedValue,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("destination-credential-conflict");
      expectNoSecretOutput(result);
      expect(snapshot(workspace)).toEqual(sourceBefore);
      expect(envSnapshot(env)).toBe(envBefore);
    },
  );

  it.each(["missing", "failed", "mismatched", "receipt-mismatch"] as const)(
    "refuses %s backup evidence before changing either side",
    (fault) => {
      const { workspace, env, backupResult } = fixture("openai");
      if (fault === "missing") rmSync(backupResult);
      if (fault === "failed") {
        writeFileSync(
          backupResult,
          JSON.stringify({ status: "failed", phase: "restored-2" }),
          "utf8",
        );
      }
      if (fault === "receipt-mismatch") {
        const receipt = JSON.parse(readFileSync(backupResult, "utf8")) as Record<string, unknown>;
        receipt.capturedAt = "2026-09-24T12:00:01.000Z";
        writeFileSync(backupResult, JSON.stringify(receipt), "utf8");
      }
      if (fault === "mismatched") {
        writeFileSync(join(workspace, "owner-note.txt"), "changed after backup\n", "utf8");
      }
      const sourceBefore = snapshot(workspace);
      const envBefore = envSnapshot(env);

      const result = runMigration("apply", workspace, env, backupResult);

      expect(result.status).toBe(1);
      expectNoSecretOutput(result);
      expect(snapshot(workspace)).toEqual(sourceBefore);
      expect(envSnapshot(env)).toBe(envBefore);
    },
  );

  it("stops without source removal when destination verification cannot succeed", () => {
    const { workspace, env, backupResult } = fixture("gemini");
    const sourceBefore = snapshot(workspace);
    const envBefore = envSnapshot(env);
    const directoryPath = join(workspace, "..", "unwritable-env-parent");
    mkdirSync(directoryPath);
    chmodSync(directoryPath, 0o500);

    try {
      const result = runMigration(
        "apply",
        workspace,
        join(directoryPath, "installation.env"),
        backupResult,
      );

      expect(result.status).toBe(1);
      expectNoSecretOutput(result);
      expect(snapshot(workspace)).toEqual(sourceBefore);
      expect(envSnapshot(env)).toBe(envBefore);
    } finally {
      chmodSync(directoryPath, 0o700);
    }
  });
});
