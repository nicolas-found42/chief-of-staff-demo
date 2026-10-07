import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function createRecordedVerdicts(replayExpected: boolean) {
  const corpus = JSON.parse(
    readFileSync(join(repoRoot, "tests/fixtures/content-scout/grouping-pairs.json"), "utf8"),
  ) as { pairs: Array<{ id: string; expected: string }> };
  return Object.fromEntries(
    corpus.pairs.map((pair) => [
      pair.id,
      {
        same: Number(replayExpected && pair.expected === "same"),
        different: Number(!replayExpected || pair.expected !== "same"),
        ambiguous: 0,
      },
    ]),
  );
}

describe("content-scout grouping evaluation CLI", () => {
  it("replays the bundled nested verdict fixture through the real entrypoint", () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pairs: 57  same-labeled: 16");
    expect(result.stdout).toContain("true merges: 16  false merges: 0  missed merges: 0");
    expect(result.stdout).toContain("gate: PASS");
  });

  it("replays the selected flat --record file offline and attributes the output to it", () => {
    const root = mkdtempSync(join(tmpdir(), "grouping-replay-"));
    const selected = join(root, "selected.json");
    writeFileSync(selected, `${JSON.stringify(createRecordedVerdicts(true))}\n`);
    try {
      const result = runCli(["--judgments", selected]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`judgments: ${selected}`);
      expect(result.stdout).toContain("true merges: 16  false merges: 0  missed merges: 0");
      expect(result.stdout).toContain("gate: PASS");

      writeFileSync(selected, `${JSON.stringify(createRecordedVerdicts(false))}\n`);
      const changed = runCli(["--judgments", selected]);
      expect(changed.status).toBe(1);
      expect(changed.stdout).toContain("true merges: 0  false merges: 0  missed merges: 16");
      expect(changed.stdout).toContain("gate: FAIL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replays a selected measured wrapper through --judgments", () => {
    const root = mkdtempSync(join(tmpdir(), "grouping-replay-measured-"));
    const selected = join(root, "measured.json");
    writeFileSync(selected, `${JSON.stringify({ measured: createRecordedVerdicts(true) })}\n`);
    try {
      const result = runCli(["--judgments", selected]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`judgments: ${selected}`);
      expect(result.stdout).toContain("true merges: 16  false merges: 0  missed merges: 0");
      expect(result.stdout).toContain("gate: PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing --judgments value instead of using the bundled fixture", () => {
    const result = runCli(["--judgments"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--judgments requires a file path");
    expect(result.stdout).not.toContain("gate:");
  });

  it("does not consume the next option as a --judgments path", () => {
    const result = runCli(["--judgments", "--help"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--judgments requires a file path");
  });

  it("reports nonexistent, malformed, and unsupported selected replay files", () => {
    const root = mkdtempSync(join(tmpdir(), "grouping-replay-invalid-"));
    const missing = join(root, "missing.json");
    const malformed = join(root, "malformed.json");
    const unsupported = join(root, "unsupported.json");
    writeFileSync(malformed, "{");
    writeFileSync(
      unsupported,
      JSON.stringify({ pair_1: { same: "yes", different: 0, ambiguous: 0 } }),
    );
    try {
      for (const path of [missing, malformed, unsupported]) {
        const result = runCli(["--judgments", path]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(path);
        expect(result.stdout).not.toContain("gate:");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("documents supported replay formats in help and keeps replay offline", () => {
    const help = runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("default: bundled fixture");
    expect(help.stdout).toContain("flat pair-id map");
    expect(help.stdout).toContain("measured");

    const root = mkdtempSync(join(tmpdir(), "grouping-replay-mode-"));
    const selected = join(root, "selected.json");
    writeFileSync(selected, `${JSON.stringify(createRecordedVerdicts(true))}\n`);
    try {
      const live = runCli(["--live", "--judgments", selected]);
      expect(live.status).not.toBe(0);
      expect(live.stderr).toContain("cannot be combined");
      expect(live.stdout).not.toContain("gate:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
