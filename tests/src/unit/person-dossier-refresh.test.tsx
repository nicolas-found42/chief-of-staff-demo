// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, expect, test, vi } from "vitest";
import type { PersonDossier } from "@chief-of-staff-demo/shared";
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

test("an action refresh cannot be overwritten by an older poll", async () => {
  vi.useFakeTimers();
  const api = client();
  const pending = Promise.withResolvers<ReturnType<typeof view>>();
  api.read = vi
    .fn<DossierClient["read"]>()
    .mockResolvedValueOnce(view())
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(view(3, "New evidence"));
  const container = await mount(api);
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  await click(container, "Prioritise research");
  expect(container.textContent).toContain("New evidence");
  await act(async () => pending.resolve(view(2, "Old poll evidence")));
  expect(container.textContent).toContain("New evidence");
  expect(container.textContent).not.toContain("Old poll evidence");
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
