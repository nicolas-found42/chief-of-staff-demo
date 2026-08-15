import { createDefaultWorkspaceStore, type WorkspaceStore } from "./store.js";

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

function joinPath(root: string, ...parts: string[]): string {
  return [root, ...parts].filter((part) => part.length > 0).join("/");
}

/**
 * Path and I/O boundary for the workspace. Every read/write goes through a
 * WorkspaceStore using workspace-relative paths. With the default Node store
 * the layout paths are absolute filesystem paths; with a browser store the
 * root is empty and layout paths stay relative.
 */
export class Workspace {
  readonly store: WorkspaceStore;

  constructor(
    readonly root: string,
    store?: WorkspaceStore
  ) {
    this.store = store ?? createDefaultWorkspaceStore(root);
  }

  get layout(): WorkspaceLayout {
    const root = this.root;
    return {
      inboxDir: joinPath(root, "inbox", "transcripts"),
      sourceProcessingDir: joinPath(root, "source", "processing"),
      sourceProcessedDir: joinPath(root, "source", "processed"),
      sourceFailedDir: joinPath(root, "source", "failed"),
      gmailDraftsDir: joinPath(root, "gmail", "drafts"),
      tasksEmailDraftsDir: joinPath(root, "tasks", "email-drafts"),
      tasksBusinessPlansDir: joinPath(root, "tasks", "business-plans"),
      tasksMyTasksDir: joinPath(root, "tasks", "my-tasks"),
      docsDir: joinPath(root, "docs", "strategy-and-planning"),
      notificationsDir: joinPath(root, "notifications"),
      trackingCsv: joinPath(root, "tracking", "actions.csv"),
      calendarFile: joinPath(root, "calendar", "events.json"),
      configDir: joinPath(root, "config"),
      runsDir: joinPath(root, "runs"),
      serviceDir: joinPath(root, "service"),
      claimsDir: joinPath(root, "service", "claims"),
    };
  }

  runDir(runId: string): string {
    return joinPath(this.root, "runs", runId);
  }

  stepsDir(runId: string): string {
    return joinPath(this.root, "runs", runId, "steps");
  }

  inputDir(runId: string): string {
    return joinPath(this.root, "runs", runId, "input");
  }

  llmDir(runId: string): string {
    return joinPath(this.root, "runs", runId, "llm");
  }

  /** Resolve a workspace-relative path to an absolute, containment-checked
   * path. Node store only; browser stores have no absolute filesystem. */
  async resolve(relativePath: string): Promise<string> {
    if (!this.store.resolvePath) {
      throw new Error("This workspace store cannot resolve absolute paths");
    }
    return this.store.resolvePath(relativePath);
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
    const dirs = [
      "inbox/transcripts",
      "source/processing",
      "source/processed",
      "source/failed",
      "gmail/drafts",
      "tasks/email-drafts",
      "tasks/business-plans",
      "tasks/my-tasks",
      "docs/strategy-and-planning",
      "notifications",
      "config",
      "runs",
      "service",
      "service/claims",
      "tracking",
      "calendar",
      "source",
    ];
    await Promise.all(dirs.map((dir) => this.store.mkdir(dir)));
  }

  async writeText(relativePath: string, text: string): Promise<void> {
    await this.store.writeText(relativePath, text);
  }

  async writeBytes(relativePath: string, bytes: Uint8Array): Promise<void> {
    await this.store.writeBytes(relativePath, bytes);
  }

  async writeTextDirect(relativePath: string, text: string): Promise<void> {
    await this.store.writeTextDirect(relativePath, text);
  }

  async appendText(relativePath: string, text: string): Promise<void> {
    await this.store.appendText(relativePath, text);
  }

  async readText(relativePath: string): Promise<string> {
    return this.store.readText(relativePath);
  }

  async readBytes(relativePath: string): Promise<Uint8Array> {
    return this.store.readBytes(relativePath);
  }

  async exists(relativePath: string): Promise<boolean> {
    return this.store.exists(relativePath);
  }

  async statFile(relativePath: string): Promise<{ size: number; mtimeMs: number }> {
    return this.store.stat(relativePath);
  }
}
