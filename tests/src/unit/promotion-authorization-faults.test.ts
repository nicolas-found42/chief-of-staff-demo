import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "../../../apps/server/src/config";
import { WorkspacePromotionAuthorization } from "../../../apps/server/src/tasks/promotion-authorization";

/**
 * Fault proofs for the promotion authorization record (issue #360). The record
 * is the one stored format this change adds, and these are the faults the issue
 * names for it, at the file boundary rather than through a mock: real writes,
 * truncation, a read-only directory, an exhausted file-size limit, a restore
 * performed twice, and isolated restoration from a copy.
 *
 * Host and power-loss durability is explicitly not claimed; what is proven here
 * is the process-visible boundary — a refused write leaves the previous record
 * exactly where it was, and the record survives being restored.
 */
const NOW = new Date("2026-09-04T09:00:00.000Z");

let root: string;
let configFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cos-promotion-faults-"));
  configFile = join(root, "config.json");
});

afterEach(() => {
  chmodSync(root, 0o755);
});

function authorization(now = NOW) {
  const store = new ConfigStore(configFile);
  store.load({ persist: false });
  return {
    store,
    promotion: new WorkspacePromotionAuthorization({ configStore: store, now: () => now }),
  };
}

function readConfig(): AppConfig {
  const store = new ConfigStore(configFile);
  return store.load({ persist: false });
}

const EVIDENCE = { reference: "private-release-evidence/baseline-9", checksum: "c".repeat(64) };

describe("the record's real writes", () => {
  it("writes the release and the enablement to the file, and reads them back", () => {
    const { promotion } = authorization();
    expect(existsSync(configFile)).toBe(false);

    promotion.recordRelease(EVIDENCE);
    const afterRelease = readFileSync(configFile, "utf8");
    expect(afterRelease).toContain('"promotion"');
    expect(afterRelease).toContain("private-release-evidence/baseline-9");

    promotion.enable();
    const afterEnable = readFileSync(configFile, "utf8");
    expect(afterEnable).not.toBe(afterRelease);

    // A second reader over the same bytes sees exactly what was committed.
    expect(readConfig().tasks.promotion.decisions.map((decision) => decision.kind)).toEqual([
      "enable",
    ]);
    expect(promotion.facts("auto-create-mine")).toMatchObject({
      released: true,
      enabledAt: NOW.toISOString(),
    });
  });

  it("refuses an unreadable record rather than quietly returning to the default", () => {
    const { promotion } = authorization();
    promotion.recordRelease(EVIDENCE);

    // Truncation: the file exists, holds half a document, and must not read as
    // "no release recorded".
    writeFileSync(configFile, readFileSync(configFile, "utf8").slice(0, 120));
    const store = new ConfigStore(configFile);
    expect(() => store.load({ persist: false })).toThrow();

    // The reader that cannot read the record cannot authorize anything.
    expect(() => authorization()).toThrow();
  });
});

describe("a refused write", () => {
  it("leaves the previous record exactly where it was when the directory is read-only", () => {
    const { promotion } = authorization();
    promotion.recordRelease(EVIDENCE);
    const held = readFileSync(configFile, "utf8");

    chmodSync(root, 0o555);
    expect(() => promotion.enable()).toThrow();
    chmodSync(root, 0o755);

    expect(readFileSync(configFile, "utf8")).toBe(held);
    expect(readConfig().tasks.promotion.decisions).toEqual([]);
  });

  it("leaves the previous record exactly where it was when the file-size limit is exhausted", () => {
    const { promotion } = authorization();
    promotion.recordRelease(EVIDENCE);
    const held = readFileSync(configFile, "utf8");
    const script = join(root, "exhaust.mjs");
    writeFileSync(
      script,
      `import { ConfigStore } from ${JSON.stringify(
        join(import.meta.dirname, "../../../apps/server/src/config.ts"),
      )};\n` +
        "const store = new ConfigStore(process.argv[2]);\n" +
        "store.load({ persist: false });\n" +
        "const config = store.get();\n" +
        "store.setPromotionAuthorization({\n" +
        "  ...config.tasks.promotion,\n" +
        "  decisions: [...config.tasks.promotion.decisions, { id: 'd', kind: 'enable', at: 'now' }],\n" +
        "});\n",
    );
    const run = spawnSync(
      "bash",
      [
        "-c",
        `ulimit -f 1; ${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(script)} ${JSON.stringify(configFile)}`,
      ],
      { encoding: "utf8" },
    );

    expect(run.status, run.stderr).not.toBe(0);
    chmodSync(root, 0o755);
    expect(readFileSync(configFile, "utf8")).toBe(held);
    expect(readConfig().tasks.promotion.decisions).toEqual([]);
  });
});

describe("restoration", () => {
  it("restores the record twice from a copy and reads the same release both times", () => {
    const { promotion } = authorization();
    promotion.recordRelease(EVIDENCE);
    promotion.enable();
    const baseline = join(root, "config.baseline.json");
    copyFileSync(configFile, baseline);
    const expected = readConfig().tasks.promotion;

    // First recovery: the current file is truncated, then restored.
    writeFileSync(configFile, "{");
    copyFileSync(baseline, configFile);
    expect(readConfig().tasks.promotion).toEqual(expected);

    // Second recovery, from the same copy, into the same place.
    writeFileSync(configFile, "");
    copyFileSync(baseline, configFile);
    expect(readConfig().tasks.promotion).toEqual(expected);

    const restored = authorization();
    expect(restored.promotion.facts("auto-create-mine")).toMatchObject({
      released: true,
      enabledAt: NOW.toISOString(),
    });
  });

  it("reads a workspace that predates the record as restricted, in isolation", () => {
    /* No writers, no connector, no scheduler: the isolated restoration of an
       affected state is a plain read of the restored bytes. */
    const { promotion } = authorization();
    promotion.recordRelease(EVIDENCE);
    const baseline = join(root, "config.baseline.json");
    copyFileSync(configFile, baseline);

    const legacy = join(root, "legacy.json");
    const parsed = JSON.parse(readFileSync(baseline, "utf8")) as Record<string, unknown>;
    const tasks = parsed.tasks as Record<string, unknown>;
    delete tasks.promotion;
    writeFileSync(legacy, JSON.stringify(parsed));

    const restored = new ConfigStore(legacy);
    restored.load({ persist: false });
    const isolated = new WorkspacePromotionAuthorization({
      configStore: restored,
      now: () => NOW,
    });

    expect(isolated.read().release.state).toBe("restricted");
    expect(isolated.facts("auto-create-mine")).toMatchObject({
      released: false,
      enabledAt: null,
    });
    expect(isolated.authorizes(isolated.facts("auto-create-mine"))).toBe(false);
  });
});
