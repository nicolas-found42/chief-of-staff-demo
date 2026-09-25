// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriveIntakeStatus, GoogleStatus, RedactedConfig } from "@chief-of-staff-demo/shared";
import { SettingsPage } from "../../../apps/web/src/pages/SettingsPage";
import { GoogleConnectionContext } from "../../../apps/web/src/useGoogleConnection";
import {
  migrationApi,
  type ConfigPayload,
  type MigrationStatus,
} from "../../../apps/web/src/clients/workspace";
import { OnboardingSetupPage } from "../../../apps/web/src/pages/OnboardingSetupPage";

const fakes = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  driveIntakeStatus: vi.fn(),
  migrationStatus: vi.fn(),
}));

vi.mock("../../../apps/web/src/clients/workspace", () => ({
  configApi: {
    getConfig: fakes.getConfig,
    saveConfig: fakes.saveConfig,
  },
  migrationApi: { status: fakes.migrationStatus },
  googleApi: {
    pickerToken: vi.fn(async () => {
      throw new Error("The folder picker is not used by this rendered UI spec");
    }),
  },
  intakeApi: {
    driveIntakeStatus: fakes.driveIntakeStatus,
  },
}));

vi.mock("../../../apps/web/src/components/GoogleConnect", () => ({
  GoogleConnect: () => null,
}));
vi.mock("../../../apps/web/src/components/OwnerOnboardingCard", () => ({
  OwnerOnboardingCard: () => null,
}));
vi.mock("../../../apps/web/src/components/MeetingBriefSettings", () => ({
  MeetingBriefSettings: () => null,
}));
vi.mock("../../../apps/web/src/modules/youtube/SpreadsheetCard", () => ({
  SpreadsheetCard: () => null,
}));
vi.mock("../../../apps/web/src/components/ClearGeneratedDataCard", () => ({
  ClearGeneratedDataCard: () => null,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const googleStatus: GoogleStatus = {
  state: "connected",
  email: "owner@example.com",
  redirectUri: "http://127.0.0.1:4320/api/google/callback",
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  lastConnectedAt: "2026-09-01T00:00:00.000Z",
  expiresAbout: null,
};

function config(overrides: Partial<RedactedConfig> = {}): RedactedConfig {
  return {
    provider: "openrouter",
    model: "inception/mercury-2.5",
    models: { openrouter: { evaluationJudge: "independent-judge" } },
    tasklistName: "Meeting Followups",
    notion: { token: { set: false, hint: "" }, lastVerifiedAt: null },
    drive: {
      enabled: false,
      folderId: "folder-1",
      folderName: "Team Transcripts",
      pollIntervalMinutes: 5,
    },
    ollama: { baseUrl: "http://127.0.0.1:11434" },
    search: { searxngUrl: null },
    ...overrides,
  };
}

function payload(overrides: Partial<RedactedConfig> = {}): ConfigPayload {
  return {
    config: config(overrides),
    defaults: { openrouter: "inception/mercury-2.5" },
    mockAvailable: false,
    installation: {
      googleClient: { state: "missing" },
      providerKeys: {
        openrouter: { state: "missing" },
        openai: { state: "missing" },
        anthropic: { state: "missing" },
        gemini: { state: "missing" },
      },
      ollama: { state: "not-required" },
    },
  };
}

function intake(enabled: boolean): DriveIntakeStatus {
  return {
    enabled,
    configured: true,
    folderName: "Team Transcripts",
    pollIntervalMinutes: 5,
    lastPollAt: null,
    lastPollOutcome: null,
    catalog: {
      consent: {
        folderId: "folder-1",
        folderName: "Team Transcripts",
        consentedAt: "2026-09-01T00:00:00.000Z",
      },
      backfill: "idle",
      pending: 0,
      processed: 3,
      failed: 0,
      skipped: 0,
      transcriptCount: 3,
    },
  };
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function mountPage(current: ConfigPayload, currentIntake: DriveIntakeStatus) {
  fakes.getConfig.mockResolvedValue(current);
  fakes.driveIntakeStatus.mockResolvedValue(currentIntake);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(
      createElement(
        GoogleConnectionContext.Provider,
        { value: { status: googleStatus, refresh: async () => {} } },
        createElement(MemoryRouter, null, createElement(SettingsPage)),
      ),
    );
  });
  await act(async () => {});
  return container;
}

async function mountOnboarding(status: MigrationStatus) {
  fakes.migrationStatus.mockResolvedValue(status);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/onboarding?goal=meetings"] },
        createElement(OnboardingSetupPage),
      ),
    );
  });
  await act(async () => {});
  return container;
}

function onboardingStatus(
  origin: "pristine" | "migrated",
  overrides: Partial<MigrationStatus["onboarding"]> = {},
): MigrationStatus {
  return {
    state: "completed",
    origin,
    onboarding: {
      goal: "general",
      complete: false,
      steps: [
        {
          id: "provider-enablement",
          label: "Enable providers",
          done: false,
          href: "/settings#api-key",
        },
        {
          id: "transcript-polling",
          label: "Enable transcript polling",
          done: false,
          href: "/settings#drive-polling",
        },
      ],
      ...overrides,
    },
  };
}

function labelledControl(container: HTMLElement, label: string): HTMLInputElement {
  const control = [...container.querySelectorAll("input")].find((input) => {
    const id = input.getAttribute("id");
    return id !== null && container.querySelector(`label[for="${id}"]`)?.textContent === label;
  });
  if (!control) throw new Error(`Control labelled "${label}" is missing`);
  return control;
}

function transcriptCard(container: HTMLElement): HTMLElement {
  const heading = [...container.querySelectorAll("h2")].find(
    (candidate) => candidate.textContent === "Transcript intake",
  );
  const card = heading?.parentElement?.querySelector<HTMLElement>(".card");
  if (!card) throw new Error("Transcript intake card is missing");
  return card;
}

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted?.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
  fakes.getConfig.mockReset();
  fakes.saveConfig.mockReset();
  fakes.driveIntakeStatus.mockReset();
  fakes.migrationStatus.mockReset();
  window.history.replaceState(null, "", "/");
});

describe("Onboarding transcript action", () => {
  it("renders enablement as the next step with the exact polling-control link", async () => {
    const status: MigrationStatus = {
      state: "completed",
      origin: "pristine",
      onboarding: {
        goal: "general",
        complete: false,
        steps: [
          {
            id: "transcript-polling",
            label: "Enable transcript polling",
            done: false,
            href: "/settings#drive-polling",
          },
        ],
      },
    };
    fakes.migrationStatus.mockResolvedValue(status);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(OnboardingSetupPage)));
    });

    const link = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Enable transcript polling",
    );
    expect(link?.getAttribute("href")).toBe("/settings#drive-polling");
    expect(link?.parentElement?.textContent).toContain("To do");
    expect(migrationApi.status).toHaveBeenCalledOnce();
  });
});

describe("Onboarding origin and goal presentation", () => {
  it("uses truthful first-run copy while keeping the server checklist", async () => {
    const container = await mountOnboarding(onboardingStatus("pristine"));
    const copy = [...container.querySelectorAll("p")].map((paragraph) => paragraph.textContent);
    expect(copy.some((text) => /first|new workspace/i.test(text))).toBe(true);
    expect(container.textContent).not.toMatch(/migration|removed|preserved.*credentials/i);
    expect(
      [...container.querySelectorAll(".setup-check-list li")].map((item) =>
        item.textContent.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual(["Enable providers To do", "Enable transcript polling To do"]);
  });

  it("uses accurate canonical-cutover copy without claiming everything else was removed", async () => {
    const container = await mountOnboarding(onboardingStatus("migrated"));
    const copy = container.textContent;
    expect(copy).toMatch(/canonical/i);
    expect(copy).toMatch(/preserv/i);
    expect(copy).not.toMatch(/removed everything else|everything else was removed/i);
    expect(container.querySelectorAll(".setup-check-list li")).toHaveLength(2);
  });

  it("shows exactly the five Meeting prerequisites at their exact control destinations", async () => {
    const steps = [
      ["meeting-provider", "Configure the model extraction provider", "/settings#api-key"],
      ["meeting-google", "Connect Google", "/settings#group-google"],
      ["meeting-folder", "Choose the transcript Drive folder", "/settings#drive-folder"],
      ["meeting-polling", "Enable Drive polling", "/settings#drive-polling"],
      [
        "meeting-consent",
        "Allow the app to read and process the selected folder",
        "/settings#transcript-consent",
      ],
    ].map(([id, label, href]) => ({ id, label, done: false, href }));
    const container = await mountOnboarding(
      onboardingStatus("pristine", { goal: "meetings", steps } as Partial<
        MigrationStatus["onboarding"]
      >),
    );
    expect(
      [...container.querySelectorAll(".setup-check-list a")].map((link) => [
        link.textContent,
        link.getAttribute("href"),
      ]),
    ).toEqual(steps.map(({ label, href }) => [label, href]));
    expect(container.textContent).not.toMatch(
      /Brand Voice|Internal Domains|Sheets|workflow bundles|Owner Profile/i,
    );
  });

  it.each(["pristine", "migrated"] as const)(
    "keeps completed %s onboarding on the same Home result",
    async (origin) => {
      const container = await mountOnboarding(
        onboardingStatus(origin, { complete: true, steps: [] }),
      );
      expect(container.querySelector('.banner-ok[role="status"]')).not.toBeNull();
      expect(container.querySelector('a[href="/"]')?.textContent).toBe("Go to Home");
    },
  );
});

describe("Transcript intake state", () => {
  it("reports polling as paused, then active after the owner enables and saves it", async () => {
    const container = await mountPage(payload(), intake(false));
    const card = transcriptCard(container);
    const checkbox = labelledControl(card, "Enable Drive polling");

    expect(checkbox.id).toBe("drive-polling");
    expect(card.textContent).toMatch(/automatic.*polling.*paused/i);
    expect(card.textContent).toMatch(/enable.*polling/i);
    expect(card.textContent).not.toContain("Reading Team Transcripts since");
    expect(
      [...card.querySelectorAll("button")].some((button) => button.textContent === "Sync now"),
    ).toBe(true);

    fakes.saveConfig.mockResolvedValue(payload({ drive: { ...config().drive, enabled: true } }));
    await act(async () => checkbox.click());
    await act(async () => {
      const save = [...card.ownerDocument.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Save settings",
      );
      if (!save) throw new Error("Save settings is missing");
      save.click();
    });

    const active = card.textContent;
    expect(active).toMatch(/polling.*enabled/i);
    expect(active).toContain("Team Transcripts");
    expect(active).toContain("5 minutes");
    expect(active).toContain("3 transcripts catalogued");
    expect(active).not.toMatch(/polling.*paused/i);
  });
});
