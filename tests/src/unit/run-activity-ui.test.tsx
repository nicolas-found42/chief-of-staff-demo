// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonResearchRunSummary, RunActivity } from "@chief-of-staff-demo/shared";
import { RunsList } from "../../../apps/web/src/components/RunsList";
import { runsApi } from "../../../apps/web/src/clients/workspace";
import { GoogleConnectionContext } from "../../../apps/web/src/useGoogleConnection";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const researching: PersonResearchRunSummary = {
  kind: "person-research",
  id: "research-current",
  profileId: "person/one",
  operationId: "operation-one",
  phase: "current",
  status: "researching",
  createdAt: "2026-09-16T10:00:00Z",
  summary: "Investigating public sources",
};
const previous: PersonResearchRunSummary = {
  ...researching,
  id: "research-previous",
  phase: "previous",
  status: "interrupted",
  summary: "Provider stopped before coverage finished",
};
const engine: Extract<RunActivity, { kind: "module-run" }> = {
  kind: "module-run",
  id: "engine-one",
  createdAt: "2026-09-15T10:00:00Z",
  module: "content-scout",
  intake: "manual",
  fileName: "Opportunities.md",
  sourceUrl: null,
  status: "done",
  skipReason: null,
  summary: "Found three opportunities",
};

describe("Unified Runs activity", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function renderList() {
    await act(async () => {
      root.render(
        createElement(
          GoogleConnectionContext.Provider,
          { value: { status: null, refresh: async () => {} } },
          createElement(
            MemoryRouter,
            { initialEntries: ["/runs"] },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: "/runs",
                element: createElement(RunsList, { empty: "No activity" }),
              }),
              createElement(Route, { path: "/people/:id", element: "Profile destination" }),
            ),
          ),
        ),
      );
    });
  }

  it("renders native state, detail and phase with profile links beside unchanged engine rows", async () => {
    vi.spyOn(runsApi, "listRuns").mockResolvedValue({
      runs: [researching, previous, engine],
      nextCursor: null,
    });
    await renderList();

    const rows = container.querySelectorAll("tbody tr");
    expect(rows[0]?.textContent).toContain("Person research");
    expect(rows[0]?.textContent).toContain("Person Profiles");
    expect(rows[0]?.textContent).toContain("Researching");
    expect(rows[0]?.textContent).toContain("Current research");
    expect(rows[0]?.textContent).toContain("Investigating public sources");
    expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe("/people/person%2Fone");
    expect(rows[1]?.textContent).toContain("Previous conclusion");
    expect(rows[1]?.textContent).toContain("Interrupted");
    expect(rows[1]?.textContent).toContain("Provider stopped before coverage finished");
    expect(rows[1]?.querySelector("a")?.getAttribute("href")).toBe("/people/person%2Fone");
    expect(rows[2]?.textContent).toContain("Content Scout");
    expect(rows[2]?.textContent).toContain("Completed");
    expect(rows[2]?.querySelector("a")?.getAttribute("href")).toBe("/runs/engine-one");
    expect(container.querySelector('a[href^="/runs/research-"]')).toBeNull();

    await act(async () => {
      rows[0]?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10 }),
      );
      rows[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect(container.textContent).toContain("Profile destination");
  });

  it("refreshes researching rows and stops once the operation settles", async () => {
    vi.useFakeTimers();
    vi.spyOn(runsApi, "listRuns")
      .mockResolvedValueOnce({ runs: [researching], nextCursor: null })
      .mockResolvedValue({
        runs: [{ ...researching, status: "completed", summary: "Coverage completed" }],
        nextCursor: null,
      });
    await renderList();
    expect(container.textContent).toContain("1 in progress");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(container.querySelector("tbody")?.textContent).toContain("Completed");
    expect(container.querySelector("tbody")?.textContent).toContain("Coverage completed");
    expect(container.textContent).toContain("0 in progress. Updates paused");
  });
});
