import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Operation = "check" | "apply";
type Provider = "openrouter" | "openai" | "anthropic" | "gemini";

const PROVIDER_ENV: Record<Provider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const WRITER_LOCK_SCRIPT = fileURLToPath(new URL("./start-workspace.py", import.meta.url));

class Refusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new Refusal(code);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function absoluteExisting(path: string, kind: "file" | "directory"): string {
  if (!isAbsolute(path)) fail(`${kind}-path-must-be-absolute`);
  const resolved = resolve(path);
  if (!existsSync(resolved)) fail(`${kind}-missing`);
  const stat = lstatSync(resolved);
  if (kind === "file" && !stat.isFile()) fail(`${kind}-not-file`);
  if (kind === "directory" && !stat.isDirectory()) fail(`${kind}-not-directory`);
  return resolved;
}

function absoluteEnvPath(path: string): string {
  if (!isAbsolute(path)) fail("env-path-must-be-absolute");
  return resolve(path);
}

function pathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertWorkspaceStopped(workspace: string): void {
  if (!existsSync(join(workspace, ".writer.lock"))) return;
  const probe = spawnSync("python3", [WRITER_LOCK_SCRIPT, process.execPath, "-e", ""], {
    encoding: "utf8",
    env: { ...process.env, WORKSPACE_DIR: workspace },
    stdio: "pipe",
  });
  if (probe.status === 73) fail("workspace-writer-active");
  if (probe.error || probe.status !== 0) fail("workspace-stopped-state-unverifiable");
}

function readJson(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("json-unreadable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("json-shape-invalid");
  return parsed as Record<string, unknown>;
}

function walk(root: string, prefix = ""): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const child = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) paths.push(...walk(root, child));
    else if (entry.isFile()) paths.push(child);
    else fail("workspace-unsupported-entry");
  }
  return paths.sort();
}

function safeRelative(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    fail("backup-path-invalid");
  }
  return normalized;
}

function verifyBackup(workspace: string, resultPath: string): string[] {
  const result = readJson(resultPath);
  if (result.status !== "captured-and-restored-twice" || result.formatMigration === true) {
    fail("backup-not-accepted");
  }
  if (typeof result.fileCount !== "number" || !Number.isSafeInteger(result.fileCount)) {
    fail("backup-receipt-invalid");
  }
  const backupRoot = dirname(resultPath);
  const manifestPath = join(backupRoot, "backup", "manifest.json");
  const capturedRoot = join(backupRoot, "backup", "workspace");
  absoluteExisting(manifestPath, "file");
  absoluteExisting(capturedRoot, "directory");
  const manifest = readJson(manifestPath);
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) fail("backup-manifest-invalid");
  if (
    manifest.files.length !== result.fileCount ||
    typeof manifest.capturedAt !== "string" ||
    manifest.capturedAt !== result.capturedAt
  ) {
    fail("backup-receipt-mismatch");
  }
  if (
    typeof manifest.canonicalHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.canonicalHash)
  ) {
    fail("backup-manifest-invalid");
  }
  const expected = new Map<string, { bytes: number; sha256: string }>();
  const changedPaths: string[] = [];
  for (const raw of manifest.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("backup-manifest-invalid");
    const entry = raw as Record<string, unknown>;
    const path = safeRelative(typeof entry.path === "string" ? entry.path : "");
    if (
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      expected.has(path)
    ) {
      fail("backup-manifest-invalid");
    }
    expected.set(path, { bytes: entry.bytes, sha256: entry.sha256 });
    const captured = join(capturedRoot, path);
    const current = join(workspace, path);
    if (!existsSync(captured) || !existsSync(current)) fail("backup-file-missing");
    const capturedBytes = readFileSync(captured);
    if (capturedBytes.length !== entry.bytes || sha256(capturedBytes) !== entry.sha256) {
      fail("backup-file-mismatch");
    }
    const currentBytes = readFileSync(current);
    if (currentBytes.length !== entry.bytes || sha256(currentBytes) !== entry.sha256) {
      changedPaths.push(path);
    }
  }
  const actual = walk(workspace);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) {
    fail("workspace-changed-after-backup");
  }
  return changedPaths;
}

type LegacyValues = {
  apiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  provider?: Provider;
};

function legacyValues(workspace: string): LegacyValues {
  const configPath = join(workspace, "config.json");
  absoluteExisting(configPath, "file");
  const config = readJson(configPath);
  const google =
    config.google && typeof config.google === "object" && !Array.isArray(config.google)
      ? (config.google as Record<string, unknown>)
      : {};
  const clientId =
    typeof google.clientId === "string" && google.clientId.length > 0 ? google.clientId : undefined;
  const clientSecret =
    typeof google.clientSecret === "string" && google.clientSecret.length > 0
      ? google.clientSecret
      : undefined;
  if ((clientId && !clientSecret) || (!clientId && clientSecret))
    fail("legacy-google-client-incomplete");
  const provider = config.provider;
  if (
    provider !== "openrouter" &&
    provider !== "openai" &&
    provider !== "anthropic" &&
    provider !== "gemini"
  ) {
    if (typeof config.apiKey === "string" && config.apiKey.length > 0)
      fail("legacy-provider-unsupported");
    return {
      ...(clientId ? { googleClientId: clientId } : {}),
      ...(clientSecret ? { googleClientSecret: clientSecret } : {}),
    };
  }
  const apiKey =
    typeof config.apiKey === "string" && config.apiKey.length > 0 ? config.apiKey : undefined;
  return {
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(clientId ? { googleClientId: clientId } : {}),
    ...(clientSecret ? { googleClientSecret: clientSecret } : {}),
  };
}
function hasLegacyFields(config: Record<string, unknown>): boolean {
  const google =
    config.google && typeof config.google === "object" && !Array.isArray(config.google)
      ? (config.google as Record<string, unknown>)
      : {};
  return (
    Object.hasOwn(config, "apiKey") ||
    Object.hasOwn(google, "clientId") ||
    Object.hasOwn(google, "clientSecret")
  );
}

function decodeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function envLine(name: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
}

function mergeEnv(
  original: string | null,
  values: Record<string, string>,
): { text: string; changed: boolean } {
  let text = original ?? "";
  let changed = original === null;
  for (const [name, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) fail("credential-value-invalid");
    const matcher = envLine(name);
    const lines = text.split(/(?<=\n)/);
    let found = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const content = line.endsWith("\n") ? line.slice(0, -1) : line;
      if (!matcher.test(content)) continue;
      found = true;
      const separator = content.indexOf("=");
      const current = decodeEnvValue(content.slice(separator + 1));
      if (current !== value) fail("destination-credential-conflict");
      break;
    }
    if (!found) {
      text += `${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}${name}=${value}\n`;
      changed = true;
    }
  }
  return { text, changed };
}
function readEnvValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const content = line.trim();
    if (!content || content.startsWith("#")) continue;
    const withoutExport = content.startsWith("export ") ? content.slice(7).trim() : content;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    values.set(
      withoutExport.slice(0, separator).trim(),
      decodeEnvValue(withoutExport.slice(separator + 1)),
    );
  }
  return values;
}

function atomicWrite(path: string, text: string, mode: number): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, text, { encoding: "utf8" });
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporary)) chmodSync(temporary, 0o600);
    } catch {
      // Preserve the original refusal; cleanup is best effort.
    }
    fail("atomic-write-failed");
  }
}

function cleanWorkspaceConfig(original: Record<string, unknown>): string {
  const next = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
  delete next.apiKey;
  if (next.google && typeof next.google === "object" && !Array.isArray(next.google)) {
    const google = next.google as Record<string, unknown>;
    delete google.clientId;
    delete google.clientSecret;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

function installationTransfers(values: LegacyValues): Record<string, string> {
  const transfers: Record<string, string> = {};
  if (values.googleClientId && values.googleClientSecret) {
    transfers.GOOGLE_CLIENT_ID = values.googleClientId;
    transfers.GOOGLE_CLIENT_SECRET = values.googleClientSecret;
  }
  if (values.apiKey && values.provider) transfers[PROVIDER_ENV[values.provider]] = values.apiKey;
  return transfers;
}

function assertProcessEnvCompatible(transfers: Record<string, string>): void {
  for (const [name, value] of Object.entries(transfers)) {
    const installed = process.env[name];
    if (installed !== undefined && installed !== value) fail("destination-credential-conflict");
  }
}

function applyMigration(
  workspace: string,
  envPath: string,
  values: LegacyValues,
): { transferred: number; changed: boolean } {
  const transfers = installationTransfers(values);
  assertProcessEnvCompatible(transfers);
  const originalEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  const merged = mergeEnv(originalEnv, transfers);
  const transferCount = Object.keys(transfers).length;
  const envExists = existsSync(envPath);
  const envMode = envExists ? statSync(envPath).mode & 0o777 : 0o600;
  const needsEnvWrite =
    (transferCount > 0 && (merged.changed || !envExists)) || (envExists && envMode !== 0o600);
  if (needsEnvWrite) atomicWrite(envPath, merged.text, 0o600);
  if (transferCount > 0) {
    const verified = readEnvValues(readFileSync(envPath, "utf8"));
    for (const [name, value] of Object.entries(transfers)) {
      if (verified.get(name) !== value) fail("destination-verification-failed");
    }
  }
  if (envExists && (statSync(envPath).mode & 0o777) !== 0o600) {
    fail("destination-permissions-invalid");
  }

  const configPath = join(workspace, "config.json");
  const before = readFileSync(configPath, "utf8");
  const parsed = readJson(configPath);
  if (hasLegacyFields(parsed)) {
    const next = cleanWorkspaceConfig(parsed);
    if (next !== before) atomicWrite(configPath, next, statSync(configPath).mode & 0o777);
    const after = readJson(configPath);
    if (Object.hasOwn(after, "apiKey")) fail("source-removal-failed");
    if (
      after.google &&
      typeof after.google === "object" &&
      (Object.hasOwn(after.google, "clientId") || Object.hasOwn(after.google, "clientSecret"))
    ) {
      fail("source-removal-failed");
    }
  }
  return {
    transferred: Object.keys(transfers).length,
    changed: needsEnvWrite || before !== readFileSync(configPath, "utf8"),
  };
}

function parseArgs(argv: string[]): {
  operation: Operation;
  workspace: string;
  env: string;
  backup: string;
} {
  const operation = argv[0];
  if (operation !== "check" && operation !== "apply") fail("operation-invalid");
  const selectedOperation: Operation = operation;
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--") ||
      options.has(flag)
    ) {
      fail("arguments-invalid");
    }
    options.set(flag, value);
  }
  if (
    options.size !== 3 ||
    !options.has("--workspace") ||
    !options.has("--env") ||
    !options.has("--backup-result")
  ) {
    fail("arguments-invalid");
  }
  const workspaceArg = options.get("--workspace");
  const envArg = options.get("--env");
  const backupArg = options.get("--backup-result");
  if (workspaceArg === undefined || envArg === undefined || backupArg === undefined) {
    fail("arguments-invalid");
  }
  return {
    operation: selectedOperation,
    workspace: absoluteExisting(workspaceArg, "directory"),
    env: absoluteEnvPath(envArg),
    backup: absoluteExisting(backupArg, "file"),
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (pathInside(args.workspace, args.env)) fail("env-path-outside-workspace-required");
  if (pathInside(dirname(args.backup), args.env)) fail("env-path-outside-backup-required");
  const changedPaths = verifyBackup(args.workspace, args.backup);
  const values = legacyValues(args.workspace);
  if (
    changedPaths.length > 0 &&
    (changedPaths.some((path) => path !== "config.json") ||
      hasLegacyFields(readJson(join(args.workspace, "config.json"))))
  ) {
    fail("workspace-changed-after-backup");
  }
  if (args.operation === "check") {
    const transfers = installationTransfers(values);
    assertProcessEnvCompatible(transfers);
    mergeEnv(existsSync(args.env) ? readFileSync(args.env, "utf8") : null, transfers);
    process.stdout.write(
      `${JSON.stringify({ operation: "check", ready: true, transfers: Object.keys(transfers).length })}\n`,
    );
  } else {
    assertWorkspaceStopped(args.workspace);
    const result = applyMigration(args.workspace, args.env, values);
    process.stdout.write(`${JSON.stringify({ operation: "apply", ok: true, ...result })}\n`);
  }
} catch (error) {
  const code = error instanceof Refusal ? error.code : "migration-failed";
  process.stderr.write(`Installation credential migration refused: ${code}\n`);
  process.exitCode = 1;
}
