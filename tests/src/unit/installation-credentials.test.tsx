// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriveIntakeStatus, GoogleStatus } from "@chief-of-staff-demo/shared";
import { SettingsPage } from "../../../apps/web/src/pages/SettingsPage";
import { GoogleConnectionContext } from "../../../apps/web/src/useGoogleConnection";
import type { ConfigPayload } from "../../../apps/web/src/clients/workspace";

const fakes = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  driveIntakeStatus: vi.fn(),
}));

vi.mock("../../../apps/web/src/clients/workspace", () => ({
  configApi: {
    getConfig: fakes.getConfig,
    saveConfig: fakes.saveConfig,
  },
  googleApi: {
    pickerToken: vi.fn(),
  },
  intakeApi: {
    driveIntakeStatus: fakes.driveIntakeStatus,
  },
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
  state: "unconfigured",
  email: null,
  redirectUri: "http://127.0.0.1:4317/api/google/callback",
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  lastConnectedAt: null,
  expiresAbout: null,
};

const intake: DriveIntakeStatus = {
  enabled: false,
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
    processed: 0,
    failed: 0,
    skipped: 0,
    transcriptCount: 0,
  },
};

type InstallationStatus = {
  googleClient: { state: "configured" | "missing" };
  providerKeys: Record<
    "openrouter" | "openai" | "anthropic" | "gemini",
    { state: "configured" | "missing" }
  >;
  ollama: { state: "not-required" };
};

function payload(installation: InstallationStatus): ConfigPayload {
  return {
    config: {
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
    },
    defaults: { openrouter: "inception/mercury-2.5" },
    mockAvailable: false,
    installation,
  };
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function mountSettings(current: ConfigPayload): Promise<HTMLDivElement> {
  fakes.getConfig.mockResolvedValue(current);
  fakes.driveIntakeStatus.mockResolvedValue(intake);
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

function labelText(container: HTMLElement, label: string): string | null {
  return (
    [...container.querySelectorAll("label")]
      .map((candidate) => candidate.textContent)
      .find((text) => text === label) ?? null
  );
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
  window.history.replaceState(null, "", "/");
});

describe("installation credential setup in Settings", () => {
  it("shows only Configured, Missing, Not required, and Guided Setup guidance", async () => {
    const container = await mountSettings(
      payload({
        googleClient: { state: "configured" },
        providerKeys: {
          openrouter: { state: "configured" },
          openai: { state: "missing" },
          anthropic: { state: "missing" },
          gemini: { state: "missing" },
        },
        ollama: { state: "not-required" },
      }),
    );

    expect(container.textContent).toContain("Configured");
    expect(container.textContent).toContain("Missing");
    expect(container.textContent).toContain("Not required");
    expect(container.textContent).toContain("./scripts/setup-wizard.sh");
    expect(container.textContent).not.toContain("Stored (");
    expect(container.textContent).not.toContain("…7890");
    expect(container.textContent).not.toContain("…cdef");
  });

  it("offers only providers with installed keys plus Ollama and no editable installation secrets", async () => {
    const container = await mountSettings(
      payload({
        googleClient: { state: "missing" },
        providerKeys: {
          openrouter: { state: "configured" },
          openai: { state: "missing" },
          anthropic: { state: "missing" },
          gemini: { state: "missing" },
        },
        ollama: { state: "not-required" },
      }),
    );
    const provider = container.querySelector<HTMLSelectElement>("#provider");
    expect(provider).not.toBeNull();
    expect([...(provider?.options ?? [])].map((option) => option.value)).toEqual([
      "openrouter",
      "ollama",
    ]);

    for (const toggle of container.querySelectorAll<HTMLButtonElement>(".wizard-step-toggle")) {
      await act(async () => toggle.click());
    }
    expect(labelText(container, "Provider API key")).toBeNull();
    expect(labelText(container, "OAuth client ID")).toBeNull();
    expect(labelText(container, "OAuth client secret")).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("keeps owner Google consent visible after the installation client is configured", async () => {
    const container = await mountSettings(
      payload({
        googleClient: { state: "configured" },
        providerKeys: {
          openrouter: { state: "configured" },
          openai: { state: "missing" },
          anthropic: { state: "missing" },
          gemini: { state: "missing" },
        },
        ollama: { state: "not-required" },
      }),
    );

    expect(container.textContent).toMatch(/sign in with google|google connection/i);
    expect(container.textContent).toMatch(/consent|permission/i);
  });
});
