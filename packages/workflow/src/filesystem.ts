/**
 * Node-only filesystem primitives. The browser entrypoint of the package must
 * never import this module; portable code lives in crypto.ts, text.ts, and
 * store.ts.
 */
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { randomBytes, utf8Bytes } from "./crypto.js";
import { registerDefaultWorkspaceStore, type WorkspaceStore } from "./store.js";
import { isAbsolutePath } from "./text.js";

/**
 * Resolve a workspace-relative path against the workspace root and verify
 * containment. For paths whose final component may not exist yet, the nearest
 * existing ancestor is realpathed and checked against the realpath of the root.
 */
export async function resolveWithinRoot(root: string, relativePath: string): Promise<string> {
  if (isAbsolutePath(relativePath)) {
    throw new Error(`Absolute paths are not allowed: ${relativePath}`);
  }
  const rootReal = await realpath(root);
  const candidate = normalize(join(rootReal, relativePath));
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) {
    throw new Error(`Path escapes the workspace root: ${relativePath}`);
  }
  // Walk up until an existing ancestor is found and verify its realpath stays
  // inside the root. This rejects symlink escapes.
  let existing = candidate;
  for (;;) {
    try {
      const real = await realpath(existing);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        throw new Error(`Symlink escapes the workspace root: ${relativePath}`);
      }
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw new Error(`Unresolvable path: ${relativePath}`);
      }
      existing = parent;
    }
  }
}

/** Write a file atomically: temp file in the same directory, then rename. */
export async function atomicWriteFile(absPath: string, data: Uint8Array | string): Promise<void> {
  const dir = dirname(absPath);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.tmp-${process.pid}-${randomBytes(6).reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "")}-${Date.now()}`
  );
  try {
    await writeFile(tmp, data);
    const handle = await open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, absPath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteText(
  absPath: string,
  text: string,
  opts: { executable?: boolean } = {}
): Promise<void> {
  await atomicWriteFile(absPath, utf8Bytes(text));
  if (opts.executable) {
    // No-op on Windows; kept for parity with POSIX hosts.
  }
}

export async function sha256OfFile(absPath: string): Promise<string> {
  const { sha256Hex } = await import("./crypto.js");
  const data = await readFile(absPath);
  return sha256Hex(data);
}

export async function readTextFile(absPath: string): Promise<string> {
  return readFile(absPath, "utf8");
}

/** Filesystem-backed WorkspaceStore rooted at an absolute directory. */
export class NodeWorkspaceStore implements WorkspaceStore {
  constructor(readonly root: string) {}

  private abs(relativePath: string): Promise<string> {
    return resolveWithinRoot(this.root, relativePath);
  }

  async mkdir(relativePath: string): Promise<void> {
    await mkdir(await this.abs(relativePath), { recursive: true });
  }

  async writeText(relativePath: string, text: string): Promise<void> {
    await atomicWriteFile(await this.abs(relativePath), utf8Bytes(text));
  }

  async writeBytes(relativePath: string, bytes: Uint8Array): Promise<void> {
    await atomicWriteFile(await this.abs(relativePath), bytes);
  }

  async writeTextDirect(relativePath: string, text: string): Promise<void> {
    await writeFile(await this.abs(relativePath), text, "utf8");
  }

  async appendText(relativePath: string, text: string): Promise<void> {
    const abs = await this.abs(relativePath);
    await mkdir(dirname(abs), { recursive: true });
    await appendFile(abs, text, "utf8");
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(await this.abs(relativePath), "utf8");
  }

  async readBytes(relativePath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(await this.abs(relativePath)));
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.stat(relativePath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(relativePath: string): Promise<{ size: number; mtimeMs: number }> {
    const abs = await this.abs(relativePath);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`Not a regular file: ${relativePath}`);
    }
    return { size: info.size, mtimeMs: info.mtimeMs };
  }

  async readdir(relativePath: string): Promise<string[]> {
    return readdir(await this.abs(relativePath));
  }

  async resolvePath(relativePath: string): Promise<string> {
    return this.abs(relativePath);
  }
}

// Node entrypoints (tests, service, scripts) import this module via the
// package index, which registers the filesystem-backed default store.
registerDefaultWorkspaceStore((root) => new NodeWorkspaceStore(root));
