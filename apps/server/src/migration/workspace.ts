import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The destructive boundary of the consolidation cutover, as a read-only inventory
 * — issue://119, ADR-0043.
 *
 * The preview classifies every local persistence category the Workspace can hold
 * and reports nothing but category names and counts, so a person can see what a
 * reset would take and what it would keep without any stored value being shown.
 * Nothing here deletes, writes, or calls a provider; the reset itself is issue://144.
 *
 * `config.json` and `relay.json` each hold authentication material and product
 * state in one file. They are parsed key by key against an explicit table rather
 * than preserved wholesale, and a key the table does not name fails the whole
 * preview closed: an unclassifiable key is exactly the ambiguity the reset must
 * never guess its way through.
 */

/** Where one piece of local persistence sits relative to the destructive boundary. */
export type WorkspaceMigrationClassification =
  "authentication" | "disposable-product-state" | "remote-reference" | "unsafe-mixed-state";

/**
 * One inventoried category. `count` is the number of records it holds: files for
 * a directory- or file-backed category, stored values for a configuration one.
 */
export interface WorkspaceMigrationCategory {
  name: string;
  classification: Exclude<WorkspaceMigrationClassification, "unsafe-mixed-state">;
  count: number;
}

/** Why the boundary could not be drawn. Names structure — a file, a key — never a stored value. */
export interface UnsafeMixedStateFinding {
  /** A recognized Workspace entry, or the unrecognized entry's own name. */
  entry: string;
  /** A dotted key path inside a recognized mixed file, or null. */
  key: string | null;
  /** `unreadable`: not valid JSON, or not a JSON object. */
  reason: "unreadable" | "unrecognized-key" | "unrecognized-entry";
}

export type WorkspaceMigrationPreview =
  | { outcome: "inventory"; categories: WorkspaceMigrationCategory[] }
  | { outcome: "unsafe-mixed-state"; findings: UnsafeMixedStateFinding[] };

type CategoryName =
  | "provider-api-keys"
  | "oauth-client-registrations"
  | "provider-tokens"
  | "connection-credentials"
  | "connection-verification-state"
  | "runs-and-artifacts"
  | "person-profiles"
  | "content-state"
  | "research-state"
  | "module-state-and-checkpoints"
  | "intake-schedules"
  | "calendar-schedule-and-checkpoints"
  | "watch-channel-registrations"
  | "non-auth-workflow-configuration"
  | "mock-provider-state"
  | "remote-record-references";

/**
 * Every category the preview reports, in the order it reports them. A category
 * with nothing in it is still reported, at zero, so the boundary reads the same
 * for an empty Workspace as for a full one.
 */
const CATEGORIES: ReadonlyArray<
  readonly [CategoryName, Exclude<WorkspaceMigrationClassification, "unsafe-mixed-state">]
> = [
  ["provider-api-keys", "authentication"],
  ["oauth-client-registrations", "authentication"],
  ["provider-tokens", "authentication"],
  ["connection-credentials", "authentication"],
  ["connection-verification-state", "authentication"],
  ["runs-and-artifacts", "disposable-product-state"],
  ["person-profiles", "disposable-product-state"],
  ["content-state", "disposable-product-state"],
  ["research-state", "disposable-product-state"],
  ["module-state-and-checkpoints", "disposable-product-state"],
  ["intake-schedules", "disposable-product-state"],
  ["calendar-schedule-and-checkpoints", "disposable-product-state"],
  ["watch-channel-registrations", "disposable-product-state"],
  ["non-auth-workflow-configuration", "disposable-product-state"],
  ["mock-provider-state", "disposable-product-state"],
  ["remote-record-references", "remote-reference"],
];

/** Directories whose every file belongs to one category. */
const DIRECTORIES: Record<string, CategoryName> = {
  runs: "runs-and-artifacts",
  "person-profiles": "person-profiles",
  "content-scout": "content-state",
  "content-research": "research-state",
};

/** Files that hold no authentication material, so the whole file is one record. */
const WHOLE_FILES: Record<string, CategoryName> = {
  // Drive Intake's ingested transcript ids, YouTube Trends' last run day, Idea Engine's ingested ids.
  "state.json": "module-state-and-checkpoints",
  "intake-schedules.json": "intake-schedules",
  // The Calendar watch channel and sync checkpoint are re-established after a reset, never preserved.
  "meeting-brief-calendar.json": "calendar-schedule-and-checkpoints",
  "mock-result.json": "mock-provider-state",
};

/** `config.json`, key by key. Mirrors `ConfigSchema`; an addition there must land here too. */
const CONFIG_KEYS: Record<string, CategoryName> = {
  provider: "non-auth-workflow-configuration",
  model: "non-auth-workflow-configuration",
  apiKey: "provider-api-keys",
  // Names a Google Tasks list the reset must leave standing.
  tasklistName: "remote-record-references",
  "google.clientId": "oauth-client-registrations",
  "google.clientSecret": "oauth-client-registrations",
  "google.refreshToken": "provider-tokens",
  "google.lastConnectedAt": "connection-verification-state",
  "google.hasExpiredBefore": "connection-verification-state",
  "notion.token": "provider-tokens",
  "notion.lastVerifiedAt": "connection-verification-state",
  "drive.enabled": "non-auth-workflow-configuration",
  "drive.folderId": "remote-record-references",
  "drive.folderName": "remote-record-references",
  "drive.pollIntervalMinutes": "non-auth-workflow-configuration",
  "ollama.baseUrl": "non-auth-workflow-configuration",
  "modules.youtube-trends.channels": "remote-record-references",
  "modules.youtube-trends.spreadsheetId": "remote-record-references",
  "modules.youtube-trends.spreadsheetUrl": "remote-record-references",
  "modules.idea-engine.spreadsheetId": "remote-record-references",
  "modules.idea-engine.spreadsheetUrl": "remote-record-references",
  "modules.idea-engine.prompts": "non-auth-workflow-configuration",
  "modules.content-scout.timeZone": "non-auth-workflow-configuration",
  "modules.content-scout.dailyTime": "non-auth-workflow-configuration",
  "modules.content-scout.weeklyDiscoveryDay": "non-auth-workflow-configuration",
  "modules.content-scout.weeklyDiscoveryTime": "non-auth-workflow-configuration",
  "modules.content-scout.shortlistSize": "non-auth-workflow-configuration",
  "modules.content-scout.canaryIntervalHours": "non-auth-workflow-configuration",
  "modules.content-scout.canaryDisabledAdapters": "non-auth-workflow-configuration",
  "modules.content-scout.notion.databaseId": "remote-record-references",
  "modules.content-scout.notion.dataSourceId": "remote-record-references",
  "modules.content-scout.notion.databaseUrl": "remote-record-references",
  "modules.content-scout.notion.mapping": "non-auth-workflow-configuration",
  "modules.content-research.timeZone": "non-auth-workflow-configuration",
  "modules.content-research.dailyTime": "non-auth-workflow-configuration",
  "modules.content-research.weeklyDiscoveryDay": "non-auth-workflow-configuration",
  "modules.content-research.weeklyDiscoveryTime": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.internalDomains": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.guestProfile.endpoint": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.guestProfile.apiKey": "provider-api-keys",
  "modules.meeting-brief-generator.guestProfile.lastVerifiedAt": "connection-verification-state",
  // Health diagnostics regenerate on the next check; they are not what keeps a connection working.
  "modules.meeting-brief-generator.guestProfile.lastCheckAt": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.guestProfile.lastCheckState": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.guestProfile.lastCheckDetail": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.hubspot.token": "provider-tokens",
  "modules.meeting-brief-generator.hubspot.lastVerifiedAt": "connection-verification-state",
};

/** `relay.json`, key by key. The installation identity and its secret authenticate the relay. */
const RELAY_KEYS: Record<string, CategoryName> = {
  installationId: "connection-credentials",
  secret: "connection-credentials",
  relayBaseUrl: "non-auth-workflow-configuration",
  channels: "watch-channel-registrations",
  lastWakeUpAt: "module-state-and-checkpoints",
};

const MIXED_FILES: Record<string, Record<string, CategoryName>> = {
  "config.json": CONFIG_KEYS,
  "relay.json": RELAY_KEYS,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How many stored records one value holds. An unset credential holds none. */
function recordCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length > 0 ? 1 : 0;
  return 1;
}

function countFiles(directory: string): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1;
  }
  return count;
}

export function previewWorkspaceMigration(workspaceDir: string): WorkspaceMigrationPreview {
  const counts = new Map<CategoryName, number>();
  const findings: UnsafeMixedStateFinding[] = [];
  const add = (name: CategoryName, count: number): void => {
    counts.set(name, (counts.get(name) ?? 0) + count);
  };

  const entries = existsSync(workspaceDir)
    ? readdirSync(workspaceDir, { withFileTypes: true })
    : [];
  for (const entry of entries) {
    const directory = entry.isDirectory() ? DIRECTORIES[entry.name] : undefined;
    if (directory) {
      add(directory, countFiles(join(workspaceDir, entry.name)));
      continue;
    }
    const wholeFile = entry.isFile() ? WHOLE_FILES[entry.name] : undefined;
    if (wholeFile) {
      add(wholeFile, 1);
      continue;
    }
    const table = entry.isFile() ? MIXED_FILES[entry.name] : undefined;
    if (table) {
      classifyMixedFile(join(workspaceDir, entry.name), entry.name, table, add, findings);
      continue;
    }
    findings.push({ entry: entry.name, key: null, reason: "unrecognized-entry" });
  }

  if (findings.length > 0) return { outcome: "unsafe-mixed-state", findings };
  return {
    outcome: "inventory",
    categories: CATEGORIES.map(([name, classification]) => ({
      name,
      classification,
      count: counts.get(name) ?? 0,
    })),
  };
}

function classifyMixedFile(
  path: string,
  entry: string,
  table: Record<string, CategoryName>,
  add: (name: CategoryName, count: number) => void,
  findings: UnsafeMixedStateFinding[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    findings.push({ entry, key: null, reason: "unreadable" });
    return;
  }
  if (!isPlainObject(parsed)) {
    findings.push({ entry, key: null, reason: "unreadable" });
    return;
  }
  const walk = (node: unknown, key: string): void => {
    const category = table[key];
    if (category) {
      add(category, recordCount(node));
      return;
    }
    if (isPlainObject(node)) {
      for (const [child, value] of Object.entries(node))
        walk(value, key ? `${key}.${child}` : child);
      return;
    }
    findings.push({ entry, key, reason: "unrecognized-key" });
  };
  walk(parsed, "");
}
