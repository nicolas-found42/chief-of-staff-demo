// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContentResearchIndex,
  NamedPerson,
  PersonProfile,
  PersonSuggestion,
} from "@chief-of-staff-demo/shared";
import { ContentResearchPage } from "../../../apps/web/src/pages/ContentResearchPage";
import { ContentScoutPage } from "../../../apps/web/src/pages/ContentScoutPage";
import type { ContentClient, ContentScoutState } from "../../../apps/web/src/clients/content";
import { ApiError } from "../../../apps/web/src/client";
import { peopleApi } from "../../../apps/web/src/clients/people";
import { runsApi } from "../../../apps/web/src/clients/workspace";
import {
  PersonDossierPanel,
  type DossierClient,
} from "../../../apps/web/src/pages/PersonDossierPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function mountPage(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(createElement(MemoryRouter, null, element));
  });
  await act(async () => {});
  return container;
}

afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  document.title = "";
});

function contentScoutState(overrides: Record<string, unknown> = {}): ContentScoutState {
  return fromPartial<ContentScoutState>({
    brandProfile: null,
    brandProfileProposal: null,
    brandProfileRevisions: [],
    sourceTargets: [],
    shortlist: null,
    adapters: [],
    sourceSuggestions: [],
    health: { warnings: [], runtimeWarnings: [], canary: [] },
    ...overrides,
  });
}

function unusedContentClient(): never {
  throw new Error("unused by this Content page test");
}

function contentClient(overrides: Partial<ContentClient>): ContentClient {
  return fromPartial<ContentClient>({
    contentScout: async () => contentScoutState(),
    contentProjects: async () => ({ projects: [] }),
    ...overrides,
  });
}

function researchIndex(waiting: {
  research: string | null;
  discovery: string | null;
}): ContentResearchIndex {
  return {
    waiting,
    byPerson: [],
    runs: [],
  };
}

function personFixture(overrides: Partial<PersonProfile> = {}): PersonProfile {
  return fromPartial<PersonProfile>({
    id: "maya",
    revision: 1,
    fullName: "Maya Chen",
    primaryEmail: "maya@example.com",
    archivedAt: null,
    ...overrides,
  });
}

function watchFixture(overrides: Partial<NamedPerson> = {}): NamedPerson {
  return fromPartial<NamedPerson>({
    id: "watch-maya",
    name: "Maya Chen",
    profileId: "maya",
    handleHints: { blogRssHints: [] },
    discoveredSourceTargets: [],
    createdAt: "2026-09-24T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  });
}

function researchClient(overrides: Partial<ContentClient> = {}): ContentClient {
  const people = [watchFixture()];
  return fromPartial<ContentClient>({
    contentResearchIndex: async () => researchIndex({ research: null, discovery: null }),
    contentResearchPeople: async () => people,
    contentResearchAllPeople: async () => people,
    contentResearchSuggestions: async () => [] as PersonSuggestion[],
    addContentResearchPerson: unusedContentClient,
    runContentResearch: unusedContentClient,
    backfillContentResearch: unusedContentClient,
    discoverContentResearchPeople: unusedContentClient,
    ...overrides,
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.bind(
    input,
  );
  setter?.(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Content Engine rendered setup", () => {
  it("presents Content Engine with the three linked setup rows in order", async () => {
    const state = contentScoutState({
      setup: {
        providerConfigured: false,
        brandVoiceAccepted: false,
        sourceTargetCollectable: false,
        scoutReady: false,
        nextAction: { label: "Open Guided Setup", href: "/onboarding?goal=meetings" },
      },
    });
    const container = await mountPage(
      createElement(ContentScoutPage, {
        client: contentClient({ contentScout: async () => state }),
      }),
    );

    expect(container.querySelector("h1")?.textContent).toBe("Content Engine");
    expect(document.title).toBe("Content Engine · Chief of Staff");
    const rows = [...container.querySelectorAll(".setup-check-list > li")];
    expect(rows.map((row) => row.textContent.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringContaining("Configure model access"),
      expect.stringContaining("Create Brand Voice"),
      expect.stringContaining("Add a source to monitor"),
    ]);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("To do"),
      expect.stringContaining("To do"),
      expect.stringContaining("To do"),
    ]);
    expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe("/onboarding?goal=meetings");
    expect(rows[1]?.querySelector("button")?.textContent).toContain("Create Brand Voice");
    expect(rows[2]?.querySelector("button")?.textContent).toContain("Add a source to monitor");
  });

  it("does not start a Brand Profile scan while provider setup is required", async () => {
    const scanBrandProfile = vi.fn(async () => ({ runId: "must-not-start" }));
    const state = contentScoutState({
      brandProfileScanReadiness: {
        state: "setup-required",
        reason: "provider-not-configured",
        nextAction: { label: "Open Guided Setup", href: "/onboarding?goal=meetings" },
      },
    });
    const container = await mountPage(
      createElement(ContentScoutPage, {
        client: contentClient({ contentScout: async () => state, scanBrandProfile }),
      }),
    );
    const brand = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Brand Profile",
    )!;
    await act(async () => brand.click());
    const setupLink = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "Open Guided Setup",
    );
    expect(setupLink?.getAttribute("href")).toBe("/onboarding?goal=meetings");
    const scan = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Scan website",
    )!;
    expect(scan.hasAttribute("disabled") || scan.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    await act(async () => scan.click());
    expect(scanBrandProfile).not.toHaveBeenCalled();
  });

  it("keeps a stale typed scan refusal actionable without showing its refusal token", async () => {
    const scanBrandProfile = vi.fn(async () => {
      throw new ApiError(409, "brand-profile-scan-disabled", {
        error: "brand-profile-scan-disabled",
        readiness: {
          state: "setup-required",
          reason: "provider-not-configured",
          nextAction: { label: "Open Guided Setup", href: "/onboarding?goal=meetings" },
        },
        nextAction: { label: "Open Guided Setup", href: "/onboarding?goal=meetings" },
      });
    });
    const state = contentScoutState({
      brandProfileScanReadiness: { state: "ready", reason: "ready" },
    });
    const container = await mountPage(
      createElement(ContentScoutPage, {
        client: contentClient({ contentScout: async () => state, scanBrandProfile }),
      }),
    );
    const brand = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Brand Profile",
    )!;
    await act(async () => brand.click());
    const input = container.querySelector<HTMLInputElement>('input[type="url"]')!;
    setInputValue(input, "https://company.example");
    const form = input.closest("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const link = [...container.querySelectorAll("a")].find(
      (candidate) => candidate.textContent === "Open Guided Setup",
    );
    expect(link?.getAttribute("href")).toBe("/onboarding?goal=meetings");
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain(
      "brand-profile-scan-disabled",
    );
  });

  it("renders invalid-key Run feedback as the primary scan failure", async () => {
    vi.spyOn(runsApi, "getRun").mockResolvedValue(
      fromPartial({
        status: "failed",
        failureHint: "The configured OpenRouter API key was rejected. Replace it in Settings.",
      }),
    );
    const state = contentScoutState({
      brandProfileScanReadiness: { state: "ready", reason: "ready" },
    });
    const container = await mountPage(
      createElement(ContentScoutPage, {
        client: contentClient({
          contentScout: async () => state,
          scanBrandProfile: async () => ({ runId: "rejected-key" }),
        }),
      }),
    );
    const brand = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Brand Profile",
    )!;
    await act(async () => brand.click());
    const input = container.querySelector<HTMLInputElement>('input[type="url"]')!;
    setInputValue(input, "https://company.example");
    await act(async () => {
      input
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
      /configured OpenRouter API key.*Settings/i,
    );
  });
});

describe("Content Research rendered setup", () => {
  it("makes only actions blocked by their own readiness non-actionable", async () => {
    vi.spyOn(peopleApi, "people").mockResolvedValue([personFixture()]);
    const runContentResearch = vi.fn(async () => ({ runId: "research" }));
    const backfillContentResearch = vi.fn(async () => ({ runId: "backfill" }));
    const discoverContentResearchPeople = vi.fn(async () => ({ runId: "discover" }));
    const client = researchClient({
      contentResearchIndex: async () =>
        researchIndex({ research: "Configure model access in Settings.", discovery: null }),
      runContentResearch,
      backfillContentResearch,
      discoverContentResearchPeople,
    });
    const container = await mountPage(createElement(ContentResearchPage, { client }));
    await vi.waitFor(() => expect(container.textContent).toContain("Run Now"));
    const action = (name: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === name,
      );
      if (!button) throw new Error(`Action "${name}" is missing`);
      return button;
    };
    const blocked = [
      action("Run Now"),
      action("Backfill 7d"),
      action("Backfill 30d"),
      action("Backfill 90d"),
    ];

    for (const button of blocked) {
      expect(
        button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true",
        button.textContent,
      ).toBe(true);
      await act(async () => button.click());
    }
    const discovery = action("Discover Now");
    expect(
      discovery.hasAttribute("disabled") || discovery.getAttribute("aria-disabled") === "true",
    ).toBe(false);
    await act(async () => discovery.click());
    expect(runContentResearch).not.toHaveBeenCalled();
    expect(backfillContentResearch).not.toHaveBeenCalled();
    expect(discoverContentResearchPeople).toHaveBeenCalledTimes(1);
  });

  it("explains that a Profile identity signal is not a LinkedIn watch source", async () => {
    const client = researchClient({});
    vi.spyOn(peopleApi, "people").mockResolvedValue([personFixture()]);
    const container = await mountPage(createElement(ContentResearchPage, { client }));

    expect(container.textContent).toMatch(/Person Profile.*identity signal/i);
    expect(container.textContent).toMatch(/LinkedIn.*not watched/i);
    for (const source of ["RSS", "websites", "YouTube", "Reddit", "Hacker News", "News"]) {
      expect(container.textContent).toContain(source);
    }
  });

  it("keeps ready research actions actionable when only discovery is blocked", async () => {
    const runContentResearch = vi.fn(async () => ({ runId: "research" }));
    const client = researchClient({
      contentResearchIndex: async () =>
        researchIndex({ research: null, discovery: "Create Brand Voice first." }),
      runContentResearch,
    });
    const container = await mountPage(createElement(ContentResearchPage, { client }));
    const run = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Run Now",
    )!;
    await act(async () => run.click());
    expect(runContentResearch).toHaveBeenCalledTimes(1);
  });

  it("accepts YouTube handle help and submits the established hint shape", async () => {
    const addContentResearchPerson = vi.fn(async () => watchFixture());
    const client = researchClient({ addContentResearchPerson });
    vi.spyOn(peopleApi, "people").mockResolvedValue([personFixture()]);
    const container = await mountPage(createElement(ContentResearchPage, { client }));

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Person Profile"]',
    )!;
    const youtube = container.querySelector<HTMLInputElement>('input[aria-label*="YouTube"]')!;
    const hn = container.querySelector<HTMLInputElement>('input[aria-label*="Hacker News"]')!;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.bind(select);
    nativeSetter?.("maya");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    setInputValue(youtube, "@found42");
    setInputValue(hn, "found42");
    const form = youtube.closest("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toMatch(/channel URL.*@handle/i);
    expect(container.textContent).toMatch(/Hacker News.*profile/i);
    expect(addContentResearchPerson).toHaveBeenCalledWith("maya", {
      blogRssHints: [],
      youtubeChannelId: "@found42",
      hnUsername: "found42",
    });
  });
});

describe("Person dossier pre-research state", () => {
  it("shows one calm not-yet-run state instead of ten section tabs", async () => {
    const client = fromPartial<DossierClient>({
      read: async () => ({ dossier: null, research: null }),
      sources: async () => ({ sources: [] }),
      history: async () => [],
      analysis: async () => null,
      summary: async () => ({
        summary: null,
        readiness: { state: "ready", reason: "ready" },
      }),
      settings: async () =>
        fromPartial({
          schemaVersion: 1,
          day: "2026-09-24",
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
          readiness: { state: "ready", reason: "ready" },
        }),
    });
    const container = await mountPage(
      createElement(PersonDossierPanel, { profileId: "maya", client }),
    );

    expect(container.textContent).toMatch(/research has not run yet/i);
    expect(container.textContent).not.toContain("Nothing is documented here yet");
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });
});
