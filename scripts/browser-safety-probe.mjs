// Run in the built production image with --network none and a temporary Workspace.
// MockAgent is the controlled public server substitute; the separate loopback
// fixture counts attempted bypasses. No request reaches an external destination.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { playwrightBrowserRenderer } from "../apps/server/dist/source-adapters/browser.js";
import { createBrowserResourceFetch } from "../apps/server/dist/source-adapters/browser-network.js";
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { MockAgent } = require("undici");
const { chromium } = require("playwright-core");

console.log(
  JSON.stringify({
    node: process.version,
    sandbox: execFileSync("/usr/local/bin/browser-network-sandbox", ["--self-test"], {
      encoding: "utf8",
    }).trim(),
  }),
);
let destinationRequests = 0;
const destination = createServer((_request, response) => {
  destinationRequests++;
  response.end("forbidden fixture");
});
await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
const port = destination.address().port;
const agent = new MockAgent();
agent.disableNetConnect();
const origin = agent.get("https://public.example");
const render = playwrightBrowserRenderer(createBrowserResourceFetch(agent));
const results = [];
try {
  origin
    .intercept({ path: "/" })
    .reply(
      200,
      '<html><head><script src="/script.js"></script></head><body>Rendered</body></html>',
      { headers: { "content-type": "text/html" } },
    );
  origin
    .intercept({ path: "/script.js" })
    .reply(200, 'document.title="Allowed public JavaScript";', {
      headers: { "content-type": "application/javascript" },
    });
  const allowed = await render("https://public.example/");
  assert.match(allowed.body, /Allowed public JavaScript/);
  results.push("allowed HTML and JavaScript rendering");

  for (const host of ["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "[fc00::1]"]) {
    await assert.rejects(render(`http://${host}:${port}/`), /public host/);
  }
  results.push("IPv4, IPv6, mapped initial targets rejected");
  // Invocation maps this synthetic hostname to the dedicated loopback fixture.
  // This exercises the production resolver and socket hook, not MockAgent.
  await assert.rejects(playwrightBrowserRenderer()(`http://private-dns.example:${port}/`));
  assert.equal(destinationRequests, 0);
  results.push("actual socket DNS private answer rejected before fixture");

  origin
    .intercept({ path: "/redirect" })
    .reply(302, "", { headers: { location: `http://127.0.0.1:${port}/` } });
  await assert.rejects(render("https://public.example/redirect"), /public host/);
  results.push("forbidden redirect rejected before destination");

  origin
    .intercept({ path: "/subresource" })
    .reply(
      200,
      `<html><script src="http://127.0.0.1:${port}/"></script><body>Blocked resource</body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  await assert.rejects(render("https://public.example/subresource"), /public host/);
  results.push("forbidden subresource rejected before destination");

  let controlReport;
  let workerRequests = 0;
  let releaseControls;
  const controlsReady = new Promise((resolve) => {
    releaseControls = resolve;
  });
  const broker = createBrowserResourceFetch(agent);
  const controlsFetch = async (url, ...args) => {
    const target = new URL(url);
    if (target.pathname === "/controls-result") {
      controlReport = JSON.parse(target.searchParams.get("result"));
      releaseControls();
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    }
    if (target.pathname === "/controls-hold.js") {
      await controlsReady;
      return {
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: Buffer.alloc(0),
      };
    }
    if (target.pathname === "/worker.js") {
      workerRequests++;
      return {
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: Buffer.from("self.addEventListener('install', () => self.skipWaiting());"),
      };
    }
    return broker(url, ...args);
  };
  origin.intercept({ path: "/socket" }).reply(
    200,
    `<html><head><script>
    const socketResult = new Promise((resolve) => {
      const socket = new WebSocket('wss://public.example/controls-socket');
      socket.addEventListener('close', (event) => resolve({ code: event.code, clean: event.wasClean }));
    });
    const workerResult = navigator.serviceWorker.register('/worker.js').then(
      async (registration) => ({ settled: "resolved", registrationReturned: registration !== undefined, registrations: (await navigator.serviceWorker.getRegistrations()).length }),
      (error) => ({ settled: "rejected", message: error.message })
    );
    Promise.all([socketResult, workerResult]).then(([socket, worker]) =>
      fetch('/controls-result?result=' + encodeURIComponent(JSON.stringify({ socket, worker })))
    );
    </script><script src="/controls-hold.js"></script></head><body>Controls settled</body></html>`,
    { headers: { "content-type": "text/html" } },
  );
  await playwrightBrowserRenderer(controlsFetch)("https://public.example/socket");
  assert.deepEqual(controlReport.socket, { code: 1008, clean: true });
  assert.deepEqual(controlReport.worker, {
    settled: "resolved",
    registrationReturned: false,
    registrations: 0,
  });
  assert.equal(workerRequests, 0);
  results.push(
    "WebSocket clean policy close code1008 and Service Worker registration returns no registration, registry empty, and no worker resource requested",
  );

  const assetCount = 21;
  origin
    .intercept({ path: "/redirected-assets" })
    .reply(
      200,
      `<html><head>${Array.from({ length: assetCount }, (_, index) => `<script src="/asset-${index}.js"></script>`).join("")}</head><body>Assets rendered</body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  for (let index = 0; index < assetCount; index++) {
    origin
      .intercept({ path: `/asset-${index}.js` })
      .reply(302, "", { headers: { location: `/resolved-${index}.js` } });
    origin
      .intercept({ path: `/resolved-${index}.js` })
      .reply(
        200,
        "document.documentElement.dataset.assetCount = String(Number(document.documentElement.dataset.assetCount || 0) + 1);",
        { headers: { "content-type": "application/javascript" } },
      );
  }
  const assets = await render("https://public.example/redirected-assets");
  assert.match(assets.body, /data-asset-count="21"/);
  results.push("21 redirected script assets render without consuming the document redirect budget");

  origin.intercept({ path: "/oversized" }).reply(200, Buffer.alloc(5_000_001));
  await assert.rejects(render("https://public.example/oversized"), {
    code: "ERR_SOURCE_BODY_LIMIT",
  });
  results.push("oversized broker response rejected");

  origin
    .intercept({ path: "/dom-growth" })
    .reply(
      200,
      '<html><body><script>document.body.append("x".repeat(5000001))</script></body></html>',
      { headers: { "content-type": "text/html" } },
    );
  await assert.rejects(render("https://public.example/dom-growth"), {
    code: "ERR_SOURCE_BODY_LIMIT",
  });
  results.push("JavaScript-expanded DOM rejected before Node receives HTML");

  for (let i = 0; i < 5; i++) {
    origin
      .intercept({ path: "/redirect-ok" })
      .reply(302, "", { headers: { location: "/landing" } });
    origin
      .intercept({ path: "/landing" })
      .reply(404, "<html><body>Landing document</body></html>", {
        headers: { "content-type": "text/html" },
      });
    const landing = await render("https://public.example/redirect-ok");
    assert.equal(landing.url, "https://public.example/landing");
    assert.equal(landing.status, 404);
    assert.match(landing.body, /Landing document/);
  }
  results.push("five redirect repetitions retain final document origin, body and 404 status");

  origin
    .intercept({ path: "/loop" })
    .reply(302, "", { headers: { location: "/loop" } })
    .persist();
  await assert.rejects(render("https://public.example/loop"), /redirect limit|timed out/);
  results.push("document redirect loop stopped by the shared deadline or twenty-hop ceiling");

  origin.intercept({ path: "/slow" }).reply(200, "late").delay(20000);
  const slowStarted = Date.now();
  await assert.rejects(render("https://public.example/slow"), { name: "AbortError" });
  assert.ok(Date.now() - slowStarted < 20000);
  results.push("slow producer canceled at the shared 15 second deadline");

  // Deliberately remove routing altogether: the kernel, not route callbacks,
  // must stop Chromium's independent network stack before the fixture sees it.
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/local/bin/browser-network-sandbox",
  });
  try {
    const page = await browser.newPage();
    await assert.rejects(page.goto(`http://127.0.0.1:${port}/`, { timeout: 3000 }));
  } finally {
    await browser.close();
  }
  assert.equal(destinationRequests, 0);
  results.push("unrouted Chromium direct TCP bypass denied by kernel; destination count zero");
  const forbiddenDestinationRequests = destinationRequests;
  const unguarded = await chromium.launch({ headless: true });
  try {
    const page = await unguarded.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    assert.ok(destinationRequests > 0);
  } finally {
    await unguarded.close();
  }
  results.push("positive control: original unguarded Chromium reaches the same controlled fixture");
  agent.assertNoPendingInterceptors();
  console.log(
    JSON.stringify(
      {
        passed: results,
        forbiddenDestinationRequests,
        positiveControlRequests: destinationRequests,
        memory: process.memoryUsage(),
        containerPeakBytes: Number(readFileSync("/sys/fs/cgroup/memory.peak", "utf8").trim()),
        containerLimitBytes: Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim()),
      },
      null,
      2,
    ),
  );
} finally {
  await agent.close();
  await new Promise((resolve) => destination.close(resolve));
}
