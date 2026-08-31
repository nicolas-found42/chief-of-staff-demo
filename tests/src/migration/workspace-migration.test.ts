import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@chief-of-staff-demo/shared";
import {
  previewWorkspaceMigration,
  type UnsafeMixedStateFinding,
  type WorkspaceMigrationCategory,
  type WorkspaceMigrationClassification,
  type WorkspaceMigrationPreview,
} from "../../../apps/server/src/migration/workspace";

/**
 * The Workspace migration contract — issue://119, ADR-0043. Every fixture is a
 * throwaway temporary directory; the preview is never pointed at the Workspace
 * this repository runs on.
 */

const TIMESTAMP = "2026-08-31T12:00:00.000Z";

/**
 * Every credential and every stored value the fixtures hold. The preview must
 * report category names and counts and never any of these.
 */
const STORED_VALUES = [
  "llm-api-key-secret",
  "google-client-id",
  "google-client-secret",
  "google-refresh-token",
  "notion-token",
  "hubspot-token",
  "guest-profile-api-key",
  "relay-installation-secret",
  "relay-channel-token",
  "calendar-channel-token",
  "drive-folder-id",
  "Board minutes",
  "youtube-spreadsheet-id",
  "https://sheets.test/ideas",
  "notion-database-id",
  "a diagnostic detail",
  "an idea prompt",
  "found42.test",
  "a private artifact",
  "A Named Person",
];

function completeConfig() {
  /* Parsed by the real schema, so every key the app can store is in the fixture
     and the classifier has to have an answer for all of them. */
  return ConfigSchema.parse({
    provider: "openai",
    model: "gpt-test",
    apiKey: "llm-api-key-secret",
    tasklistName: "Meeting Followups",
    google: {
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      refreshToken: "google-refresh-token",
      lastConnectedAt: TIMESTAMP,
      hasExpiredBefore: false,
    },
    notion: { token: "notion-token", lastVerifiedAt: TIMESTAMP },
    drive: {
      enabled: true,
      folderId: "drive-folder-id",
      folderName: "Board minutes",
      pollIntervalMinutes: 2,
    },
    ollama: { baseUrl: "http://ollama.test:11434" },
    modules: {
      "youtube-trends": {
        channels: [
          {
            id: "UCyoutube",
            handle: "@found42",
            title: "Found42",
            uploadsPlaylistId: "UUyoutube",
            addedAt: TIMESTAMP,
          },
        ],
        spreadsheetId: "youtube-spreadsheet-id",
        spreadsheetUrl: "https://sheets.test/youtube",
      },
      "idea-engine": {
        spreadsheetId: "idea-spreadsheet-id",
        spreadsheetUrl: "https://sheets.test/ideas",
        prompts: { article: "an idea prompt" },
      },
      "content-scout": {
        timeZone: "Europe/Paris",
        dailyTime: "08:00",
        weeklyDiscoveryDay: 1,
        weeklyDiscoveryTime: "09:00",
        shortlistSize: 5,
        canaryIntervalHours: 12,
        canaryDisabledAdapters: ["reddit"],
        notion: {
          databaseId: "notion-database-id",
          dataSourceId: "notion-data-source-id",
          databaseUrl: "https://notion.test/db",
          mapping: {
            name: "Name",
            status: "Status",
            platform: "Platform",
            format: "Format",
            scheduledDate: "Scheduled date",
          },
        },
      },
      "content-research": {
        timeZone: "Europe/Paris",
        dailyTime: "08:00",
        weeklyDiscoveryDay: 1,
        weeklyDiscoveryTime: "09:00",
      },
      "meeting-brief-generator": {
        internalDomains: ["found42.test"],
        guestProfile: {
          endpoint: "https://guests.test",
          apiKey: "guest-profile-api-key",
          lastVerifiedAt: TIMESTAMP,
          lastCheckAt: TIMESTAMP,
          lastCheckState: "connected",
          lastCheckDetail: "a diagnostic detail",
        },
        hubspot: { token: "hubspot-token", lastVerifiedAt: TIMESTAMP },
      },
    },
  });
}

function workspace(label: string, files: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), `cos-migration-${label}-`));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

/** Everything a fixture Workspace holds, so a preview can be proved to change none of it. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return files;
}

function completeWorkspace(label: string): string {
  return workspace(label, {
    "config.json": completeConfig(),
    "relay.json": {
      installationId: "relay-installation-id",
      secret: "relay-installation-secret",
      relayBaseUrl: "https://relay.test",
      channels: [
        {
          channelId: "relay-channel-id",
          token: "relay-channel-token",
          resourceId: "relay-resource-id",
          expiration: TIMESTAMP,
        },
      ],
      lastWakeUpAt: TIMESTAMP,
    },
    "meeting-brief-calendar.json": {
      channel: {
        channelId: "calendar-channel-id",
        token: "calendar-channel-token",
        resourceId: "calendar-resource-id",
        expiration: TIMESTAMP,
        calendarId: "primary",
      },
      syncToken: "calendar-sync-token",
      lastSyncAt: TIMESTAMP,
      cancellations: [],
    },
    /* Drive Intake's ingested transcript ids are the Transcript workflow's state. */
    "state.json": {
      drive: { ingestedIds: ["drive-file-id"] },
      youtubeTrends: { lastRunDay: "2026-08-30" },
      ideaEngine: { ingestedIds: ["idea-row-id"] },
    },
    "intake-schedules.json": [{ key: "content-scout:daily", dueAt: TIMESTAMP }],
    "mock-result.json": { tasks: [] },
    "runs/run_20260831-120000_0a1b2c3d/meta.json": { id: "run_20260831-120000_0a1b2c3d" },
    "runs/run_20260831-120000_0a1b2c3d/events.jsonl": '{"type":"started"}\n',
    "runs/run_20260831-120000_0a1b2c3d/artifact.md": "a private artifact\n",
    "person-profiles/person_1/current.json": { name: "A Named Person", revision: 2 },
    "person-profiles/person_1/revisions/1.json": { name: "A Named Person", revision: 1 },
    "person-profiles/person_1/revisions/2.json": { name: "A Named Person", revision: 2 },
    "content-scout/state.json": { opportunities: [] },
    "content-scout/canary-state.json": { adapters: [] },
    "content-scout/brand-profiles/brand_1.md": "# Brand\n",
    "content-scout/evidence-transcripts/item_1.txt": "evidence\n",
    "content-research/people.json": { people: [] },
    "content-research/items/item_1.json": { url: "https://example.test" },
  });
}

function categories(preview: WorkspaceMigrationPreview): WorkspaceMigrationCategory[] {
  if (preview.outcome !== "inventory") {
    throw new Error(`expected an inventory, got ${JSON.stringify(preview)}`);
  }
  return preview.categories;
}

/** One category by name, without the name, so an assertion reads as the boundary it checks. */
function inventory(
  preview: WorkspaceMigrationPreview,
): Map<string, Omit<WorkspaceMigrationCategory, "name">> {
  return new Map(
    categories(preview).map((category) => [
      category.name,
      { classification: category.classification, count: category.count },
    ]),
  );
}

function named(
  preview: WorkspaceMigrationPreview,
  classification: WorkspaceMigrationClassification,
): string[] {
  return categories(preview)
    .filter((category) => category.classification === classification)
    .map((category) => category.name);
}

function findings(preview: WorkspaceMigrationPreview): UnsafeMixedStateFinding[] {
  if (preview.outcome !== "unsafe-mixed-state") {
    throw new Error(`expected a fail-closed result, got ${JSON.stringify(preview)}`);
  }
  return preview.findings;
}

/* No preview may reach a provider, so every test runs with the network refused. */
let providerCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  providerCalls = 0;
  globalThis.fetch = () => {
    providerCalls += 1;
    throw new Error("the migration preview must not call a provider");
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(providerCalls).toBe(0);
});

describe("Workspace migration preview", () => {
  it("reports every category at zero for an empty Workspace", () => {
    const preview = previewWorkspaceMigration(workspace("empty"));
    const categories = inventory(preview);

    expect([...categories.values()].every((category) => category.count === 0)).toBe(true);
    expect([...categories.keys()]).toEqual([
      "provider-api-keys",
      "oauth-client-registrations",
      "provider-tokens",
      "connection-credentials",
      "connection-verification-state",
      "runs-and-artifacts",
      "person-profiles",
      "content-state",
      "research-state",
      "module-state-and-checkpoints",
      "intake-schedules",
      "calendar-schedule-and-checkpoints",
      "watch-channel-registrations",
      "non-auth-workflow-configuration",
      "mock-provider-state",
      "remote-record-references",
    ]);
  });

  it("classifies every recognized credential category as authentication", () => {
    const categories = inventory(previewWorkspaceMigration(completeWorkspace("credentials")));

    /* The Shell's model key and the Meeting Brief guest profile key. */
    expect(categories.get("provider-api-keys")).toEqual({
      classification: "authentication",
      count: 2,
    });
    /* The Google OAuth client id and secret. */
    expect(categories.get("oauth-client-registrations")).toEqual({
      classification: "authentication",
      count: 2,
    });
    /* The Google refresh token, the Notion token, the HubSpot token. */
    expect(categories.get("provider-tokens")).toEqual({
      classification: "authentication",
      count: 3,
    });
    /* The relay installation identifier and its secret. */
    expect(categories.get("connection-credentials")).toEqual({
      classification: "authentication",
      count: 2,
    });
    /* When each connection was last verified, and whether Google has ever expired. */
    expect(categories.get("connection-verification-state")).toEqual({
      classification: "authentication",
      count: 5,
    });
  });

  it("classifies Runs, profiles, product stores, schedules and checkpoints as disposable", () => {
    const categories = inventory(previewWorkspaceMigration(completeWorkspace("disposable")));

    expect(categories.get("runs-and-artifacts")).toEqual({
      classification: "disposable-product-state",
      count: 3,
    });
    expect(categories.get("person-profiles")).toEqual({
      classification: "disposable-product-state",
      count: 3,
    });
    expect(categories.get("content-state")).toEqual({
      classification: "disposable-product-state",
      count: 4,
    });
    expect(categories.get("research-state")).toEqual({
      classification: "disposable-product-state",
      count: 2,
    });
    /* Transcript ingest checkpoints live in state.json, alongside the relay wake-up. */
    expect(categories.get("module-state-and-checkpoints")).toEqual({
      classification: "disposable-product-state",
      count: 2,
    });
    expect(categories.get("intake-schedules")).toEqual({
      classification: "disposable-product-state",
      count: 1,
    });
    expect(categories.get("calendar-schedule-and-checkpoints")).toEqual({
      classification: "disposable-product-state",
      count: 1,
    });
    expect(categories.get("watch-channel-registrations")).toEqual({
      classification: "disposable-product-state",
      count: 1,
    });
    expect(categories.get("non-auth-workflow-configuration")).toEqual({
      classification: "disposable-product-state",
      count: 28,
    });
    expect(categories.get("mock-provider-state")).toEqual({
      classification: "disposable-product-state",
      count: 1,
    });
  });

  it("names remote records without scheduling them for deletion", () => {
    const preview = previewWorkspaceMigration(completeWorkspace("remote"));
    const categories = inventory(preview);

    /* Tasklist, Drive folder, two Sheets and their URLs, one YouTube channel,
       the Notion database, data source and URL. */
    expect(categories.get("remote-record-references")).toEqual({
      classification: "remote-reference",
      count: 11,
    });
    expect(named(preview, "disposable-product-state")).not.toContain("remote-record-references");
  });

  it("reports counts without any stored value", () => {
    const preview = previewWorkspaceMigration(completeWorkspace("content-free"));

    const serialized = JSON.stringify(preview);
    for (const value of STORED_VALUES) expect(serialized).not.toContain(value);
  });

  it("changes nothing in the Workspace it previews", () => {
    const root = completeWorkspace("read-only");
    const before = snapshot(root);

    previewWorkspaceMigration(root);

    expect(snapshot(root)).toEqual(before);
  });

  it("fails closed on a configuration key it cannot place on either side", () => {
    const root = workspace("unrecognized-key", {
      "config.json": { ...completeConfig(), sendgrid: { token: "an unclassified credential" } },
    });

    const preview = previewWorkspaceMigration(root);

    expect(findings(preview)).toEqual([
      { entry: "config.json", key: "sendgrid.token", reason: "unrecognized-key" },
    ]);
    expect(JSON.stringify(preview)).not.toContain("an unclassified credential");
  });

  it("fails closed on an unrecognized Workspace entry", () => {
    const root = workspace("unrecognized-entry", { "future-store/record.json": { a: 1 } });

    expect(findings(previewWorkspaceMigration(root))).toEqual([
      { entry: "future-store", key: null, reason: "unrecognized-entry" },
    ]);
  });

  it("fails closed on a malformed Workspace", () => {
    const malformed = '{"google":{"refreshToken":"a token that must not leak"';
    const root = workspace("malformed", { "config.json": malformed, "relay.json": "[]" });

    const preview = previewWorkspaceMigration(root);

    expect([...findings(preview)].sort((a, b) => a.entry.localeCompare(b.entry))).toEqual([
      { entry: "config.json", key: null, reason: "unreadable" },
      { entry: "relay.json", key: null, reason: "unreadable" },
    ]);
    expect(JSON.stringify(preview)).not.toContain("a token that must not leak");
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(malformed);
  });
});
