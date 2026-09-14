import { afterEach, describe, expect, it } from "vitest";
import { MockAgent } from "undici";
import { createBrowserResourceFetch } from "../../../apps/server/src/source-adapters/browser-network";

const agents: MockAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.map((agent) => agent.close()));
  agents.length = 0;
});
function fixture() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agents.push(agent);
  return { agent, fetch: createBrowserResourceFetch(agent) };
}
const signal = () => new AbortController().signal;

describe("browser resource broker", () => {
  it("fulfills an anonymous allowed resource with decompressed headers", async () => {
    const { agent, fetch } = fixture();
    agent
      .get("https://example.com")
      .intercept({ path: "/", headers: { accept: "text/html" } })
      .reply(200, "<p>Allowed</p>", {
        headers: { "content-type": "text/html", "set-cookie": "secret=1" },
      });
    const response = await fetch(
      "https://example.com",
      "GET",
      { accept: "text/html", cookie: "secret=1", authorization: "secret" },
      null,
      signal(),
    );
    expect(response.body.toString()).toBe("<p>Allowed</p>");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it.each(["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "[fc00::1]", "169.254.169.254"])(
    "rejects %s before dispatch",
    async (host) => {
      const { fetch } = fixture();
      await expect(fetch(`http://${host}/`, "GET", {}, null, signal())).rejects.toThrow(
        "public host",
      );
    },
  );

  it("rejects a forbidden redirect before Chromium receives a location", async () => {
    const { agent, fetch } = fixture();
    agent
      .get("https://example.com")
      .intercept({ path: "/" })
      .reply(302, "", { headers: { location: "http://[::ffff:127.0.0.1]/" } });
    await expect(fetch("https://example.com", "GET", {}, null, signal())).rejects.toThrow(
      "public host",
    );
    agent.assertNoPendingInterceptors();
  });

  it("leaves allowed redirects visible to Chromium so origin is preserved", async () => {
    const { agent, fetch } = fixture();
    agent
      .get("https://example.com")
      .intercept({ path: "/" })
      .reply(302, "", { headers: { location: "/landing" } });
    expect(await fetch("https://example.com", "GET", {}, null, signal(), true)).toEqual({
      status: 302,
      headers: { location: "https://example.com/landing" },
      body: Buffer.alloc(0),
    });
  });

  it("bounds a non-document redirect loop before the twenty-second request", async () => {
    const { agent, fetch } = fixture();
    let requests = 0;
    agent
      .get("https://example.com")
      .intercept({ path: "/" })
      .reply(() => {
        requests += 1;
        return { statusCode: 302, data: "", responseOptions: { headers: { location: "/" } } };
      })
      .persist();
    await expect(fetch("https://example.com", "GET", {}, null, signal())).rejects.toThrow(
      "redirect limit",
    );
    expect(requests).toBe(21);
  });

  it("rejects oversized resource bodies with a distinct outcome", async () => {
    const { agent, fetch } = fixture();
    agent.get("https://example.com").intercept({ path: "/" }).reply(200, Buffer.alloc(5_000_001));
    await expect(fetch("https://example.com", "GET", {}, null, signal())).rejects.toMatchObject({
      code: "ERR_SOURCE_BODY_LIMIT",
    });
  });

  it("rejects unsupported methods and oversized POSTs before dispatch", async () => {
    const { fetch } = fixture();
    await expect(fetch("https://example.com", "PUT", {}, null, signal())).rejects.toThrow(
      "unsupported",
    );
    await expect(
      fetch("https://example.com", "POST", {}, Buffer.alloc(5_000_001), signal()),
    ).rejects.toMatchObject({ code: "ERR_SOURCE_BODY_LIMIT" });
  });

  it("propagates cancellation instead of producing a complete resource", async () => {
    const { agent, fetch } = fixture();
    agent.get("https://example.com").intercept({ path: "/" }).reply(200, "late").delay(100);
    const controller = new AbortController();
    const result = fetch("https://example.com", "GET", {}, null, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
