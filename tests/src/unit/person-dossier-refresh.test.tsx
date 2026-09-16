// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, expect, test, vi } from "vitest";
import type { PersonDossier, PersonResearchProfileSummary } from "@chief-of-staff-demo/shared";
import {
  PersonDossierPanel,
  type DossierClient,
} from "../../../apps/web/src/pages/PersonDossierPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function view(revision = 2, statement = "Current evidence") {
  return {
    dossier: fromPartial<PersonDossier>({
      revision,
      claims: [{ id: "claim", statement, status: "supported", nature: "statement", citations: [] }],
      sections: [],
      sourceIds: [],
    }),
    research: null,
  };
}
function client(): DossierClient {
  return {
    read: vi.fn(async () => view()),
    source: vi.fn(),
    history: vi.fn(async () => []),
    analysis: vi.fn(async () => null),
    research: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    settings: vi.fn<DossierClient["settings"]>(async () => ({
      schemaVersion: 1,
      day: "2026-09-14",
      usedCalls: 0,
      totalJobs: 0,
      byState: {},
      running: 0,
      settings: {
        paused: false,
        concurrency: 1,
        profileCalls: 18,
        profileMilliseconds: 900000,
        readConcurrency: 4,
        requestTimeoutMilliseconds: 20000,
        quietRounds: 2,
        refreshHours: 168,
      },
    })),
    summary: vi.fn<DossierClient["summary"]>(async () => null),
    diagnostics: vi.fn<DossierClient["diagnostics"]>(async () => null),
  };
}
function research(
  overrides: Partial<PersonResearchProfileSummary> = {},
): PersonResearchProfileSummary {
  return {
    schemaVersion: 1,
    profileId: "maya",
    readiness: { state: "ready", reason: "ready" },
    state: "queued",
    queuedAt: "2026-09-14",
    updatedAt: "2026-09-14",
    nextAt: "2026-09-14",
    calls: 0,
    sources: 0,
    attempts: 0,
    detail: "Waiting for automatic research.",
    diagnostics: { totalAttempts: 0, byCode: {}, sample: [], truncated: false },
    ...overrides,
  };
}
let mounted: { root: Root; container: HTMLDivElement } | null = null;
async function mount(api: DossierClient) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () =>
    root.render(createElement(PersonDossierPanel, { profileId: "maya", client: api })),
  );
  return container;
}
async function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  if (!button) throw new Error(`Missing button ${text}`);
  await act(async () => button.click());
}
afterEach(async () => {
  await act(async () => mounted?.root.unmount());
  mounted?.container.remove();
  mounted = null;
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

test("slow dossier reads do not accumulate overlapping polls", async () => {
  vi.useFakeTimers();
  const api = client();
  const pending = Promise.withResolvers<ReturnType<typeof view>>();
  const read = vi.fn(() => pending.promise);
  api.read = read;
  await mount(api);
  await act(async () => vi.advanceTimersByTimeAsync(12_000));
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(view()));
});

test("a successful poll clears a recovered read error", async () => {
  vi.useFakeTimers();
  const api = client();
  api.read = vi
    .fn<DossierClient["read"]>()
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValue(view());
  const container = await mount(api);
  expect(container.textContent).toContain("Connection lost");
  expect(container.textContent).toContain("Research status unavailable");
  expect(container.textContent).not.toContain("Preparing automatic research");
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(container.textContent).toContain("Current evidence");
  expect(container.textContent).not.toContain("Connection lost");
});

test("research actions preserve the selected historical dossier", async () => {
  window.history.replaceState(null, "", "/?dossierRevision=1");
  const api = client();
  api.read = vi.fn(async (_id, revision) =>
    revision === 1 ? view(1, "Historical evidence") : view(),
  );
  const container = await mount(api);
  expect(container.textContent).toContain("Historical evidence");
  await click(container, "Prioritise research");
  expect(container.textContent).toContain("Historical evidence");
  expect(container.textContent).not.toContain("Current evidence");
});

test("successful action refresh cannot erase independent history failures", async () => {
  const api = client();
  api.history = vi.fn(async () => {
    throw new Error("History unavailable");
  });
  const container = await mount(api);
  expect(container.textContent).toContain("History unavailable");
  await click(container, "Prioritise research");
  expect(container.textContent).toContain("History unavailable");
});

test("normal polling requests only the summary and does not re-read the dossier", async () => {
  vi.useFakeTimers();
  const api = client();
  const read = vi.fn<DossierClient["read"]>(async () => ({
    ...view(),
    research: research({ attempts: 0 }),
  }));
  const summary = vi.fn<DossierClient["summary"]>(async () => research({ attempts: 0 }));
  api.read = read;
  api.summary = summary;
  const container = await mount(api);
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(summary).toHaveBeenCalledTimes(1);
  // Unchanged live counters: no reason to re-read the dossier, and the poll
  // itself is side-effect-free — it never calls the enqueuing dossier route.
  expect(read).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Queued for research");
});

test("a poll noticing forward progress triggers exactly one reactive dossier refresh", async () => {
  vi.useFakeTimers();
  const api = client();
  const researching = research({ state: "researching", attempts: 1, calls: 1, sources: 1 });
  const read = vi
    .fn<DossierClient["read"]>()
    .mockResolvedValueOnce({ ...view(), research: research({ attempts: 0 }) })
    .mockResolvedValue({ ...view(), research: researching });
  const summary = vi.fn<DossierClient["summary"]>(async () => researching);
  api.read = read;
  api.summary = summary;
  const container = await mount(api);
  expect(read).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Queued for research");
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(summary).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Researching");
});

test("a stale summary poll cannot overwrite a fresher action refresh", async () => {
  vi.useFakeTimers();
  const api = client();
  const pendingSummary = Promise.withResolvers<Awaited<ReturnType<DossierClient["summary"]>>>();
  api.read = vi
    .fn<DossierClient["read"]>()
    .mockResolvedValueOnce(view())
    .mockResolvedValue(view(3, "New evidence"));
  api.summary = vi.fn<DossierClient["summary"]>(() => pendingSummary.promise);
  const container = await mount(api);
  // Starts the poll tick's summary fetch, left pending.
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  await click(container, "Prioritise research");
  expect(container.textContent).toContain("New evidence");
  await act(async () =>
    pendingSummary.resolve(research({ state: "researching", attempts: 1, calls: 1, sources: 1 })),
  );
  expect(container.textContent).toContain("New evidence");
  expect(container.textContent).not.toContain("Researching");
});

test("changing revision hides old claims while historical evidence loads", async () => {
  const api = client();
  const pending = Promise.withResolvers<ReturnType<typeof view>>();
  api.read = vi.fn(async (_id, revision) => (revision === 1 ? pending.promise : view()));
  const container = await mount(api);
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Dossier revision"]')!;
  await act(async () => {
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("Reading historical dossier revision 1");
  expect(container.textContent).not.toContain("Current evidence");
  await act(async () => pending.resolve(view(1, "Historical evidence")));
  expect(container.textContent).toContain("Historical evidence");
});

test("a late historical read cannot replace the newly selected current revision", async () => {
  const api = client();
  const pending = Promise.withResolvers<ReturnType<typeof view>>();
  api.read = vi.fn(async (_id, revision) => (revision === 1 ? pending.promise : view()));
  const container = await mount(api);
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Dossier revision"]')!;
  await act(async () => {
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    select.value = "current";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => pending.resolve(view(1, "Historical evidence")));
  expect(container.textContent).toContain("Current evidence");
  expect(container.textContent).not.toContain("Historical evidence");
});

test("successful polling preserves a failed action until that action is retried", async () => {
  vi.useFakeTimers();
  const api = client();
  api.research = vi
    .fn<DossierClient["research"]>()
    .mockRejectedValueOnce(new Error("Research unavailable"))
    .mockResolvedValueOnce(undefined);
  const container = await mount(api);
  await click(container, "Prioritise research");
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(container.textContent).toContain("Research unavailable");
  await click(container, "Prioritise research");
  expect(container.textContent).not.toContain("Research unavailable");
});

async function editConcurrency(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (!descriptor?.set) throw new Error("Missing native value setter");
  await act(async () => {
    descriptor.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

test("research actions and polling preserve unsaved scheduling settings", async () => {
  vi.useFakeTimers();
  const api = client();
  const container = await mount(api);
  const input = await editConcurrency(container, "5");
  await click(container, "Prioritise research");
  expect(input.value).toBe("5");
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(input.value).toBe("5");
});

test("saving settings preserves edits entered while the save was pending", async () => {
  const api = client();
  const pending = Promise.withResolvers<void>();
  const configure = vi.fn(() => pending.promise);
  api.configure = configure;
  const container = await mount(api);
  const input = await editConcurrency(container, "5");
  await click(container, "Save research settings");
  await editConcurrency(container, "7");
  await act(async () => pending.resolve());
  expect(input.value).toBe("7");
  expect(configure).toHaveBeenCalledWith(expect.objectContaining({ concurrency: 5 }));
});

test("an initial pending read reports loading without inventing research progress", async () => {
  const api = client();
  const pending = Promise.withResolvers<ReturnType<typeof view>>();
  api.read = vi.fn(() => pending.promise);
  const container = await mount(api);
  expect(container.textContent).toContain("Loading dossier");
  expect(container.textContent).not.toContain("0 sources processed");
  expect(container.textContent).not.toContain("Preparing automatic research");
  await act(async () => pending.resolve(view()));
});

test("pause and resume refresh server state while preserving all unsaved scheduling fields", async () => {
  const api = client();
  const progress = await api.settings();
  const configure = vi.fn<DossierClient["configure"]>(async (settings) => {
    if (settings.paused !== undefined) progress.settings.paused = settings.paused;
  });
  api.configure = configure;
  api.settings = vi.fn(async () => structuredClone(progress));
  const container = await mount(api);
  const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
  const values = ["5", "48", "360"];
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (!descriptor?.set) throw new Error("Missing native value setter");
  for (const [index, input] of inputs.entries()) {
    await act(async () => {
      descriptor.set?.call(input, values[index]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await click(container, "Pause research");
  expect(container.textContent).toContain("Workspace research paused");
  expect(inputs.map((input) => input.value)).toEqual(values);
  await click(container, "Resume research");
  expect(configure).toHaveBeenLastCalledWith({ paused: false });
  expect(container.textContent).not.toContain("Workspace research paused");
  expect(inputs.map((input) => input.value)).toEqual(values);
});

test("history reports loading and failed reads honestly, then retries independently", async () => {
  const api = client();
  const pending = Promise.withResolvers<Awaited<ReturnType<DossierClient["history"]>>>();
  api.history = vi
    .fn<DossierClient["history"]>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce([]);
  const container = await mount(api);
  await click(container, "Relationship history");
  expect(container.textContent).toContain("Loading Relationship history");
  expect(container.textContent).not.toContain("No confirmed Workspace history yet");
  await act(async () => pending.reject(new Error("History unavailable")));
  expect(container.textContent).toContain("History unavailable");
  expect(container.textContent).not.toContain("No confirmed Workspace history yet");
  await click(container, "Retry Relationship history");
  expect(container.textContent).toContain("No confirmed Workspace history yet");
  expect(container.textContent).not.toContain("History unavailable");
  expect(container.textContent).toContain("1 retained claims");
});

test("readiness is actionable before any research job exists", async () => {
  const api = client();
  api.read = vi.fn(async () => ({
    ...view(),
    researchDecision: {
      kind: "rejected-readiness" as const,
      profileId: "maya",
      readiness: {
        state: "setup-required" as const,
        reason: "owner-not-confirmed" as const,
        nextAction: { label: "Open Settings", href: "/settings" },
      },
    },
  }));
  const container = await mount(api);
  expect(container.textContent).toContain("An owner has not yet confirmed");
  expect(container.querySelector('a[href="/settings"]')?.textContent).toBe("Open Settings");
});

test("partial dossier counts describe retained evidence rather than completed operations", async () => {
  const api = client();
  api.read = vi.fn(async () => ({
    ...view(),
    dossier: { ...view().dossier, sourceIds: ["one", "two"] },
    research: research({ state: "researching", sources: 0, calls: 2 }),
  }));
  const container = await mount(api);
  expect(container.textContent).toContain("2 retained sources");
  expect(container.textContent).not.toContain("0 sources processed");
});

test("retry preserves the server's actionable readiness refusal", async () => {
  const { ApiError } = await import("../../../apps/web/src/client");
  const api = client();
  api.research = vi.fn(async () => {
    throw new ApiError(409, "research-disabled", {
      readiness: {
        state: "setup-required",
        reason: "provider-not-configured",
        nextAction: { label: "Configure provider", href: "/settings" },
      },
    });
  });
  const container = await mount(api);
  await click(container, "Prioritise research");
  expect(container.textContent).toContain("No model provider is configured");
  expect(container.textContent).not.toContain("research-disabled");
  expect(container.querySelector('a[href="/settings"]')?.textContent).toBe("Configure provider");
});

test("jobless polling updates readiness without enqueueing a read", async () => {
  vi.useFakeTimers();
  const api = client();
  const settings = await api.settings();
  api.settings = vi.fn(async () => ({
    ...settings,
    readiness: { state: "ready" as const, reason: "ready" as const },
  }));
  const read = vi.fn(async () => ({
    ...view(),
    readiness: { state: "setup-required" as const, reason: "owner-not-confirmed" as const },
  }));
  api.read = read;
  const container = await mount(api);
  expect(container.textContent).toContain("An owner has not yet confirmed");
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(container.textContent).not.toContain("An owner has not yet confirmed");
  expect(container.textContent).toContain("Research ready");
  expect(read).toHaveBeenCalledTimes(1);
});
