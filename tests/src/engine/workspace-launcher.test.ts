import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, it } from "vitest";

it("refuses a competing Workspace process and permits two restarts after process death", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "workspace-launcher-"));
  const launcher = fileURLToPath(new URL("../../../scripts/start-workspace.py", import.meta.url));
  const env = { ...process.env, WORKSPACE_DIR: workspace };
  const holder = spawn(
    "python3",
    [launcher, process.execPath, "-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { env },
  );
  try {
    const ready = await Promise.race([
      once(holder.stdout, "data").then(([bytes]) => String(bytes)),
      once(holder, "exit").then(([code]) => `exited:${code}`),
    ]);
    expect(ready).toBe("ready");
    expect(() =>
      execFileSync(
        "python3",
        [launcher, process.execPath, "-e", "process.stdout.write('started')"],
        { env, stdio: "pipe" },
      ),
    ).toThrow();
    const exited = once(holder, "exit");
    holder.kill("SIGKILL");
    await exited;
    for (let recovery = 0; recovery < 2; recovery++) {
      expect(
        execFileSync(
          "python3",
          [launcher, process.execPath, "-e", "process.stdout.write('recovered')"],
          { env, encoding: "utf8" },
        ),
      ).toBe("recovered");
    }
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, "exit");
      holder.kill("SIGKILL");
      await exited;
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});
