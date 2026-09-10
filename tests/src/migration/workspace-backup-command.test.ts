import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod/v3";

it("the operator command rejects invalid invocation without leaking source paths or credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "backup-command-"));
  try {
    const rejected = runBackup(["invalid", root, "synthetic-secret"], "");
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Usage: workspace-backup");
    expect(rejected.stderr).not.toContain(root);
    expect(rejected.stderr).not.toContain("synthetic-secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("captures actual code changes, untracked inputs and stopped-image identity beside the private Workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "backup-command-provenance-"));
  try {
    const repository = join(root, "repo");
    const workspace = join(root, "workspace");
    for (const path of [repository, workspace]) mkdirSync(path);
    writeFileSync(join(workspace, "config.json"), '{"secret":"synthetic-secret"}');
    initRepository(repository);
    writeFileSync(join(repository, "tracked.txt"), "changed");
    writeFileSync(join(repository, "private-input.txt"), "uncommitted input");
    const destination = join(root, "capture");
    const capture = runBackup(
      ["capture", workspace, destination, repository, "app"],
      fakeRuntime(root, {}),
    );
    expect(capture.status).toBe(0);
    expect(capture.stderr).toBe("");
    expect(capture.stdout).not.toContain("synthetic-secret");
    expect(readFileSync(join(destination, "provenance/code.diff"), "utf8")).toContain("+changed");
    expect(readFileSync(join(destination, "provenance/untracked/private-input.txt"), "utf8")).toBe(
      "uncommitted input",
    );
    expect(
      JSON.parse(readFileSync(join(destination, "provenance/runtime.json"), "utf8")),
    ).toMatchObject({ imageId: "sha256:synthetic-image", running: false });
    expect(readFileSync(join(destination, "provenance/runtime-image.tar"), "utf8")).toBe(
      "saved-image",
    );
    const container = readFileSync(join(destination, "provenance/container.json"), "utf8");
    expect(JSON.parse(container)).toMatchObject({
      imageReference: "chief-of-staff-demo-app",
      restartPolicy: "no",
      portBindings: { "4317/tcp": [{ HostIp: "127.0.0.1", HostPort: "4317" }] },
      envKeys: ["PORT", "SYNTHETIC_TOKEN"],
    });
    expect(container).not.toContain("synthetic-secret");
    expect(readFileSync(join(destination, "backup/workspace/config.json"), "utf8")).toContain(
      "synthetic-secret",
    );
    expect(JSON.parse(readFileSync(join(destination, "result.json"), "utf8"))).toMatchObject({
      status: "captured-and-restored-twice",
      formatMigration: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses capture when host quiescence cannot be verified and retains the private reason", () => {
  const root = mkdtempSync(join(tmpdir(), "backup-command-host-"));
  try {
    const workspace = join(root, "workspace");
    const repository = join(root, "repo");
    for (const path of [workspace, repository]) mkdirSync(path);
    const capture = runBackup(["capture", workspace, join(root, "capture"), repository, "app"], "");
    expect(capture.status).toBe(1);
    expect(capture.stderr).toContain("Backup refused");
    expect(capture.stderr).not.toContain(root);
    expect(existsSync(join(root, "capture"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, "capture.partial/failure.json"), "utf8")),
    ).toMatchObject({ status: "failed", phase: "quiescence-preflight" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("records known read-only Docker handles instead of refusing them", () => {
  const root = mkdtempSync(join(tmpdir(), "backup-command-handles-"));
  try {
    const repository = join(root, "repo");
    const workspace = join(root, "workspace");
    for (const path of [repository, workspace]) mkdirSync(path);
    initRepository(repository);
    const bin = fakeRuntime(root, { lsof: "p4242\nccom.docker.backend\nf7\nar\nf9\nar\n" });
    const destination = join(root, "capture");
    const capture = runBackup(["capture", workspace, destination, repository, "app"], bin);
    expect(capture.stderr).toBe("");
    expect(capture.status).toBe(0);
    for (const probe of captureProbes(destination)) {
      expect(probe.readonlyDockerHandles).toBe(2);
      expect(probe.runningWorkspaceWriters).toBe(0);
      expect(probe.unresolvedContainerMounts).toEqual([]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("permits a running container whose mounted host path does not exist", () => {
  const root = mkdtempSync(join(tmpdir(), "backup-command-volume-"));
  try {
    const repository = join(root, "repo");
    const workspace = join(root, "workspace");
    for (const path of [repository, workspace]) mkdirSync(path);
    initRepository(repository);
    const volume = "/var/lib/docker/volumes/synthetic-volume/_data";
    const bin = fakeRuntime(root, {
      running: [{ Id: "sibling", Mounts: [{ Source: volume, RW: true }] }],
    });
    const destination = join(root, "capture");
    const capture = runBackup(["capture", workspace, destination, repository, "app"], bin);
    expect(capture.stderr).toBe("");
    expect(capture.status).toBe(0);
    for (const probe of captureProbes(destination))
      expect(probe.unresolvedContainerMounts).toEqual([volume]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["an unexplained writer", "p4242\ncFinder\nf7\naw\n"],
  ["a handle with no reported access", "p4242\ncFinder\nf7\n"],
])("refuses capture when host inspection reports %s", (_, lsof) => {
  const root = mkdtempSync(join(tmpdir(), "backup-command-refused-"));
  try {
    const workspace = join(root, "workspace");
    const repository = join(root, "repo");
    for (const path of [workspace, repository]) mkdirSync(path);
    const bin = fakeRuntime(root, { lsof });
    const capture = runBackup(
      ["capture", workspace, join(root, "capture"), repository, "app"],
      bin,
    );
    expect(capture.status).toBe(1);
    expect(capture.stderr).toContain("Backup refused");
    expect(capture.stderr).not.toContain(root);
    expect(existsSync(join(root, "capture"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, "capture.partial/failure.json"), "utf8")),
    ).toMatchObject({ status: "failed", phase: "quiescence-preflight" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses capture when a running container can still write the Workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "backup-command-writer-"));
  try {
    const workspace = join(root, "workspace");
    const repository = join(root, "repo");
    for (const path of [workspace, repository]) mkdirSync(path);
    const bin = fakeRuntime(root, {
      running: [{ Id: "sibling", Mounts: [{ Source: workspace, RW: true }] }],
    });
    const capture = runBackup(
      ["capture", workspace, join(root, "capture"), repository, "app"],
      bin,
    );
    expect(capture.status).toBe(1);
    expect(capture.stderr).toContain("Backup refused");
    expect(existsSync(join(root, "capture"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, "capture.partial/failure.json"), "utf8")),
    ).toMatchObject({ status: "failed", phase: "quiescence-preflight" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses an interrupted partial backup without leaking paths or writing a destination", () => {
  const root = mkdtempSync(join(tmpdir(), "backup-command-restore-"));
  try {
    const workspace = join(root, "workspace");
    const partial = join(root, "backup.partial");
    for (const path of [workspace, partial]) mkdirSync(path);
    const restore = runBackup(
      ["restore", workspace, partial, join(root, "restored")],
      fakeRuntime(root, {}),
    );
    expect(restore.status).toBe(1);
    expect(restore.stderr).toContain("Restoration refused");
    expect(restore.stderr).not.toContain(root);
    expect(existsSync(join(root, "restored"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("retains private failure evidence for each failed attempt without publishing a capture", () => {
  const root = mkdtempSync(join(tmpdir(), "backup-command-failure-"));
  try {
    const workspace = join(root, "workspace");
    const repository = join(root, "repo");
    for (const path of [workspace, repository]) mkdirSync(path);
    const bin = fakeRuntime(root, { failImageSave: true });
    const first = runBackup(["capture", workspace, join(root, "first"), repository, "app"], bin);
    expect(first.status).toBe(1);
    expect(first.stderr).toContain("Backup refused");
    expect(first.stderr).not.toContain(root);
    const firstReceipt = readFileSync(join(root, "first.partial/failure.json"), "utf8");
    expect(JSON.parse(firstReceipt)).toMatchObject({
      status: "failed",
      phase: "runtime-provenance",
    });
    expect(existsSync(join(root, "first"))).toBe(false);
    expect(existsSync(join(root, "first.partial/result.json"))).toBe(false);
    const second = runBackup(["capture", workspace, join(root, "second"), repository, "app"], bin);
    expect(second.status).toBe(1);
    expect(existsSync(join(root, "second"))).toBe(false);
    expect(readFileSync(join(root, "first.partial/failure.json"), "utf8")).toBe(firstReceipt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const Probe = z.object({
  checkedAt: z.string(),
  runningWorkspaceWriters: z.number(),
  readonlyDockerHandles: z.number(),
  unresolvedContainerMounts: z.array(z.string()),
  scope: z.string(),
});

function captureProbes(destination: string): z.infer<typeof Probe>[] {
  const probes = z
    .array(Probe)
    .parse(JSON.parse(readFileSync(join(destination, "provenance/quiescence.json"), "utf8")));
  expect(probes.length).toBeGreaterThanOrEqual(4);
  return probes;
}

function runBackup(
  args: string[],
  bin: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../../../scripts/workspace-backup.mts", import.meta.url)),
      ...args,
    ],
    {
      env: bin
        ? { ...process.env, PATH: `${bin}:${process.env.PATH}` }
        : { ...process.env, PATH: "" },
      encoding: "utf8",
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function initRepository(repository: string): void {
  execFileSync("git", ["init", repository], { stdio: "pipe" });
  writeFileSync(join(repository, "tracked.txt"), "original");
  execFileSync("git", ["-C", repository, "add", "."], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "baseline",
    ],
    { stdio: "pipe" },
  );
}

/* Controlled executables at the OS boundary. The command must decide on the
   bytes these print, so every fixture stays next to the assertion that uses it. */
function fakeRuntime(
  root: string,
  options: {
    lsof?: string;
    failImageSave?: boolean;
    running?: { Id: string; Mounts: { Source: string; RW: boolean }[] }[];
  },
): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const app = [
    {
      Image: "sha256:synthetic-image",
      State: { Running: false },
      Mounts: [{ Source: join(root, "workspace"), Destination: "/app/workspace", RW: true }],
      Config: {
        Image: "chief-of-staff-demo-app",
        Entrypoint: null,
        Cmd: ["node", "apps/server/dist/main.js"],
        WorkingDir: "/app",
        User: "pwuser",
        Env: ["SYNTHETIC_TOKEN=synthetic-secret", "PORT=4317"],
      },
      HostConfig: {
        RestartPolicy: { Name: "no" },
        PortBindings: { "4317/tcp": [{ HostIp: "127.0.0.1", HostPort: "4317" }] },
      },
    },
  ];
  const running = options.running ?? [];
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const app = ${JSON.stringify(app)};
const running = ${JSON.stringify(running)};
if (args[0] === "inspect") process.stdout.write(JSON.stringify(args.includes("app") ? app : running));
else if (args[0] === "ps") process.stdout.write(running.map((container) => container.Id).join(String.fromCharCode(10)));
else if (args[0] === "image" && args[1] === "save") {
${
  options.failImageSave
    ? `  process.stderr.write("synthetic image failure");
  process.exitCode = 1;`
    : `  fs.writeFileSync(args[args.indexOf("--output") + 1], "saved-image");`
}
}
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "lsof"),
    `#!${process.execPath}
process.stdout.write(${JSON.stringify(options.lsof ?? "")});
process.exitCode=${options.lsof ? 0 : 1};`,
    { mode: 0o700 },
  );
  return bin;
}
