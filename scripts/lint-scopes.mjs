import { spawnSync } from "node:child_process";

/**
 * Serial per-workspace full-tree lint with progress lines.
 *
 * One `eslint .` invocation holds every workspace's type information in a
 * single process and prints nothing until the end, which reads as a stall
 * (cold full runs exceed 5 minutes silently). The same coverage split into
 * one invocation per scope fails fast per scope and reports a progress line
 * every few seconds; measured total is ~55s cold. Scopes below must keep
 * covering everything `eslint .` would: the five workspaces plus the root
 * config file and scripts/.
 */
const SCOPES = [
  "apps/server",
  "apps/web",
  "packages/shared",
  "tests",
  "relay",
  "scripts",
  "eslint.config.js",
];

const started = Date.now();
let failed = false;
for (const [index, scope] of SCOPES.entries()) {
  process.stdout.write(`[lint ${index + 1}/${SCOPES.length}] ${scope} …\n`);
  const scopeStarted = Date.now();
  const result = spawnSync(
    "pnpm",
    ["exec", "eslint", scope, "--max-warnings", "0", "--cache", "--concurrency", "auto"],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  const elapsed = ((Date.now() - scopeStarted) / 1000).toFixed(1);
  if (result.status !== 0) {
    process.stdout.write(`[lint ${index + 1}/${SCOPES.length}] ${scope} FAILED (${elapsed}s)\n`);
    failed = true;
    break;
  }
  process.stdout.write(`[lint ${index + 1}/${SCOPES.length}] ${scope} ok (${elapsed}s)\n`);
}
process.stdout.write(`[lint] total ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
process.exit(failed ? 1 : 0);
