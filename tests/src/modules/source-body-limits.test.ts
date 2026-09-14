import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHttpFetch,
  publicHttpFetchBytes,
} from "../../../apps/server/src/source-adapters/http.js";
import {
  readSourceBytes,
  readSourceText,
} from "../../../apps/server/src/source-adapters/source-body.js";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async (original) => ({ ...(await original<typeof import("undici")>()), fetch }));
beforeEach(() => fetch.mockReset());

function streamed(chunks: number, size: number) {
  let produced = 0;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (produced === chunks) controller.close();
        else {
          produced += 1;
          controller.enqueue(new Uint8Array(size).fill(97));
        }
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  fetch.mockResolvedValue(new Response(body, { headers: { "content-length": "1" } }));
  return { produced: () => produced, cancelled };
}

describe("source collection retention", () => {
  it.each(["text", "bytes"])("bounds decompressed %s expansion", async (kind) => {
    const plain = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(new Uint8Array(gzipSync(Buffer.alloc(12_000_000, 97))));
        controller.close();
      },
    });
    const decoded = plain.pipeThrough(new DecompressionStream("gzip"));
    await expect(
      (kind === "text" ? readSourceText : readSourceBytes)(decoded),
    ).rejects.toMatchObject({ code: "ERR_SOURCE_BODY_LIMIT" });
    expect(decoded.locked).toBe(false);
  });
  it.each(["text", "bytes"])(
    "releases %s reader after an interrupted slow stream",
    async (kind) => {
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new Uint8Array([97]));
        },
      });
      const result = (kind === "text" ? readSourceText : readSourceBytes)(stream);
      const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await Promise.resolve();
      streamController!.error(new DOMException("Timed out", "AbortError"));
      await assertion;
      expect(stream.locked).toBe(false);
    },
  );
  it.each(["text", "bytes"])(
    "cancels oversized %s before collecting the entire stream",
    async (kind) => {
      const source = streamed(100, 1_000_000);
      const read = kind === "text" ? createHttpFetch() : publicHttpFetchBytes;
      const outcome = await read("https://public.example/").catch((error: unknown) => error);
      expect(source.produced()).toBe(6);
      expect(outcome).toMatchObject({ code: "ERR_SOURCE_BODY_LIMIT" });
      expect(source.cancelled).toHaveBeenCalledOnce();
    },
  );
  it.each(["text", "bytes"])(
    "rejects a single oversized %s chunk without retaining it",
    async (kind) => {
      const source = streamed(2, 16_000_000);
      await expect(
        (kind === "text" ? createHttpFetch() : publicHttpFetchBytes)("https://public.example/"),
      ).rejects.toMatchObject({ code: "ERR_SOURCE_BODY_LIMIT" });
      expect(source.produced()).toBe(1);
      expect(source.cancelled).toHaveBeenCalledOnce();
    },
  );
  it("preserves the five-million UTF-16 character text contract and split UTF-8", async () => {
    const bytes = new TextEncoder().encode("é".repeat(4_999_999) + "中");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 1));
        controller.enqueue(bytes.subarray(1));
        controller.close();
      },
    });
    fetch.mockResolvedValue(new Response(body));
    const result = await createHttpFetch()("https://public.example/");
    expect(result.body).toBe("é".repeat(4_999_999) + "中");
  });
  it("accepts the largest valid UTF-8 encoding of the character limit, including its BOM", async () => {
    fetch.mockResolvedValue(
      new Response(new TextEncoder().encode("\ufeff" + "中".repeat(5_000_000))),
    );
    await expect(createHttpFetch()("https://public.example/")).resolves.toMatchObject({
      body: "中".repeat(5_000_000),
    });
  });
  it.each(["text", "bytes"])("accepts exactly the %s limit", async (kind) => {
    const source = streamed(5, 1_000_000);
    const result = await (kind === "text" ? createHttpFetch() : publicHttpFetchBytes)(
      "https://public.example/",
    );
    expect("body" in result ? result.body.length : result.bytes.length).toBe(5_000_000);
    expect(source.cancelled).not.toHaveBeenCalled();
  });
});
