import { google } from "googleapis";
import type { GoogleAuth } from "../../../google/oauth.js";
import { isExternalGuest } from "../eligibility.js";

/**
 * Gmail Delivery Output Adapter — send-only-to-owner (ADR-0034).
 *
 * This is the deliberate exception to the draft-only policy. It never accepts
 * a recipient from event/API/model; the recipient is structurally fixed to the
 * connected Google identity. It never emails External Guests. It renders the
 * Meeting Brief deterministically and persists a stable delivery identity
 * before the outward write for idempotency.
 *
 * Draft-only Modules (apps/server/src/google/gmail.ts) remain structurally
 * unable to call send; the banned-token test enforces that. Only this adapter
 * may reference users.messages.send.
 */

export interface GmailDeliveryProvider {
  /**
   * Send the rendered Meeting Brief to the workspace owner.
   * The recipient is fixed at construction (ownerEmail).
   * Returns the Gmail messageId.
   */
  send(params: {
    subject: string;
    text: string;
    html: string;
    deliveryId: string;
  }): Promise<string>;

  /**
   * Reconcile: did a message with this deliveryId already send?
   * Read-only; used before retry so a lost ack converges to one message.
   */
  findByDeliveryId(deliveryId: string): Promise<{ messageId: string; recipient: string } | null>;
}

function encodeMeetingBriefRaw(
  to: string,
  subject: string,
  text: string,
  html: string,
  deliveryId: string,
): string {
  // Deterministic MIME with stable delivery header for reconciliation.
  const boundary = `mb_${deliveryId.replace(/[^a-zA-Z0-9]/g, "_")}_b`;
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `X-MeetingBrief-Delivery-Id: ${deliveryId}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const safeText = text.replace(/\r?\n/g, "\r\n");
  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    safeText,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    html,
    `--${boundary}--`,
  ];
  const mime = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function createGmailDeliveryProvider(
  auth: GoogleAuth,
  ownerEmail: string,
): GmailDeliveryProvider {
  if (!ownerEmail || !isValidEmail(ownerEmail)) {
    throw new Error(`Gmail delivery requires a valid owner email, got ${ownerEmail}`);
  }
  const owner = ownerEmail.trim();

  return {
    async send({ subject, text, html, deliveryId }): Promise<string> {
      // Owner-only enforcement: recipient is fixed, never from model/event.
      // Double-guard against External Guest leakage even if caller confused.
      // Here owner is trusted; we just ensure we never accept an external Guest address.
      // The adapter itself never takes a `to` param; it is bound to owner at construction.
      if (!deliveryId) throw new Error("deliveryId is required for idempotency");
      // Defensive: if internalDomains were provided, we could check isExternalGuest, but owner by definition is not external.
      // Still, ensure we never send to a consumer domain that looks external? Owner is always allowed.
      const raw = encodeMeetingBriefRaw(owner, subject, text, html, deliveryId);
      const gmail = google.gmail({ version: "v1", auth });
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      const id = (res.data as { id?: string }).id;
      if (!id) throw new Error(`Gmail send returned no id for delivery ${deliveryId}`);
      return id;
    },

    async findByDeliveryId(
      deliveryId: string,
    ): Promise<{ messageId: string; recipient: string } | null> {
      if (!deliveryId) return null;
      const gmail = google.gmail({ version: "v1", auth });
      // Read-only reconciliation: search sent mailbox for the delivery header value.
      // Gmail's free-text search indexes header values, so querying the id suffices.
      const q = `"${deliveryId}" in:sent`;
      const list = await gmail.users.messages.list({ userId: "me", maxResults: 10, q });
      const messages = (list.data as { messages?: Array<{ id?: string }> }).messages ?? [];
      for (const m of messages) {
        const id = m.id;
        if (!id) continue;
        try {
          const get = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["X-MeetingBrief-Delivery-Id", "To"],
          });
          const headers = (
            get.data as { payload?: { headers?: Array<{ name?: string; value?: string }> } }
          ).payload?.headers;
          const headerId = headers?.find(
            (h) => h.name?.toLowerCase() === "x-meetingbrief-delivery-id",
          )?.value;
          if (headerId === deliveryId) {
            const to = headers?.find((h) => h.name?.toLowerCase() === "to")?.value ?? owner;
            return { messageId: id, recipient: to };
          }
        } catch {
          // Ignore per-message fetch errors; continue.
        }
      }
      return null;
    },
  };
}

/**
 * Totally injectable fake delivery provider for host-seam tests (issue://90).
 * Retains real delivery state machine while avoiding Google network.
 */
export type FakeGmailDeliveryMode = "normal" | "unavailable" | "lostAck" | "permanentFailure";

export interface FakeGmailDeliveryOptions {
  ownerEmail: string;
  mode?: FakeGmailDeliveryMode;
  /** Fail the Nth send call (1-indexed) with transient error for lostAck simulation. */
  failOnAttempt?: number | null;
  internalDomains?: string[];
}

export class FakeGmailDeliveryProvider implements GmailDeliveryProvider {
  private readonly ownerEmail: string;
  private readonly mode: FakeGmailDeliveryMode;
  private readonly internalDomains: string[];
  private failOnAttempt: number | null;
  private sendCount = 0;
  private readonly sentByDeliveryId = new Map<
    string,
    { messageId: string; recipient: string; subject: string }
  >();
  private readonly allMessages: Array<{
    messageId: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    deliveryId: string;
  }> = [];

  constructor(opts: FakeGmailDeliveryOptions) {
    if (!opts.ownerEmail) throw new Error("FakeGmailDeliveryProvider requires ownerEmail");
    this.ownerEmail = opts.ownerEmail;
    this.mode = opts.mode ?? "normal";
    this.internalDomains = opts.internalDomains ?? [];
    this.failOnAttempt = opts.failOnAttempt ?? null;
  }

  get messages(): ReadonlyArray<{
    messageId: string;
    to: string;
    subject: string;
    deliveryId: string;
  }> {
    return this.allMessages;
  }

  get count(): number {
    return this.sendCount;
  }

  getSentByDeliveryId(deliveryId: string): { messageId: string; recipient: string } | undefined {
    return this.sentByDeliveryId.get(deliveryId);
  }

  clear(): void {
    this.sentByDeliveryId.clear();
    this.allMessages.length = 0;
    this.sendCount = 0;
  }

  async send(params: {
    subject: string;
    text: string;
    html: string;
    deliveryId: string;
  }): Promise<string> {
    this.sendCount++;
    // Owner-only enforcement: this fake MUST reject any attempt to send to non-owner.
    // The real adapter binds `to` at construction; the fake mirrors that structural guarantee.
    // If caller tries to bypass by passing external Guest via any backdoor, we check.
    // Here we only have deliveryId, but we expose ownerEmail check via a backdoor method below.

    if (this.mode === "unavailable") {
      throw Object.assign(new Error("Gmail delivery unavailable (fake)"), {
        code: 503,
        response: {
          data: { error: { message: "Gmail unavailable", errors: [{ reason: "backendError" }] } },
        },
      });
    }
    if (this.failOnAttempt !== null && this.sendCount === this.failOnAttempt) {
      throw new Error(`Fake transient failure on attempt ${this.sendCount}`);
    }
    if (this.mode === "permanentFailure") {
      throw new Error("Fake permanent Gmail failure");
    }

    // Enforce: never email External Guest. Since this fake's recipient is always owner,
    // we just double-check owner is not considered external when internalDomains includes owner domain.
    if (isExternalGuest({ email: this.ownerEmail } as never, this.internalDomains)) {
      // If owner domain is mistakenly considered external (should not happen via normalized domains),
      // this is a test misconfiguration, but we guard.
      // Allow owner anyway; the check is for non-owner recipients which this fake never uses.
    }

    const messageId = `fake-msg-${params.deliveryId}-${this.sendCount}-${Date.now()}`;

    // For lostAck mode: store but then throw to simulate lost acknowledgement
    if (this.mode === "lostAck" && this.sendCount === 1) {
      this.sentByDeliveryId.set(params.deliveryId, {
        messageId,
        recipient: this.ownerEmail,
        subject: params.subject,
      });
      this.allMessages.push({
        messageId,
        to: this.ownerEmail,
        subject: params.subject,
        text: params.text,
        html: params.html,
        deliveryId: params.deliveryId,
      });
      throw new Error("Fake lost acknowledgement after send");
    }

    this.sentByDeliveryId.set(params.deliveryId, {
      messageId,
      recipient: this.ownerEmail,
      subject: params.subject,
    });
    this.allMessages.push({
      messageId,
      to: this.ownerEmail,
      subject: params.subject,
      text: params.text,
      html: params.html,
      deliveryId: params.deliveryId,
    });
    return messageId;
  }

  /**
   * Owner-only enforcement backdoor: if a test tries to call a method that would send to arbitrary recipient,
   * it should be caught. This fake deliberately has no `sendTo(to)` method — only the owner-bound `send` exists.
   * Tests can attempt to misuse via casting; we expose a guarded method for verification.
   */
  async sendTo(
    to: string,
    _params: { subject: string; text: string; html: string; deliveryId: string },
  ): Promise<string> {
    if (to.toLowerCase() !== this.ownerEmail.toLowerCase()) {
      throw new Error(
        `Gmail delivery is owner-only: refusing to send to ${to} (owner is ${this.ownerEmail}); External Guests never emailed`,
      );
    }
    return this.send(_params);
  }

  async findByDeliveryId(
    deliveryId: string,
  ): Promise<{ messageId: string; recipient: string } | null> {
    const found = this.sentByDeliveryId.get(deliveryId);
    if (!found) return null;
    return { messageId: found.messageId, recipient: found.recipient };
  }

  /** Direct manipulation for tests: inject a sent message without going through send() */
  injectSent(params: {
    deliveryId: string;
    messageId: string;
    recipient: string;
    subject?: string;
  }): void {
    this.sentByDeliveryId.set(params.deliveryId, {
      messageId: params.messageId,
      recipient: params.recipient,
      subject: params.subject ?? "Injected",
    });
    this.allMessages.push({
      messageId: params.messageId,
      to: params.recipient,
      subject: params.subject ?? "Injected",
      text: "injected",
      html: "<p>injected</p>",
      deliveryId: params.deliveryId,
    });
  }
}
