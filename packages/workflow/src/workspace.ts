import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, resolveWithinRoot } from "./filesystem.js";

export interface WorkspaceLayout {
  inboxDir: string;
  sourceProcessingDir: string;
  sourceProcessedDir: string;
  sourceFailedDir: string;
  gmailDraftsDir: string;
  tasksEmailDraftsDir: string;
  tasksBusinessPlansDir: string;
  tasksMyTasksDir: string;
  docsDir: string;
  notificationsDir: string;
  trackingCsv: string;
  calendarFile: string;
  configDir: string;
  runsDir: string;
  serviceDir: string;
  claimsDir: string;
}

/**
 * Path and I/O boundary for the local workspace. Every read/write goes through
 * containment-checked resolution against the workspace root.
 */
export class Workspace {
  constructor(readonly root: string) {}

  get layout(): WorkspaceLayout {
    return {
      inboxDir: join(this.root, "inbox", "transcripts"),
      sourceProcessingDir: join(this.root, "source", "processing"),
      sourceProcessedDir: join(this.root, "source", "processed"),
      sourceFailedDir: join(this.root, "source", "failed"),
      gmailDraftsDir: join(this.root, "gmail", "drafts"),
      tasksEmailDraftsDir: join(this.root, "tasks", "email-drafts"),
      tasksBusinessPlansDir: join(this.root, "tasks", "business-plans"),
      tasksMyTasksDir: join(this.root, "tasks", "my-tasks"),
      docsDir: join(this.root, "docs", "strategy-and-planning"),
      notificationsDir: join(this.root, "notifications"),
      trackingCsv: join(this.root, "tracking", "actions.csv"),
      calendarFile: join(this.root, "calendar", "events.json"),
      configDir: join(this.root, "config"),
      runsDir: join(this.root, "runs"),
      serviceDir: join(this.root, "service"),
      claimsDir: join(this.root, "service", "claims"),
    };
  }

  runDir(runId: string): string {
    return join(this.root, "runs", runId);
  }

  stepsDir(runId: string): string {
    return join(this.root, "runs", runId, "steps");
  }

  inputDir(runId: string): string {
    return join(this.root, "runs", runId, "input");
  }

  llmDir(runId: string): string {
    return join(this.root, "runs", runId, "llm");
  }

  /** Resolve a workspace-relative path to an absolute, containment-checked path. */
  async resolve(relativePath: string): Promise<string> {
    return resolveWithinRoot(this.root, relativePath);
  }

  /** Resolve a local:// URI to an absolute, containment-checked path. */
  async resolveUri(uri: string): Promise<string> {
    const prefix = "local://";
    if (!uri.startsWith(prefix)) {
      throw new Error(`Not a local:// URI: ${uri}`);
    }
    const rel = uri.slice(prefix.length);
    return this.resolve(rel);
  }

  async initialize(): Promise<void> {
    const { layout } = this;
    const dirs = [
      layout.inboxDir,
      layout.sourceProcessingDir,
      layout.sourceProcessedDir,
      layout.sourceFailedDir,
      layout.gmailDraftsDir,
      layout.tasksEmailDraftsDir,
      layout.tasksBusinessPlansDir,
      layout.tasksMyTasksDir,
      layout.docsDir,
      layout.notificationsDir,
      layout.configDir,
      layout.runsDir,
      layout.serviceDir,
      layout.claimsDir,
      join(this.root, "tracking"),
      join(this.root, "calendar"),
      join(this.root, "source"),
    ];
    await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
  }

  async writeText(relativePath: string, text: string): Promise<void> {
    const abs = await this.resolve(relativePath);
    await atomicWriteFile(abs, Buffer.from(text, "utf8"));
  }

  async writeBytes(relativePath: string, bytes: Uint8Array): Promise<void> {
    const abs = await this.resolve(relativePath);
    await atomicWriteFile(abs, bytes);
  }

  async writeTextDirect(relativePath: string, text: string): Promise<void> {
    const abs = await this.resolve(relativePath);
    await writeFile(abs, text, "utf8");
  }

  async readText(relativePath: string): Promise<string> {
    const abs = await this.resolve(relativePath);
    return readFile(abs, "utf8");
  }

  async readBytes(relativePath: string): Promise<Uint8Array> {
    const abs = await this.resolve(relativePath);
    return new Uint8Array(await readFile(abs));
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.statFile(relativePath);
      return true;
    } catch {
      return false;
    }
  }

  async statFile(relativePath: string): Promise<{ size: number; mtimeMs: number }> {
    const abs = await this.resolve(relativePath);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`Not a regular file: ${relativePath}`);
    }
    return { size: info.size, mtimeMs: info.mtimeMs };
  }
}
