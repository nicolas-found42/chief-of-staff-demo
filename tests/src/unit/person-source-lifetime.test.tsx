// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  PersonDossier,
  PersonSourceDocument,
  PersonResearchAggregateStatus,
} from "@chief-of-staff-demo/shared";
import {
  PersonDossierPanel,
  type DossierClient,
} from "../../../apps/web/src/pages/PersonDossierPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
function client(): DossierClient {
  return {
    read: vi.fn<DossierClient["read"]>(async (_id, revision) => ({
      dossier: fromPartial<PersonDossier>({
        revision: revision ?? 2,
        claims: [],
        sections: [],
        sourceIds: ["source"],
        works: [],
      }),
      research: null,
    })),
    settings: vi.fn(async () =>
      fromPartial<PersonResearchAggregateStatus>({
        settings: { paused: false },
        totalJobs: 0,
        byState: {},
        running: 0,
      }),
    ),
    history: vi.fn(async () => []),
    analysis: vi.fn(async () => null),
    source: vi.fn(),
    research: vi.fn(),
    detach: vi.fn(),
    configure: vi.fn(),
  };
}
async function click(text: string) {
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent.startsWith(text))!.click(),
  );
}
test.each(["success", "failure"])(
  "changing revision invalidates a reader's pending %s",
  async (outcome) => {
    const api = client();
    const pending = Promise.withResolvers<PersonSourceDocument>();
    const readSource = vi.fn(() => pending.promise);
    api.source = readSource;
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client: api })),
    );
    await click("Sources");
    await click("Inspect retained source");
    expect(container.querySelector("dialog")).not.toBeNull();
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("dialog")).toBeNull();
    await act(async () => {
      if (outcome === "failure") pending.reject(new Error("Obsolete source failure"));
      else pending.resolve(fromPartial({ title: "Obsolete source", text: "Obsolete text" }));
    });
    expect(container.textContent).not.toContain("Obsolete");
  },
);
test.each(["success", "failure"])(
  "switching Profile invalidates a reader's pending %s",
  async (outcome) => {
    const api = client();
    const pending = Promise.withResolvers<PersonSourceDocument>();
    const readSource = vi.fn(() => pending.promise);
    api.source = readSource;
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client: api })),
    );
    await click("Sources");
    await click("Inspect retained source");
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "ada", client: api })),
    );
    await act(async () => {
      if (outcome === "failure") pending.reject(new Error("Obsolete source failure"));
      else pending.resolve(fromPartial({ title: "Obsolete source", text: "Obsolete text" }));
    });
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.textContent).not.toContain("Obsolete");
    expect(readSource).toHaveBeenCalledTimes(1);
  },
);

test("a poll notices external detachment while the reader is pending", async () => {
  vi.useFakeTimers();
  try {
    const api = client();
    const pending = Promise.withResolvers<PersonSourceDocument>();
    const readSource = vi.fn(() => pending.promise);
    api.source = readSource;
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client: api })),
    );
    await click("Sources");
    await click("Inspect retained source");
    api.read = vi.fn(async () => ({
      dossier: fromPartial<PersonDossier>({
        revision: 3,
        claims: [],
        sections: [],
        sourceIds: [],
        works: [],
      }),
      research: null,
    }));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(container.querySelector("dialog")).toBeNull();
    await act(async () =>
      pending.resolve(fromPartial({ title: "Detached", text: "Old retained evidence" })),
    );
    expect(container.textContent).not.toContain("Old retained evidence");
  } finally {
    vi.useRealTimers();
  }
});

test.each(["success", "failure"])(
  "new source selection owns a preceding read's late %s",
  async (outcome) => {
    const api = client();
    const pending = Promise.withResolvers<PersonSourceDocument>();
    const view = await api.read("maya");
    view.dossier!.sourceIds.push("second");
    api.read = vi.fn(async () => view);
    api.source = vi.fn(async (_id, sourceId) =>
      sourceId === "source"
        ? pending.promise
        : fromPartial<PersonSourceDocument>({
            title: "Second source",
            text: "Current selection <script>alert(1)</script>",
            url: "javascript:alert(1)",
            publishedAt: null,
          }),
    );
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client: api })),
    );
    await click("Sources");
    await click("Inspect retained source 1");
    await click("Close source");
    await click("Inspect retained source 2");
    await act(async () => {
      if (outcome === "failure") pending.reject(new Error("Obsolete source failure"));
      else pending.resolve(fromPartial({ title: "Obsolete source", text: "Obsolete text" }));
    });
    expect(container.querySelector("dialog")?.textContent).toContain("Current selection");
    expect(container.querySelector("dialog")?.textContent).not.toContain("Obsolete");
    expect(container.querySelector('dialog a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector("dialog script")).toBeNull();
  },
);

test.each(["profile", "revision"])(
  "correction notice is cleared when changing %s",
  async (context) => {
    const api = client();
    api.source = vi.fn(async () =>
      fromPartial<PersonSourceDocument>({ title: "Evidence", text: "Evidence" }),
    );
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client: api })),
    );
    await click("Sources");
    await click("Inspect retained source");
    await click("Remove wrong-person attribution");
    expect(container.textContent).toContain("Attribution removed from this Profile");
    if (context === "profile") {
      await act(async () =>
        root.render(createElement(PersonDossierPanel, { profileId: "ada", client: api })),
      );
    } else {
      await act(async () => {
        const select = container.querySelector("select")!;
        select.value = "1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    expect(container.textContent).not.toContain("Attribution removed from this Profile");
  },
);

test("a late correction refresh cannot announce success on another Profile", async () => {
  const api = client();
  api.source = vi.fn(async () =>
    fromPartial<PersonSourceDocument>({ title: "Evidence", text: "Evidence" }),
  );
  await act(async () =>
    root.render(createElement(PersonDossierPanel, { profileId: "maya", client: api })),
  );
  await click("Sources");
  await click("Inspect retained source");
  const originalRead = api.read.bind(api);
  const pending = Promise.withResolvers<Awaited<ReturnType<DossierClient["read"]>>>();
  api.read = vi.fn<DossierClient["read"]>(async (id, revision) =>
    id === "maya" ? pending.promise : originalRead(id, revision),
  );
  await click("Remove wrong-person attribution");
  await act(async () =>
    root.render(createElement(PersonDossierPanel, { profileId: "ada", client: api })),
  );
  await act(async () => pending.resolve(await originalRead("maya")));
  expect(container.textContent).not.toContain("Attribution removed from this Profile");
});
