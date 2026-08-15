import { describe, expect, it } from "vitest";
import { Workspace } from "@chief-of-staff/workflow";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptWatcher } from "@chief-of-staff/service";
import { waitForStability, isSupported } from "@chief-of-staff/service";

describe("transcript watcher", () => {
  it("claims a stable supported file and offers it to the pipeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "watcher-"));
    const workspace = new Workspace(root);
    await workspace.initialize();
    const seen: string[] = [];
    const watcher = new TranscriptWatcher({
      inboxDir: workspace.layout.inboxDir,
      debounceMs: 50,
      onFile: async (filePath) => {
        seen.push(filePath);
      },
      log: () => undefined,
    });
    await watcher.start();
    const inboxFile = join(workspace.layout.inboxDir, "meeting.txt");
    await writeFile(inboxFile, "hello\n", "utf8");
    // Wait for the watcher to claim.
    for (let i = 0; i < 50 && seen.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(seen).toHaveLength(1);
    await watcher.stop();
    // The handler in this test records rather than claims, so the file stays;
    // the watcher must have offered exactly the stable file once.
    const inboxEntries = await readdir(workspace.layout.inboxDir);
    expect(inboxEntries).toEqual(["meeting.txt"]);
  });

  it("ignores unsupported, hidden, and temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "watcher-"));
    const workspace = new Workspace(root);
    await workspace.initialize();
    const seen: string[] = [];
    const watcher = new TranscriptWatcher({
      inboxDir: workspace.layout.inboxDir,
      debounceMs: 50,
      onFile: async (filePath) => {
        seen.push(filePath);
      },
      log: () => undefined,
    });
    await watcher.start();
    await writeFile(join(workspace.layout.inboxDir, "notes.csv"), "x\n", "utf8");
    await writeFile(join(workspace.layout.inboxDir, ".hidden.txt"), "x\n", "utf8");
    await writeFile(join(workspace.layout.inboxDir, "draft.txt.tmp"), "x\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 600));
    await watcher.stop();
    expect(seen).toEqual([]);
    expect(isSupported("notes.csv")).toBe(false);
    expect(isSupported("meeting.txt")).toBe(true);
    expect(isSupported("meeting.md")).toBe(true);
    expect(isSupported("meeting.pdf")).toBe(true);
    expect(isSupported("meeting.docx")).toBe(true);
  });

  it("detects stability after a write settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "watcher-"));
    const file = join(root, "stable.txt");
    await writeFile(file, "content\n", "utf8");
    expect(await waitForStability(file, 30)).toBe(true);
    expect(await waitForStability(join(root, "missing.txt"), 30)).toBe(false);
  });
});
