import { spawnSync } from "node:child_process";

/**
 * Bound typed-lint memory to one workspace at a time. A single full-tree
 * process exhausted its 4 GB heap in the 2026-09-06 audit. Automatic ESLint
 * workers duplicate TypeScript programs, so each scope runs in one process.
 *
 * Do not cache typed results: changing an imported type can invalidate a
 * caller without changing its bytes. The final pass covers the rest of the
 * tree so root files and new directories cannot fall outside this gate.
 */
const SCOPES = ["apps/server", "apps/web", "packages/shared", "tests", "relay", "scripts", "."];

const started = Date.now();
let failed = false;
for (const [index, scope] of SCOPES.entries()) {
  process.stdout.write(`[lint ${index + 1}/${SCOPES.length}] ${scope} …\n`);
  const scopeStarted = Date.now();
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "eslint",
      scope,
      "--max-warnings",
      "0",
      "--concurrency",
      "off",
      ...(scope === "."
        ? SCOPES.slice(0, -1).flatMap((covered) => ["--ignore-pattern", `${covered}/**`])
        : []),
    ],
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
