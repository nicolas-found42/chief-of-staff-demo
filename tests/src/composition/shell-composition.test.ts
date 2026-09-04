import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeShell, type Shell } from "../../../apps/server/src/composition/shell";

/**
 * The composition root, composed for real — the gap behind three defects.
 *
 * The Transcript Catalog (#125) passed a full suite while production
 * constructed it nowhere: every spec built the Catalog itself, so passing was
 * compatible with the app never touching it. #144 was the same shape one level
 * down — the runs directory and the V1 watchlist were created on the boot path
 * but not by the in-process cutover the gate performs, so a Workspace migrated
 * without a restart came up missing both. Neither was reachable from a test,
 * because `main.ts` was a top-level-await script that bound a port: importing it
 * was starting the server, and the only wiring a test could examine was its
 * source text.
 *
 * `composeShell` is that script as a function. It builds the whole graph and
 * registers every route without listening, so a Shell composes over a temporary
 * Workspace in about a tenth of a second and answers through `app.inject`. Every
 * assertion below is on what the composition did, not on what it looks like.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER_SRC = join(REPO_ROOT, "apps/server/src");

/* The address docker-compose declares. The Shell seeds relay.json from it on a
   Workspace with none stored, which is a startup write like any other — and the
   one that was still happening outside the boot sequence. */
const DEPLOYMENT_RELAY_BASE_URL = "http://relay:4318";

const shells: Shell[] = [];
let priorRelayBaseUrl: string | undefined;

beforeEach(() => {
  /* Set for the whole test, not just the compose: the boot sequence reads it
     when it runs, which is the point — a deployment variable that only takes
     effect at startup is one the gate has to be able to withhold. */
  priorRelayBaseUrl = process.env.RELAY_BASE_URL;
  process.env.RELAY_BASE_URL = DEPLOYMENT_RELAY_BASE_URL;
});

afterEach(() => {
  /* Started Modules hold schedulers. Nothing here may outlive its own test. */
  while (shells.length > 0) shells.pop()?.stop();
  if (priorRelayBaseUrl === undefined) delete process.env.RELAY_BASE_URL;
  else process.env.RELAY_BASE_URL = priorRelayBaseUrl;
});

async function compose(workspaceDir: string): Promise<Shell> {
  const shell = await composeShell({ workspaceDir, port: 4999 });
  shells.push(shell);
  return shell;
}

/**
 * A Workspace with product state and no migration marker, so the gate holds it.
 * The Content Scout clock is parked just short of its due times for the same
 * reason the browser suite parks it: a scheduler tick that fired mid-test would
 * write a Run, and these assertions are about what startup writes.
 */
function workspaceDirectory(migrated: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "cos-shell-"));
  writeFileSync(
    join(dir, "config.json"),
    `${JSON.stringify(
      {
        provider: "mock",
        model: "",
        apiKey: "",
        google: { clientId: "", clientSecret: "", refreshToken: null },
        drive: { enabled: false, folderId: "", folderName: "", pollIntervalMinutes: 2 },
        ollama: { baseUrl: "http://127.0.0.1:11434" },
        modules: {
          "content-scout": {
            dailyTime: "23:59",
            weeklyDiscoveryDay: 7,
            weeklyDiscoveryTime: "23:59",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (migrated) {
    mkdirSync(join(dir, "migration"), { recursive: true });
    writeFileSync(
      join(dir, "migration", "completed.json"),
      `${JSON.stringify({ migratedAt: "2026-08-31T12:00:00.000Z" })}\n`,
      "utf8",
    );
  }
  return dir;
}

/** Relative paths, sorted. */
function paths(dir: string, base = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(`${rel}/`, ...paths(dir, rel));
    else found.push(rel);
  }
  return found.sort();
}

/** Relative path plus content hash, sorted — the Workspace's bytes. */
function snapshot(dir: string): string[] {
  return paths(dir)
    .map((rel) =>
      rel.endsWith("/")
        ? rel
        : `${rel} ${createHash("sha256")
            .update(readFileSync(join(dir, rel)))
            .digest("hex")}`,
    )
    .sort();
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
describe("the mock provider follows the process posture, not the config (#198)", () => {
  /* Both switches the posture reads are pinned, so an operator's exported
     DEMO_MODE cannot flip these assertions. */
  async function withPosture(posture: { test?: "1" }, run: () => Promise<void>): Promise<void> {
    const prior = { test: process.env.ENABLE_TEST_SEED, demo: process.env.DEMO_MODE };
    delete process.env.ENABLE_TEST_SEED;
    delete process.env.DEMO_MODE;
    if (posture.test !== undefined) process.env.ENABLE_TEST_SEED = posture.test;
    try {
      await run();
    } finally {
      if (prior.test === undefined) delete process.env.ENABLE_TEST_SEED;
      else process.env.ENABLE_TEST_SEED = prior.test;
      if (prior.demo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prior.demo;
    }
  }

  it("keeps mock out of a production-composed Shell", async () => {
    await withPosture({}, async () => {
      const shell = await compose(workspaceDirectory(true));
      const get = await shell.app.inject({ method: "GET", url: "/api/config" });
      expect(get.json<{ mockAvailable: boolean }>().mockAvailable).toBe(false);
    });
  });

  it("admits mock only where the process itself is a test or explicit demo", async () => {
    await withPosture({ test: "1" }, async () => {
      const shell = await compose(workspaceDirectory(true));
      const get = await shell.app.inject({ method: "GET", url: "/api/config" });
      expect(get.json<{ mockAvailable: boolean }>().mockAvailable).toBe(true);
    });
  });
});

describe("composition writes nothing while the gate holds a pre-cutover Workspace (#144)", () => {
  it("leaves the Workspace byte-for-byte unchanged, under the deployment's own environment", async () => {
    const dir = workspaceDirectory(false);
    const before = snapshot(dir);

    const shell = await compose(dir);

    expect(shell.gate.isActive()).toBe(true);
    expect(
      snapshot(dir),
      "composing a gated Shell must not touch the Workspace the person has not yet agreed to reset",
    ).toEqual(before);
  });

  it("holds the product API and answers the migration surface", async () => {
    const shell = await compose(workspaceDirectory(false));

    const runs = await shell.app.inject({ method: "GET", url: "/api/runs" });
    expect(runs.statusCode).toBe(503);
    const status = await shell.app.inject({ method: "GET", url: "/api/migration/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json<{ state: string }>().state).toBe("required");
  });
});

describe("the in-process cutover reaches the Workspace a restart would (#144)", () => {
  it("creates exactly what the boot sequence creates", async () => {
    /* The defect this reproduces: the runs directory, the V1 watchlist and the
       relay address were written on the boot path but not by the gate's own
       cutover, so confirming without a restart left a Workspace short of all
       three. Both sides run the same startup — one through the gate, one
       through boot — and the comparison is what each newly created. */
    const cutoverDir = workspaceDirectory(false);
    const cutoverBefore = paths(cutoverDir);
    const cutover = await compose(cutoverDir);
    expect(cutover.gate.isActive()).toBe(true);
    cutover.gate.complete();
    await waitFor(() => paths(cutoverDir).includes("runs/"), "the cutover to start the Modules");

    const bootDir = workspaceDirectory(true);
    const bootBefore = paths(bootDir);
    const boot = await compose(bootDir);
    expect(boot.gate.isActive()).toBe(false);
    await boot.start();

    /* The runs directory is compared, its contents are not: what a started
       engine enqueues is scheduler timing, and this is about what the startup
       sequence creates. Everything else — the V1 watchlist, the Profile it
       writes, the seeded relay address — is compared exactly. */
    const created = (after: string[], before: string[]) =>
      after.filter((path) => !before.includes(path) && !path.startsWith("runs/run"));
    const byBoot = created(paths(bootDir), bootBefore);

    /* Non-vacuous, and named rather than counted: these three are the writes
       that actually went missing. */
    expect(byBoot).toContain("runs/");
    expect(byBoot).toContain("relay.json");
    expect(byBoot.some((p) => p.startsWith("content-research/"))).toBe(true);

    expect(
      created(paths(cutoverDir), cutoverBefore),
      "a Workspace migrated in-process must hold what one migrated by restart holds",
    ).toEqual(byBoot);
  });
});

/**
 * Every exported `…Store`: the classes that own a piece of durable Workspace
 * state. Read from the source tree rather than listed here, because a list is
 * another hand-written fixture and drifts the way `CONFIG_KEYS` drifted — a
 * store added tomorrow joins this expectation by existing.
 */
function declaredStores(dir = SERVER_SRC, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      declaredStores(path, found);
      continue;
    }
    if (!path.endsWith(".ts")) continue;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext);
    for (const statement of source.statements) {
      if (
        ts.isClassDeclaration(statement) &&
        statement.name?.text.endsWith("Store") &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        found.push(statement.name.text);
      }
    }
  }
  return found.sort();
}

/** Constructor names of every object the given roots actually hold. */
function heldClasses(roots: unknown): Set<string> {
  const names = new Set<string>();
  const visited = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || typeof value !== "object" || value === null) return;
    if (visited.has(value)) return;
    visited.add(value);
    names.add(value.constructor.name);
    for (const key of Object.keys(value)) {
      visit((value as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(roots, 0);
  return names;
}

/**
 * Opened per call over `relay.json` and held by nobody — the relay's state is
 * the file, and every reader constructs a reader for the one operation. There is
 * nothing on the graph to find, and nothing #125 could have hidden in it.
 */
const NOT_HELD = new Set(["RelayStateStore"]);

describe("the composed graph holds every Workspace store the server declares (#125)", () => {
  it("holds each one, in the root's own graph or inside a Module", async () => {
    const shell = await compose(workspaceDirectory(true));
    const held = heldClasses({ workspace: shell.workspace, modules: shell.modules });
    const stores = declaredStores();

    /* Non-vacuous: the tree really was read, and the graph really was walked. */
    expect(stores.length).toBeGreaterThan(5);
    expect(held.size).toBeGreaterThan(20);

    expect(
      stores.filter((store) => !held.has(store) && !NOT_HELD.has(store)),
      "a Workspace store no composed object holds is state the product never reads — wire it into composeShell, or delete it",
    ).toEqual([]);
  });

  it("reports what the root holds, not what the repo contains", async () => {
    /* The mutation witness. Before this extraction the root returned nothing,
       and the transcript owners were reachable from no composed value at all —
       exactly the state #125 shipped in. Walking the Modules alone reproduces
       it: the check passes above because the root now names them, not because
       every declared class is found wherever you look. */
    const shell = await compose(workspaceDirectory(true));
    const withoutRootGraph = heldClasses({ modules: shell.modules });

    expect(withoutRootGraph.has("TranscriptCatalogStore")).toBe(false);
    expect(heldClasses({ workspace: shell.workspace }).has("TranscriptCatalogStore")).toBe(true);
  });
});
