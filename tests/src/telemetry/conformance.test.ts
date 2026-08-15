import { describe, expect, it } from "vitest";
import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import { JsonlTelemetryContext } from "@chief-of-staff/service";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "telemetry-jsonl-"));
  const context = new JsonlTelemetryContext(join(dir, "telemetry.jsonl"));
  return {
    context,
    getSpans: () => context.getSpans(),
    async [Symbol.asyncDispose]() {
      await context.dispose();
    },
  };
}

describe("JsonlTelemetryContext conformance", () => {
  const cases = createTelemetryAdapterConformance(createFixture);

  for (const testCase of cases) {
    it(`${testCase.group} - ${testCase.name}`, async () => {
      await testCase.run();
    });
  }

  it("records the required span hierarchy for a run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telemetry-jsonl-"));
    const context = new JsonlTelemetryContext(join(dir, "telemetry.jsonl"));
    await context.startSpan(
      { name: "chief_of_staff.run", attributes: { "chief_of_staff.run_id": "r" } },
      async (run) => {
        await run.startSpan(
          { name: "chief_of_staff.iteration", attributes: { "chief_of_staff.task_index": 0 } },
          async (iteration) => {
            await iteration.startSpan({ name: "chief_of_staff.step" }, async (step) => {
              step.addEvent("committed", { bytes: 12 });
              await step.startSpan(
                { name: "chief_of_staff.filesystem_commit" },
                async (commit) => {
                  commit.setAttributes({ "chief_of_staff.byte_count": 12 });
                }
              );
            });
          }
        );
        await run.startSpan(
          { name: "chief_of_staff.notification" },
          async (notification) => {
            notification.setStatus({ status: "ok" });
          }
        );
      }
    );
    const spans = await context.getSpans();
    const byName = new Map(spans.map((span) => [span.name, span]));
    const run = byName.get("chief_of_staff.run");
    const iteration = byName.get("chief_of_staff.iteration");
    const step = byName.get("chief_of_staff.step");
    const commit = byName.get("chief_of_staff.filesystem_commit");
    const notification = byName.get("chief_of_staff.notification");
    expect(run?.parentId).toBeNull();
    expect(iteration?.parentId).toBe(run?.id);
    expect(step?.parentId).toBe(iteration?.id);
    expect(commit?.parentId).toBe(step?.id);
    expect(notification?.parentId).toBe(run?.id);
    expect(commit?.attributes["chief_of_staff.byte_count"]).toBe(12);
  });

  it("never throws when the backing file cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telemetry-jsonl-"));
    const context = new JsonlTelemetryContext(join(dir, "missing-dir", "telemetry.jsonl"));
    const result = await context.startSpan({ name: "span" }, async (span) => {
      span.setAttributes({ key: "value" });
      return 42;
    });
    expect(result).toBe(42);
    expect(await context.getSpans()).toEqual([]);
  });
});
