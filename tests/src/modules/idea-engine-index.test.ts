import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdeaEngineIdea, IdeaEngineRunResult } from "@chief-of-staff-demo/shared";
import { IdeaIndex } from "../../../apps/server/src/modules/idea-engine/index";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

let runs: Runs;
let spreadsheet: { id: string; url: string } | null;

function contentIdea(title: string): IdeaEngineIdea {
  return {
    Title: title,
    Description: `Description for ${title}`,
    "Target Audience": "founders",
    CTA: "Read more",
    Format: "articles",
    ContentType: "article",
    "Custom Prompt": `Expand ${title}`,
    evidence: { at: "00:01", quote: title },
    confidence: 0.95,
  };
}

function createRun(options: {
  module?: string;
  fileName?: string;
  externalId?: string;
  result?: string;
  summary?: string;
}) {
  const handle = runs.create({
    module: options.module ?? "idea-engine",
    moduleVersion: 1,
    intake: "drive",
    ...(options.fileName === undefined ? {} : { fileName: options.fileName }),
    sourceUrl: options.externalId ? `https://drive.google.test/${options.externalId}` : null,
    externalId: options.externalId ?? null,
  });
  if (options.result !== undefined) {
    handle.writeArtifact("result.json", options.result);
  }
  handle.finished({
    status: "done",
    ...(options.summary === undefined ? {} : { summary: options.summary }),
  });
  return handle;
}

function serializedRunResult(title: string): string {
  const value: IdeaEngineRunResult = {
    version: 1,
    sourceId: title,
    sourceFileName: `${title}.md`,
    sourceUrl: null,
    ideas: [contentIdea(title)],
    perTypeReasons: {},
    reason: null,
    processedAt: "2026-08-25T12:00:00.000Z",
  };
  return JSON.stringify(value);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
  runs = openRuns(mkdtempSync(join(tmpdir(), "cos-idea-index-")));
  spreadsheet = { id: "sheet-1", url: "https://docs.google.test/sheet-1" };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Idea Engine Cross-Run index", () => {
  it("derives valid Content Ideas from Runs and skips missing or torn results", () => {
    const valid = createRun({
      fileName: "meeting.md",
      externalId: "drive-1",
      result: serializedRunResult("Vertical agents"),
      summary: "1 Content Idea",
    });
    createRun({
      module: "transcript",
      fileName: "other.md",
      result: serializedRunResult("Wrong Module"),
    });
    createRun({ fileName: "pending-result.md" });
    createRun({ fileName: "torn.md", result: "{ torn" });
    createRun({ fileName: "wrong-shape.md", result: JSON.stringify({ ideas: "not-an-array" }) });

    const index = new IdeaIndex({ runs, spreadsheet: () => spreadsheet }).read();

    expect(index.spreadsheet).toEqual(spreadsheet);
    expect(index.runs).toEqual([
      {
        runId: valid.id,
        createdAt: valid.read().createdAt,
        fileName: "meeting.md",
        sourceUrl: "https://drive.google.test/drive-1",
        externalId: "drive-1",
        ideas: [contentIdea("Vertical agents")],
        summary: "1 Content Idea",
      },
    ]);
    expect(index.ideas).toEqual([contentIdea("Vertical agents")]);
  });

  it("caches one derived view until invalidated", () => {
    const older = createRun({
      fileName: "older.md",
      externalId: "drive-old",
      result: serializedRunResult("Older idea"),
    });
    const index = new IdeaIndex({ runs, spreadsheet: () => spreadsheet });
    expect(index.read().runs.map((entry) => entry.runId)).toEqual([older.id]);

    vi.setSystemTime(new Date("2026-08-25T12:01:00.000Z"));
    const newer = createRun({
      externalId: "drive-new",
      result: serializedRunResult("Newer idea"),
    });

    expect(index.read().runs.map((entry) => entry.runId)).toEqual([older.id]);
    index.invalidate();
    expect(index.read().runs.map((entry) => entry.runId)).toContain(newer.id);
  });

  it("returns newest Runs first with current spreadsheet metadata", () => {
    const older = createRun({
      fileName: "older.md",
      externalId: "drive-old",
      result: serializedRunResult("Older idea"),
    });
    vi.setSystemTime(new Date("2026-08-25T12:01:00.000Z"));
    const newer = createRun({
      externalId: "drive-new",
      result: serializedRunResult("Newer idea"),
    });
    spreadsheet = null;
    const index = new IdeaIndex({ runs, spreadsheet: () => spreadsheet });

    const current = index.read();
    expect(current.runs.map((entry) => entry.runId)).toEqual([newer.id, older.id]);
    expect(current.runs[0]?.fileName).toBeUndefined();
    expect(current.ideas.map((entry) => entry.Title)).toEqual(["Newer idea", "Older idea"]);
    expect(current.spreadsheet).toBeNull();
  });
});
