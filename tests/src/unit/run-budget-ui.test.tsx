// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingDebriefDetail, RunDetail } from "@chief-of-staff-demo/shared";
import { RunDetailPage } from "../../../apps/web/src/pages/RunDetailPage";
import { MeetingDebriefDetailPage } from "../../../apps/web/src/pages/MeetingDebriefDetailPage";
import { runsApi } from "../../../apps/web/src/clients/workspace";
import { GoogleConnectionProvider } from "../../../apps/web/src/GoogleConnectionProvider";
import type { MeetingsClient } from "../../../apps/web/src/clients/meetings";
import { fromPartial } from "@total-typescript/shoehorn";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("UI display of honest queue delay, budget, and interruption states", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders budget and queue delay on RunDetailPage", async () => {
    const mockDetail: Partial<RunDetail> = {
      id: "run_test_budget",
      module: "meeting-debrief",
      intake: "manual",
      status: "running",
      attempts: 1,
      createdAt: "2026-09-10T12:00:00.000Z",
      failedStage: null,
      skipReason: null,
      failureHint: null,
      result: null,
      events: [],
      files: [],
      budget: {
        operationId: "run_test_budget",
        runId: "run_test_budget",
        version: 2,
        generation: 1,
        allowedDollars: 2.0,
        spentDollars: 0.125,
        reservedDollars: 0.05,
        remainingDollars: 1.825,
        allowedInputTokens: 4_000_000,
        spentInputTokens: 12000,
        reservedInputTokens: 5000,
        allowedOutputTokens: 500_000,
        spentOutputTokens: 2500,
        reservedOutputTokens: 1000,
        startedAt: "2026-09-10T12:00:00.000Z",
        elapsedProcessingMs: 1500,
        status: "active",
        extensions: [],
        dispatches: 3,
      },
      queueWaitMs: 450,
    };

    vi.spyOn(runsApi, "getRun").mockResolvedValue(fromPartial<RunDetail>(mockDetail));

    await act(async () => {
      root.render(
        createElement(
          GoogleConnectionProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: ["/runs/run_test_budget"] },
            createElement(
              Routes,
              null,
              createElement(Route, { path: "/runs/:id", element: createElement(RunDetailPage) }),
            ),
          ),
        ),
      );
    });

    const budgetEl = container.querySelector('[data-testid="run-budget"]');
    expect(budgetEl).not.toBeNull();
    expect(budgetEl?.textContent).toContain("Budget: $0.1250 of $2.00");

    const queueEl = container.querySelector('[data-testid="run-queue-wait"]');
    expect(queueEl).not.toBeNull();
    expect(queueEl?.textContent).toContain("Queue delay:");
  });

  it("renders budget exhausted banner on RunDetailPage", async () => {
    const mockDetail: Partial<RunDetail> = {
      id: "run_test_exhausted",
      module: "meeting-debrief",
      intake: "manual",
      status: "failed",
      attempts: 1,
      createdAt: "2026-09-10T12:00:00.000Z",
      failedStage: "extract",
      skipReason: null,
      failureHint: "Operation budget exhausted",
      result: null,
      events: [],
      files: [],
      budget: {
        operationId: "run_test_exhausted",
        runId: "run_test_exhausted",
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
        elapsedProcessingMs: 25000,
        status: "exhausted",
        extensions: [],
        dispatches: 5,
      },
    };

    vi.spyOn(runsApi, "getRun").mockResolvedValue(fromPartial<RunDetail>(mockDetail));

    await act(async () => {
      root.render(
        createElement(
          GoogleConnectionProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: ["/runs/run_test_exhausted"] },
            createElement(
              Routes,
              null,
              createElement(Route, { path: "/runs/:id", element: createElement(RunDetailPage) }),
            ),
          ),
        ),
      );
    });

    const banner = container.querySelector('[data-testid="budget-exhausted-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Operation budget exhausted.");
  });

  it("renders budget and interruption state on MeetingDebriefDetailPage", async () => {
    const mockDebrief: Partial<MeetingDebriefDetail> = {
      runId: "run_debrief_interrupted",
      transcriptId: "trans_1",
      meetingId: null,
      status: "failed",
      summary: null,
      skipReason: null,
      meetingDate: "2026-09-10",
      fileName: "Transcript.json",
      sourceUrl: null,
      linked: false,
      occurrence: null,
      roster: [],
      speakers: [],
      rosterStatus: "requires_confirmation",
      identity: { resolved: [], unresolved: [], organizations: [] },
      extraction: null,
      reviewReadiness: "no_extraction",
      review: null,
      interrupted: true,
      budget: {
        operationId: "run_debrief_interrupted",
        runId: "run_debrief_interrupted",
        version: 2,
        generation: 2,
        allowedDollars: 2.0,
        spentDollars: 0.35,
        reservedDollars: 0.0,
        remainingDollars: 1.65,
        allowedInputTokens: 4_000_000,
        spentInputTokens: 15000,
        reservedInputTokens: 0,
        allowedOutputTokens: 500_000,
        spentOutputTokens: 2000,
        reservedOutputTokens: 0,
        startedAt: "2026-09-10T12:00:00.000Z",
        elapsedProcessingMs: 12000,
        status: "cancelled",
        extensions: [],
        dispatches: 2,
      },
    };

    const mockClient = {
      meetingDebriefDetail: vi
        .fn()
        .mockResolvedValue(fromPartial<MeetingDebriefDetail>(mockDebrief)),
      meetingRead: vi.fn(),
      meetings: vi.fn().mockResolvedValue([]),
    } as unknown as MeetingsClient;
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/meeting-debrief/run_debrief_interrupted"] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/meeting-debrief/:runId",
              element: createElement(MeetingDebriefDetailPage, { client: mockClient }),
            }),
          ),
        ),
      );
    });

    const interruptedBanner = container.querySelector('[data-testid="debrief-interrupted"]');
    expect(interruptedBanner).not.toBeNull();
    expect(interruptedBanner?.textContent).toContain("Debrief preparation was interrupted.");

    expect(container.textContent).toContain("Budget: $0.3500 of $2.00");
  });
});
