import { beforeEach, describe, expect, it, vi } from "vitest";

const gmailApi = vi.hoisted(() => ({
  send: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  getProfile: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    gmail: () => ({
      users: {
        messages: gmailApi,
        getProfile: gmailApi.getProfile,
      },
    }),
  },
}));

import {
  createGmailDeliveryProvider,
  gmailOwnerEmail,
} from "../../../apps/server/src/modules/meeting-brief-generator/google/gmailDelivery.js";
import type { GoogleAuth } from "../../../apps/server/src/google/oauth.js";

describe("Gmail delivery Output Adapter — issue #90", () => {
  beforeEach(() => {
    gmailApi.send.mockReset();
    gmailApi.list.mockReset();
    gmailApi.get.mockReset();
    gmailApi.getProfile.mockReset();
  });

  it("resolves the owner only from the authenticated Gmail profile", async () => {
    gmailApi.getProfile.mockResolvedValue({ data: { emailAddress: "Owner@Example.com" } });

    await expect(gmailOwnerEmail({} as GoogleAuth)).resolves.toBe("owner@example.com");
    expect(gmailApi.getProfile).toHaveBeenCalledWith({ userId: "me" });
  });

  it("uses a deterministic RFC Message-ID and strips newlines from the Subject header", async () => {
    gmailApi.send.mockResolvedValue({ data: { id: "gmail-message-1" } });
    const provider = createGmailDeliveryProvider({} as GoogleAuth, "owner@example.com");

    await provider.send({
      subject: "Meeting Brief\r\nBcc: guest@external.co",
      text: "Plain text",
      html: "<p>HTML</p>",
      deliveryId: "mb-deliver-event::occurrence-v1",
    });

    const request = gmailApi.send.mock.calls[0]?.[0] as { requestBody: { raw: string } };
    const mime = Buffer.from(request.requestBody.raw, "base64url").toString("utf8");
    expect(mime).toContain("Message-ID: <meeting-brief-");
    expect(mime).toContain("@chief-of-staff-demo.local>");
    expect(mime).toContain("Subject: Meeting Brief Bcc: guest@external.co");
    expect(mime).not.toContain("\r\nBcc:");
  });

  it("classifies an unreadable candidate as unreadable instead of throwing", async () => {
    gmailApi.list.mockResolvedValue({ data: { messages: [{ id: "candidate-1" }] } });
    gmailApi.get.mockRejectedValue(new Error("Gmail metadata unavailable"));
    const provider = createGmailDeliveryProvider({} as GoogleAuth, "owner@example.com");

    await expect(provider.findByDeliveryId("delivery-1")).resolves.toEqual({
      kind: "unreadable",
      reason: "Gmail metadata unavailable",
    });
    expect(gmailApi.list.mock.calls[0]?.[0]?.q).toMatch(/^rfc822msgid:/);
  });

  it("classifies no candidate as none and one verified candidate as found", async () => {
    const provider = createGmailDeliveryProvider({} as GoogleAuth, "owner@example.com");
    gmailApi.list.mockResolvedValue({ data: { messages: [] } });
    await expect(provider.findByDeliveryId("delivery-1")).resolves.toEqual({ kind: "none" });

    gmailApi.list.mockResolvedValue({ data: { messages: [{ id: "message-1" }] } });
    gmailApi.get.mockResolvedValue({
      data: {
        payload: {
          headers: [
            { name: "X-MeetingBrief-Delivery-Id", value: "delivery-1" },
            { name: "To", value: "owner@example.com" },
          ],
        },
      },
    });
    await expect(provider.findByDeliveryId("delivery-1")).resolves.toEqual({
      kind: "found",
      messageId: "message-1",
      recipient: "owner@example.com",
    });
  });

  it("classifies several messages carrying one delivery identity as ambiguous", async () => {
    gmailApi.list.mockResolvedValue({
      data: { messages: [{ id: "message-1" }, { id: "message-2" }] },
    });
    gmailApi.get.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({
        data: {
          payload: {
            headers: [
              { name: "X-MeetingBrief-Delivery-Id", value: "delivery-1" },
              { name: "To", value: "owner@example.com" },
            ],
            id,
          },
        },
      }),
    );
    const provider = createGmailDeliveryProvider({} as GoogleAuth, "owner@example.com");

    const reconciliation = await provider.findByDeliveryId("delivery-1");
    expect(reconciliation).toEqual({ kind: "ambiguous", messageIds: ["message-1", "message-2"] });
  });
});
