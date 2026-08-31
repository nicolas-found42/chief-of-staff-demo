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
 *
 * A remote reference is not a third answer to "does the reset delete this?". A
 * spreadsheet id is non-auth workflow configuration: the local value goes with
 * everything else, and the spreadsheet it names is provider-owned and survives
 * untouched. The preview states both, because a reader who saw only the first
 * would delete a spreadsheet and a reader who saw only the second would restore
 * an old destination.
 */

/** Where one piece of local persistence sits relative to the destructive boundary. */
export type WorkspaceMigrationClassification =
  "authentication" | "disposable-product-state" | "remote-reference" | "unsafe-mixed-state";

/**
 * The only two answers to "does the reset delete this?". `remote-reference` is
 * not one of them — it describes what a local value points at, not whether that
 * value survives — and `unsafe-mixed-state` ends the preview instead of joining it.
 */
export type WorkspaceMigrationDisposition = Extract<
  WorkspaceMigrationClassification,
  "authentication" | "disposable-product-state"
>;

/**
 * One inventoried category. `count` is the number of records it holds: files for
 * a directory- or file-backed category, stored values for a configuration one.
 */
export interface WorkspaceMigrationCategory {
  name: string;
  classification: WorkspaceMigrationDisposition;
  count: number;
}

/**
 * A kind of provider-owned record that local values name — a Sheet, a Drive
 * folder, a Notion database. Disclosed so the reset cannot mistake a pointer for
 * the thing it points at: the local values are deleted, counted in
 * `localCategory` like any other non-auth configuration, and the records
 * themselves are left exactly as they are.
 */
export interface RemoteRecordDisclosure {
  name: string;
  classification: Extract<WorkspaceMigrationClassification, "remote-reference">;
  /** How many local values name a record of this kind. */
  count: number;
  /** The category those local values are deleted with. */
  localCategory: string;
  /** Always false. No reset deletes provider-owned data. */
  deletedByReset: false;
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
  | {
      outcome: "inventory";
      categories: WorkspaceMigrationCategory[];
      remoteRecords: RemoteRecordDisclosure[];
    }
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
  | "operating-system-metadata";

/** A kind of provider-owned record local values point at. */
type RemoteRecordName =
  | "google-tasklists"
  | "google-drive-folders"
  | "google-sheets-spreadsheets"
  | "youtube-channels"
  | "notion-databases";

/**
 * Every category the preview reports, in the order it reports them. A category
 * with nothing in it is still reported, at zero, so the boundary reads the same
 * for an empty Workspace as for a full one.
 */
const CATEGORIES: ReadonlyArray<readonly [CategoryName, WorkspaceMigrationDisposition]> = [
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
  ["operating-system-metadata", "disposable-product-state"],
];

/**
 * Every kind of provider-owned record the preview discloses, in the order it
 * discloses them. Like a category, one with nothing in it is still reported.
 */
const REMOTE_RECORDS: readonly RemoteRecordName[] = [
  "google-tasklists",
  "google-drive-folders",
  "google-sheets-spreadsheets",
  "youtube-channels",
  "notion-databases",
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
  /* Named rather than ignored: the Workspace of anyone who has opened it on a
     Mac holds one of these, and OS metadata is not the ambiguity the fail-closed
     path is for. Leaving it unnamed would block every real preview and invite
     the next person to loosen the rule that matters. */
  ".DS_Store": "operating-system-metadata",
  "._.DS_Store": "operating-system-metadata",
  "Thumbs.db": "operating-system-metadata",
  "desktop.ini": "operating-system-metadata",
};

/**
 * `config.json`, key by key. Mirrors `ConfigSchema`; an addition there must land
 * here too. A `CategoryName` names the category the stored value is counted in.
 * A `RemoteRecordName` says the value names a provider-owned record of that
 * kind: it is counted as non-auth workflow configuration like any other
 * destination setting, so the reset deletes it, and it is disclosed so the reset
 * knows the record it named is not its to delete.
 */
const CONFIG_KEYS: Record<string, CategoryName | RemoteRecordName> = {
  provider: "non-auth-workflow-configuration",
  model: "non-auth-workflow-configuration",
  apiKey: "provider-api-keys",
  tasklistName: "google-tasklists",
  "google.clientId": "oauth-client-registrations",
  "google.clientSecret": "oauth-client-registrations",
  "google.refreshToken": "provider-tokens",
  "google.lastConnectedAt": "connection-verification-state",
  "google.hasExpiredBefore": "connection-verification-state",
  "notion.token": "provider-tokens",
  "notion.lastVerifiedAt": "connection-verification-state",
  "drive.enabled": "non-auth-workflow-configuration",
  "drive.folderId": "google-drive-folders",
  "drive.folderName": "google-drive-folders",
  "drive.pollIntervalMinutes": "non-auth-workflow-configuration",
  "ollama.baseUrl": "non-auth-workflow-configuration",
  "modules.youtube-trends.channels": "youtube-channels",
  "modules.youtube-trends.spreadsheetId": "google-sheets-spreadsheets",
  "modules.youtube-trends.spreadsheetUrl": "google-sheets-spreadsheets",
  "modules.idea-engine.spreadsheetId": "google-sheets-spreadsheets",
  "modules.idea-engine.spreadsheetUrl": "google-sheets-spreadsheets",
  "modules.idea-engine.prompts": "non-auth-workflow-configuration",
  "modules.content-scout.timeZone": "non-auth-workflow-configuration",
  "modules.content-scout.dailyTime": "non-auth-workflow-configuration",
  "modules.content-scout.weeklyDiscoveryDay": "non-auth-workflow-configuration",
  "modules.content-scout.weeklyDiscoveryTime": "non-auth-workflow-configuration",
  "modules.content-scout.shortlistSize": "non-auth-workflow-configuration",
  "modules.content-scout.canaryIntervalHours": "non-auth-workflow-configuration",
  "modules.content-scout.canaryDisabledAdapters": "non-auth-workflow-configuration",
  "modules.content-scout.notion.databaseId": "notion-databases",
  "modules.content-scout.notion.dataSourceId": "notion-databases",
  "modules.content-scout.notion.databaseUrl": "notion-databases",
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

const MIXED_FILES: Record<string, Record<string, CategoryName | RemoteRecordName>> = {
  "config.json": CONFIG_KEYS,
  "relay.json": RELAY_KEYS,
};

function isRemoteRecord(name: CategoryName | RemoteRecordName): name is RemoteRecordName {
  return (REMOTE_RECORDS as readonly string[]).includes(name);
}

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
  const remoteCounts = new Map<RemoteRecordName, number>();
  const findings: UnsafeMixedStateFinding[] = [];
  /* A remote reference is counted twice on purpose, once on each axis: the local
     value is deleted with the non-auth workflow configuration, and the record it
     names is disclosed as one the reset leaves standing. */
  const add = (name: CategoryName | RemoteRecordName, count: number): void => {
    if (isRemoteRecord(name)) {
      remoteCounts.set(name, (remoteCounts.get(name) ?? 0) + count);
      add("non-auth-workflow-configuration", count);
      return;
    }
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
    remoteRecords: REMOTE_RECORDS.map((name) => ({
      name,
      classification: "remote-reference",
      count: remoteCounts.get(name) ?? 0,
      localCategory: "non-auth-workflow-configuration",
      deletedByReset: false,
    })),
  };
}

function classifyMixedFile(
  path: string,
  entry: string,
  table: Record<string, CategoryName | RemoteRecordName>,
  add: (name: CategoryName | RemoteRecordName, count: number) => void,
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
