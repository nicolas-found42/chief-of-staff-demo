// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import type { PeopleClient, PersonProfileLookup } from "../../../apps/web/src/clients/people";
import { NewPersonProfilePage } from "../../../apps/web/src/pages/NewPersonProfilePage";

// The creation surface renders against a fake PeopleClient — the seam issue
// #170 put beneath every product-area surface. jsdom stands in for the
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
function fakeClient(overrides: Partial<PeopleClient> = {}): PeopleClient {
  const unused = (): never => {
    throw new Error("unused by this spec");
  };
  return {
    people: unused,
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
    ...overrides,
  };
}

function lookupFixture(id: string): PersonProfileLookup {
  return fromPartial<PersonProfileLookup>({ profile: profileFixture({ id }) });
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function mountPage(client: PeopleClient): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(NewPersonProfilePage, { client })));
  });
  await act(async () => {});
  return container;
}

/** Sets a controlled field through the native setter the DOM would use. */
function change(container: HTMLDivElement, selector: string, value: string): void {
  const field = container.querySelector(selector);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    throw new Error(`${selector} is missing`);
  }
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set?.bind(field) as
    ((next: string) => void) | undefined;
  setValue?.(value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(container: HTMLDivElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`button "${text}" is missing`);
  return found;
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

describe("NewPersonProfilePage setup guidance", () => {
  it("states the whole prerequisite chain in order, with the provider link", async () => {
    const container = await mountPage(fakeClient());

    const steps = [...container.querySelectorAll("ol li")].map((item) => item.textContent);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain("Add a model provider key");
    expect(steps[1]).toContain("Create a Person Profile for yourself");
    expect(steps[2]).toContain("Confirm your Profile in Settings → Owner Profile");
    // The link is real: the Extraction provider card's anchor (#417/F2).
    expect(container.querySelector("ol a")?.getAttribute("href")).toBe("/settings#group-provider");
    // Guidance, not a gate: the form stays usable.
    expect(button(container, "Add and research")).toBeDefined();
    expect(button(container, "Create profile")).toBeDefined();
  });
});

describe("Identifier creation", () => {
  it("passes the optional full name through to acceptPersonProfileLookup", async () => {
    const accept = vi.fn<PeopleClient["acceptPersonProfileLookup"]>(async () =>
      lookupFixture("person-new"),
    );
    const container = await mountPage(fakeClient({ acceptPersonProfileLookup: accept }));

    await act(async () => {
      change(container, "#profile-identifier", "linkedin.com/in/someone");
      change(container, "#profile-identifier-name", "Some One");
    });
    await act(async () => button(container, "Add and research").click());

    expect(accept).toHaveBeenCalledWith("linkedin.com/in/someone", "Some One");
  });

  it("clears the previous identifier error as soon as the field changes", async () => {
    const container = await mountPage(fakeClient());

    await act(async () => button(container, "Add and research").click());
    expect(container.textContent).toContain("Enter an email address or a profile URL");

    await act(async () => change(container, "#profile-identifier", "a"));
    expect(container.textContent).not.toContain("Enter an email address or a profile URL");
  });
});

describe("Same-name duplicate warning (audit F4)", () => {
  const existing = profileFixture({ id: "person-existing", fullName: "Satya Nadella" });

  it("holds an identifier accept until Create anyway, linking the existing profile", async () => {
    const accept = vi.fn<PeopleClient["acceptPersonProfileLookup"]>(async () =>
      lookupFixture("person-new"),
    );
    const people = vi.fn<PeopleClient["people"]>(async () => [existing]);
    const container = await mountPage(fakeClient({ people, acceptPersonProfileLookup: accept }));

    await act(async () => {
      change(container, "#profile-identifier", "linkedin.com/in/satyanadella");
      change(container, "#profile-identifier-name", "satya nadella");
    });
    await act(async () => button(container, "Add and research").click());

    // Nothing was created or queued for research before the owner saw the warning.
    expect(accept).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A profile named Satya Nadella already exists.");
    expect(container.querySelector('a[href="/people/person-existing"]')).not.toBeNull();

    await act(async () => button(container, "Create anyway").click());
    expect(accept).toHaveBeenCalledWith("linkedin.com/in/satyanadella", "satya nadella");
    expect(container.textContent).not.toContain("already exists");
  });

  it("holds a manual create until Create anyway", async () => {
    const create = vi.fn<PeopleClient["createPersonProfile"]>(async () =>
      profileFixture({ id: "person-new" }),
    );
    const people = vi.fn<PeopleClient["people"]>(async () => [existing]);
    const container = await mountPage(fakeClient({ people, createPersonProfile: create }));

    await act(async () => change(container, "#profile-full-name", "SATYA NADELLA"));
    await act(async () => button(container, "Create profile").click());

    expect(create).not.toHaveBeenCalled();
    // The warning names the canonical Profile that already exists, not the typing.
    expect(container.textContent).toContain("A profile named Satya Nadella already exists.");
    expect(container.querySelector('a[href="/people/person-existing"]')).not.toBeNull();

    await act(async () => button(container, "Create anyway").click());
    expect(create).toHaveBeenCalledWith({ fullName: "SATYA NADELLA" });
  });

  it("reads the people list once per mount", async () => {
    const people = vi.fn<PeopleClient["people"]>(async () => [existing]);
    const create = vi.fn<PeopleClient["createPersonProfile"]>(async () =>
      profileFixture({ id: "person-new" }),
    );
    const container = await mountPage(fakeClient({ people, createPersonProfile: create }));

    await act(async () => change(container, "#profile-full-name", "Satya Nadella"));
    await act(async () => button(container, "Create profile").click());
    expect(container.textContent).toContain("already exists");
    // A second attempt reuses the mount's cached list, warning again without a read.
    await act(async () => button(container, "Create profile").click());

    expect(people).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("never blocks creation when the people list cannot be read", async () => {
    const people = vi.fn<PeopleClient["people"]>(async () => {
      throw new Error("Connection unavailable");
    });
    const create = vi.fn<PeopleClient["createPersonProfile"]>(async () =>
      profileFixture({ id: "person-new" }),
    );
    const container = await mountPage(fakeClient({ people, createPersonProfile: create }));

    await act(async () => change(container, "#profile-full-name", "Satya Nadella"));
    await act(async () => button(container, "Create profile").click());

    expect(create).toHaveBeenCalledWith({ fullName: "Satya Nadella" });
  });
});
