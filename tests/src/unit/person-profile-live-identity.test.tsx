// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

test("live identity adopts newer revisions and ignores late research responses after a correction", async () => {
  const initial = fromPartial<PersonProfile>({
    id: "person",
    revision: 1,
    fullName: null,
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
