import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Shell-side relay workspace persistence — issue://80 (relay registration) + ADR-0031.
 * Installation identity+secret generated locally, secret never leaves Workspace except as verifier.
 * Channel identifiers, verifier, expiry persisted for restart recovery.
 */

export interface RelayChannelLocal {
  channelId: string;
  token: string; // plaintext channel token kept locally (not exposed via status)
  resourceId: string | null;
  expiration: string | null; // ISO string
}

export interface RelayWorkspace {
  installationId: string | null;
  secret: string | null; // plaintext installation secret — never exposed via API
  relayBaseUrl: string | null;
  channels: RelayChannelLocal[];
  lastWakeUpAt: string | null;
}

const EMPTY: RelayWorkspace = {
  installationId: null,
  secret: null,
  relayBaseUrl: null,
  channels: [],
  lastWakeUpAt: null,
};

export function relayFile(workspaceDir: string): string {
  return join(workspaceDir, "relay.json");
}

export function hashVerifier(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export class RelayStateStore {
  constructor(private readonly filePath: string) {}

  load(): RelayWorkspace {
    if (!existsSync(this.filePath)) return { ...EMPTY, channels: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<RelayWorkspace>;
      return {
        installationId: typeof parsed.installationId === "string" ? parsed.installationId : null,
        secret: typeof parsed.secret === "string" ? parsed.secret : null,
        relayBaseUrl: typeof parsed.relayBaseUrl === "string" ? parsed.relayBaseUrl : null,
        channels: Array.isArray(parsed.channels)
          ? parsed.channels.filter((c: unknown): c is RelayChannelLocal => {
              if (typeof c !== "object" || c === null) return false;
              const rec = c as Record<string, unknown>;
              return typeof rec.channelId === "string" && typeof rec.token === "string";
            })
          : [],
        lastWakeUpAt: typeof parsed.lastWakeUpAt === "string" ? parsed.lastWakeUpAt : null,
      };
    } catch {
      return { ...EMPTY, channels: [] };
    }
  }

  save(state: RelayWorkspace): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  }

  ensureInstallation(): {
    installationId: string;
    secret: string;
    verifier: string;
    created: boolean;
  } {
    const current = this.load();
    if (current.installationId && current.secret) {
      return {
        installationId: current.installationId,
        secret: current.secret,
        verifier: hashVerifier(current.secret),
        created: false,
      };
    }
    const installationId = randomUUID();
    const secret = randomBytes(32).toString("hex"); // 64 hex chars
    const next: RelayWorkspace = {
      ...current,
      installationId,
      secret,
    };
    this.save(next);
    return { installationId, secret, verifier: hashVerifier(secret), created: true };
  }

  setRelayBaseUrl(url: string): void {
    const current = this.load();
    this.save({ ...current, relayBaseUrl: url });
  }

  setLastWakeUpAt(iso: string | null): void {
    const current = this.load();
    this.save({ ...current, lastWakeUpAt: iso });
  }

  addChannel(channel: RelayChannelLocal): void {
    const current = this.load();
    const exists = current.channels.find((c) => c.channelId === channel.channelId);
    if (exists) {
      // idempotent update
      const nextChannels = current.channels.map((c) =>
        c.channelId === channel.channelId ? channel : c,
      );
      this.save({ ...current, channels: nextChannels });
      return;
    }
    this.save({ ...current, channels: [...current.channels, channel] });
  }

  removeChannel(channelId: string): void {
    const current = this.load();
    this.save({ ...current, channels: current.channels.filter((c) => c.channelId !== channelId) });
  }

  clear(): void {
    this.save({ ...EMPTY, channels: [] });
  }
}
