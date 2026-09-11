import { expect, test } from "./fixture";

test.use({ freshWorkspace: true });

test.describe("model admission, budget, and interruption browser journeys", () => {
  test("displays honest budget, queue delay, and exhaustion state on run detail page", async ({
    page,
  }) => {
    await page.route("**/api/runs/run_journey_budget", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "run_journey_budget",
          module: "meeting-debrief",
          intake: "manual",
          status: "failed",
          attempts: 2,
          createdAt: "2026-09-10T12:00:00.000Z",
          failedStage: "extract",
          skipReason: null,
          failureHint: "Operation budget exhausted.",
          result: null,
          events: [],
          files: [],
          budget: {
            operationId: "run_journey_budget",
            runId: "run_journey_budget",
            version: 3,
            generation: 1,
            allowedDollars: 2.0,
            spentDollars: 2.0,
            reservedDollars: 0.0,
            remainingDollars: 0.0,
            allowedInputTokens: 4_000_000,
            spentInputTokens: 50000,
            reservedInputTokens: 0,
            allowedOutputTokens: 500_000,
            spentOutputTokens: 15000,
            reservedOutputTokens: 0,
            startedAt: "2026-09-10T12:00:00.000Z",
            elapsedProcessingMs: 15000,
            status: "exhausted",
            extensions: [],
            dispatches: 4,
          },
          queueWaitMs: 1250,
        }),
      });
    });

    await page.goto("/runs/run_journey_budget");

    await expect(page.getByTestId("run-budget")).toBeVisible();
    await expect(page.getByTestId("run-budget")).toContainText("Budget: $2.0000 of $2.00");
    await expect(page.getByTestId("run-budget")).toContainText("(budget exhausted)");

    await expect(page.getByTestId("run-queue-wait")).toBeVisible();
    await expect(page.getByTestId("run-queue-wait")).toContainText("Queue delay:");

    await expect(page.getByTestId("budget-exhausted-banner")).toBeVisible();
    await expect(page.getByTestId("budget-exhausted-banner")).toContainText(
      "Operation budget exhausted.",
    );
  });

  test("displays honest budget and interruption banner on debrief detail page", async ({
    page,
  }) => {
    await page.route("**/api/meeting-debrief/run_journey_debrief_interrupted", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runId: "run_journey_debrief_interrupted",
          transcriptId: "transcript_journey_1",
          meetingId: null,
          status: "failed",
          summary: null,
          skipReason: null,
          meetingDate: "2026-09-10",
          fileName: "Product Sync Transcript.json",
          sourceUrl: null,
          linked: false,
          occurrence: null,
          roster: [],
          speakers: ["Alice", "Bob"],
          rosterStatus: "requires_confirmation",
          identity: { resolved: [], unresolved: [], organizations: [] },
          extraction: null,
          reviewReadiness: "no_extraction",
          review: null,
          interrupted: true,
          budget: {
            operationId: "run_journey_debrief_interrupted",
            runId: "run_journey_debrief_interrupted",
            version: 2,
            generation: 2,
            allowedDollars: 2.0,
            spentDollars: 0.45,
            reservedDollars: 0.0,
            remainingDollars: 1.55,
            allowedInputTokens: 4_000_000,
            spentInputTokens: 20000,
            reservedInputTokens: 0,
            allowedOutputTokens: 500_000,
            spentOutputTokens: 2500,
            reservedOutputTokens: 0,
            startedAt: "2026-09-10T12:00:00.000Z",
            elapsedProcessingMs: 14000,
            status: "cancelled",
            extensions: [],
            dispatches: 2,
          },
        }),
      });
    });

    await page.goto("/meeting-debrief/run_journey_debrief_interrupted");

    await expect(page.getByTestId("debrief-interrupted")).toBeVisible();
    await expect(page.getByTestId("debrief-interrupted")).toContainText(
      "Debrief preparation was interrupted.",
    );

    await expect(page.getByText("Budget: $0.4500 of $2.00 (cancelled)")).toBeVisible();
  });
});
