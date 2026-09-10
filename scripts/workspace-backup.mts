import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { WorkspaceBackup } from "../apps/server/src/backup/workspace.js";

const command = parseCommand(process.argv.slice(2));
if (!command) {
  process.stderr.write(
    "Usage: workspace-backup capture <workspace> <destination> <repository> <stopped-container> | restore <current-workspace> <backup> <destination>\n",
  );
  process.exitCode = 1;
} else {
  const { workspace } = command;
  // Null until the destination path is accepted, so a refused path check leaves
  // nothing behind; every later failure is retained with its phase and reason.
  let attemptDirectory: string | null = null;
  let phase = "preflight";
  try {
    const probes: ReturnType<typeof assertQuiescent>[] = [];
    const backup = new WorkspaceBackup(workspace, async () => {
      probes.push(assertQuiescent(workspace));
    });
    if (command.operation === "capture") {
      const { destination, repository, container } = command;
      const output = resolve(destination);
      const source = realpathSync(workspace);
      const repo = realpathSync(repository);
      const parent = realpathSync(dirname(output));
      if (
        output === source ||
        parent === source ||
        parent.startsWith(`${source}${sep}`) ||
        output === repo ||
        parent === repo ||
        parent.startsWith(`${repo}${sep}`) ||
        existsSync(output)
      )
        throw new Error("Private output must be new and outside the repository and Workspace");
      const staging = `${output}.partial`;
      mkdirSync(staging, { mode: 0o700 });
      attemptDirectory = staging;
      phase = "quiescence-preflight";
      probes.push(assertQuiescent(workspace));
      phase = "runtime-provenance";
      const provenance = join(staging, "provenance");
      mkdirSync(provenance, { mode: 0o700 });
      const runtime = JSON.parse(
        execFileSync("docker", ["inspect", container], { encoding: "utf8", stdio: "pipe" }),
      ) as {
        Image: string;
        State: { Running: boolean };
        Mounts: { Source: string; Destination: string; RW: boolean }[];
        Config: {
          Image: string;
          Entrypoint: string[] | null;
          Cmd: string[] | null;
          WorkingDir: string;
          User: string;
          Env: string[] | null;
        };
        HostConfig: {
          RestartPolicy: { Name: string };
          PortBindings: Record<string, { HostIp: string; HostPort: string }[]> | null;
        };
      }[];
      const selected = runtime[0];
      if (
        !selected ||
        selected.State.Running ||
        !selected.Mounts.some((mount) => mount.RW && realpathSync(mount.Source) === source)
      )
        throw new Error("The recorded app must be stopped and mount this Workspace");
      writeFileSync(
        join(provenance, "runtime.json"),
        JSON.stringify({
          imageId: selected.Image,
          mounts: selected.Mounts,
          running: false,
          runtimeCodeRelationship: "unverified",
          capturedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        join(provenance, "container.json"),
        JSON.stringify({
          imageReference: selected.Config.Image,
          entrypoint: selected.Config.Entrypoint,
          command: selected.Config.Cmd,
          workingDir: selected.Config.WorkingDir,
          user: selected.Config.User,
          restartPolicy: selected.HostConfig.RestartPolicy.Name,
          portBindings: selected.HostConfig.PortBindings ?? {},
          // Names only: an environment value can carry a credential.
          envKeys: (selected.Config.Env ?? []).map((entry) => entry.split("=")[0]).sort(),
          capturedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      execFileSync(
        "docker",
        ["image", "save", "--output", join(provenance, "runtime-image.tar"), selected.Image],
        { stdio: "pipe" },
      );
      phase = "code-provenance";
      const before = freezeCode(repo, provenance);
      phase = "workspace-capture";
      const receipt = await backup.capture(join(staging, "backup"));
      for (const name of ["restored-1", "restored-2"]) {
        phase = name;
        await backup.restore(join(staging, "backup"), join(staging, name));
      }
      phase = "final-verification";
      if (JSON.stringify(codeState(repo)) !== JSON.stringify(before))
        throw new Error("Code changed during capture");
      writeFileSync(join(provenance, "quiescence.json"), JSON.stringify(probes), { mode: 0o600 });
      writeFileSync(
        join(provenance, "checksums.json"),
        JSON.stringify(await checksums(provenance)),
        { mode: 0o600 },
      );
      writeFileSync(
        join(staging, "result.json"),
        JSON.stringify({
          ...receipt,
          status: "captured-and-restored-twice",
          formatMigration: false,
          networkStarted: false,
          deletionFreshness: "same-quiescent-point-only",
          lossInterval: "changes after capturedAt are not covered",
          hostPowerLoss: "unclaimed",
        }),
        { mode: 0o600 },
      );
      renameSync(staging, output);
      attemptDirectory = null;
      process.stdout.write(
        `${JSON.stringify({ ...receipt, status: "captured-and-restored-twice" })}\n`,
      );
    } else {
      await backup.restore(command.backup, command.destination);
      process.stdout.write(
        '{"restoration":"verified-same-point-offline","networkStarted":false}\n',
      );
    }
  } catch (error) {
    if (attemptDirectory) {
      try {
        writeFileSync(
          join(attemptDirectory, "failure.json"),
          JSON.stringify({
            status: "failed",
            phase,
            at: new Date().toISOString(),
            reason: error instanceof Error ? error.message : "Unknown failure",
          }),
          { mode: 0o600, flag: "wx" },
        );
      } catch {
        process.stderr.write(
          "Private failure receipt could not be saved; capture remains unverified.\n",
        );
      }
    }
    // OS and parser errors can include private paths or bytes. The private
    // partial directory retains evidence; ordinary command output never does.
    process.stderr.write(
      command.operation === "capture"
        ? "Backup refused: host quiescence, paths or integrity could not be verified. Retain any private .partial evidence and inspect the offline workflow.\n"
        : "Restoration refused: the backup, current Workspace or integrity could not be verified and nothing was written. Recheck both inputs.\n",
    );
    process.exitCode = 1;
  }
}

function parseCommand(args: string[]):
  | {
      operation: "capture";
      workspace: string;
      destination: string;
      repository: string;
      container: string;
    }
  | { operation: "restore"; workspace: string; backup: string; destination: string }
  | null {
  if (args[0] === "capture") {
    const [, workspace, destination, repository, container] = args;
    if (args.length === 5 && workspace && destination && repository && container)
      return { operation: "capture", workspace, destination, repository, container };
  } else if (args[0] === "restore") {
    const [, workspace, backup, destination] = args;
    if (args.length === 4 && workspace && backup && destination)
      return { operation: "restore", workspace, backup, destination };
  }
  return null;
}

function git(repo: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
}

function codeState(repo: string): {
  head: string;
  diff: string;
  untracked: { path: string; sha256: string }[];
} {
  return {
    head: git(repo, ["rev-parse", "HEAD"]).toString().trim(),
    diff: git(repo, ["diff", "--binary", "HEAD"]).toString(),
    untracked: git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
      .toString()
      .split("\0")
      .filter(Boolean)
      .sort()
      .map((path) => {
        if (!lstatSync(join(repo, path)).isFile())
          throw new Error("Untracked input is not a regular file");
        return {
          path,
          sha256: createHash("sha256")
            .update(readFileSync(join(repo, path)))
            .digest("hex"),
        };
      }),
  };
}

function freezeCode(repo: string, destination: string): ReturnType<typeof codeState> {
  const state = codeState(repo);
  git(repo, [
    "archive",
    "--format=tar",
    `--output=${join(destination, "code-head.tar")}`,
    state.head,
  ]);
  writeFileSync(join(destination, "code-head.txt"), state.head, { mode: 0o600 });
  writeFileSync(join(destination, "code.diff"), state.diff, { mode: 0o600 });
  for (const entry of state.untracked) {
    const target = join(destination, "untracked", entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const bytes = readFileSync(join(repo, entry.path));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error("Untracked input changed while freezing code");
    writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
    if (createHash("sha256").update(readFileSync(target)).digest("hex") !== entry.sha256)
      throw new Error("Copied untracked input failed verification");
  }
  writeFileSync(join(destination, "code-state.json"), JSON.stringify(state), { mode: 0o600 });
  return state;
}

async function checksums(root: string): Promise<{ path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  async function walk(relative: string): Promise<void> {
    const path = join(root, relative);
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) await walk(join(relative, name));
    } else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      result.push({ path: relative, sha256: hash.digest("hex") });
    }
  }
  await walk("");
  return result;
}

function assertQuiescent(workspace: string): {
  checkedAt: string;
  runningWorkspaceWriters: number;
  readonlyDockerHandles: number;
  unresolvedContainerMounts: string[];
  scope: string;
} {
  const source = realpathSync(workspace);
  const unresolvedContainerMounts: string[] = [];
  const ids = execFileSync("docker", ["ps", "-q"], { encoding: "utf8", stdio: "pipe" })
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length) {
    const containers = JSON.parse(
      execFileSync("docker", ["inspect", ...ids], { encoding: "utf8", stdio: "pipe" }),
    ) as { Mounts: { Source: string; RW: boolean }[] }[];
    for (const container of containers) {
      for (const mount of container.Mounts) {
        if (!mount.RW) continue;
        // A Docker-managed volume lives inside the VM, so its host path does not
        // exist; a path that does not exist cannot be the Workspace or contain it.
        const path = existingPath(mount.Source);
        if (!path) {
          unresolvedContainerMounts.push(mount.Source);
          continue;
        }
        if (
          source === path ||
          source.startsWith(`${path}${sep}`) ||
          path.startsWith(`${source}${sep}`)
        )
          throw new Error("Workspace container writer is active");
      }
    }
  }
  const handles = spawnSync("lsof", ["-Fpcfa", "+D", source], { encoding: "utf8" });
  if (handles.error || handles.stderr.trim() || (handles.status !== 0 && handles.status !== 1))
    throw new Error("Host handles could not be inspected");
  let processName = "";
  let readonlyDockerHandles = 0;
  let pendingHandle = false;
  for (const line of handles.stdout.split("\n")) {
    if (line.startsWith("f")) {
      if (pendingHandle) throw new Error("Host handle access is unknown");
      pendingHandle = true;
    }
    if (line.startsWith("c")) processName = line.slice(1);
    if (
      line.startsWith("a") &&
      (line !== "ar" ||
        !["com.apple.Virtualization.Virtua", "com.docker.backend"].includes(processName))
    )
      throw new Error("Unexplained host handle");
    if (line === "ar") {
      readonlyDockerHandles++;
      pendingHandle = false;
    }
  }
  if (pendingHandle) throw new Error("Host handle access is unknown");
  return {
    checkedAt: new Date().toISOString(),
    runningWorkspaceWriters: 0,
    readonlyDockerHandles,
    unresolvedContainerMounts,
    scope: "Docker mounts and currently open host handles; supported single-app deployment",
  };
}

function existingPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
