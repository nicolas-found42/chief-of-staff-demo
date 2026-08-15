import { describe, expect, it } from "vitest";
import { LOCAL_SCOPE_SUPPLIED_WARNING, TRACKING_SCOPE_VALIDATION_ERROR } from "@chief-of-staff/contracts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runGoldenTranscript } from "../helpers/engine.js";

/** Normalize run output: replace real filesystem timestamps so two replay runs
 * in different temp workspaces can be compared byte-for-byte. */
function normalize(text: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const replaceTimestamps = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(replaceTimestamps);
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(record)) {
        if (["birthtimeMs", "mtimeMs", "ctimeMs"].includes(key)) {
          out[key] = 0;
        } else {
          out[key] = replaceTimestamps(nested);
        }
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(replaceTimestamps(parsed));
}

async function readWorkspaceFile(relativePath: string, workspaceRoot: string): Promise<string> {
  return readFile(join(workspaceRoot, relativePath), "utf8");
}

describe("golden workflow run", () => {
  it("extracts three accepted tasks, excludes the unassigned one, and routes all three branches", async () => {
    const run = await runGoldenTranscript();
    const manifest = run.manifest;

    expect(manifest.status).toBe("succeeded");
    expect(manifest.tasks).toHaveLength(3);
    expect(manifest.tasks.map((task) => task.type)).toEqual([
      "email",
      "business plan",
      "other",
    ]);
    expect(manifest.tasks.map((task) => task.branch)).toEqual([
      "ou028y_xg63bi",
      "ou028y_vd3vc1",
      "ou028y_wtnzhv",
    ]);
    expect(manifest.discardedTasks).toBe(1);
    expect(manifest.unresolvedRefs).toEqual([]);
    expect(manifest.warnings.filter((w) => w.code === LOCAL_SCOPE_SUPPLIED_WARNING)).toHaveLength(3);
  });

  it("produces one email draft, one plan, and three local task resources", async () => {
    const run = await runGoldenTranscript();
    const { workspace, runId } = run;

    const draftFiles = await listFiles(join(workspace.root, "gmail", "drafts"));
    const planFiles = await listFiles(join(workspace.root, "docs", "strategy-and-planning"));
    const emailTaskFiles = await listFiles(join(workspace.root, "tasks", "email-drafts"));
    const planTaskFiles = await listFiles(join(workspace.root, "tasks", "business-plans"));
    const myTaskFiles = await listFiles(join(workspace.root, "tasks", "my-tasks"));

    expect(draftFiles).toHaveLength(1);
    expect(planFiles).toHaveLength(1);
    expect(emailTaskFiles).toHaveLength(1);
    expect(planTaskFiles).toHaveLength(1);
    expect(myTaskFiles).toHaveLength(1);

    const draft = await readFile(join(draftFiles[0]), "utf8");
    expect(draft).toContain("schemaVersion: 1");
    expect(draft).toContain(`runId: ${runId}`);
    expect(draft).toContain("subject: Delivery timeline update");
    expect(draft).toContain("to:");
    expect(draft).toContain("supplier@example.com");
    expect(draft).toContain("labels:");
    expect(draft).toContain("Inbox");
    expect(draft).toContain("Our client launch depends on the timeline");

    const plan = await readFile(join(planFiles[0]), "utf8");
    expect(plan).toContain("# V1 AI-written draft: Subscription Tier Launch Plan");
    expect(plan).toContain("High Level Summary of plan:");
    expect(plan).toContain("Pricing, rollout phases, and success metrics for the new subscription tier.");
    expect(plan).toContain("V1 Draft:");
    expect(plan).toContain("# Pricing");

    const emailTask = JSON.parse(await readFile(join(emailTaskFiles[0]), "utf8"));
    expect(emailTask.title).toBe("[Draft Ready] Email supplier about delivery timeline");
    expect(emailTask.due).toBe("2026-08-15T15:00:00.000Z");
    expect(emailTask.notes).toContain("Check Inbox for v1 Email Draft: Delivery timeline update");
    expect(emailTask.notes).toContain("Link to Draft: local://gmail/drafts/");
    expect(emailTask.notes).toContain("Task from Transcript:");
    expect(emailTask.notes).toContain(`local://source/processing/${runId}/golden-meeting.txt`);

    const planTask = JSON.parse(await readFile(join(planTaskFiles[0]), "utf8"));
    expect(planTask.title).toBe("Iterate on plan - Subscription Tier Launch Plan");
    expect(planTask.notes).toContain("AI has written the first version of this plan");
    expect(planTask.notes).toContain("local://docs/strategy-and-planning/");

    const myTask = JSON.parse(await readFile(join(myTaskFiles[0]), "utf8"));
    expect(myTask.title).toBe("Review Q3 budget spreadsheet");
    expect(myTask.due).toBe("2026-08-22T17:00:00.000Z");
    expect(myTask.notes).toContain("Review the Q3 budget spreadsheet");
  });

  it("writes one tracking row per accepted task with the exact header and no duplicates", async () => {
    const run = await runGoldenTranscript();
    const csv = await readWorkspaceFile("tracking/actions.csv", run.workspace.root);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "row_id,run_id,task_index,task_name,task_type,assigned_to,deadline,source_step,target_uri,status,created_at,source_validation_error"
    );
    expect(lines).toHaveLength(4);
    const rows = lines.slice(1).map((line) => line.split(",")[0]);
    expect(new Set(rows).size).toBe(3);
    for (const line of lines.slice(1)) {
      expect(line).toContain(TRACKING_SCOPE_VALIDATION_ERROR);
    }
    expect(csv).toContain("source_step,7b5596".split(",")[1] !== undefined ? "7b5596" : "");
    expect(csv).toContain("1730yy");
    expect(csv).toContain("pthrsh");
  });

  it("writes the completion notification with the three tasks in extraction order", async () => {
    const run = await runGoldenTranscript();
    const notification = await readWorkspaceFile(
      `notifications/${run.runId}-summary.md`,
      run.workspace.root
    );
    expect(notification).toContain("# Transcription Processed - golden-meeting");
    expect(notification).toContain("Title: golden-meeting");
    expect(notification).toContain(`Link: local://source/processing/${run.runId}/golden-meeting.txt`);
    const emailIndex = notification.indexOf("(email)");
    const planIndex = notification.indexOf("(business plan)");
    const otherIndex = notification.indexOf("(other)");
    expect(emailIndex).toBeGreaterThan(-1);
    expect(emailIndex).toBeLessThan(planIndex);
    expect(planIndex).toBeLessThan(otherIndex);
    // The unassigned task never reaches the notification.
    expect(notification).not.toContain("server room");
  });

  it("records correct Draft URL and Document URL references in step artifacts", async () => {
    const run = await runGoldenTranscript();
    const draftStep = JSON.parse(
      await readWorkspaceFile(`runs/${run.runId}/steps/axgv0j/0000.json`, run.workspace.root)
    );
    expect(draftStep.output["Draft URL"]).toMatch(/^local:\/\/gmail\/drafts\/[0-9A-HJKMNP-TV-Z]{26}\.md$/);
    const docStep = JSON.parse(
      await readWorkspaceFile(`runs/${run.runId}/steps/kjlw70/0001.json`, run.workspace.root)
    );
    expect(docStep.output["Document URL"]).toMatch(
      /^local:\/\/docs\/strategy-and-planning\/[0-9A-HJKMNP-TV-Z]{26}\.md$/
    );
    const emailTaskStep = JSON.parse(
      await readWorkspaceFile(`runs/${run.runId}/steps/x1gstq/0000.json`, run.workspace.root)
    );
    expect(emailTaskStep.output["Task URL"]).toContain("local://tasks/email-drafts/");
  });

  it("isolates loop step artifacts by task index", async () => {
    const run = await runGoldenTranscript();
    const stepsDir = join(run.workspace.root, "runs", run.runId, "steps");
    const tableArtifacts = ["7b5596", "1730yy", "pthrsh"].map((stepId) => {
      return readWorkspaceFile(
        `runs/${run.runId}/steps/${stepId}/${stepId === "7b5596" ? "0000" : stepId === "1730yy" ? "0001" : "0002"}.json`,
        run.workspace.root
      );
    });
    const parsed = await Promise.all(tableArtifacts);
    expect(parsed.map((text) => JSON.parse(text).taskIndex)).toEqual([0, 1, 2]);
    void stepsDir;
  });

  it("keeps the iterator aggregate in extraction order", async () => {
    const run = await runGoldenTranscript();
    const iterator = JSON.parse(
      await readWorkspaceFile(`runs/${run.runId}/steps/yk5itn.json`, run.workspace.root)
    );
    expect(iterator.output.agg_ou028y).toHaveLength(3);
    const names = iterator.output.agg_ou028y.map((row: { task_name: string }) => row.task_name);
    expect(names).toEqual([
      "Email supplier about delivery timeline",
      "Draft subscription tier launch plan",
      "Review Q3 budget spreadsheet",
    ]);
  });

  it("produces byte-identical normalized outputs across two replay runs", async () => {
    const first = await runGoldenTranscript();
    const second = await runGoldenTranscript();
    expect(first.runId).toBe(second.runId);

    const relativeFiles = [
      "manifest.json",
      "events.jsonl",
      "steps/trigger.json",
      "steps/eitxht.json",
      "steps/yk5itn.json",
      "steps/aase0r.json",
      "steps/ou028y/0000.json",
      "steps/ou028y/0001.json",
      "steps/ou028y/0002.json",
      "steps/maoa1p/0000.json",
      "steps/axgv0j/0000.json",
      "steps/x1gstq/0000.json",
      "steps/7b5596/0000.json",
      "steps/ia2vvr/0001.json",
      "steps/kjlw70/0001.json",
      "steps/4a71s7/0001.json",
      "steps/1730yy/0001.json",
      "steps/8w9czb/0002.json",
      "steps/pthrsh/0002.json",
      "input/transcript.txt",
      "input/source-metadata.json",
    ];
    for (const relative of relativeFiles) {
      const a = await readWorkspaceFile(`runs/${first.runId}/${relative}`, first.workspace.root);
      const b = await readWorkspaceFile(`runs/${second.runId}/${relative}`, second.workspace.root);
      const normalizedA = relative.endsWith(".json")
        ? normalize(a)
        : relative.endsWith(".jsonl")
          ? normalizeJsonl(a)
          : a;
      const normalizedB = relative.endsWith(".json")
        ? normalize(b)
        : relative.endsWith(".jsonl")
          ? normalizeJsonl(b)
          : b;
      expect(normalizedA, `run output ${relative} must be identical`).toBe(normalizedB);
    }

    const pairs = [
      ["gmail/drafts", "gmail-draft"],
      ["docs/strategy-and-planning", "plan"],
      ["tasks/email-drafts", "task"],
      ["tasks/business-plans", "task"],
      ["tasks/my-tasks", "task"],
      ["notifications", "notification"],
      ["tracking/actions.csv", "csv"],
    ] as const;
    for (const [relative] of pairs) {
      const aFiles = await listFiles(join(first.workspace.root, relative)).catch(() =>
        join(first.workspace.root, relative).endsWith(".csv")
          ? [join(first.workspace.root, relative)]
          : []
      );
      const bFiles = await listFiles(join(second.workspace.root, relative)).catch(() =>
        join(second.workspace.root, relative).endsWith(".csv")
          ? [join(second.workspace.root, relative)]
          : []
      );
      expect(aFiles).toHaveLength(bFiles.length);
      for (let i = 0; i < aFiles.length; i++) {
        const a = await readFile(aFiles[i], "utf8");
        const b = await readFile(bFiles[i], "utf8");
        expect(a, `workspace file under ${relative} must be identical`).toBe(b);
      }
    }
  });

function normalizeJsonl(text: string): string {
  // Event order across parallel iterations can vary; compare the multiset.
  const lines = text.trim().split("\n").map((line) => {
    const parsed = JSON.parse(line) as { sequence?: number };
    const { sequence: _sequence, ...rest } = parsed;
    return JSON.stringify(rest);
  });
  return JSON.stringify(lines.sort());
}

async function listFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name))
    .sort();
}

});


