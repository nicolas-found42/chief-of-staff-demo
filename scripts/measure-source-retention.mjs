import { createServer } from "node:http";
import { once } from "node:events";
import { fetch } from "../apps/server/node_modules/undici/index.js";
import {
  readSourceBytes,
  readSourceText,
} from "../apps/server/dist/source-adapters/source-body.js";

// Synthetic loopback origin only. Run each arm in a fresh --expose-gc process;
// baseline reproduces the exact previous full-buffer/check collection order.
const [mode, kind] = process.argv.slice(2);
if (!["before", "after"].includes(mode) || !["text", "bytes"].includes(kind))
  throw new Error(
    "Usage: node --expose-gc scripts/measure-source-retention.mjs before|after text|bytes",
  );
let sent = 0;
const server = createServer(async (_request, response) => {
  const chunk = Buffer.alloc(65_536, 97);
  for (let i = 0; i < 1600 && !response.destroyed; i += 1) {
    sent += chunk.length;
    if (!response.write(chunk)) {
      await new Promise((resolve) => {
        const finish = () => {
          response.off("drain", finish);
          response.off("close", finish);
          resolve();
        };
        response.once("drain", finish);
        response.once("close", finish);
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  response.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
global.gc?.();
const baseline = process.memoryUsage();
let peak = baseline.rss;
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 1);
let outcome;
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  if (mode === "before") {
    const body =
      kind === "text" ? await response.text() : Buffer.from(await response.arrayBuffer());
    peak = Math.max(peak, process.memoryUsage().rss);
    if (body.length > 5_000_000) throw new Error("limit");
  } else {
    await (kind === "text" ? readSourceText(response.body) : readSourceBytes(response.body));
  }
  outcome = "success";
} catch (error) {
  const expected =
    mode === "before"
      ? error instanceof Error && error.message === "limit"
      : error instanceof Error && "code" in error && error.code === "ERR_SOURCE_BODY_LIMIT";
  if (!expected) throw error;
  outcome = "rejected";
} finally {
  clearInterval(sampler);
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}
console.log(
  JSON.stringify({
    mode,
    kind,
    node: process.version,
    outcome,
    sentBytes: sent,
    baselineRss: baseline.rss,
    peakRss: peak,
    deltaRss: peak - baseline.rss,
  }),
);
