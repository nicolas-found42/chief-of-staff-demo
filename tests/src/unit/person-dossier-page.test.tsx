// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import {
  PersonDossierPanel,
  type DossierClient,
} from "../../../apps/web/src/pages/PersonDossierPanel";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
test("a public-only person has a separate empty Relationship history tab while research is queued", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client: DossierClient = {
    read: async () => ({
      dossier: null,
      research: {
        profileId: "maya",
        state: "queued",
        reasons: ["created"],
        queuedAt: "2026-09-05",
        updatedAt: "2026-09-05",
        nextAt: "2026-09-05",
        calls: 0,
        sources: 0,
        attempts: 0,
        detail: "Waiting for automatic research.",
      },
    }),
    source: async () => {
      throw new Error("No source requested");
    },
    history: async () => [],
    analysis: async () => null,
    research: async () => {},
    detach: async () => {},
    settings: async () => ({
      schemaVersion: 1,
      day: "2026-09-05",
      usedCalls: 0,
      jobs: [],
      settings: {
        paused: false,
        concurrency: 1,
        profileCalls: 18,
        profileMilliseconds: 120000,
        dailyCalls: 100,
        refreshHours: 168,
      },
    }),
    configure: async () => {},
  };
  try {
    await act(async () => {
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client }));
    });
    expect(container.textContent).toContain("Queued");
    const history = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Relationship history",
    )!;
    await act(async () => {
      history.click();
    });
    expect(container.textContent).toContain("No confirmed Workspace history yet");
    expect(container.textContent).not.toContain("What has this person actually built");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
