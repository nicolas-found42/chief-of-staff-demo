import chokidar, { type FSWatcher } from "chokidar";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isSupportedFileName } from "../text/convert.js";
import { stat, open } from "node:fs/promises";

const TEMP_SUFFIXES = /(\.tmp|\.partial|\.crdownload|~)$/i;

/** A file is stable when size and mtime are unchanged for debounceMs and it can be opened. */
export async function waitForStability(
  filePath: string,
  debounceMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  let last = { size: -1, mtimeMs: -1 };
  for (;;) {
    if (signal?.aborted) {
      return false;
    }
    let current: { size: number; mtimeMs: number };
    try {
      const info = await stat(filePath);
      current = { size: info.size, mtimeMs: info.mtimeMs };
      const handle = await open(filePath, "r");
      await handle.close();
    } catch {
      return false;
    }
    if (current.size === last.size && current.mtimeMs === last.mtimeMs) {
      return true;
    }
    last = current;
    const { promise: settled, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, debounceMs);
    await settled;
    if (Date.now() > deadline) {
      return false;
    }
  }
}

/** Move into the archive with collision suffixing; the move is the dedupe. */
async function archiveFile(filePath: string, archiveDir: string): Promise<string> {
  await mkdir(archiveDir, { recursive: true });
  const name = basename(filePath);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let destination = join(archiveDir, name);
  let counter = 1;
  while (existsSync(destination)) {
    destination = join(archiveDir, `${stem}-${counter}${ext}`);
    counter += 1;
  }
  await rename(filePath, destination);
  return destination;
}

export interface WatchIntakeOptions {
  archiveDir: string;
  /** Invoked once per stable file, after it has been moved to the archive. */
  onFile: (spec: { fileName: string; bytes: Buffer }) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Watches a folder with chokidar (v4) and scans it on startup. Ignores
 * directories, hidden files, temporary suffixes, and unsupported extensions.
 * A file is processed only after it is stable (size+mtime unchanged 2s), and
 * only after it has been moved into the archive.
 */
export class WatchIntake {
  private watcher: FSWatcher | null = null;
  private folderPath: string | null = null;

  constructor(private readonly options: WatchIntakeOptions) {}

  private shouldIgnore(filePath: string): boolean {
    const name = filePath.split(/[\\/]/).pop() ?? "";
    if (name.startsWith(".")) {
      return true;
    }
    if (TEMP_SUFFIXES.test(name)) {
      return true;
    }
    return !isSupportedFileName(name);
  }

  async start(folderPath: string): Promise<void> {
    await this.stop();
    if (!folderPath) {
      return;
    }
    try {
      await mkdir(folderPath, { recursive: true });
    } catch (error) {
      this.options.log(
        `Cannot create watch folder ${folderPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    this.folderPath = folderPath;
    await this.scan();
    this.watcher = chokidar.watch(folderPath, {
      ignoreInitial: true,
      awaitWriteFinish: false,
    });
    const handle = async (filePath: string): Promise<void> => {
      if (this.shouldIgnore(filePath)) {
        return;
      }
      const stable = await waitForStability(filePath, 2_000);
      if (!stable) {
        this.options.log(`Ignoring unstable file: ${filePath}`);
        return;
      }
      await this.claim(filePath);
    };
    this.watcher.on("add", handle);
    this.watcher.on("change", handle);
    // chokidar v4 establishes its native handle asynchronously and exposes no
    // readiness signal; bridge the gap with a delayed scan. Double claims are
    // impossible: the archive move lets one claimant win.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.scan();
  }

  private async claim(filePath: string): Promise<void> {
    try {
      const archived = await archiveFile(filePath, this.options.archiveDir);
      const bytes = await readFile(archived);
      await this.options.onFile({ fileName: basename(archived), bytes });
    } catch (error) {
      this.options.log(
        `Pipeline rejected ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async scan(): Promise<void> {
    if (!this.folderPath) {
      return;
    }
    let entries: string[] = [];
    try {
      entries = await readdir(this.folderPath);
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = join(this.folderPath, entry);
      if (this.shouldIgnore(filePath)) {
        continue;
      }
      const stable = await waitForStability(filePath, 2_000);
      if (!stable) {
        continue;
      }
      await this.claim(filePath);
    }
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.folderPath = null;
  }
}
