import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config";

function workspaceWithConfig(label: string, config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), `config-store-${label}-`));
  writeFileSync(join(root, "config.json"), `${JSON.stringify(config)}\n`);
  return root;
}

describe("ConfigStore.load legacy tolerance", () => {
  it("loads a pre-cutover config carrying the retired content-scout Notion calendar block", () => {
    const root = workspaceWithConfig("notion-legacy", {
      provider: "anthropic",
      model: "fixture-model",
      apiKey: "fixture-key",
      modules: {
        "content-scout": {
          timeZone: "UTC",
          dailyTime: "08:00",
          weeklyDiscoveryDay: 1,
          weeklyDiscoveryTime: "09:00",
          shortlistSize: 5,
          canaryIntervalHours: 12,
          canaryDisabledAdapters: [],
          notion: {
            databaseId: "legacy-database",
            dataSourceId: "legacy-data-source",
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
      },
    });
    const store = new ConfigStore(join(root, "config.json"));
    const config = store.load();
    expect(Object.hasOwn(config.modules["content-scout"], "notion")).toBe(false);
  });

  it("still drops the fireflies and watch keys the pre-parse tolerance already removed", () => {
    const root = workspaceWithConfig("legacy-keys", {
      fireflies: { apiKey: "legacy" },
      watch: { id: "legacy" },
    });
    const store = new ConfigStore(join(root, "config.json"));
    expect(() => store.load()).not.toThrow();
  });
});

describe("ConfigStore.getForPurpose", () => {
  it("resolves claim extraction's purpose identically to dossier extraction's until it carries its own override (#381, R5)", () => {
    const root = workspaceWithConfig("purpose-split", {
      provider: "openrouter",
      model: "inception/mercury-2.5",
      apiKey: "fixture-key",
    });
    const store = new ConfigStore(join(root, "config.json"));
    store.load();
    // No `models` override exists yet: introducing the `personProfileClaims`
    // purpose changes no resolved request — both purposes fall back to the
    // same base model.
    expect(store.getForPurpose("personProfileClaims").model).toBe(
      store.getForPurpose("personResearch").model,
    );
    expect(store.getForPurpose("personProfileClaims").model).toBe("inception/mercury-2.5");
  });

  it("lets a claim-extraction override diverge from dossier extraction without moving it", () => {
    const root = workspaceWithConfig("purpose-split-override", {
      provider: "openrouter",
      model: "inception/mercury-2.5",
      apiKey: "fixture-key",
    });
    const store = new ConfigStore(join(root, "config.json"));
    store.load();
    store.update({
      models: { openrouter: { personProfileClaims: "z-ai/glm-5.3-flash" } },
    });
    expect(store.getForPurpose("personProfileClaims").model).toBe("z-ai/glm-5.3-flash");
    expect(store.getForPurpose("personResearch").model).toBe("inception/mercury-2.5");
  });

  it("seeds claim extraction from a pre-existing dossier-extraction override, so an upgrade cannot silently move it (#381, R5)", () => {
    const root = workspaceWithConfig("purpose-split-preexisting", {
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      apiKey: "fixture-key",
      // Set before `personProfileClaims` existed: pre-upgrade, this model
      // answered both dossier and claim extraction.
      models: { openrouter: { personResearch: "research-model" } },
    });
    const store = new ConfigStore(join(root, "config.json"));
    store.load();
    expect(store.getForPurpose("personProfileClaims").model).toBe("research-model");
    // The seed is persisted, not a live fallback: moving `personResearch`
    // later must not carry claim extraction along with it.
    store.update({ models: { openrouter: { personResearch: "moved-later" } } });
    expect(store.getForPurpose("personResearch").model).toBe("moved-later");
    expect(store.getForPurpose("personProfileClaims").model).toBe("research-model");
  });
});
