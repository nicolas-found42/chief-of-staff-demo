import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config.js";
import type { GoogleConnection } from "../../../apps/server/src/google/connection.js";
import { createMeetingBriefProductionRuntime } from "../../../apps/server/src/modules/meeting-brief-generator/production.js";
import { RelayStateStore } from "../../../apps/server/src/relay/state.js";
import { openRuns } from "../../../apps/server/src/runs.js";

describe("Meeting Brief production composition — issue #92", () => {
  it("preserves the person-configured public relay URL without probing Google", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-brief-production-"));
    const configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    new RelayStateStore(join(workspaceDir, "relay.json")).setRelayBaseUrl(
      "https://relay.example.com",
    );
    const google = {
      state: async () => {
        throw new Error("production composition must not automatically prove Google");
      },
      auth: () => ({ ok: false, state: "unconfigured" }),
    } as unknown as GoogleConnection;

    createMeetingBriefProductionRuntime({
      runs: openRuns(workspaceDir),
      workspaceDir,
      configStore,
      google,
      getCompleteJson: () => async () => ({}),
    });

    expect(new RelayStateStore(join(workspaceDir, "relay.json")).load().relayBaseUrl).toBe(
      "https://relay.example.com",
    );
  });
});
