import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  createHttpFetch,
  createSourceHttpDispatcher,
} from "../../../apps/server/src/source-adapters/http.js";

async function withOrigin(
  write: (response: ServerResponse) => void,
  test: (url: string) => Promise<void>,
) {
  const server = createServer((_request, response) => write(response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  try {
    await test(`http://127.0.0.1:${address.port}/`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

describe("real source stream cleanup", () => {
  it("limits decompressed data despite a small compressed Content-Length", async () => {
    const compressed = gzipSync(Buffer.alloc(20_000_000, 97));
    const dispatcher = createSourceHttpDispatcher(false);
    try {
      await withOrigin(
        (response) => {
          response.writeHead(200, {
            "content-encoding": "gzip",
            "content-length": compressed.length,
          });
          response.end(compressed);
        },
        async (url) => {
          await expect(createHttpFetch({ guarded: false, dispatcher })(url)).rejects.toMatchObject({
            code: "ERR_SOURCE_BODY_LIMIT",
          });
        },
      );
    } finally {
      await dispatcher.destroy();
    }
  });
  it("closes a slow body on the shared deadline and remains usable afterward", async () => {
    const dispatcher = createSourceHttpDispatcher(false);
    const closed = Promise.withResolvers<void>();
    let reads = 0;
    try {
      await withOrigin(
        (response) => {
          reads += 1;
          if (reads > 1) {
            response.end("recovered");
            return;
          }
          response.on("close", closed.resolve);
          response.writeHead(200);
          response.write("partial");
        },
        async (url) => {
          const read = createHttpFetch({ guarded: false, dispatcher });
          await expect(read(url, { timeoutMs: 50 })).rejects.toMatchObject({ name: "AbortError" });
          await closed.promise;
          await expect(read(url)).resolves.toMatchObject({ body: "recovered" });
        },
      );
    } finally {
      await dispatcher.destroy();
    }
  });
});
