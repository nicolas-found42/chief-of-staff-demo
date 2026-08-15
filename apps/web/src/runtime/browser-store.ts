/**
 * IndexedDB-backed WorkspaceStore for the in-browser engine. Keys are the
 * workspace-relative paths (forward slashes). All mutating operations are
 * serialized through a promise queue so concurrent engine writes cannot race;
 * IndexedDB transactions add a second layer of isolation per operation.
 */
import type { WorkspaceStore } from "@chief-of-staff/workflow/browser";

interface StoredFile {
  path: string;
  bytes: ArrayBuffer;
  mtimeMs: number;
}

const DB_NAME = "chief-of-staff-workspace";
const DB_VERSION = 1;
const STORE_NAME = "files";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "path" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function normalizePath(relativePath: string): string {
  const parts: string[] = [];
  for (const part of relativePath.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export class BrowserWorkspaceStore implements WorkspaceStore {
  private db: Promise<IDBDatabase> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private getDb(): Promise<IDBDatabase> {
    this.db ??= openDatabase();
    return this.db;
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async getFile(path: string): Promise<StoredFile | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(path);
      request.onsuccess = () => resolve((request.result as StoredFile | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
  }

  private async putFile(path: string, bytes: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const record: StoredFile = {
      path,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      mtimeMs: Date.now(),
    };
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
    });
  }

  private async deleteFile(path: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .delete(path);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
    });
  }

  private async allFiles(): Promise<StoredFile[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result as StoredFile[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
  }

  private async requireFile(relativePath: string): Promise<StoredFile> {
    const key = normalizePath(relativePath);
    const file = await this.getFile(key);
    if (!file) {
      const error = new Error(`No such file: ${relativePath}`);
      Object.assign(error, { code: "ENOENT" });
      throw error;
    }
    return file;
  }

  mkdir(_relativePath: string): Promise<void> {
    // Flat key space: directories exist implicitly.
    return Promise.resolve();
  }

  writeText(relativePath: string, text: string): Promise<void> {
    return this.serialize(() =>
      this.putFile(normalizePath(relativePath), new TextEncoder().encode(text))
    );
  }

  writeBytes(relativePath: string, bytes: Uint8Array): Promise<void> {
    return this.serialize(() => this.putFile(normalizePath(relativePath), bytes));
  }

  writeTextDirect(relativePath: string, text: string): Promise<void> {
    return this.writeText(relativePath, text);
  }

  appendText(relativePath: string, text: string): Promise<void> {
    return this.serialize(async () => {
      const key = normalizePath(relativePath);
      const existing = await this.getFile(key);
      const combined = existing
        ? `${new TextDecoder().decode(existing.bytes)}${text}`
        : text;
      await this.putFile(key, new TextEncoder().encode(combined));
    });
  }

  readText(relativePath: string): Promise<string> {
    return this.serialize(async () => {
      const file = await this.requireFile(relativePath);
      return new TextDecoder().decode(file.bytes);
    });
  }

  readBytes(relativePath: string): Promise<Uint8Array> {
    return this.serialize(async () => {
      const file = await this.requireFile(relativePath);
      return new Uint8Array(file.bytes);
    });
  }

  exists(relativePath: string): Promise<boolean> {
    return this.serialize(async () => (await this.getFile(normalizePath(relativePath))) !== null);
  }

  stat(relativePath: string): Promise<{ size: number; mtimeMs: number }> {
    return this.serialize(async () => {
      const file = await this.requireFile(relativePath);
      return { size: file.bytes.byteLength, mtimeMs: file.mtimeMs };
    });
  }

  readdir(relativePath: string): Promise<string[]> {
    return this.serialize(async () => {
      const dir = normalizePath(relativePath);
      const prefix = dir.length === 0 ? "" : `${dir}/`;
      const files = await this.allFiles();
      const names = new Set<string>();
      for (const file of files) {
        if (prefix.length > 0 && !file.path.startsWith(prefix)) {
          continue;
        }
        const rest = file.path.slice(prefix.length);
        const firstSegment = rest.split("/")[0];
        if (firstSegment.length > 0) {
          names.add(firstSegment);
        }
      }
      return [...names].sort();
    });
  }

  async clear(): Promise<void> {
    await this.serialize(async () => {
      const files = await this.allFiles();
      await Promise.all(files.map((file) => this.deleteFile(file.path)));
    });
  }
}
