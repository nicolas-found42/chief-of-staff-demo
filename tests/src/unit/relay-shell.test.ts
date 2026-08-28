import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { RelayStateStore, hashVerifier } from "../../../apps/server/src/relay/state.js";
import { RelayClient } from "../../../apps/server/src/relay/client.js";
import { createRelayApp } from "../../../relay/src/app.js";
import { registerRelayRoutes } from "../../../apps/server/src/relay/routes.js";

// Shell relay client, workspace persistence, Settings status — issue://80 + ADR-0031 + issue://81
// Tests: local generation, Workspace persistence, status without secrets, channel replacement ordering.

describe("RelayStateStore workspace persistence — issue://81", () => {
  it("generates installation identity+secret locally and persists secret in Workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-shell-"));
    const store = new RelayStateStore(join(dir, "relay.json"));
    const first = store.ensureInstallation();
    expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(first.verifier).toBe(createHash("sha256").update(first.secret, "utf8").digest("hex"));

    const second = store.ensureInstallation();
    expect(second.installationId).toBe(first.installationId);
    expect(second.secret).toBe(first.secret);
    expect(second.created).toBe(false);

    const file = JSON.parse(readFileSync(join(dir, "relay.json"), "utf8")) as { secret: string };
    expect(file.secret).toBe(first.secret);
  });

  it("persists channels and lastWakeUpAt, round-trips via file", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-shell-"));
    const store = new RelayStateStore(join(dir, "relay.json"));
    store.ensureInstallation();
    store.setRelayBaseUrl("http://127.0.0.1:4318");
    store.addChannel({
      channelId: "ch-1",
      token: "tok-1",
      resourceId: "res-1",
      expiration: new Date(Date.now() + 86400000).toISOString(),
    });
    store.setLastWakeUpAt("2026-08-27T12:00:00.000Z");

    const loaded = store.load();
    expect(loaded.relayBaseUrl).toBe("http://127.0.0.1:4318");
    expect(loaded.channels).toHaveLength(1);
    expect(loaded.channels[0]?.channelId).toBe("ch-1");
    expect(loaded.lastWakeUpAt).toBe("2026-08-27T12:00:00.000Z");
  });
});

describe("Settings status without exposing secrets — issue://81", () => {
  it("GET /api/relay/status reports installation/channel/lastWakeUp without secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-shell-"));
    const app = Fastify({ logger: false });
    registerRelayRoutes(app, { workspaceDir: dir });

    // initially no installation
    const empty = await app.inject({ method: "GET", url: "/api/relay/status" });
    expect(empty.statusCode).toBe(200);
    const emptyBody = JSON.parse(empty.body) as {
      installationId: string | null;
      hasSecret: boolean;
    };
    expect(emptyBody.installationId).toBeNull();
    expect(emptyBody.hasSecret).toBe(false);

    // create installation
    await app.inject({ method: "POST", url: "/api/relay/install", payload: {} });

    // add channel via store directly to avoid needing relay
    const store = new RelayStateStore(join(dir, "relay.json"));
    store.addChannel({
      channelId: "ch-123",
      token: "secret-token-should-not-appear",
      resourceId: "res-123",
      expiration: null,
    });
    store.setLastWakeUpAt("2026-08-27T15:00:00.000Z");
    store.setRelayBaseUrl("http://127.0.0.1:9"); // unreachable, but status should still report

    const status = await app.inject({ method: "GET", url: "/api/relay/status" });
    expect(status.statusCode).toBe(200);
    const body = JSON.parse(status.body) as {
      installationId: string | null;
      hasSecret: boolean;
      channels: Array<{ channelId: string }>;
      lastWakeUpAt: string | null;
    };
    expect(body.installationId).toBeTruthy();
    expect(body.hasSecret).toBe(true);
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]?.channelId).toBe("ch-123");
    expect(body.lastWakeUpAt).toBe("2026-08-27T15:00:00.000Z");
    // prove secrets/tokens not exposed in status payload
    expect(status.body).not.toContain("secret-token-should-not-appear");
    expect(status.body).not.toContain("secret");
    // file holds secret, status hides it
    const fileContent = readFileSync(join(dir, "relay.json"), "utf8");
    expect(fileContent).toContain("secret-token-should-not-appear"); // stored locally
    expect(status.body).not.toContain("secret-token-should-not-appear");

    await app.close();
  });
});

describe("Shell relay client channel replacement — issue://81", () => {
  it("activates new before revoking old (RelayClient.replaceChannel order)", async () => {
    const { app, store } = createRelayApp();
    // start in-process relay HTTP
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const installationId = "inst-replace-1";
    const secret = "replace-secret-" + Math.random().toString(16).slice(2);
    const verifier = hashVerifier(secret);
    store.createInstallation(installationId, verifier);

    const client = new RelayClient({ baseUrl, installationId, secret });
    await client.registerInstallation();

    const oldChannelId = "old-ch";
    const oldToken = "old-token-xyz";
    await client.registerChannel({ channelId: oldChannelId, token: oldToken });

    const newChannelId = "new-ch";
    const newToken = "new-token-abc";
    // replace: new activated before old revoked
    await client.replaceChannel(oldChannelId, { channelId: newChannelId, token: newToken });

    // old should be revoked
    expect(store.getChannel(oldChannelId)?.revokedAt).toBeTruthy();
    expect(store.getChannel(newChannelId)).toBeTruthy();

    // new still accepts, old rejected
    const ok = await app.inject({
      method: "POST",
      url: "/push",
      headers: {
        "x-goog-channel-id": newChannelId,
        "x-goog-channel-token": newToken,
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "1",
      },
    });
    expect(ok.statusCode).toBe(204);

    const bad = await app.inject({
      method: "POST",
      url: "/push",
      headers: {
        "x-goog-channel-id": oldChannelId,
        "x-goog-channel-token": oldToken,
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "2",
      },
    });
    expect(bad.statusCode).toBe(404);

    await app.close();
  });
});
