// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import type { PeopleClient } from "../../../apps/web/src/clients/people";
import { PersonProfileDetailPage } from "../../../apps/web/src/pages/PersonProfileDetailPage";

// The dossier panel owns its own polling and data contract; this spec is about
// the page's heading, subtitle, and revision list, so the panel is stubbed.
vi.mock("../../../apps/web/src/pages/PersonDossierPanel", () => ({
  PersonDossierPanel: () => null,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function profile(revision: number, overrides: Partial<PersonProfile> = {}): PersonProfile {
  return fromPartial<PersonProfile>({
    id: "person-1",
    revision,
    fullName: "Satya Nadella",
    role: null,
    currentEmployer: null,
    archivedAt: null,
    emails: [],
    handles: {},
    profileUrls: [],
    employerHints: [],
    socialProfiles: [],
    websites: [],
    feeds: [],
    publications: [],
    mentions: [],
    evidence: [],
    sourceDiagnostics: [],
    ...overrides,
  });
}

function fakeClient(current: PersonProfile, history: PersonProfile[]): PeopleClient {
  return fromPartial<PeopleClient>({
    personProfile: async () => current,
    personProfileRevisions: async () => history,
    personProfileLifecycle: async () => {
      throw new Error("No lifecycle fixture");
    },
  });
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function mountPage(client: PeopleClient): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/people/person-1"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/people/:profileId",
            element: createElement(PersonProfileDetailPage, { client }),
          }),
        ),
      ),
    );
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

describe("PersonProfileDetailPage heading", () => {
  it("carries role and employer as the subtitle without repeating the name", async () => {
    const container = await mountPage(fakeClient(profile(1, { role: "CEO" }), [profile(1)]));

    expect(container.querySelector("h1")?.textContent).toBe("Satya Nadella");
    const subtitle = container.querySelector("p.muted");
    expect(subtitle?.textContent).toBe("CEO");
    expect(subtitle?.textContent).not.toContain("Satya Nadella");
  });

  it("keeps the no-resolved-facts fallback", async () => {
    const container = await mountPage(fakeClient(profile(1), [profile(1)]));

    expect(container.querySelector("h1")?.textContent).toBe("Satya Nadella");
    expect(container.querySelector("p.muted")?.textContent).toBe("No resolved facts yet.");
  });
});

describe("PersonProfileDetailPage revision history", () => {
  function revisionCard(container: HTMLDivElement): Element {
    const heading = [...container.querySelectorAll("h2")].find(
      (candidate) => candidate.textContent === "Revision history",
    );
    const card = heading?.parentElement;
    if (!card) throw new Error("the Revision history card is missing");
    return card;
  }

  it("lists the 30 most recent revisions, then expands the rest on Show all", async () => {
    const history = Array.from({ length: 35 }, (_, index) => profile(35 - index));
    const container = await mountPage(fakeClient(history[0], history));

    const card = revisionCard(container);
    const rows = () => [...card.querySelectorAll("li")].map((item) => item.textContent);
    expect(rows()).toHaveLength(30);
    expect(rows()[0]).toContain("Revision 35 (current)");
    expect(rows()[29]).toContain("Revision 6");
    /* Older revisions stay one click away: the toggle names the count and
       expands the full history. */
    const toggle = [...card.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Show all 35 revisions"),
    );
    expect(toggle).toBeDefined();
    expect(card.textContent).not.toContain("Revision 5");
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rows()).toHaveLength(35);
    expect(rows()[34]).toContain("Revision 1");
  });

  it("lists every revision and no note when the history is short", async () => {
    const history = [profile(3), profile(2), profile(1)];
    const container = await mountPage(fakeClient(history[0], history));

    const card = revisionCard(container);
    expect(card.querySelectorAll("li")).toHaveLength(3);
    expect(card.textContent).not.toContain("older revisions not listed");
  });
});
