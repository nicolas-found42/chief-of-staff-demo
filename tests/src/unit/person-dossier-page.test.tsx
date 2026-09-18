import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PersonDossierStore,
  synthesizeSections,
} from "../../../apps/server/src/person-profile/dossier-store";
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { fromPartial } from "@total-typescript/shoehorn";
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import type {
  PersonDossier,
  PersonProfile,
  PersonResearchProfileSummary,
} from "@chief-of-staff-demo/shared";
import {
  PersonDossierPanel,
  type DossierClient,
} from "../../../apps/web/src/pages/PersonDossierPanel";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no top layer; browser journeys verify focus, Escape and inertness.
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
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
  const research: PersonResearchProfileSummary = {
    schemaVersion: 1,
    profileId: "maya",
    readiness: { state: "ready", reason: "ready" },
    state: "queued",
    queuedAt: "2026-09-05",
    updatedAt: "2026-09-05",
    nextAt: "2026-09-05",
    calls: 0,
    sources: 0,
    attempts: 0,
    detail: "Waiting for automatic research.",
    diagnostics: { totalAttempts: 0, byCode: {}, sample: [], truncated: false },
  };
  return {
    read: async () => ({ dossier: null, research }),
    sources: async () => ({ sources: [] }),
    source: async () => {
      throw new Error("No source requested");
    },
    history: async () => [],
    analysis: async () => null,
    research: async () => {},
    cancel: async () => ({ cancelled: true }),
    detach: async () => {},
    settings: async () => ({
      schemaVersion: 1,
      day: "2026-09-05",
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
    }),
    configure: async () => {},
    summary: async () => ({
      summary: research,
      readiness: { state: "ready", reason: "ready" },
    }),
    diagnostics: async () => null,
  };
}

/** A minimal, schema-valid summary for one T9 rendering scenario. */
function researchFixture(
  overrides: Partial<PersonResearchProfileSummary> = {},
): PersonResearchProfileSummary {
  return {
    schemaVersion: 1,
    profileId: "maya",
    readiness: { state: "ready", reason: "ready" },
    state: "queued",
    queuedAt: "2026-09-05",
    updatedAt: "2026-09-05",
    nextAt: "2026-09-05",
    calls: 0,
    sources: 0,
    attempts: 0,
    detail: "Waiting for automatic research.",
    diagnostics: { totalAttempts: 0, byCode: {}, sample: [], truncated: false },
    ...overrides,
  };
}

async function mountWithResearch(research: PersonResearchProfileSummary) {
  const client = makeClient();
  client.read = async () => ({ dossier: null, research });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PersonDossierPanel, { profileId: "maya", client }));
  });
  return { container, root };
}

test("a setup-required blocker names the missing owner confirmation and links to Settings", async () => {
  const { container, root } = await mountWithResearch(
    researchFixture({
      readiness: {
        state: "setup-required",
        reason: "owner-not-confirmed",
        ownerEmail: "nicolas@found42.com",
        nextAction: { label: "Open Settings", href: "/settings" },
      },
    }),
  );
  try {
    expect(container.textContent).toContain("Research setup required");
    expect(container.textContent).toContain("owner has not yet confirmed");
    /* The waiting email and the card that resolves it are the cure (UX audit
       F2): a beginner otherwise never learns the gate needs their own Profile. */
    expect(container.textContent).toContain("No Person Profile carries nicolas@found42.com yet");
    expect(container.textContent).toContain("Settings → Owner Profile");
    const link = container.querySelector<HTMLAnchorElement>("a[href='/settings']");
    expect(link?.textContent).toBe("Open Settings");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("without a connected email the setup-required copy stays generic", async () => {
  const { container, root } = await mountWithResearch(
    researchFixture({
      readiness: { state: "setup-required", reason: "owner-not-confirmed" },
    }),
  );
  try {
    expect(container.textContent).toContain("owner has not yet confirmed");
    expect(container.textContent).not.toContain("No Person Profile carries");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("initializing renders distinctly from setup-required and never asks to repeat onboarding", async () => {
  const { container, root } = await mountWithResearch(
    researchFixture({
      readiness: { state: "initializing", reason: "owner-identity-unresolved" },
    }),
  );
  try {
    expect(container.textContent).toContain("Confirming workspace setup");
    expect(container.textContent).not.toContain("Research setup required");
    // Temporary and retryable: no Settings action is offered for a state
    // that resolves on its own (#417 F7).
    expect(container.querySelector("a[href='/settings']")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a previous conclusion stays visible as labeled history and is never shown as the current operation's failure", async () => {
  const { container, root } = await mountWithResearch(
    researchFixture({
      state: "researching",
      calls: 3,
      sources: 2,
      attempts: 2,
      currentOperationId: "op-b",
      currentOperationRevision: 2,
      detail: "Research is in progress.",
      // T5 leaves `decisive`/`operationRevision` carrying operation A's data
      // while B runs; the panel must not read them as B's outcome.
      operationRevision: 1,
      decisive: {
        operationId: "op-a",
        profileId: "maya",
        stage: "extraction",
        disposition: "interrupted",
        classification: "transport-failure",
        cause: "observed",
        reason: "A transport or provider-side failure interrupted extraction.",
        recoveryAttempts: 0,
        completedUnits: 0,
        incompleteUnits: 1,
        recordedAt: "2026-09-04T00:00:00Z",
      },
      previousConclusion: {
        operationId: "op-a",
        revision: 1,
        conclusion: "interrupted",
        finishedAt: "2026-09-04T00:00:00Z",
        detail: "A transport or provider-side failure interrupted extraction.",
      },
    }),
  );
  try {
    expect(container.textContent).toContain("Researching");
    expect(container.textContent).not.toContain("Research interrupted");
    expect(container.textContent).toContain("Previous research attempt");
    expect(container.textContent).toContain("transport or provider-side failure");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a real unusable-shape interruption names the extraction boundary, not a generic interruption", async () => {
  /* Production path (#417 F2, ReadinessAudit): an unusable shape latches the
     operation into `interrupted` with pending work retained — not an `empty`
     settled state. The title must come from the decisive classification. */
  const { container, root } = await mountWithResearch(
    researchFixture({
      state: "interrupted",
      detail: "Extraction responses did not match the dossier extraction schema.",
      decisive: {
        operationId: "op-1",
        profileId: "maya",
        stage: "extraction",
        disposition: "interrupted",
        classification: "no-usable-model-answer",
        cause: "observed",
        reason: "The model returned no usable extraction answer; retained evidence is preserved.",
        recoveryAttempts: 0,
        completedUnits: 0,
        incompleteUnits: 1,
        recordedAt: "2026-09-05T00:00:00Z",
      },
    }),
  );
  try {
    expect(container.textContent).toContain("No usable extraction answer");
    expect(container.textContent).toContain("retained evidence is preserved");
    expect(container.textContent).not.toContain("Research interrupted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("empty-answer copy explains the model returned no usable answer and that evidence is retained", async () => {
  const { container, root } = await mountWithResearch(
    researchFixture({
      state: "empty",
      decisive: {
        operationId: "op-1",
        profileId: "maya",
        stage: "extraction",
        disposition: "completed",
        classification: "no-usable-model-answer",
        cause: "observed",
        reason:
          "The model returned no usable extraction answer; retained evidence is preserved and pending work continues.",
        recoveryAttempts: 0,
        completedUnits: 0,
        incompleteUnits: 1,
        recordedAt: "2026-09-05T00:00:00Z",
      },
    }),
  );
  try {
    expect(container.textContent).toContain("No usable extraction answer");
    expect(container.textContent).toContain("retained evidence is preserved");
    expect(container.textContent).not.toContain("No matched evidence found");
    expect(container.textContent.toLowerCase()).not.toContain("provider");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a legitimate no-supported-facts result reads differently from a no-usable-model-answer result", async () => {
  const { container, root } = await mountWithResearch(
    researchFixture({
      state: "empty",
      decisive: {
        operationId: "op-1",
        profileId: "maya",
        stage: "extraction",
        disposition: "completed",
        classification: "no-supported-facts",
        cause: "observed",
        reason:
          "Extraction validated successfully and found no facts it could support about this person.",
        recoveryAttempts: 0,
        completedUnits: 1,
        incompleteUnits: 0,
        recordedAt: "2026-09-05T00:00:00Z",
      },
    }),
  );
  try {
    expect(container.textContent).toContain("No supported facts found");
    expect(container.textContent).toContain("validated successfully");
    expect(container.textContent).not.toContain("No usable extraction answer");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

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

test("a claim grounded in an archived capture shows the capture date and its bounded period", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dossier-capture-ui-"));
  const store = new PersonDossierStore(directory);
  const source = store.retainSource({
    url: "https://web.archive.org/web/20240523200341/https://bank.example/past/shafik",
    title: "Past people biography",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-07",
    capturedAt: "2024-05-23T20:03:41.000Z",
    text: "Deputy Governor, Markets and Banking between 2014 and 2017.",
    family: "bank.example",
    sourceClass: "self-report",
    visibility: "public",
    completeness: "full",
    extractionCoverage: "full",
    access: "retrieved",
    acquisition: "wayback-capture",
  });
  const dossier = store.publish("shafik", 0, {
    sourceIds: [source.id],
    claims: [
      {
        id: "tenure",
        section: "career",
        statement: source.text,
        fact: { field: "role", value: "Deputy Governor, Markets and Banking" },
        status: "stale",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: "2014-08-01",
        effectiveTo: "2024-05-23",
        citations: [{ sourceId: source.id, quote: source.text, capturedAt: source.capturedAt }],
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
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "shafik", client })),
    );
    /* The reader sees a former role as former, dated by the capture, without
       having to open the retained source behind it. */
    expect(container.textContent).toContain("archived capture 2024-05-23");
    expect(container.textContent).toContain("2014-08-01 to 2024-05-23");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dossier tabs use a single tab stop and arrow keys move selection", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client: makeClient() })),
    );
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    await act(async () => {
      tabs[0].focus();
      tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(tabs.at(-1)?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs.at(-1));
    for (const [key, index] of [
      ["ArrowRight", 0],
      ["End", tabs.length - 1],
      ["Home", 0],
    ] as const) {
      await act(async () =>
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
      );
      expect(document.activeElement).toBe(tabs[index]);
      expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([tabs[index]]);
      expect(tabs[index].getAttribute("aria-selected")).toBe("true");
      const panel = container.querySelector<HTMLElement>('[role="tabpanel"]')!;
      expect(tabs[index].getAttribute("aria-controls")).toBe(panel.id);
      expect(panel.getAttribute("aria-labelledby")).toBe(tabs[index].id);
      expect(panel.tabIndex).toBe(0);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a source opens immediately and closing it prevents a late response reopening it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dossier-source-ui-"));
  const store = new PersonDossierStore(directory);
  const source = store.retainSource({
    url: "https://example.com/source",
    title: "Delayed source",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-14",
    text: "Synthetic retained text",
    family: "example.com",
    sourceClass: "primary-artifact",
    visibility: "public",
    completeness: "full",
    access: "retrieved",
    acquisition: "public-web",
  });
  const dossier = store.publish("maya", 0, {
    sourceIds: [source.id],
    claims: [],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  });
  const pending = Promise.withResolvers<typeof source>();
  const client = makeClient();
  client.read = async () => ({ dossier, research: null });
  client.source = () => pending.promise;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client })),
    );
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Sources")!.click(),
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Inspect retained source 1")!
        .click(),
    );
    const close = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Close source",
    );
    expect(close).toBeDefined();
    await act(async () => close!.click());
    await act(async () => pending.resolve(source));
    expect(container.querySelector('[aria-label="Retained source"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a source page with more outbound URLs than the stored cap retains a bounded record", () => {
  const directory = mkdtempSync(join(tmpdir(), "dossier-source-ui-"));
  const store = new PersonDossierStore(directory);
  const outboundUrls = [
    ...Array.from({ length: 250 }, (_, i) => `https://example.com/link/${i}`),
    "https://example.com/link/0",
  ];
  const input = {
    url: "https://www.linkedin.com/in/joseceresc/",
    title: "Profile page",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-18",
    text: "Readable profile text.",
    family: "professional-network",
    sourceClass: "primary-artifact" as const,
    visibility: "public" as const,
    completeness: "full" as const,
    extractionCoverage: "full" as const,
    access: "retrieved" as const,
    acquisition: "browser-render",
    outboundUrls,
    provenanceNote: "Rendered from the live page.",
  };
  try {
    const document = store.retainSource(input);
    expect(document.outboundUrls).toHaveLength(200);
    expect(document.outboundUrls?.[0]).toBe("https://example.com/link/0");
    expect(document.provenanceNote).toContain("Rendered from the live page.");
    expect(document.provenanceNote).toContain("251");
    // Identical input normalizes identically, so re-retaining stays one record.
    const again = store.retainSource(input);
    expect(again.id).toBe(document.id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit F13: an old stored summary gains punctuation on read without changing the dossier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dossier-old-prose-"));
  const store = new PersonDossierStore(directory);
  const claims = ["Maya built Atlas", "Maya deployed Nova"].map((statement, index) => ({
    id: `old-${index}`,
    section: "work" as const,
    statement,
    status: "unknown" as const,
    nature: "statement" as const,
    matchConfidence: "high" as const,
    effectiveFrom: null,
    effectiveTo: null,
    citations: [],
    supports: [],
    supersedes: [],
    changeReason: null,
  }));
  const dossier = store.publish("maya", 0, {
    claims,
    works: [],
    expertise: [],
    connections: [],
    sections: synthesizeSections(claims),
  });
  dossier.sections[0].summary = "Maya built Atlas Maya deployed Nova";
  const api = makeClient();
  api.read = async () => ({ dossier, research: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client: api })),
    );
    expect(container.querySelector("#dossier-panel > p")?.textContent).toBe(
      "Maya built Atlas. Maya deployed Nova.",
    );
    expect(dossier.sections[0].summary).toBe("Maya built Atlas Maya deployed Nova");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unnamed Profile explains how to name it before research can attribute evidence", async () => {
  const unnamed = makeClient();
  unnamed.read = async () => ({
    dossier: null,
    research: researchFixture(),
    profile: fromPartial<PersonProfile>({ id: "maya", fullName: null }),
  });
  const named = makeClient();
  named.read = async () => ({
    dossier: null,
    research: researchFixture(),
    profile: fromPartial<PersonProfile>({ id: "maya", fullName: "Maya Chen" }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client: unnamed }));
    });
    expect(container.textContent).toContain("could not tell who this Profile is about");
    expect(container.textContent).toContain('"Correct facts"');
    expect(container.textContent).toContain("Prioritise research again");
    // Once the Profile has a name the guidance has nothing left to ask for.
    await act(async () => {
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client: named }));
    });
    expect(container.textContent).not.toContain("could not tell who this Profile is about");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a terminal unavailable conclusion names the retry step", async () => {
  const { container, root } = await mountWithResearch(
    researchFixture({
      state: "unavailable",
      detail:
        "Investigated the planned coverage without finding evidence that could be attributed to this person.",
    }),
  );
  try {
    expect(container.textContent).toContain("Sources unavailable");
    expect(container.textContent).toContain("Choose Prioritise research to try again.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an empty section says plainly that nothing is documented yet", async () => {
  const { container, root } = await mountWithResearch(researchFixture());
  try {
    expect(container.textContent).toContain("Nothing is documented here yet");
    expect(container.textContent).not.toContain("No supported account is available");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

function revisionClient(): DossierClient {
  const client = makeClient();
  client.read = async (_id, revision) => ({
    dossier: fromPartial<PersonDossier>({
      revision: revision ?? 120,
      claims: [],
      sections: [],
      sourceIds: [],
    }),
    research: null,
  });
  return client;
}

test("audit F13: the revision selector lists the newest 50 revisions and names the rest", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(PersonDossierPanel, { profileId: "maya", client: revisionClient() }),
      ),
    );
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Dossier revision"]')!;
    const options = [...select.options];
    expect(options.filter((option) => option.textContent.startsWith("Revision "))).toHaveLength(50);
    const note = options.find((option) =>
      option.textContent.includes("older revisions not listed"),
    );
    expect(note?.textContent).toBe("…70 older revisions not listed");
    expect(note?.disabled).toBe(true);
    expect(select.textContent).toContain("Revision 120");
    expect(select.textContent).not.toContain("Revision 70");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("audit F13: a selected revision older than the window stays in the selector", async () => {
  window.history.replaceState(null, "", "/?dossierRevision=5");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(PersonDossierPanel, { profileId: "maya", client: revisionClient() }),
      ),
    );
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Dossier revision"]')!;
    expect(select.value).toBe("5");
    expect([...select.options].some((option) => option.value === "5")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
  }
});
