import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { BrowserWorkspaceStore } from "../../../apps/web/src/runtime/browser-store";
import { Workspace, EventSink, TrackingCsv, utf8Bytes } from "@chief-of-staff/workflow/browser";

describe("browser workspace store", () => {
  it("round-trips text and bytes with atomically replaced content", async () => {
    const store = new BrowserWorkspaceStore();
    await store.writeText("a/b.txt", "first");
    await store.writeText("a/b.txt", "second");
    expect(await store.readText("a/b.txt")).toBe("second");
    expect(await store.exists("a/b.txt")).toBe(true);
    await expect(store.readText("a/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends without losing prior content and lists directory entries", async () => {
    const store = new BrowserWorkspaceStore();
    await store.appendText("log/events.jsonl", "a\n");
    await store.appendText("log/events.jsonl", "b\n");
    expect(await store.readText("log/events.jsonl")).toBe("a\nb\n");
    await store.writeText("log/other.txt", "x");
    await store.writeText("log/deep/nested.txt", "y");
    expect(await store.readdir("log")).toEqual(["deep", "events.jsonl", "other.txt"]);
    expect(await store.readdir("log/deep")).toEqual(["nested.txt"]);
  });

  it("keeps a full engine run on one store: manifest, events, and tracking csv", async () => {
    const store = new BrowserWorkspaceStore();
    const workspace = new Workspace("", store);
    await workspace.initialize();

    const events = new EventSink(workspace, "runs/r1/events.jsonl", () => new Date("2026-08-15T15:00:00.000Z"));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => events.emit({ runId: "r1", type: "progress", data: { i } }))
    );
    const eventText = await workspace.readText("runs/r1/events.jsonl");
    const sequences = eventText
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const csv = new TrackingCsv(workspace, "tracking/actions.csv");
    const row = {
      row_id: "r1:0000",
      run_id: "r1",
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
    await csv.upsert({ ...row, task_name: "Updated name" });
    expect(await csv.readRows()).toHaveLength(1);
    expect((await csv.readRows())[0].task_name).toBe("Updated name");

    const bytes = utf8Bytes("binary payload");
    await workspace.writeBytes("runs/r1/input/source.bin", bytes);
    expect(await workspace.readBytes("runs/r1/input/source.bin")).toEqual(bytes);
  });

  it("survives across store instances through the same IndexedDB database", async () => {
    const first = new BrowserWorkspaceStore();
    await first.writeText("config/profile.json", "{\"name\":\"Ada\"}");
    const second = new BrowserWorkspaceStore();
    expect(await second.readText("config/profile.json")).toBe("{\"name\":\"Ada\"}");
  });
});
