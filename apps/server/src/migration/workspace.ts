import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "@chief-of-staff-demo/shared";
import { z } from "zod";

type WorkspaceMigrationClassification =
  "authentication" | "disposable_product_state" | "remote_reference" | "unsafe_mixed_state";

type WorkspaceMigrationDisposition = "preserve" | "delete" | "block";

interface WorkspaceMigrationCategory {
  id: string;
  classification: WorkspaceMigrationClassification;
  disposition: WorkspaceMigrationDisposition;
  count: number;
}

export type WorkspaceMigrationPreview =
  | { status: "ready"; categories: WorkspaceMigrationCategory[] }
  | {
      status: "blocked";
      failure: { code: "unsafe_mixed_state" };
      categories: WorkspaceMigrationCategory[];
    };

const EMPTY_CATEGORIES: WorkspaceMigrationCategory[] = [
  { id: "provider-api-keys", classification: "authentication", disposition: "preserve", count: 0 },
  {
    id: "oauth-client-registrations",
    classification: "authentication",
    disposition: "preserve",
    count: 0,
  },
  { id: "provider-tokens", classification: "authentication", disposition: "preserve", count: 0 },
  {
    id: "connection-credentials",
    classification: "authentication",
    disposition: "preserve",
    count: 0,
  },
  {
    id: "runs-and-artifacts",
    classification: "disposable_product_state",
    disposition: "delete",
    count: 0,
  },
  {
    id: "person-profiles",
    classification: "disposable_product_state",
    disposition: "delete",
    count: 0,
  },
  {
    id: "content-state",
    classification: "disposable_product_state",
    disposition: "delete",
    count: 0,
  },
  {
    id: "research-state",
    classification: "disposable_product_state",
    disposition: "delete",
    count: 0,
  },
  {
    id: "workflow-state-and-checkpoints",
    classification: "disposable_product_state",
    disposition: "delete",
    count: 0,
  },
  {
    id: "schedules",
    classification: "disposable_product_state",
    disposition: "delete",
    count: 0,
  },
  {
    id: "non-auth-workflow-configuration",
    classification: "disposable_product_state",
    disposition: "delete",
    count: 0,
  },
  {
    id: "mock-provider-state",
    classification: "disposable_product_state",
    disposition: "delete",
    count: 0,
  },
  {
    id: "remote-provider-references",
    classification: "remote_reference",
    disposition: "delete",
    count: 0,
  },
];

const RelayWorkspaceSchema = z.strictObject({
  installationId: z.string().nullable(),
  secret: z.string().nullable(),
  relayBaseUrl: z.string().nullable(),
  channels: z.array(
    z.strictObject({
      channelId: z.string(),
      token: z.string(),
      resourceId: z.string().nullable(),
      expiration: z.string().nullable(),
    }),
  ),
  lastWakeUpAt: z.string().nullable(),
});

const MeetingBriefCalendarSchema = z.strictObject({
  channel: z
    .strictObject({
      channelId: z.string(),
      token: z.string(),
      resourceId: z.string().nullable(),
      expiration: z.string().nullable(),
      calendarId: z.string(),
    })
    .nullable(),
  syncToken: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  cancellations: z.array(z.unknown()),
});

function countFiles(path: string): number {
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isFile()) count += 1;
    if (entry.isDirectory()) count += countFiles(join(path, entry.name));
  }
  return count;
}

function countPresent(values: Array<string | null | undefined>): number {
  return values.filter((value) => typeof value === "string" && value.length > 0).length;
}

function setCount(categories: WorkspaceMigrationCategory[], id: string, count: number): void {
  const category = categories.find((candidate) => candidate.id === id);
  if (category) category.count = count;
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

function blocked(
  categories: WorkspaceMigrationCategory[],
  unsafeCount = 1,
): WorkspaceMigrationPreview {
  categories.push({
    id: "unsafe-mixed-state",
    classification: "unsafe_mixed_state",
    disposition: "block",
    count: unsafeCount,
  });
  return { status: "blocked", failure: { code: "unsafe_mixed_state" }, categories };
}

export function previewWorkspaceMigration(workspaceDir: string): WorkspaceMigrationPreview {
  const categories = structuredClone(EMPTY_CATEGORIES);
  const expectedRootEntries = new Map<string, "file" | "directory">([
    ["config.json", "file"],
    ["relay.json", "file"],
    ["meeting-brief-calendar.json", "file"],
    ["state.json", "file"],
    ["intake-schedules.json", "file"],
    ["mock-result.json", "file"],
    ["runs", "directory"],
    ["person-profiles", "directory"],
    ["content-scout", "directory"],
    ["content-research", "directory"],
  ]);
  const unsafeRootEntries = existsSync(workspaceDir)
    ? readdirSync(workspaceDir, { withFileTypes: true }).filter((entry) => {
        const expected = expectedRootEntries.get(entry.name);
        if (!expected) return true;
        return expected === "file" ? !entry.isFile() : !entry.isDirectory();
      }).length
    : 0;
  if (unsafeRootEntries > 0) return blocked(categories, unsafeRootEntries);

  setCount(categories, "runs-and-artifacts", countFiles(join(workspaceDir, "runs")));
  setCount(categories, "person-profiles", countFiles(join(workspaceDir, "person-profiles")));
  setCount(categories, "content-state", countFiles(join(workspaceDir, "content-scout")));
  setCount(categories, "research-state", countFiles(join(workspaceDir, "content-research")));
  setCount(
    categories,
    "workflow-state-and-checkpoints",
    existsSync(join(workspaceDir, "state.json")) ? 1 : 0,
  );
  setCount(
    categories,
    "mock-provider-state",
    existsSync(join(workspaceDir, "mock-result.json")) ? 1 : 0,
  );

  const configPath = join(workspaceDir, "config.json");
  if (existsSync(configPath)) {
    const json = readJson(configPath);
    if (!json.ok) return blocked(categories);
    const parsed = ConfigSchema.safeParse(json.value);
    if (!parsed.success) return blocked(categories);
    const config = parsed.data;
    setCount(
      categories,
      "provider-api-keys",
      countPresent([config.apiKey, config.modules["meeting-brief-generator"].guestProfile.apiKey]),
    );
    setCount(
      categories,
      "oauth-client-registrations",
      config.google.clientId || config.google.clientSecret ? 1 : 0,
    );
    setCount(
      categories,
      "provider-tokens",
      countPresent([
        config.google.refreshToken,
        config.notion.token,
        config.modules["meeting-brief-generator"].hubspot.token,
      ]),
    );
    setCount(categories, "non-auth-workflow-configuration", 1);
    setCount(
      categories,
      "remote-provider-references",
      countPresent([
        config.drive.folderId,
        config.modules["youtube-trends"].spreadsheetId,
        config.modules["idea-engine"].spreadsheetId,
        config.modules["meeting-brief-generator"].guestProfile.endpoint,
      ]) +
        config.modules["youtube-trends"].channels.length +
        (config.modules["content-scout"].notion.databaseId ||
        config.modules["content-scout"].notion.dataSourceId
          ? 1
          : 0),
    );
  }

  let schedules = existsSync(join(workspaceDir, "intake-schedules.json")) ? 1 : 0;
  const relayPath = join(workspaceDir, "relay.json");
  if (existsSync(relayPath)) {
    const json = readJson(relayPath);
    if (!json.ok) return blocked(categories);
    const parsed = RelayWorkspaceSchema.safeParse(json.value);
    if (!parsed.success) return blocked(categories);
    const relay = parsed.data;
    setCount(
      categories,
      "connection-credentials",
      (relay.installationId || relay.secret ? 1 : 0) + relay.channels.length,
    );
    if (relay.relayBaseUrl || relay.channels.length > 0 || relay.lastWakeUpAt) {
      const configuration = categories.find(
        (category) => category.id === "non-auth-workflow-configuration",
      );
      if (configuration) configuration.count += 1;
    }
    schedules += relay.channels.length;
    const remoteReferences = categories.find(
      (category) => category.id === "remote-provider-references",
    );
    if (remoteReferences) {
      remoteReferences.count += relay.channels.length;
    }
  }

  const calendarPath = join(workspaceDir, "meeting-brief-calendar.json");
  if (existsSync(calendarPath)) {
    const json = readJson(calendarPath);
    if (!json.ok) return blocked(categories);
    const parsed = MeetingBriefCalendarSchema.safeParse(json.value);
    if (!parsed.success) return blocked(categories);
    schedules += 1;
    if (parsed.data.channel) {
      const connectionCredentials = categories.find(
        (category) => category.id === "connection-credentials",
      );
      if (connectionCredentials) connectionCredentials.count += 1;
      const remoteReferences = categories.find(
        (category) => category.id === "remote-provider-references",
      );
      if (remoteReferences) remoteReferences.count += 1;
    }
  }
  setCount(categories, "schedules", schedules);

  return { status: "ready", categories };
}
