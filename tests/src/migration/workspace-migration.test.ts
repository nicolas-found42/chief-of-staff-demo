import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config";
import { previewWorkspaceMigration } from "../../../apps/server/src/migration/workspace";

describe("Workspace migration preview", () => {
  it("reports every recognized category with zero counts for an empty Workspace", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-migration-empty-"));

    expect(previewWorkspaceMigration(workspaceDir)).toEqual({
      status: "ready",
      categories: [
        {
          id: "provider-api-keys",
          classification: "authentication",
          disposition: "preserve",
          count: 0,
        },
        {
          id: "oauth-client-registrations",
          classification: "authentication",
          disposition: "preserve",
          count: 0,
        },
        {
          id: "provider-tokens",
          classification: "authentication",
          disposition: "preserve",
          count: 0,
        },
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
      ],
    });
  });

  it("inventories a complete Workspace without exposing its stored content", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-migration-complete-"));
    const writeJson = (path: string, value: unknown) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    };
    const writeText = (path: string, value: string) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, value, "utf8");
    };
    writeJson(join(workspaceDir, "config.json"), {
      provider: "openai",
      model: "gpt-test",
      apiKey: "llm-secret-value",
      tasklistName: "Private tasks",
      google: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        refreshToken: "google-refresh-token",
        lastConnectedAt: "2026-08-31T12:00:00.000Z",
        hasExpiredBefore: false,
      },
      notion: { token: "notion-token", lastVerifiedAt: "2026-08-31T12:00:00.000Z" },
      drive: {
        enabled: true,
        folderId: "drive-folder-id",
        folderName: "Private transcripts",
        pollIntervalMinutes: 2,
      },
      ollama: { baseUrl: "http://model.internal:11434" },
      modules: {
        "youtube-trends": {
          channels: [
            {
              id: "youtube-channel-id",
              handle: "@private",
              title: "Private channel",
              uploadsPlaylistId: "youtube-playlist-id",
              addedAt: "2026-08-31T12:00:00.000Z",
            },
          ],
          spreadsheetId: "youtube-sheet-id",
          spreadsheetUrl: "https://docs.google.test/youtube-sheet-id",
        },
        "idea-engine": {
          spreadsheetId: "ideas-sheet-id",
          spreadsheetUrl: "https://docs.google.test/ideas-sheet-id",
          prompts: { article: "private prompt" },
        },
        "content-scout": {
          timeZone: "America/New_York",
          dailyTime: "08:00",
          weeklyDiscoveryDay: 1,
          weeklyDiscoveryTime: "09:00",
          shortlistSize: 5,
          canaryIntervalHours: 12,
          canaryDisabledAdapters: [],
          notion: {
            databaseId: "notion-database-id",
            dataSourceId: "notion-data-source-id",
            databaseUrl: "https://notion.test/private",
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
          timeZone: "America/New_York",
          dailyTime: "08:00",
          weeklyDiscoveryDay: 1,
          weeklyDiscoveryTime: "09:00",
        },
        "meeting-brief-generator": {
          internalDomains: ["private.test"],
          guestProfile: {
            endpoint: "https://profiles.test",
            apiKey: "profile-api-key",
            lastVerifiedAt: "2026-08-31T12:00:00.000Z",
            lastCheckAt: "2026-08-31T12:00:00.000Z",
            lastCheckState: "connected",
            lastCheckDetail: "private diagnostic",
          },
          hubspot: { token: "hubspot-token", lastVerifiedAt: "2026-08-31T12:00:00.000Z" },
        },
      },
    });
    writeJson(join(workspaceDir, "relay.json"), {
      installationId: "relay-installation-id",
      secret: "relay-installation-secret",
      relayBaseUrl: "https://relay.test",
      channels: [
        {
          channelId: "calendar-channel-id",
          token: "calendar-channel-token",
          resourceId: "calendar-resource-id",
          expiration: "2026-09-01T12:00:00.000Z",
        },
      ],
      lastWakeUpAt: "2026-08-31T12:00:00.000Z",
    });
    writeJson(join(workspaceDir, "meeting-brief-calendar.json"), {
      channel: {
        channelId: "google-calendar-channel-id",
        token: "google-calendar-channel-token",
        resourceId: "google-calendar-resource-id",
        expiration: "2026-09-01T12:00:00.000Z",
        calendarId: "primary",
      },
      syncToken: "calendar-sync-token",
      lastSyncAt: "2026-08-31T12:00:00.000Z",
      cancellations: [],
    });
    writeJson(join(workspaceDir, "state.json"), { drive: { ingestedIds: ["drive-file-id"] } });
    writeJson(join(workspaceDir, "intake-schedules.json"), [{ module: "meeting", key: "private" }]);
    writeJson(join(workspaceDir, "mock-result.json"), { private: "model result" });
    writeJson(join(workspaceDir, "runs", "run_20260831-120000_12345678", "meta.json"), {
      id: "run_20260831-120000_12345678",
    });
    writeText(
      join(workspaceDir, "runs", "run_20260831-120000_12345678", "events.jsonl"),
      "private event\n",
    );
    writeText(
      join(workspaceDir, "runs", "run_20260831-120000_12345678", "artifact.md"),
      "private artifact\n",
    );
    writeJson(join(workspaceDir, "person-profiles", "person-1", "current.json"), {
      name: "Private person",
    });
    writeJson(join(workspaceDir, "person-profiles", "person-1", "revisions", "1.json"), {
      name: "Private person",
    });
    writeJson(join(workspaceDir, "content-scout", "state.json"), { private: "content state" });
    writeText(join(workspaceDir, "content-scout", "brand-profiles", "brand.md"), "private brand");
    writeJson(join(workspaceDir, "content-research", "people.json"), {
      private: "research state",
    });
    writeJson(join(workspaceDir, "content-research", "items", "source.json"), {
      private: "source item",
    });

    const preview = previewWorkspaceMigration(workspaceDir);

    expect(preview).toEqual({
      status: "ready",
      categories: [
        {
          id: "provider-api-keys",
          classification: "authentication",
          disposition: "preserve",
          count: 2,
        },
        {
          id: "oauth-client-registrations",
          classification: "authentication",
          disposition: "preserve",
          count: 1,
        },
        {
          id: "provider-tokens",
          classification: "authentication",
          disposition: "preserve",
          count: 3,
        },
        {
          id: "connection-credentials",
          classification: "authentication",
          disposition: "preserve",
          count: 3,
        },
        {
          id: "runs-and-artifacts",
          classification: "disposable_product_state",
          disposition: "delete",
          count: 3,
        },
        {
          id: "person-profiles",
          classification: "disposable_product_state",
          disposition: "delete",
          count: 2,
        },
        {
          id: "content-state",
          classification: "disposable_product_state",
          disposition: "delete",
          count: 2,
        },
        {
          id: "research-state",
          classification: "disposable_product_state",
          disposition: "delete",
          count: 2,
        },
        {
          id: "workflow-state-and-checkpoints",
          classification: "disposable_product_state",
          disposition: "delete",
          count: 1,
        },
        {
          id: "schedules",
          classification: "disposable_product_state",
          disposition: "delete",
          count: 3,
        },
        {
          id: "non-auth-workflow-configuration",
          classification: "disposable_product_state",
          disposition: "delete",
          count: 2,
        },
        {
          id: "mock-provider-state",
          classification: "disposable_product_state",
          disposition: "delete",
          count: 1,
        },
        {
          id: "remote-provider-references",
          classification: "remote_reference",
          disposition: "delete",
          count: 8,
        },
      ],
    });
    const serialized = JSON.stringify(preview);
    for (const storedValue of [
      "llm-secret-value",
      "google-client-id",
      "google-refresh-token",
      "Private transcripts",
      "drive-folder-id",
      "notion-token",
      "hubspot-token",
      "relay-installation-id",
      "calendar-channel-id",
      "google-calendar-resource-id",
      "private artifact",
      "Private person",
    ]) {
      expect(serialized).not.toContain(storedValue);
    }
  });

  it("deliberately separates authentication, product configuration, and remote references in mixed files", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-migration-mixed-"));
    const configPath = join(workspaceDir, "config.json");
    const relayPath = join(workspaceDir, "relay.json");
    const config = new ConfigStore(configPath);
    config.load();
    config.update({
      google: { clientId: "client-id", clientSecret: "client-secret" },
      drive: { enabled: true, folderId: "folder-id", folderName: "Transcripts" },
    });
    config.setGoogleRefreshToken("refresh-token");
    writeFileSync(
      relayPath,
      `${JSON.stringify(
        {
          installationId: "installation-id",
          secret: "installation-secret",
          relayBaseUrl: null,
          channels: [],
          lastWakeUpAt: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const before = {
      config: readFileSync(configPath, "utf8"),
      relay: readFileSync(relayPath, "utf8"),
    };
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = () => {
      providerCalls += 1;
      throw new Error("migration preview must not call a provider");
    };

    try {
      const preview = previewWorkspaceMigration(workspaceDir);
      const byId = new Map(preview.categories.map((category) => [category.id, category]));

      expect(preview.status).toBe("ready");
      expect(byId.get("oauth-client-registrations")?.count).toBe(1);
      expect(byId.get("provider-tokens")?.count).toBe(1);
      expect(byId.get("connection-credentials")?.count).toBe(1);
      expect(byId.get("non-auth-workflow-configuration")?.count).toBe(1);
      expect(byId.get("remote-provider-references")?.count).toBe(1);
      expect(providerCalls).toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(before.config);
      expect(readFileSync(relayPath, "utf8")).toBe(before.relay);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a typed fail-closed result for malformed mixed state without mutating the Workspace", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-migration-malformed-"));
    const configPath = join(workspaceDir, "config.json");
    const malformed = '{"google":{"refreshToken":"credential-that-must-not-leak"';
    writeFileSync(configPath, malformed, "utf8");
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = () => {
      providerCalls += 1;
      throw new Error("migration preview must not call a provider");
    };

    try {
      const preview = previewWorkspaceMigration(workspaceDir);

      expect(preview).toMatchObject({
        status: "blocked",
        failure: { code: "unsafe_mixed_state" },
        categories: expect.arrayContaining([
          {
            id: "unsafe-mixed-state",
            classification: "unsafe_mixed_state",
            disposition: "block",
            count: 1,
          },
        ]),
      });
      expect(JSON.stringify(preview)).not.toContain("credential-that-must-not-leak");
      expect(readFileSync(configPath, "utf8")).toBe(malformed);
      expect(providerCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when the Workspace contains unrecognized persistence categories", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-migration-unknown-"));
    writeFileSync(join(workspaceDir, "mystery.json"), '{"private":"value"}\n', "utf8");
    mkdirSync(join(workspaceDir, "future-state"));
    writeFileSync(join(workspaceDir, "future-state", "record.json"), "{}\n", "utf8");

    const preview = previewWorkspaceMigration(workspaceDir);

    expect(preview).toMatchObject({
      status: "blocked",
      failure: { code: "unsafe_mixed_state" },
      categories: expect.arrayContaining([
        {
          id: "unsafe-mixed-state",
          classification: "unsafe_mixed_state",
          disposition: "block",
          count: 2,
        },
      ]),
    });
    expect(JSON.stringify(preview)).not.toContain("mystery.json");
    expect(JSON.stringify(preview)).not.toContain("future-state");
  });

  it("classifies provider channel identifiers and verification secrets as authentication", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-migration-connections-"));
    writeFileSync(
      join(workspaceDir, "relay.json"),
      `${JSON.stringify({
        installationId: null,
        secret: null,
        relayBaseUrl: null,
        channels: [
          {
            channelId: "relay-channel-id",
            token: "relay-channel-secret",
            resourceId: "relay-resource-id",
            expiration: null,
          },
        ],
        lastWakeUpAt: null,
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "meeting-brief-calendar.json"),
      `${JSON.stringify({
        channel: {
          channelId: "calendar-channel-id",
          token: "calendar-channel-secret",
          resourceId: "calendar-resource-id",
          expiration: null,
          calendarId: "primary",
        },
        syncToken: null,
        lastSyncAt: null,
        cancellations: [],
      })}\n`,
      "utf8",
    );

    const preview = previewWorkspaceMigration(workspaceDir);
    const byId = new Map(preview.categories.map((category) => [category.id, category]));

    expect(preview.status).toBe("ready");
    expect(byId.get("connection-credentials")?.count).toBe(2);
    expect(byId.get("schedules")?.count).toBe(2);
    expect(JSON.stringify(preview)).not.toContain("relay-channel-secret");
    expect(JSON.stringify(preview)).not.toContain("calendar-channel-secret");
  });
});
