// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import type { OwnerOnboardingStatus } from "../../../apps/web/src/clients/workspace";
import { OwnerOnboardingCard } from "../../../apps/web/src/components/OwnerOnboardingCard";
import { providerSaveWarning } from "../../../apps/web/src/pages/SettingsPage";

/* The save warning (UX audit F3) is a decision, not a rendering — it lives in
   an exported helper so this spec reads the decision without mounting the
   thousand-line page. The owner dropdown is mounted for real against fake
   clients, because the unnamed-Profile filter is only observable in the
   options it renders. */

const fakes = vi.hoisted(() => ({
  owner: null as null | (() => Promise<OwnerOnboardingStatus>),
  people: null as null | (() => Promise<PersonProfile[]>),
}));

vi.mock("../../../apps/web/src/clients/workspace", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    onboardingApi: {
      owner: () => fakes.owner!(),
      confirm: () => Promise.reject(new Error("confirm is unused by this spec")),
    },
  };
});

vi.mock("../../../apps/web/src/clients/people", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    peopleApi: { people: () => fakes.people!() },
  };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const WARNING = "No API key set — research and extraction will not run until one is added.";

describe("providerSaveWarning", () => {
  it("warns for a production provider with no key in the field and none stored", () => {
    expect(providerSaveWarning("openrouter", "", false)).toBe(WARNING);
    expect(providerSaveWarning("openai", "", false)).toBe(WARNING);
    expect(providerSaveWarning("anthropic", "", false)).toBe(WARNING);
    expect(providerSaveWarning("gemini", "", false)).toBe(WARNING);
  });

  it("treats whitespace as no key, and clears once one is typed", () => {
    expect(providerSaveWarning("openrouter", "   ", false)).toBe(WARNING);
    expect(providerSaveWarning("openrouter", "sk-or-abc", false)).toBeNull();
  });

  it("stays quiet when a key is stored for the same provider and the field is left blank", () => {
    expect(providerSaveWarning("openrouter", "", true, false)).toBeNull();
  });

  it("warns when the provider changed onto a stored key, because that key is not its own", () => {
    expect(providerSaveWarning("openai", "", true, true)).toBe(
      "The stored API key belongs to the previous provider — saving now removes it, and " +
        "research and extraction will not run for this provider until its own key is added.",
    );
  });

  it("warns with the generic no-key message when the provider changes and none is stored", () => {
    expect(providerSaveWarning("openai", "", false, true)).toBe(
      "No API key set — research and extraction will not run until one is added.",
    );
  });

  it("stays quiet for providers that need no key", () => {
    expect(providerSaveWarning("mock", "", false)).toBeNull();
    expect(providerSaveWarning("ollama", "", false)).toBeNull();
  });
});

function profile(id: string, fullName: string | null): PersonProfile {
  return fromPartial<PersonProfile>({
    id,
    revision: 1,
    fullName,
    primaryEmail: `${id}@example.com`,
    archivedAt: null,
  });
}

const proposal: OwnerOnboardingStatus["proposal"] = {
  googleEmail: "owner@example.com",
  matchedProfileId: null,
  matchedProfileRevision: null,
};

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function mountCard(status: OwnerOnboardingStatus, profiles: PersonProfile[]) {
  fakes.owner = async () => status;
  fakes.people = async () => profiles;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(OwnerOnboardingCard, { googleConnectionState: "connected" }),
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

describe("OwnerOnboardingCard owner candidates", () => {
  it("offers only named Profiles and does not auto-select an unnamed email match", async () => {
    const container = await mountCard(
      { proposal: { ...proposal, matchedProfileId: "unnamed" }, confirmed: null },
      [profile("unnamed", null), profile("ada", "Ada Lovelace")],
    );

    const select = container.querySelector("select")!;
    const options = [...select.querySelectorAll("option")];
    expect(options.map((option) => option.value)).toEqual(["ada"]);
    expect(select.value).toBe("ada");
    expect(container.textContent).not.toContain("(unnamed)");
  });

  it("tells the owner to create a Profile when none has a name", async () => {
    const container = await mountCard(
      { proposal: { ...proposal, matchedProfileId: "unnamed" }, confirmed: null },
      [profile("unnamed", null)],
    );

    const select = container.querySelector("select")!;
    expect(select.hasAttribute("disabled")).toBe(true);
    expect(select.querySelector("option")!.value).toBe("");
    expect(select.querySelector("option")!.textContent).toBe("No Person Profiles yet");
    expect(container.textContent).toContain("Create one under Person Profiles");
    expect(container.textContent).toContain("with your connected email");
  });

  it("names the matched Profile when the email match has one", async () => {
    const container = await mountCard(
      { proposal: { ...proposal, matchedProfileId: "ada" }, confirmed: null },
      [profile("ada", "Ada Lovelace")],
    );

    expect(container.textContent).toContain("Proposed by the connected email: Ada Lovelace.");
  });
});
