import { describe, expect, it } from "vitest";
import {
  encodeDeterministicUlid,
  createDeterministicIdGenerator,
  localUri,
  parseLocalUri,
  resolveWithinRoot,
  safeFilenameFragment,
  atomicWriteFile,
  TrackingCsv,
  Workspace,
} from "@chief-of-staff/workflow";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("deterministic ids", () => {
  it("produces stable ULID-shaped ids for the same seeds", () => {
    const digest = createHash("sha256").update("artifact:r:s:1").digest();
    const first = encodeDeterministicUlid(new Uint8Array(digest));
    const second = encodeDeterministicUlid(new Uint8Array(digest));
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("produces distinct ids for distinct inputs", () => {
    const a = encodeDeterministicUlid(new Uint8Array(createHash("sha256").update("a").digest()));
    const b = encodeDeterministicUlid(new Uint8Array(createHash("sha256").update("b").digest()));
    expect(a).not.toBe(b);
  });

  it("derives deterministic artifact and row ids from runId, taskIndex, and stepId", () => {
    const ids = createDeterministicIdGenerator("seed");
    const runId = ids.runId();
    const artifact = ids.artifactId(runId, "maoa1p", 2);
    expect(artifact).toBe(ids.artifactId(runId, "maoa1p", 2));
    expect(artifact).not.toBe(ids.artifactId(runId, "maoa1p", 3));
    expect(ids.rowId(runId, 7)).toBe(`${runId}:0007`);
  });
});

describe("filename sanitization", () => {
  it("strips unsafe characters and leading dots", () => {
    const fragment = safeFilenameFragment("..\\evil<name>:\"x\"/y?*z");
    // eslint-disable-next-line no-control-regex
    expect(fragment).not.toMatch(/[\u0000-\u001f<>:"/\\|?*]/);
    expect(fragment).not.toMatch(/^\./);
    expect(safeFilenameFragment("...hidden")).toBe("hidden");
  });

  it("never lets raw LLM-shaped text become a path", () => {
    const fragment = safeFilenameFragment("../../windows/system32");
    expect(fragment).not.toMatch(/[\\/]/);
    expect(fragment).not.toMatch(/^\./);
    const absolute = `C:/root/${fragment}`;
    expect(absolute.startsWith("C:/root/")).toBe(true);
  });

  it("falls back for empty input", () => {
    expect(safeFilenameFragment("   ...")).toBe("item");
  });
});

describe("local URIs", () => {
  it("round-trips workspace-relative paths", () => {
    const uri = localUri("gmail/drafts/abc.md");
    expect(uri).toBe("local://gmail/drafts/abc.md");
    expect(parseLocalUri(uri)).toBe("gmail/drafts/abc.md");
  });

  it("rejects traversal and absolute paths in URIs", () => {
    expect(() => parseLocalUri("local://../escape")).toThrow();
    expect(() => parseLocalUri("local://C:/absolute")).toThrow();
    expect(() => parseLocalUri("local://a\\b")).toThrow();
  });
});

describe("path containment", () => {
  it("resolves safe paths inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "containment-"));
    const rootReal = await realpath(root);
    await mkdir(join(root, "sub"), { recursive: true });
    const resolved = await resolveWithinRoot(root, "sub/file.txt");
    expect(resolved.startsWith(rootReal)).toBe(true);
  });

  it("rejects traversal and absolute paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "containment-"));
    await expect(resolveWithinRoot(root, "../escape")).rejects.toThrow();
    await expect(resolveWithinRoot(root, "C:\\Windows\\system32")).rejects.toThrow();
  });
});

describe("atomic writes", () => {
  it("writes the full content and leaves no temp files behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    const target = join(dir, "out.txt");
    await atomicWriteFile(target, "hello\n");
    expect(await readFile(target, "utf8")).toBe("hello\n");
    const entries = await readdir(dir);
    expect(entries).toEqual(["out.txt"]);
  });

  it("overwrites atomically on second write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    const target = join(dir, "out.txt");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    expect(await readFile(target, "utf8")).toBe("second");
  });
});

describe("tracking CSV", () => {
  const header =
    "row_id,run_id,task_index,task_name,task_type,assigned_to,deadline,source_step,target_uri,status,created_at,source_validation_error";

  it("has the exact required header", () => {
    expect(header).toBe(
      "row_id,run_id,task_index,task_name,task_type,assigned_to,deadline,source_step,target_uri,status,created_at,source_validation_error"
    );
  });

  it("upserts idempotently by row_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "csv-"));
    const csv = new TrackingCsv(new Workspace(dir), "actions.csv");
    const row = {
      row_id: "run:0000",
      run_id: "run",
      task_index: 0,
      task_name: 'Has, "quotes" and, commas',
      task_type: "email",
      assigned_to: "Ada",
      deadline: "",
      source_step: "7b5596",
      target_uri: "local://gmail/drafts/a.md",
      status: "created",
      created_at: "2026-08-15T15:00:00.000Z",
      source_validation_error: "Scope is not set",
    };
    await csv.upsert(row);
    const firstText = await readFile(join(dir, "actions.csv"), "utf8");
    expect(firstText).toContain('"Has, ""quotes"" and, commas"');
    await csv.upsert({ ...row, task_name: "Updated name" });
    const rows = await csv.readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].task_name).toBe("Updated name");
    const text = await readFile(join(dir, "actions.csv"), "utf8");
    expect(text.startsWith(header)).toBe(true);
  });

  it("preserves rows for other ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "csv-"));
    const csv = new TrackingCsv(new Workspace(dir), "actions.csv");
    const base = {
      run_id: "run",
      task_index: 0,
      task_name: "Task",
      task_type: "other",
      assigned_to: "Ada",
      deadline: "",
      source_step: "pthrsh",
      target_uri: "local://tasks/my-tasks/a.json",
      status: "created",
      created_at: "2026-08-15T15:00:00.000Z",
      source_validation_error: "Scope is not set",
    };
    await csv.upsert({ ...base, row_id: "run:0000" });
    await csv.upsert({ ...base, row_id: "run:0001" });
    await csv.upsert({ ...base, row_id: "run:0002" });
    expect(await csv.readRows()).toHaveLength(3);
  });

  it("refuses to parse a mismatched header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "csv-"));
    await writeFile(join(dir, "actions.csv"), "other,header\n", "utf8");
    const csv = new TrackingCsv(new Workspace(dir), "actions.csv");
    await expect(csv.readRows()).rejects.toThrow(/header mismatch/);
  });
});
