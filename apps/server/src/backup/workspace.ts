import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { TaskStore } from "../tasks/store.js";
import { WorkspaceMeetings } from "../meetings/store.js";
import { TranscriptCatalogStore } from "../transcript-catalog/store.js";

const Entry = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});
const Manifest = z.object({
  version: z.literal(1),
  capturedAt: z.string(),
  files: z.array(Entry),
  canonicalHash: z.string(),
});

/**
 * Offline backup and restoration at one verified quiescent point (#353). The
 * host check must reject any possible writer before and after each copy. The
 * command never starts the application, connects a provider or replaces a live
 * Workspace. Until current deletion/spend fences can be applied independently,
 * restoration requires the current Workspace to match the captured point.
 */
export class WorkspaceBackup {
  constructor(
    private readonly workspace: string,
    private readonly assertQuiescent: () => Promise<void>,
  ) {}

  async capture(destination: string): Promise<{ fileCount: number; capturedAt: string }> {
    await disjoint(this.workspace, destination);
    await requireAbsent(destination);
    await this.assertQuiescent();
    const files = await inventory(this.workspace);
    const canonicalHash = canonical(this.workspace);
    const staging = `${destination}.partial`;
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.cp(this.workspace, join(staging, "workspace"), { recursive: true });
    await this.assertQuiescent();
    equal(await inventory(this.workspace), files);
    equal(await inventory(join(staging, "workspace")), files);
    equal(canonical(join(staging, "workspace")), canonicalHash);
    const capturedAt = new Date().toISOString();
    await fs.writeFile(
      join(staging, "manifest.json"),
      JSON.stringify({ version: 1, capturedAt, files, canonicalHash }),
      { mode: 0o600, flag: "wx" },
    );
    await fs.rename(staging, destination);
    return { fileCount: files.length, capturedAt };
  }

  async restore(backup: string, destination: string): Promise<void> {
    if (basename(resolve(backup)).endsWith(".partial"))
      throw new Error("An interrupted partial backup is not accepted");
    await disjoint(this.workspace, destination);
    await disjoint(backup, destination);
    await requireAbsent(destination);
    await this.assertQuiescent();
    const manifest = Manifest.parse(
      JSON.parse(await fs.readFile(join(backup, "manifest.json"), "utf8")),
    );
    equal(await inventory(join(backup, "workspace")), manifest.files);
    // No old snapshot is evidence of current deletion intent or remaining spend.
    equal(await inventory(this.workspace), manifest.files);
    const staging = `${destination}.partial`;
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.cp(join(backup, "workspace"), join(staging, "workspace"), { recursive: true });
    equal(await inventory(join(staging, "workspace")), manifest.files);
    equal(canonical(join(staging, "workspace")), manifest.canonicalHash);
    await this.assertQuiescent();
    equal(await inventory(this.workspace), manifest.files);
    await fs.chmod(join(staging, "workspace"), 0o700);
    await fs.rename(join(staging, "workspace"), resolve(destination));
    await fs.rmdir(staging);
  }
}

async function disjoint(source: string, destination: string): Promise<void> {
  const from = await fs.realpath(source);
  const to = join(await fs.realpath(dirname(resolve(destination))), basename(destination));
  if (from === to || from.startsWith(`${to}${sep}`) || to.startsWith(`${from}${sep}`))
    throw new Error("Backup source and destination overlap");
}

async function requireAbsent(path: string): Promise<void> {
  const stat = await fs.lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (stat) throw new Error("Backup destination already exists");
}

async function inventory(root: string): Promise<z.infer<typeof Entry>[]> {
  const entries: z.infer<typeof Entry>[] = [];
  async function walk(relative: string): Promise<void> {
    const path = join(root, relative);
    const stat = await fs.lstat(path);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(path)).sort()) await walk(join(relative, name));
    } else if (stat.isFile()) {
      const bytes = await fs.readFile(path);
      entries.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    } else throw new Error("Backup refuses symlinks and special files");
  }
  await walk("");
  return entries;
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      "Workspace backup verification failed: inventory changed or integrity mismatch",
    );
}

function canonical(root: string): string {
  const tasks = new TaskStore(root);
  const catalog = new TranscriptCatalogStore(root);
  return hash(
    JSON.stringify({
      tasks: tasks.readTasks(),
      lists: tasks.readLists(),
      actionItems: tasks.readActionItems(),
      cutover: tasks.cutoverReceipt(),
      meetings: new WorkspaceMeetings(root).list(),
      transcripts: catalog.listTranscripts(),
      consent: catalog.readConsent(),
      ledger: catalog.readLedger(),
      tombstones: catalog.listTombstones(),
    }),
  );
}
