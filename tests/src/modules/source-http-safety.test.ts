import type { LookupFunction } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpUrl,
  createHttpFetch,
  createSourceHttpDispatcher,
  publicHttpFetchBytes,
} from "../../../apps/server/src/source-adapters/http.js";

const transport = vi.hoisted(() => ({
  fetch: vi.fn<
    (
      url: URL,
      options: {
        redirect: string;
        signal?: AbortSignal;
        method?: string;
        body?: unknown;
        headers?: HeadersInit;
      },
    ) => Promise<Response>
  >(),
  lookups: [] as LookupFunction[],
  address: "93.184.216.34",
  family: 4,
}));
vi.mock("undici", () => ({
  fetch: transport.fetch,
  Agent: class {
    constructor(options: { connect: { lookup: LookupFunction } }) {
      transport.lookups.push(options.connect.lookup);
    }
  },
}));
vi.mock("../../../apps/server/node_modules/cacheable-lookup/source/index.js", () => ({
  default: class {
    lookup(_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) {
      callback(
        null,
        options.all
          ? [{ address: transport.address, family: transport.family }]
          : transport.address,
        transport.family,
      );
    }
  },
}));

beforeEach(() => {
  transport.fetch.mockReset();
  transport.address = "93.184.216.34";
  transport.family = 4;
});

describe("public source HTTP boundary", () => {
  it.each([
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.1.2.3]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://100.64.0.1/",
  ])("rejects non-public literal %s before fetching", (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(/public host/);
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it.each(["text", "bytes"])("checks every %s redirect before requesting it", async (kind) => {
    transport.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    const fetch = kind === "text" ? createHttpFetch() : publicHttpFetchBytes;
    await expect(fetch("https://public.example/start")).rejects.toThrow(/public host/);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it.each([true, false])("checks DNS answer at connection time (all=%s)", async (all) => {
    createSourceHttpDispatcher();
    const lookup = transport.lookups.at(-1)!;
    const resolve = () =>
      new Promise<Error | null>((done) => {
        lookup("public.example", { all }, (error) => done(error));
      });
    await expect(resolve()).resolves.toBeNull();
    transport.address = all ? "127.0.0.1" : "::ffff:10.0.0.1";
    transport.family = all ? 4 : 6;
    await expect(resolve()).resolves.toMatchObject({ code: "ERR_SOURCE_PRIVATE_ADDRESS" });
  });
  it("follows public relative redirects, retaining final URL and safe headers", async () => {
    transport.fetch
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final" } }))
      .mockResolvedValueOnce(new Response("ready"));
    await expect(createHttpFetch()("https://public.example/start")).resolves.toMatchObject({
      url: "https://public.example/final",
      body: "ready",
    });
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(String(transport.fetch.mock.calls[1]?.[0])).toBe("https://public.example/final");
  });

  it("drops origin-bound headers and converts POST to GET for a 302", async () => {
    transport.fetch
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://other.example/" } }),
      )
      .mockResolvedValueOnce(new Response("ready"));
    await createHttpFetch({ headers: { authorization: "synthetic", "x-api-key": "synthetic" } })(
      "https://public.example/start",
      { method: "POST", body: "q=test", etag: "old" },
    );
    const init = transport.fetch.mock.calls[1][1];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.has("if-none-match")).toBe(false);
    expect(headers.has("content-type")).toBe(false);
  });

  it("bounds redirect loops while retaining one deadline", async () => {
    transport.fetch.mockImplementation(
      async () => new Response(null, { status: 307, headers: { location: "/again" } }),
    );
    await expect(createHttpFetch()("https://public.example/start")).rejects.toThrow(
      /redirect limit/,
    );
    expect(transport.fetch).toHaveBeenCalledTimes(21);
    expect(new Set(transport.fetch.mock.calls.map((call) => call[1].signal)).size).toBe(1);
  });

  it("preserves explicitly unguarded self-hosted search resolution", async () => {
    transport.fetch.mockResolvedValueOnce(new Response("local results"));
    const fetch = createHttpFetch({ guarded: false });
    transport.address = "127.0.0.1";
    const lookup = transport.lookups.at(-1)!;
    const result = await new Promise<Error | null>((done) =>
      lookup("search.local", { all: true }, (error) => done(error)),
    );
    expect(result).toBeNull();
    await expect(fetch("http://search.local/")).resolves.toMatchObject({ body: "local results" });
  });
});
