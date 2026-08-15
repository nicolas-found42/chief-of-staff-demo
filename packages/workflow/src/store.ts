/**
 * Storage boundary behind the Workspace. All paths are workspace-relative with
 * forward slashes. Implementations exist for the Node filesystem (see
 * filesystem.ts) and for the browser (IndexedDB, in the web app); the engine
 * and service code only ever talk to this interface.
 */
export interface WorkspaceStore {
  /** Ensure a directory exists (no-op for stores without directories). */
  mkdir(relativePath: string): Promise<void>;
  /** Write atomically where the implementation supports it. */
  writeText(relativePath: string, text: string): Promise<void>;
  writeBytes(relativePath: string, bytes: Uint8Array): Promise<void>;
  /** Direct, non-atomic write (rare paths that must not go through temp files). */
  writeTextDirect(relativePath: string, text: string): Promise<void>;
  /** Append a chunk; creates the file when missing. Serialized by the caller. */
  appendText(relativePath: string, text: string): Promise<void>;
  /** Read as UTF-8. Missing files throw an error with code "ENOENT". */
  readText(relativePath: string): Promise<string>;
  readBytes(relativePath: string): Promise<Uint8Array>;
  exists(relativePath: string): Promise<boolean>;
  stat(relativePath: string): Promise<{ size: number; mtimeMs: number }>;
  /** Entry names directly under a directory. */
  readdir(relativePath: string): Promise<string[]>;
  /** Node-only: resolve to an absolute, containment-checked path. */
  resolvePath?(relativePath: string): Promise<string>;
}

/** Registry seam: Node entrypoints register the NodeFilesystemStore so the
 * classic `new Workspace(root)` constructor keeps working; browser code passes
 * its store explicitly. */
let defaultStoreFactory: ((root: string) => WorkspaceStore) | null = null;

export function registerDefaultWorkspaceStore(factory: (root: string) => WorkspaceStore): void {
  defaultStoreFactory = factory;
}

export function createDefaultWorkspaceStore(root: string): WorkspaceStore {
  if (!defaultStoreFactory) {
    throw new Error(
      "No default workspace store registered; pass a store explicitly or import the node entrypoint"
    );
  }
  return defaultStoreFactory(root);
}
