// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import type { PeopleClient } from "../../../apps/web/src/clients/people";
import { PeoplePage } from "../../../apps/web/src/pages/PeoplePage";

// The page test renders a real page against a fake PeopleClient — the seam
// issue #170 put beneath every product-area surface. jsdom stands in for the
// browser; nothing here touches fetch.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function profileFixture(overrides: Partial<PersonProfile> = {}): PersonProfile {
  return {
    id: "profile-1",
    revision: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    fullName: null,
    primaryEmail: null,
    emails: [],
    handles: {},
    profileUrls: [],
    employerHints: [],
    role: null,
    background: null,
    currentEmployer: null,
    socialProfiles: [],
    websites: [],
    feeds: [],
    publications: [],
    mentions: [],
    evidence: [],
    sourceDiagnostics: [],
    archivedAt: null,
    ...overrides,
  };
}

/** The double convention the server specs use: every unneeded member throws. */
function fakePeopleClient(people: PeopleClient["people"]): PeopleClient {
  const unused = (): never => {
    throw new Error("unused by this spec");
  };
  return {
    people,
    createPersonProfile: unused,
    lookupPersonProfile: unused,
    acceptPersonProfileLookup: unused,
    researchStatus: unused,
    cancelPersonResearch: unused,
    sourceSummaries: unused,
    enrichPersonProfile: unused,
    personProfile: unused,
    personProfileRevisions: unused,
    personProfileRevision: unused,
    personProfileProjection: unused,
    correctPersonProfile: unused,
    mergePersonProfile: unused,
    detachPersonEvidence: unused,
    personProfileLifecycle: unused,
    archivePersonProfile: unused,
    restorePersonProfile: unused,
    privacyDeletePersonProfile: unused,
    transcriptRelevanceQueue: unused,
    searchTranscriptRelevance: unused,
    decideTranscriptRelevance: unused,
    transcripts: unused,
    transcriptDeletionPreview: unused,
    deleteTranscript: unused,
    transcriptTombstones: unused,
    restoreTranscriptProcessing: unused,
  };
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function mountPage(client: PeopleClient): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(PeoplePage, { client })));
  });
  await act(async () => {});
  return container;
}

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted?.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

describe("PeoplePage against a fake PeopleClient", () => {
  it("renders Profiles from the injected client and never touches the transport", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const calls: Array<Parameters<PeopleClient["people"]>> = [];
    const client = fakePeopleClient((...args) => {
      calls.push(args);
      return Promise.resolve([
        profileFixture({ id: "profile-ada", fullName: "Ada Lovelace" }),
        profileFixture({
          id: "profile-nemo",
          fullName: "Nobody Nemo",
          archivedAt: "2026-09-02T00:00:00.000Z",
        }),
      ]);
    });

    const container = await mountPage(client);

    // The initial load carried the page's defaults: no query, active Profiles.
    expect(calls).toEqual([["", false]]);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain("Ada Lovelace");
    // Archive state renders as a classified badge, not a bare word.
    expect(container.textContent).toContain("Archived");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("sends the search query through the client seam", async () => {
    const calls: Array<Parameters<PeopleClient["people"]>> = [];
    const client = fakePeopleClient((...args) => {
      calls.push(args);
      return Promise.resolve([]);
    });

    const container = await mountPage(client);
    const input = container.querySelector("#people-search");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("the search input is missing");
    }

    await act(async () => {
      // React's controlled input ignores a plain `input.value = …`, so the
      // value goes through the native setter the way the DOM would set it.
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      // Bound to the element: the native setter reads `this` as the input.
      const setValue = descriptor?.set?.bind(input) as ((value: string) => void) | undefined;
      setValue?.("ada");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(calls[1]).toEqual(["ada", false]);
  });
});

describe("People search recovery", () => {
  it.each(["success", "failure"])(
    "ignores an older search %s after the filters change",
    async (outcome) => {
      const initial = Promise.withResolvers<PersonProfile[]>();
      const filtered = Promise.withResolvers<PersonProfile[]>();
      const client = fakePeopleClient((_query, archived) =>
        archived ? filtered.promise : initial.promise,
      );
      const container = await mountPage(client);
      await act(async () => {
        container.querySelector<HTMLInputElement>("#people-archived")!.click();
      });
      await act(async () => filtered.resolve([profileFixture({ fullName: "Current result" })]));
      await act(async () => {
        if (outcome === "failure") initial.reject(new Error("Obsolete failure"));
        else initial.resolve([profileFixture({ fullName: "Obsolete result" })]);
      });
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain("Current result");
      expect(container.textContent).not.toContain("Obsolete result");
    },
  );

  it("offers a retry after an initial failure instead of claiming to keep loading", async () => {
    const people = vi
      .fn<PeopleClient["people"]>()
      .mockRejectedValueOnce(new Error("Connection unavailable"))
      .mockResolvedValueOnce([profileFixture({ fullName: "Recovered profile" })]);
    const container = await mountPage(fakePeopleClient(people));
    expect(container.textContent).not.toContain("Loading…");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(container.textContent).toContain("Recovered profile");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("Person Profiles list honesty", () => {
  it("labels the review link for the Transcript review page it opens", async () => {
    const container = await mountPage(
      fakePeopleClient(async () => [profileFixture({ fullName: "Ada Lovelace" })]),
    );

    const link = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.getAttribute("href") === "/people/review",
    );
    expect(link?.textContent).toBe("Transcript review");
  });

  it("marks .example Profiles and explains them once", async () => {
    const container = await mountPage(
      fakePeopleClient(async () => [
        profileFixture({ fullName: "Pieter Levels", primaryEmail: "pieter@levelsio.example" }),
        profileFixture({
          id: "profile-2",
          fullName: "Ada Lovelace",
          primaryEmail: "ada@example.com",
        }),
      ]),
    );

    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.find((row) => row.textContent.includes("Pieter Levels"))?.textContent).toContain(
      "Example",
    );
    expect(rows.find((row) => row.textContent.includes("Ada Lovelace"))?.textContent).not.toContain(
      "Example",
    );
    const footnote =
      "Example profiles ship with the workspace for Content Research; delete them anytime.";
    expect(
      [...container.querySelectorAll("p.muted")].filter((item) => item.textContent === footnote),
    ).toHaveLength(1);
  });

  it("says nothing about example profiles when the list has none", async () => {
    const container = await mountPage(
      fakePeopleClient(async () => [
        profileFixture({ fullName: "Ada Lovelace", primaryEmail: "ada@example.com" }),
      ]),
    );

    expect(container.textContent).not.toContain("Example profiles ship with the workspace");
  });
});
