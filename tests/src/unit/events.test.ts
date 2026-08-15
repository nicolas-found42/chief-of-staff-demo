import { describe, expect, it } from "vitest";
import { EventSink } from "@chief-of-staff/workflow";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("event sink", () => {
  it("assigns monotonic sequence numbers and appends only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "events-"));
    const path = join(dir, "events.jsonl");
    const sink = new EventSink(path, () => new Date("2026-08-15T15:00:00.000Z"));
    await sink.emit({ runId: "run-1", type: "run.started" });
    await sink.emit({ runId: "run-1", type: "step.started", stepId: "trigger" });
    const first = await readFile(path, "utf8");
    await sink.emit({ runId: "run-1", type: "run.finished", data: { status: "succeeded" } });
    const second = await readFile(path, "utf8");
    expect(first).toContain('"sequence":1');
    expect(first).toContain('"sequence":2');
    expect(second.startsWith(first)).toBe(true);
    const lines = second.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number });
    expect(lines.map((line) => line.sequence)).toEqual([1, 2, 3]);
    expect(sink.nextSequence).toBe(4);
  });

  it("serializes concurrent emissions without corrupting lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "events-"));
    const path = join(dir, "events.jsonl");
    const sink = new EventSink(path, () => new Date("2026-08-15T15:00:00.000Z"));
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        sink.emit({ runId: "run-1", type: "progress", data: { index } })
      )
    );
    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(50);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("rejects malformed manual appends on read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "events-"));
    const path = join(dir, "events.jsonl");
    await writeFile(path, "not json\n", "utf8");
    await expect(readFile(path, "utf8")).resolves.toBe("not json\n");
  });
});
