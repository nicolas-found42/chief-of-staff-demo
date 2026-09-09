import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHttpFetch,
  createSourceHttpDispatcher,
  type PublicHttpFetch,
  type SourceHttpDispatcher,
} from "../../../apps/server/src/source-adapters/http.js";

/**
 * Pooled HTTP dispatch for collection fetches (speed lever 3): sequential
 * requests share keep-alive sockets per origin, aborts keep their shape, and
 * the SSRF guard still fires before any socket opens. Loopback is
 * guard-blocked by design, so the pooling cases run unguarded while the guard
 * case asserts no connection reaches its server.
 */

const servers: Server[] = [];
const dispatchers: SourceHttpDispatcher[] = [];

async function closeServers(): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let pending = servers.length;
  if (pending === 0) {
    resolve();
  } else {
    for (const server of servers) {
      server.close((error) => {
        if (error) reject(error);
        else if ((pending -= 1) === 0) resolve();
      });
    }
  }
  await promise;
  servers.length = 0;
}

async function closeDispatchers(): Promise<void> {
  await Promise.all(dispatchers.map((dispatcher) => dispatcher.close()));
  dispatchers.length = 0;
}

interface LocalOrigin {
  url: string;
  connections: () => number;
}

async function startOrigin(body: string, hang = false): Promise<LocalOrigin> {
  let connections = 0;
  const server = createServer((_request, response) => {
    if (!hang) response.end(body);
  });
  server.on("connection", () => {
    connections += 1;
  });
  servers.push(server);
  const bound = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", bound.resolve);
  await bound.promise;
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server failed to bind a local port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    connections: () => connections,
  };
}

/** An isolated transport per caller: its own Agent, never the process singleton. */
function isolatedFetch(guarded = false): {
  fetchText: PublicHttpFetch;
  dispatcher: SourceHttpDispatcher;
} {
  const dispatcher = createSourceHttpDispatcher();
  dispatchers.push(dispatcher);
  const fetchText = guarded
    ? createHttpFetch({ dispatcher })
    : createHttpFetch({ guarded: false, dispatcher });
  return { fetchText, dispatcher };
}

/**
 * The pool hands its socket back a tick after the body resolves. Wait for the
 * free slot itself instead of guessing a delay, so reuse is deterministic:
 * the next request is only sent once a pooled socket is available to take it.
 */
async function waitForPooledConnection(
  dispatcher: SourceHttpDispatcher,
  originUrl: string,
): Promise<void> {
  const origin = new URL(originUrl).origin;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const entry: unknown = dispatcher.stats[origin];
    if (
      typeof entry === "object" &&
      entry !== null &&
      "free" in entry &&
      typeof entry.free === "number" &&
      entry.free >= 1
    ) {
      return;
    }
    const tick = Promise.withResolvers<void>();
    setImmediate(tick.resolve);
    await tick.promise;
  }
  throw new Error(`Pooled connection for ${origin} never returned to the pool.`);
}

describe("Source HTTP pooled dispatch", () => {
  afterEach(async () => {
    // Agents first: closing them drops the keep-alive sockets the servers wait on.
    await closeDispatchers();
    await closeServers();
  });

  it("reuses one connection for sequential requests to the same origin", async () => {
    const origin = await startOrigin("hello");
    const { fetchText, dispatcher } = isolatedFetch();

    const first = await fetchText(origin.url);
    expect(first).toMatchObject({ status: 200, body: "hello" });
    await waitForPooledConnection(dispatcher, origin.url);

    const second = await fetchText(origin.url);
    expect(second).toMatchObject({ status: 200, body: "hello" });
    await waitForPooledConnection(dispatcher, origin.url);

    expect(origin.connections()).toBe(1);
    // The socket belongs to the injected agent, not some ambient dispatcher.
    expect(Object.keys(dispatcher.stats)).toContain(new URL(origin.url).origin);
  });

  it("opens a separate connection per origin", async () => {
    const firstOrigin = await startOrigin("a");
    const secondOrigin = await startOrigin("b");
    const { fetchText, dispatcher } = isolatedFetch();

    await expect(fetchText(firstOrigin.url)).resolves.toMatchObject({ status: 200, body: "a" });
    await waitForPooledConnection(dispatcher, firstOrigin.url);
    await expect(fetchText(secondOrigin.url)).resolves.toMatchObject({ status: 200, body: "b" });
    await waitForPooledConnection(dispatcher, secondOrigin.url);

    expect(firstOrigin.connections()).toBe(1);
    expect(secondOrigin.connections()).toBe(1);
    expect(Object.keys(dispatcher.stats).sort()).toEqual(
      [new URL(firstOrigin.url).origin, new URL(secondOrigin.url).origin].sort(),
    );
  });

  it("still aborts on the per-request timeout with the existing error shape", async () => {
    const origin = await startOrigin("never", true);
    const { fetchText } = isolatedFetch();

    const outcome = await fetchText(origin.url, { timeoutMs: 100 }).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    const failure = outcome as Error;
    expect(failure.name).toBe("AbortError");
    expect(failure.message).toBe("This operation was aborted");
  });

  it("propagates a DNS failure as a fetch error instead of crashing", async () => {
    /* autoSelectFamily asks the resolver for the all:true address list; a
       resolver error arriving with no address list used to throw a TypeError
       from inside the connect callback and take the process down (live arm,
       2026-09-09). It must surface as an ordinary fetch failure. */
    const { fetchText } = isolatedFetch();
    await expect(
      fetchText("https://pooled-lookup-dns-failure.invalid/", { timeoutMs: 5_000 }),
    ).rejects.toThrow();
  });

  it("still blocks non-public targets before any socket opens", async () => {
    const origin = await startOrigin("hello");
    const { fetchText } = isolatedFetch(true);

    await expect(fetchText(origin.url)).rejects.toThrow(
      "Source Targets must resolve to a public host.",
    );
    await expect(fetchText("http://localhost/")).rejects.toThrow(
      "Source Targets must resolve to a public host.",
    );
    expect(origin.connections()).toBe(0);
  });
});
