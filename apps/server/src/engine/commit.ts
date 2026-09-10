import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  mkdirSync,
  promises as fs,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The Shell's commit protocol for Workspace records (#354, ADR-0086).
 *
 * File storage stays, so this cannot offer a multi-file transaction. What it
 * offers is one record committed by rename, verified by reading the published
 * bytes back, replayed only when an immutable identity already holds exactly
 * those bytes, and serialized against competing writers of the same record.
 * Durability is process and container recovery on an intact writable mount —
 * the page cache survives both — so no sync is performed and host-crash
 * durability stays unclaimed (the settled #339 boundary).
 *
 * Temporary siblings carry a unique suffix beside their target, so the rename
 * stays within one filesystem and two writers never share a temporary name.
 */

/** A record that exists but cannot be read as what it claims to be. */
export class WorkspaceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceIntegrityError";
  }
}

/** A caller held an older generation than the record now carries. */
export class ExpectedVersionConflictError extends Error {
  constructor(
    path: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`Workspace record ${path} is at generation ${actual}, not ${expected}`);
    this.name = "ExpectedVersionConflictError";
  }
}

export interface WorkspaceWriter {
  /** Commit JSON bytes; resolves with the SHA-256 of what was published. */
  writeJson(path: string, value: unknown): Promise<string>;
  /** Commit text bytes; resolves with the SHA-256 of what was published. */
  writeFile(path: string, contents: string): Promise<string>;
  /**
   * Commit bytes under one immutable identity. Identical bytes replay; other
   * bytes are an integrity error rather than a replacement.
   */
  writeImmutable(
    path: string,
    contents: string,
  ): Promise<{ outcome: "written" | "replayed"; sha256: string }>;
  /** Read, transform and commit one record inside its own critical section. */
  update<T>(path: string, mutate: (current: unknown) => T | Promise<T>): Promise<T>;
  /** Commit a record only if it still carries `expectedGeneration`. */
  replace(path: string, guard: { expectedGeneration: number }, next: unknown): Promise<string>;
}

// Factories are convenient for consumers, but a second consumer must not create
// a second authority for the same record inside the supported single process.
const chains = new Map<string, Promise<unknown>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();
const active = new Set<string>();

export function createWorkspaceWriter(): WorkspaceWriter {
  /**
   * One critical section per path. A second writer of the same record waits for
   * the first; a nested write of the record already inside the section is a
   * programming error, not a deadlock to wait out.
   */
  function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
    path = resolve(path);
    if (held.getStore()?.has(path)) {
      return Promise.reject(
        new WorkspaceIntegrityError(`Workspace record ${path} is already being written`),
      );
    }
    const previous = chains.get(path) ?? Promise.resolve();
    // Only the caller's async ancestry identifies re-entry. A global held set
    // mistakes an unrelated caller arriving during an await for a nested write.
    const ancestry = new Set(held.getStore());
    ancestry.add(path);
    const run = previous.then(() =>
      held.run(ancestry, async () => {
        active.add(path);
        try {
          return await operation();
        } finally {
          active.delete(path);
        }
      }),
    );
    const tail = run.catch(() => undefined);
    chains.set(path, tail);
    void tail.then(() => {
      if (chains.get(path) === tail) chains.delete(path);
    });
    return run;
  }

  async function commit(path: string, bytes: Buffer): Promise<string> {
    await fs.mkdir(dirname(path), { recursive: true });
    const temporary = join(
      dirname(path),
      `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(temporary, bytes);
      await fs.rename(temporary, path);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    const published = await fs.readFile(path);
    if (!published.equals(bytes)) {
      throw new WorkspaceIntegrityError(
        `Workspace record ${path} published bytes do not match the committed record`,
      );
    }
    return createHash("sha256").update(published).digest("hex");
  }

  return {
    async writeJson(path, value) {
      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      return serialize(path, () => commit(path, bytes));
    },

    async writeFile(path, contents) {
      return serialize(path, () => commit(path, Buffer.from(contents, "utf8")));
    },

    async writeImmutable(path, contents) {
      const bytes = Buffer.from(contents, "utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return serialize(path, async () => {
        const existing = await readOrNull(path);
        if (existing !== null) {
          if (existing !== bytes.toString("utf8")) {
            throw new WorkspaceIntegrityError(
              `Workspace record ${path} already holds different bytes under this identity`,
            );
          }
          return { outcome: "replayed" as const, sha256 };
        }
        await commit(path, bytes);
        return { outcome: "written" as const, sha256 };
      });
    },

    async update<T>(path: string, mutate: (current: unknown) => T | Promise<T>) {
      return serialize(path, async () => {
        const current = await readParsedOrNull(path);
        const next = await mutate(current);
        await commit(path, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"));
        return next;
      });
    },

    async replace(path, guard, next) {
      return serialize(path, async () => {
        const current = await readParsedOrNull(path);
        const generation = generationOf(current);
        if (generation !== guard.expectedGeneration) {
          throw new ExpectedVersionConflictError(path, guard.expectedGeneration, generation);
        }
        return commit(path, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"));
      });
    },
  };
}

/**
 * Read one record, or `null` when it does not exist yet. A file that exists and
 * fails the guard is refused rather than narrowed: an unreadable record is
 * corruption, and the difference between "no record" and "damaged record" is
 * what stops a later whole-record write from turning one into the other.
 */
export function readJsonRecord<T>(path: string, guard: (value: unknown) => value is T): T | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkspaceIntegrityError(`Workspace record ${path} is not a readable record`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkspaceIntegrityError(`Workspace record ${path} is not a readable record`);
  }
  if (!guard(parsed)) {
    throw new WorkspaceIntegrityError(`Workspace record ${path} is not a readable record`);
  }
  return parsed;
}

/**
 * Commit one JSON record synchronously for call sites that cannot await: the
 * same unique temporary sibling, rename and read-back verification as the
 * writer above, without the per-record queue (JavaScript turns between the
 * read and the write of a synchronous caller cannot interleave).
 */
export function writeJsonVerifiedSync(path: string, value: unknown): string {
  return writeFileVerifiedSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Commit text bytes synchronously, verified the same way. */
export function writeFileVerifiedSync(path: string, contents: string): string {
  // A synchronous store cannot wait for an async owner. Refuse before any
  // effects so its caller can retry from current state instead of losing edits.
  if (active.has(resolve(path))) {
    throw new WorkspaceIntegrityError(`Workspace record ${path} is already being written`);
  }
  const bytes = Buffer.from(contents, "utf8");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const published = readFileSync(path);
  if (!published.equals(bytes)) {
    throw new WorkspaceIntegrityError(
      `Workspace record ${path} published bytes do not match the committed record`,
    );
  }
  return createHash("sha256").update(published).digest("hex");
}

/** The record's own generation, absent meaning the first one. */
function generationOf(record: unknown): number {
  if (typeof record !== "object" || record === null || !("generation" in record)) return 0;
  const value: unknown = record.generation;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

async function readOrNull(path: string): Promise<string | null> {
  return fs.readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

async function readParsedOrNull(path: string): Promise<unknown> {
  const text = await readOrNull(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceIntegrityError(`Workspace record ${path} is not a readable record`);
  }
}
