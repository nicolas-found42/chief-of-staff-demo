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

describe("ConfigStore dossier-extraction purpose migration (issue #418, T2)", () => {
  it("seeds dossier extraction from a pre-existing personResearch override exactly once, leaving planning and discovery untouched", () => {
    const root = workspaceWithConfig("dossier-purpose-preexisting", {
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      apiKey: "fixture-key",
      // Set before `personDossierExtraction` existed: pre-upgrade, this model
      // answered dossier extraction through `personResearch`.
      models: {
        openrouter: {
          personResearch: "research-model",
          personProfileClaims: "claims-model",
          researchPlanning: "planning-model",
        },
      },
    });
    const store = new ConfigStore(join(root, "config.json"));
    store.load();
    // The prior effective dossier-extraction choice is preserved...
    expect(store.getForPurpose("personDossierExtraction").model).toBe("research-model");
    // ...and discovery-claim and planning choices are left exactly as they were.
    expect(store.getForPurpose("personProfileClaims").model).toBe("claims-model");
    expect(store.getForPurpose("researchPlanning").model).toBe("planning-model");
    expect(store.getForPurpose("personResearch").model).toBe("research-model");

    // The seed is persisted, not a live fallback: moving `personResearch`
    // later must not carry dossier extraction along with it, and it must not
    // re-track a later change either (a true one-time migration).
    store.update({ models: { openrouter: { personResearch: "moved-later" } } });
    expect(store.getForPurpose("personResearch").model).toBe("moved-later");
    expect(store.getForPurpose("personDossierExtraction").model).toBe("research-model");
  });

  it("inherits the shared base model for dossier extraction when personResearch was never overridden", () => {
    const root = workspaceWithConfig("dossier-purpose-inherited", {
      provider: "openrouter",
      model: "inception/mercury-2.5",
      apiKey: "fixture-key",
    });
    const store = new ConfigStore(join(root, "config.json"));
    store.load();
    expect(store.getForPurpose("personDossierExtraction").model).toBe(
      store.getForPurpose("personResearch").model,
    );
    expect(store.getForPurpose("personDossierExtraction").model).toBe("inception/mercury-2.5");
  });

  it("never re-seeds an explicitly-cleared dossier-extraction override", () => {
    const root = workspaceWithConfig("dossier-purpose-cleared", {
      provider: "openrouter",
      model: "inception/mercury-2.5",
      apiKey: "fixture-key",
      models: {
        openrouter: {
          personResearch: "research-model",
          // Explicitly cleared back to empty: distinct from `undefined`, and
          // must never be re-seeded from `personResearch`.
          personDossierExtraction: "",
        },
      },
    });
    const store = new ConfigStore(join(root, "config.json"));
    store.load();
    expect(store.getForPurpose("personDossierExtraction").model).toBe("inception/mercury-2.5");
    expect(store.getForPurpose("personResearch").model).toBe("research-model");
  });

  it("lets a dossier-extraction override diverge from personResearch without moving it", () => {
    const root = workspaceWithConfig("dossier-purpose-override", {
      provider: "openrouter",
      model: "inception/mercury-2.5",
      apiKey: "fixture-key",
    });
    const store = new ConfigStore(join(root, "config.json"));
    store.load();
    store.update({
      models: { openrouter: { personDossierExtraction: "z-ai/glm-5.3-flash" } },
    });
    expect(store.getForPurpose("personDossierExtraction").model).toBe("z-ai/glm-5.3-flash");
    expect(store.getForPurpose("personResearch").model).toBe("inception/mercury-2.5");
  });
});

describe("ConfigStore.dossierExtractionPolicy (issue #418, T2)", () => {
  it("defaults to a positive bounded output ceiling, the existing low-effort intent, the full shape, and fallback disabled", () => {
    const root = workspaceWithConfig("dossier-policy-default", {
      provider: "openrouter",
      model: "inception/mercury-2.5",
      apiKey: "fixture-key",
    });
    const store = new ConfigStore(join(root, "config.json"));
    const config = store.load();
    expect(config.dossierExtractionPolicy).toEqual({
      version: 1,
      outputTokenCeiling: 65536,
      requestedEffort: "low",
      shapeStrategy: "full",
    });
  });
});
