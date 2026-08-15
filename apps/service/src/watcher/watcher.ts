import chokidar, { type FSWatcher } from "chokidar";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isSupported, waitForStability } from "../ingest.js";

const TEMP_SUFFIXES = /(\.tmp|\.partial|\.crdownload|~)$/i;

export interface TranscriptWatcherOptions {
  inboxDir: string;
  debounceMs: number;
  /** Invoked once per stable, claimed file. */
  onFile: (filePath: string) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Watches the transcript inbox with chokidar and scans it on startup.
 * Ignores directories, hidden files, temporary suffixes, and unsupported
 * extensions. A file is offered to the pipeline only after it is stable.
 */
export class TranscriptWatcher {
  private watcher: FSWatcher | null = null;

  constructor(private readonly options: TranscriptWatcherOptions) {}

  private shouldIgnore(filePath: string): boolean {
    const name = filePath.split(/[\\/]/).pop() ?? "";
    if (name.startsWith(".")) {
      return true;
    }
    if (TEMP_SUFFIXES.test(name)) {
      return true;
    }
    return !isSupported(name);
  }

  async start(): Promise<void> {
    // Startup scan: claim everything already present and stable.
    await this.scanInbox();
    this.watcher = chokidar.watch(this.options.inboxDir, {
      ignoreInitial: true,
      awaitWriteFinish: false,
    });
    const handle = async (filePath: string): Promise<void> => {
      if (this.shouldIgnore(filePath)) {
        return;
      }
      const stable = await waitForStability(
        filePath,
        this.options.debounceMs,
        undefined
      );
      if (!stable) {
        this.options.log(`Ignoring unstable file: ${filePath}`);
        return;
      }
      // Claim is an atomic move; the loser of a race gets ENOENT here.
      await this.options.onFile(filePath).catch((error) => {
        this.options.log(
          `Pipeline rejected ${filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    };
    this.watcher.on("add", handle);
    this.watcher.on("change", handle);
    // chokidar v4 establishes its native handle asynchronously and exposes no
    // readiness signal; bridge the gap with a delayed scan. Double claims are
    // impossible: the atomic rename lets one claimant win.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.scanInbox();
  }

  private async scanInbox(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.options.inboxDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = join(this.options.inboxDir, entry);
      if (this.shouldIgnore(filePath)) {
        continue;
      }
      const stable = await waitForStability(filePath, this.options.debounceMs);
      if (!stable) {
        continue;
      }
      await this.options.onFile(filePath).catch((error) => {
        this.options.log(
          `Pipeline rejected ${filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
