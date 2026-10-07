import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function runCli(args: string[], script = "scripts/content-scout-grouping-eval.mts") {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, OPENROUTER_API_KEY: "" },
  });
  if (result.status === null) {
    throw new Error(`grouping evaluation CLI did not exit: ${result.error?.message ?? "unknown"}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function createIsolatedDefaultFixture(root: string, verdicts?: string) {
  const fixtureDir = join(root, "tests/fixtures/content-scout");
  mkdirSync(fixtureDir, { recursive: true });
  cpSync(
    join(repoRoot, "tests/fixtures/content-scout/grouping-pairs.json"),
    join(fixtureDir, "grouping-pairs.json"),
  );
  if (verdicts !== undefined)
    writeFileSync(join(fixtureDir, "grouping-pairs-verdicts.json"), verdicts);
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(
    join(repoRoot, "scripts/content-scout-grouping-eval.mts"),
    join(root, "scripts/content-scout-grouping-eval.mts"),
  );
  symlinkSync(join(repoRoot, "apps"), join(root, "apps"), "dir");
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
}

describe("content-scout grouping evaluation CLI", () => {
  it("replays the bundled nested verdict fixture through the real entrypoint", () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pairs: 57  same-labeled: 16");
    expect(result.stdout).toContain("true merges: 16  false merges: 0  missed merges: 0");
    expect(result.stdout).toContain("gate: PASS");
  });

  it("reports unreadable verdict input as an actionable input error", () => {
    const root = mkdtempSync(join(tmpdir(), "grouping-verdicts-"));
    createIsolatedDefaultFixture(root);
    const missing = join(root, "tests/fixtures/content-scout/grouping-pairs-verdicts.json");
    try {
      const result = runCli([], join(root, "scripts/content-scout-grouping-eval.mts"));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(missing);
      expect(result.stderr).toContain("verdict");
      expect(result.stdout).not.toContain("gate: FAIL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports invalid verdict structure without scoring missing model decisions", () => {
    const root = mkdtempSync(join(tmpdir(), "grouping-verdicts-"));
    createIsolatedDefaultFixture(root, JSON.stringify({ measured: [] }));
    const invalid = join(root, "tests/fixtures/content-scout/grouping-pairs-verdicts.json");
    try {
      const result = runCli([], join(root, "scripts/content-scout-grouping-eval.mts"));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(invalid);
      expect(result.stderr).toContain("measured");
      expect(result.stdout).not.toContain("gate: FAIL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
