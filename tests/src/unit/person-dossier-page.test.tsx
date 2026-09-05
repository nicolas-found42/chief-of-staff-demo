import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store";
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
  const client = makeClient();

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

function makeClient(): DossierClient {
  return {
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
}

test.each(["supported", "contested"] as const)(
  "private-only %s evidence stays inspectable without inventing public history",
  async (status) => {
    const directory = mkdtempSync(join(tmpdir(), "dossier-ui-"));
    const store = new PersonDossierStore(directory);
    const document = store.retainSource({
      url: "transcript:private",
      title: "Private conversation",
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-05",
      text: "Maya built the scheduler.",
      family: "workspace",
      sourceClass: "workspace",
      visibility: "private",
      completeness: "full",
      extractionCoverage: "full",
      access: "retrieved",
      acquisition: "workspace",
    });
    const dossier = store.publish("maya", 0, {
      sourceIds: [document.id],
      claims: [
        {
          id: "claim",
          section: "work",
          statement: document.text,
          status,
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: document.id, quote: document.text }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    });
    const client = makeClient();
    client.read = async () => ({ dossier, research: null });
    client.source = async () => document;
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(createElement(PersonDossierPanel, { profileId: "maya", client })),
      );
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Sources")!
          .click(),
      );
      expect(container.textContent).toContain(document.text);
      if (status === "contested")
        expect(container.textContent.toLowerCase()).toContain("contested");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Inspect retained source 1")!
          .click(),
      );
      expect(container.querySelector('[aria-label="Retained source"]')?.textContent).toContain(
        "private",
      );
      expect(container.querySelector('[aria-label="Retained source"]')?.textContent).toContain(
        document.text,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
