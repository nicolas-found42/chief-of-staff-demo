import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Minimal opaque relay store — see issue://80 spec (Calendar push Intake / opaque relay)
 * and ADR-0031 (ADR-0031-calendar-push-uses-an-opaque-cloud-relay).
 * Stores only installation / channel / message / expiry / ack metadata.
 * No credentials, Calendar event data, enrichment evidence or Meeting Brief content.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days bounded retention (ADR-0031: long enough to cover offline)

export interface InstallationRecord {
  installationId: string;
  verifier: string; // hex sha256(secret)
  createdAt: string;
}

export interface ChannelRecord {
  channelId: string;
  installationId: string;
  tokenVerifier: string; // hex sha256(channelToken)
  resourceId: string | null;
  expiration: string | null; // ISO string
  revokedAt: string | null;
  createdAt: string;
}

export interface MessageRecord {
  installationId: string;
  channelId: string;
  messageNumber: string; // as received (Google sends numeric string)
  resourceId: string;
  resourceState: string;
  resourceUri: string | null;
  channelExpiration: string | null;
  receivedAt: string;
  expiresAt: string;
  ack: boolean;
}

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  // Constant-time compare via timingSafeEqual on buffers (issue://81 / ADR-0031)
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function safeEqualHash(provided: string, storedHexVerifier: string): boolean {
  const providedHash = hashHex(provided);
  return safeEqualHex(providedHash, storedHexVerifier);
}

export class RelayStore {
  private installations = new Map<string, InstallationRecord>();
  private channels = new Map<string, ChannelRecord>(); // keyed by channelId globally
  private messages = new Map<string, MessageRecord>(); // keyed by `${channelId}:${messageNumber}`
  private messagesByInstallation = new Map<string, Set<string>>(); // installationId -> Set of keys

  constructor(private readonly now: () => Date = () => new Date()) {}

  // --- Installation ---

  createInstallation(installationId: string, verifier: string): InstallationRecord {
    const existing = this.installations.get(installationId);
    if (existing) {
      if (!safeEqualHex(existing.verifier, verifier)) {
        throw Object.assign(new Error("installation verifier mismatch"), { statusCode: 409 });
      }
      return existing;
    }
    const rec: InstallationRecord = {
      installationId,
      verifier: verifier.toLowerCase(),
      createdAt: this.now().toISOString(),
    };
    this.installations.set(installationId, rec);
    this.messagesByInstallation.set(installationId, new Set());
    return rec;
  }

  getInstallation(installationId: string): InstallationRecord | undefined {
    return this.installations.get(installationId);
  }

  verifyInstallationSecret(installationId: string, secret: string): boolean {
    const inst = this.installations.get(installationId);
    if (!inst) return false;
    return safeEqualHash(secret, inst.verifier);
  }

  // --- Channel ---

  createChannel(args: {
    installationId: string;
    channelId: string;
    tokenVerifier: string;
    expiration?: string | null;
    resourceId?: string | null;
  }): ChannelRecord {
    const { installationId, channelId, tokenVerifier, expiration, resourceId } = args;
    if (!this.installations.has(installationId)) {
      throw Object.assign(new Error("unknown installation"), { statusCode: 404 });
    }
    const existing = this.channels.get(channelId);
    if (existing) {
      if (existing.installationId !== installationId) {
        throw Object.assign(new Error("channel id conflict"), { statusCode: 409 });
      }
      if (existing.revokedAt) {
        throw Object.assign(new Error("channel revoked"), { statusCode: 409 });
      }
      if (!safeEqualHex(existing.tokenVerifier, tokenVerifier)) {
        throw Object.assign(new Error("channel verifier mismatch"), { statusCode: 409 });
      }
      return existing;
    }
    const rec: ChannelRecord = {
      channelId,
      installationId,
      tokenVerifier: tokenVerifier.toLowerCase(),
      resourceId: resourceId ?? null,
      expiration: expiration ?? null,
      revokedAt: null,
      createdAt: this.now().toISOString(),
    };
    this.channels.set(channelId, rec);
    return rec;
  }

  revokeChannel(installationId: string, channelId: string): void {
    const ch = this.channels.get(channelId);
    if (!ch || ch.installationId !== installationId) {
      throw Object.assign(new Error("unknown channel"), { statusCode: 404 });
    }
    if (ch.revokedAt) return;
    ch.revokedAt = this.now().toISOString();
  }

  getChannel(channelId: string): ChannelRecord | undefined {
    return this.channels.get(channelId);
  }

  listChannels(installationId: string): ChannelRecord[] {
    return [...this.channels.values()].filter(
      (c) => c.installationId === installationId && !c.revokedAt,
    );
  }

  verifyChannelToken(channelId: string, token: string): boolean {
    const ch = this.channels.get(channelId);
    if (!ch || ch.revokedAt) return false;
    // Expiration check: if expiration is ISO and now past it, treat as expired -> reject
    if (ch.expiration) {
      const exp = Date.parse(ch.expiration);
      if (!Number.isNaN(exp) && this.now().getTime() > exp) return false;
    }
    return safeEqualHash(token, ch.tokenVerifier);
  }

  // --- Messages (wake-ups) ---

  isExpired(msg: MessageRecord): boolean {
    return Date.parse(msg.expiresAt) <= this.now().getTime();
  }

  pruneExpired(): void {
    for (const [key, msg] of this.messages) {
      if (this.isExpired(msg)) {
        this.messages.delete(key);
        this.messagesByInstallation.get(msg.installationId)?.delete(key);
      }
    }
    // also prune channels whose expiration passed? Not auto, but push will reject
  }

  appendMessage(args: {
    channelId: string;
    messageNumber: string;
    resourceId: string;
    resourceState: string;
    resourceUri: string | null;
    channelExpiration: string | null;
  }): { created: boolean; record: MessageRecord | null } {
    const ch = this.channels.get(args.channelId);
    if (!ch || ch.revokedAt) {
      throw Object.assign(new Error("unknown channel"), { statusCode: 404 });
    }
    if (ch.expiration) {
      const exp = Date.parse(ch.expiration);
      if (!Number.isNaN(exp) && this.now().getTime() > exp) {
        throw Object.assign(new Error("channel expired"), { statusCode: 410 });
      }
    }
    const key = `${args.channelId}:${args.messageNumber}`;
    const existing = this.messages.get(key);
    if (existing) {
      // Duplicate message number idempotent (issue://80 at-least-once, duplicate wake-ups harmless)
      return { created: false, record: existing };
    }
    const receivedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + RETENTION_MS).toISOString();
    const rec: MessageRecord = {
      installationId: ch.installationId,
      channelId: args.channelId,
      messageNumber: args.messageNumber,
      resourceId: args.resourceId,
      resourceState: args.resourceState,
      resourceUri: args.resourceUri,
      channelExpiration: args.channelExpiration,
      receivedAt,
      expiresAt,
      ack: false,
    };
    this.messages.set(key, rec);
    if (!this.messagesByInstallation.has(ch.installationId)) {
      this.messagesByInstallation.set(ch.installationId, new Set());
    }
    this.messagesByInstallation.get(ch.installationId)!.add(key);
    return { created: true, record: rec };
  }

  listPending(installationId: string): MessageRecord[] {
    this.pruneExpired();
    const keys = this.messagesByInstallation.get(installationId);
    if (!keys) return [];
    const out: MessageRecord[] = [];
    for (const key of keys) {
      const msg = this.messages.get(key);
      if (msg && !msg.ack && !this.isExpired(msg)) out.push(msg);
    }
    // sort by receivedAt then messageNumber numeric
    out.sort((a, b) => {
      const ta = Date.parse(a.receivedAt);
      const tb = Date.parse(b.receivedAt);
      if (ta !== tb) return ta - tb;
      return Number(a.messageNumber) - Number(b.messageNumber);
    });
    return out;
  }

  ackMessages(
    installationId: string,
    acks: Array<{ channelId: string; messageNumber: string }>,
  ): number {
    this.pruneExpired();
    let count = 0;
    for (const { channelId, messageNumber } of acks) {
      const key = `${channelId}:${messageNumber}`;
      const msg = this.messages.get(key);
      if (!msg) continue;
      if (msg.installationId !== installationId) continue; // isolation: ignore cross-installation ack
      if (msg.ack) continue;
      if (this.isExpired(msg)) continue;
      msg.ack = true;
      count++;
    }
    return count;
  }

  // For testing: expose internal counts
  countMessages(): number {
    return this.messages.size;
  }

  countPending(installationId: string): number {
    return this.listPending(installationId).length;
  }

  // For retention test: allow manual time injection via `now` provider; also expose direct prune with custom now?
  // Tests can create store with mocked now.

  // Utility to check forbidden storage: ensure no extra fields stored
  snapshot(): unknown {
    return {
      installations: [...this.installations.values()],
      channels: [...this.channels.values()],
      messages: [...this.messages.values()],
    };
  }
}
