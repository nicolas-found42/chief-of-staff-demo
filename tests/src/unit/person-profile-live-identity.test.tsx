// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test, vi } from "vitest";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import type { PeopleClient } from "../../../apps/web/src/clients/people";
import { PersonProfileDetailPage } from "../../../apps/web/src/pages/PersonProfileDetailPage";

const delivery = vi.hoisted(() => ({ receive: null as ((profile: PersonProfile) => void) | null }));
vi.mock("../../../apps/web/src/pages/PersonDossierPanel", () => ({
  PersonDossierPanel: ({ onProfile }: { onProfile: (profile: PersonProfile) => void }) => {
    delivery.receive = onProfile;
    return null;
  },
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function profile(id: string, fullName: string | null = null): PersonProfile {
  return fromPartial<PersonProfile>({
    id,
    revision: 1,
    fullName,
    role: null,
    currentEmployer: null,
    background: null,
    primaryEmail: null,
    archivedAt: null,
    emails: [],
    profileUrls: [],
    handles: {},
    employerHints: [],
    socialProfiles: [],
    websites: [],
    feeds: [],
    publications: [],
    mentions: [],
    evidence: [],
    sourceDiagnostics: [],
  });
}

test("live identity adopts newer revisions and ignores late research responses after a correction", async () => {
  const initial = profile("person");
  const client = fromPartial<PeopleClient>({
    personProfile: async () => initial,
    personProfileRevisions: async () => [initial],
    personProfileLifecycle: async () => {
      throw new Error("No lifecycle fixture");
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/people/person"] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/people/:profileId",
              element: createElement(PersonProfileDetailPage, { client }),
            }),
          ),
        ),
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe("(unnamed)");
    await act(async () =>
      delivery.receive?.({ ...initial, revision: 2, fullName: "Resolved Name" }),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Resolved Name");
    await act(async () =>
      delivery.receive?.({ ...initial, revision: 4, fullName: "Corrected Name" }),
    );
    await act(async () => delivery.receive?.({ ...initial, revision: 2, fullName: "Stale Name" }));
    expect(container.querySelector("h1")?.textContent).toBe("Corrected Name");
    expect(container.textContent).toContain("Revision 4 (current)");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delivery.receive = null;
  }
});

test("navigation to another profile cannot receive the previous profile's late async response", async () => {
  const client = fromPartial<PeopleClient>({
    personProfile: async (id: string) => profile(id, id === "a" ? "Person A" : "Person B"),
    personProfileRevisions: async (id: string) => [profile(id)],
    personProfileLifecycle: async () => {
      throw new Error("No lifecycle fixture");
    },
  });
  function Navigate() {
    const navigate = useNavigate();
    return createElement("button", { onClick: () => navigate("/people/b") }, "Open B");
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/people/a"] },
          createElement(
            "div",
            null,
            createElement(Navigate),
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: "/people/:profileId",
                element: createElement(PersonProfileDetailPage, { client }),
              }),
            ),
          ),
        ),
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Person A");
    const lateResponse = delivery.receive!;
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("h1")?.textContent).toBe("Person B");
    await act(async () => lateResponse({ ...profile("a", "Stale Person A"), revision: 99 }));
    expect(container.querySelector("h1")?.textContent).toBe("Person B");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
