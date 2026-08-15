#!/usr/bin/env node
/**
 * Opt-in live smoke test: runs a minimal transcript through the engine in
 * live mode using the pi OpenRouter provider. Cost-bearing and manual; never
 * part of CI. Redacts all persisted records (no prompts or transcript text
 * are written anywhere).
 *
 * Usage: node scripts/live-smoke.mjs [--workspace <dir>]
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const workspaceDir = arg("--workspace", null);

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is required for the live smoke test.");
  process.exit(1);
}

const root = workspaceDir ?? mkdtempSync(join(tmpdir(), "live-smoke-"));
const { Workspace } = await import("@chief-of-staff/workflow");
const { ServiceRuntime } = await import("@chief-of-staff/service");

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
  mode: "live",
  developerMode: true,
  logger: { info: console.log, warn: console.warn, error: console.error },
});
await runtime.start();

const transcript = [
  "Meeting notes: Ada Lovelace to email supplier@example.com about the delivery timeline.",
  "Subject: Delivery timeline update. Ask for the updated schedule.",
  "Ada Lovelace to prepare a business plan for the subscription tier. Title: Subscription Tier Launch Plan.",
].join("\n");

const filename = "live-smoke.txt";
const inboxPath = join(workspace.layout.inboxDir, filename);
writeFileSync(inboxPath, transcript, "utf8");
const runId = await runtime.startRunFromInbox(inboxPath);

const manifest = await runtime.readManifest(runId);
console.log("");
console.log("LIVE SMOKE RESULT");
console.log("  runId:   ", runId);
console.log("  status:  ", manifest?.status);
console.log("  model:   ", manifest?.llm.model ?? "unknown");
console.log("  tasks:   ", manifest?.tasks?.length ?? 0);
console.log("  usage:   ", manifest?.usage ? JSON.stringify(manifest.usage) : "n/a");
console.log("  error:   ", manifest?.error ? `${manifest.error.code}: ${manifest.error.message}` : "none");
console.log("");

const ok = manifest?.status === "succeeded" && (manifest.tasks?.length ?? 0) > 0;
await runtime.stop();
if (!workspaceDir && existsSync(root)) {
  rmSync(root, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
