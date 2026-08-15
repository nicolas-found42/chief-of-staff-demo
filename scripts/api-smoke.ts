/**
 * Manual integration smoke: exercises the ServiceRuntime + ApiServer against a
 * temp workspace in replay mode. Not part of the unit suite.
 */
import { Workspace } from "@chief-of-staff/workflow";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceRuntime } from "../apps/service/src/runtime.ts";


const root = mkdtempSync(join(tmpdir(), "api-smoke-"));
const workspace = new Workspace(root);
await workspace.initialize();
writeFileSync(
  join(root, "config", "profile.json"),
  JSON.stringify({
    name: "Ada Lovelace",
    title: "Chief of Staff",
    company: "Analytical Engines Inc.",
    writingStyle: "I am concise in my communication, polite but direct. I prefer shorter emails.",
    focusAreas: ["Customer success", "Product quality", "Operational efficiency"],
  })
);

const runtime = new ServiceRuntime({
  workspace,
  repoRoot: process.cwd(),
  mode: "replay",
  fixturesDir: join(process.cwd(), "fixtures", "llm"),
  developerMode: true,
  logger: { info() {}, warn() {}, error() {} },
});
await runtime.start();
const code = runtime.issuePairingCode();
const server = new ApiServer({ runtime, host: "127.0.0.1", port: 4499, log() {} });
await server.start();

const base = "http://127.0.0.1:4499";
const pair = await (
  await fetch(`${base}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
).json();
console.log("pair:", Boolean(pair.sessionToken));
const headers = { authorization: `Bearer ${pair.sessionToken}`, origin: "http://localhost:5173" };

const config = await (await fetch(`${base}/v1/config`, { headers })).json();
console.log("config readiness errors:", config.readiness.errors);
console.log("openRouterConfigured:", config.openRouterConfigured);

const transcript = readFileSync(join(process.cwd(), "fixtures", "transcripts", "golden-meeting.txt"));
const form = new FormData();
form.append("file", new Blob([transcript], { type: "text/plain" }), "golden-meeting.txt");
const upload = await (
  await fetch(`${base}/v1/transcripts`, { method: "POST", headers: { authorization: `Bearer ${pair.sessionToken}`, origin: "http://localhost:5173" }, body: form })
).json();
console.log("upload:", JSON.stringify(upload));
const runId = upload.runId;

let detail = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250));
  detail = await (await fetch(`${base}/v1/runs/${runId}`, { headers })).json();
  if (detail.manifest && detail.manifest.status !== "running") break;
}
console.log("run status:", detail.manifest?.status);
console.log("tasks:", detail.manifest?.tasks?.map((t) => t.type).join(","));
console.log("warnings:", detail.manifest?.warnings?.map((w) => w.code).join(","));
console.log("artifacts:", detail.artifacts?.length);

const events = await (await fetch(`${base}/v1/runs/${runId}/events`, { headers })).text();
console.log("events lines:", events.trim().split("\n").length);

const draft = detail.artifacts?.find((a) => a.type === "gmail-draft");
if (draft) {
  const artifact = await (
    await fetch(`${base}/v1/artifacts/${draft.artifactId}`, { headers })
  ).text();
  console.log("draft preview ok:", artifact.includes("Delivery timeline update"));
}

const runs = await (await fetch(`${base}/v1/runs`, { headers })).json();
console.log("runs:", runs.total, runs.runs[0]?.status);

await server.stop();
await runtime.stop();
console.log("SMOKE OK");
