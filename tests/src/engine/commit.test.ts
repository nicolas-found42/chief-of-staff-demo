import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  ExpectedVersionConflictError,
  WorkspaceIntegrityError,
  createWorkspaceWriter,
  readJsonRecord,
} from "../../../apps/server/src/engine/commit";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "cos-commit-"));
  roots.push(root);
  return root;
}

it("publishes committed bytes and leaves no temporary sibling behind", async () => {
  const root = scratch();
  const writer = createWorkspaceWriter();
  await writer.writeJson(join(root, "records.json"), { version: 1, items: [1, 2, 3] });

  expect(JSON.parse(readFileSync(join(root, "records.json"), "utf8"))).toEqual({
    version: 1,
    items: [1, 2, 3],
  });
  expect(readdirSync(root)).toEqual(["records.json"]);
});

it.each(["ENOSPC", "EACCES"])("a %s error cannot publish a record", async (code) => {
  const root = scratch();
  const writer = createWorkspaceWriter();
  await writer.writeJson(join(root, "records.json"), { version: 1 });

  const write = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
    await write(...args);
    throw Object.assign(new Error(code), { code });
  });
  await expect(
    writer.update(join(root, "records.json"), (current) => ({
      ...(current as { version: number }),
      version: 2,
    })),
  ).rejects.toThrow(code);

  // The refused attempt left the previously committed record authoritative.
  expect(JSON.parse(readFileSync(join(root, "records.json"), "utf8"))).toEqual({ version: 1 });
});

it("verifies the bytes it published instead of trusting the write", async () => {
  const root = scratch();
  const writer = createWorkspaceWriter();
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
    await rename(from, to);
    await fs.writeFile(to, '{"version":99}\n', "utf8");
  });

  await expect(writer.writeJson(join(root, "records.json"), { version: 1 })).rejects.toThrow(
    "published bytes do not match",
  );
});

it("replays identical bytes to one immutable identity and refuses conflicting bytes", async () => {
  const root = scratch();
  const writer = createWorkspaceWriter();
  const path = join(root, "result.json");
  const bytes = JSON.stringify({ result: "first" });

  expect(await writer.writeImmutable(path, bytes)).toEqual({
    outcome: "written",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect((await writer.writeImmutable(path, bytes)).outcome).toBe("replayed");
  expect(readFileSync(path, "utf8")).toBe(bytes);
  await expect(writer.writeImmutable(path, JSON.stringify({ result: "second" }))).rejects.toThrow(
    WorkspaceIntegrityError,
  );
  expect(readFileSync(path, "utf8")).toBe(bytes);
});

it.each(["{ truncated", '{"version":1}trailing', "[]"])(
  "refuses %s as a record instead of returning a damaged value",
  (contents) => {
    const root = scratch();
    const path = join(root, "records.json");
    writeFileSync(path, contents, "utf8");
    expect(() =>
      readJsonRecord(path, (value): value is { version: number } => {
        return typeof value === "object" && value !== null && "version" in value;
      }),
    ).toThrow("is not a readable record");
  },
);

it("treats an absent record as absent and a readable one as itself", () => {
  const root = scratch();
  const isAnything = (value: unknown): value is unknown => value !== undefined;
  expect(readJsonRecord(join(root, "missing.json"), isAnything)).toBeNull();
  const path = join(root, "records.json");
  writeFileSync(path, '{"version":7}', "utf8");
  expect(
    readJsonRecord(path, (value): value is { version: number } => {
      return typeof value === "object" && value !== null && "version" in value;
    }),
  ).toEqual({ version: 7 });
});

it("serializes competing updates of one record and reads inside each turn", async () => {
  const root = scratch();
  const writer = createWorkspaceWriter();
  const path = join(root, "counter.json");
  await writer.writeJson(path, { generation: 0, count: 0 });

  const increment = async (): Promise<void> => {
    await writer.update(path, (current) => {
      const record = current as { generation: number; count: number };
      return { generation: record.generation + 1, count: record.count + 1 };
    });
  };
  await Promise.all([increment(), increment(), increment()]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ generation: 3, count: 3 });
});

it("rejects a stale expected generation instead of overwriting the newer record", async () => {
  const root = scratch();
  const writer = createWorkspaceWriter();
  const path = join(root, "record.json");
  await writer.writeJson(path, { generation: 4, title: "current" });

  await expect(
    writer.replace(path, { expectedGeneration: 3 }, { generation: 5, title: "stale writer" }),
  ).rejects.toThrow(ExpectedVersionConflictError);
  await writer.replace(path, { expectedGeneration: 4 }, { generation: 5, title: "current writer" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    generation: 5,
    title: "current writer",
  });
});

it("holds one critical section per record while other records keep moving", async () => {
  const root = scratch();
  const writer = createWorkspaceWriter();
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  await writer.writeJson(first, { generation: 0, value: 0 });
  await writer.writeJson(second, { generation: 0, value: 0 });
  const order: string[] = [];

  const held = Promise.withResolvers<void>();
  const slow = writer.update(first, async (current) => {
    order.push("first-start");
    await held.promise;
    order.push("first-end");
    return { ...(current as { generation: number; value: number }), value: 1 };
  });
  await delay(10);
  await writer.update(second, (current) => ({
    ...(current as { generation: number; value: number }),
    value: 1,
  }));
  expect(order).toEqual(["first-start"]);
  held.resolve();
  await slow;
  expect(order).toEqual(["first-start", "first-end"]);
  expect(JSON.parse(readFileSync(second, "utf8"))).toMatchObject({ value: 1 });
});

it("refuses a re-entrant update of the record it is already writing", async () => {
  const root = scratch();
  const writer = createWorkspaceWriter();
  const path = join(root, "record.json");
  await writer.writeJson(path, { generation: 0 });

  await expect(
    writer.update(path, async () => {
      await writer.replace(path, { expectedGeneration: 0 }, { generation: 1 });
      return { generation: 1 };
    }),
  ).rejects.toThrow("already being written");
});

it("counts a checksum for the bytes it committed", async () => {
  const root = scratch();
  const writer = createWorkspaceWriter();
  const path = join(root, "record.json");
  const { sha256 } = await writer.writeImmutable(path, "payload");
  expect(sha256).toBe(createHash("sha256").update("payload").digest("hex"));
  expect(existsSync(path)).toBe(true);
});
