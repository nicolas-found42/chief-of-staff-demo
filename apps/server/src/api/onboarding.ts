import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AppConfig,
  GoogleStatus,
  InstallationProviderId,
  InstallationStatus,
} from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../config.js";
import type { Runs } from "../runs.js";
import { readPublishedDebrief } from "../modules/meeting-debrief/publication.js";
import type { WorkspaceBrandProfileStore } from "../brand-profile/store.js";
import { OwnerOnboarding, OwnerOnboardingError } from "../onboarding/owner.js";

export interface OnboardingApiContext {
  /** The owner-onboarding interface; routes stay thin over it. */
  onboarding: OwnerOnboarding;
}

/**
 * The onboarding product namespace (issue #123): the connected Google
 * identity's owner-Profile proposal and the explicit confirmation that pins
 * it. Every route returns durable resource state or a typed failure
 * classification; no credential material passes through any of them.
 */
export function registerOnboardingApi(app: FastifyInstance, ctx: OnboardingApiContext): void {
  const onboarding = ctx.onboarding;

  app.get("/api/onboarding/owner", async () => {
    return {
      proposal: onboarding.proposal(),
      confirmed: onboarding.confirmed(),
    };
  });

  /* POST, not GET: it writes the durable owner reference. */
  app.post("/api/onboarding/owner/confirm", async (request: FastifyRequest, reply) => {
    const body = (request.body ?? {}) as { profileId?: unknown };
    if (typeof body.profileId !== "string" || !body.profileId.trim()) {
      reply.code(400).send({ error: "invalid-request" });
      return;
    }
    try {
      const confirmed = onboarding.confirm(body.profileId.trim());
      return confirmed;
    } catch (error) {
      if (error instanceof OwnerOnboardingError) {
        reply.code(error.code === "unknown-profile" ? 404 : 409).send({ error: error.code });
        return;
      }
      throw error;
    }
  });
}

/* ── Post-migration onboarding status (issues #144, #478) ───────────────────
   The one aggregator behind GET /api/migration/status. Every step's `done` is
   a genuine read of the real store the step configures — never a flag — so
   the onboarding checklist follows the Workspace instead of the ceremony. */

export type OnboardingGoal = "general" | "meetings";

type OnboardingStepId =
  | "provider-enablement"
  | "owner-profile"
  | "brand-voice"
  | "internal-domains"
  | "transcript-polling"
  | "sheets-destinations"
  | "workflow-bundles"
  | "meeting-provider"
  | "meeting-google"
  | "meeting-folder"
  | "meeting-polling"
  | "meeting-consent";

interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  done: boolean;
  href: string;
}

interface OnboardingOtherSetup {
  complete: boolean;
  steps: OnboardingStep[];
}

export interface OnboardingStatus {
  goal: OnboardingGoal;
  complete: boolean;
  steps: OnboardingStep[];
  otherSetup: OnboardingOtherSetup;
  guidedSetup: {
    stages: {
      id: string;
      label: string;
      state: "confirmed" | "to-do" | "operator-check" | "waiting" | "unavailable";
      href: string | null;
    }[];
  };
}

export interface OnboardingStatusDeps {
  configStore: ConfigStore;
  /** Narrowed to the one read the status makes; no credential surface. */
  googleConnection: { state(): Promise<Pick<GoogleStatus, "state">> };
  ownerOnboarding: OwnerOnboarding;
  brandProfiles: WorkspaceBrandProfileStore;
  /** Explicit Transcript Catalog consent, not a transcript count or config flag. */
  transcriptCatalog?: { status(): { consent: { folderId: string } | null } };
  /** Installation status is deliberately status-only; no value crosses this seam. */
  installationStatus: () => InstallationStatus;
  /** A finished Debrief is the first result; a Transcript alone is not. */
  runs?: Pick<Runs, "list" | "open">;
}

function providerIsReady(
  config: AppConfig,
  installationStatus: OnboardingStatusDeps["installationStatus"],
): boolean {
  if (config.provider === "mock" || config.provider === "ollama") return true;
  return (
    installationStatus().providerKeys[config.provider as InstallationProviderId].state ===
    "configured"
  );
}

function generalSteps(
  config: AppConfig,
  googleState: GoogleStatus["state"],
  ownerConfirmed: unknown,
  brandVoice: unknown,
  providerReady: boolean,
): OnboardingStep[] {
  const briefConfig = config.modules["meeting-brief-generator"];
  const folderSelected = config.drive.folderId.length > 0;
  const transcriptStep: OnboardingStep = folderSelected
    ? {
        id: "transcript-polling",
        label: config.drive.enabled ? "Transcript polling enabled" : "Enable transcript polling",
        done: config.drive.enabled,
        href: "/settings#drive-polling",
      }
    : {
        id: "transcript-polling",
        label: "Choose the Transcripts folder",
        done: false,
        href: "/settings#drive-folder",
      };
  return [
    {
      id: "provider-enablement",
      label: "Enable providers",
      done: providerReady && googleState === "connected",
      href: "/onboarding?goal=meetings",
    },
    {
      id: "owner-profile",
      label: "Confirm the owner Profile",
      done: ownerConfirmed !== null,
      href: "/settings#group-owner-onboarding",
    },
    {
      id: "brand-voice",
      label: "Create Brand Voice",
      done: brandVoice !== null,
      href: "/content-scout",
    },
    {
      id: "internal-domains",
      label: "Select Internal Domains",
      done: briefConfig.internalDomains.length > 0,
      href: "/settings#group-meeting-brief-domains",
    },
    transcriptStep,
    {
      id: "sheets-destinations",
      label: "Configure clean Sheets destinations",
      done: config.modules["youtube-trends"].spreadsheetId.length > 0,
      href: "/settings#section-youtube",
    },
    {
      id: "workflow-bundles",
      label: "Configure workflow bundles",
      done: Object.keys(briefConfig.providerPolicy).length > 0,
      href: "/settings#group-meeting-brief-bundles",
    },
  ];
}

function meetingSteps(
  config: AppConfig,
  googleState: GoogleStatus["state"],
  providerReady: boolean,
  consentFolderId: string | null,
): OnboardingStep[] {
  const folderId = config.drive.folderId;
  return [
    {
      id: "meeting-provider",
      label: "Configure the model extraction provider",
      done: providerReady,
      href: "/settings#api-key",
    },
    {
      id: "meeting-google",
      label: "Connect Google",
      done: googleState === "connected",
      href: "/settings#group-google",
    },
    {
      id: "meeting-folder",
      label: "Choose the transcript Drive folder",
      done: folderId.length > 0,
      href: "/settings#drive-folder",
    },
    {
      id: "meeting-polling",
      label: "Enable Drive polling",
      done: config.drive.enabled,
      href: "/settings#drive-polling",
    },
    {
      id: "meeting-consent",
      label: "Allow the app to read and process the selected folder",
      done: consentFolderId !== null && consentFolderId === folderId,
      href: "/settings#transcript-consent",
    },
  ];
}

export async function buildOnboardingStatus(
  deps: OnboardingStatusDeps,
  goal: OnboardingGoal = "general",
): Promise<OnboardingStatus> {
  const config = deps.configStore.get();
  const [google, ownerConfirmed, brandVoice] = await Promise.all([
    deps.googleConnection.state(),
    Promise.resolve(deps.ownerOnboarding.confirmed()),
    Promise.resolve(deps.brandProfiles.current()),
  ]);
  const providerReady = providerIsReady(config, deps.installationStatus);
  const general = generalSteps(config, google.state, ownerConfirmed, brandVoice, providerReady);
  const consent = deps.transcriptCatalog?.status().consent?.folderId ?? null;
  const steps =
    goal === "meetings" ? meetingSteps(config, google.state, providerReady, consent) : general;
  const installation = deps.installationStatus();
  const googleClientReady = installation.googleClient.state === "configured";
  const modelReady =
    config.provider === "ollama" ||
    (config.provider !== "mock" &&
      installation.providerKeys[config.provider as InstallationProviderId].state === "configured");
  const meetingReady = meetingSteps(config, google.state, providerReady, consent).every(
    (step) => step.done,
  );
  let firstDebriefReady = false;
  let firstDebriefUnavailable = false;
  try {
    firstDebriefReady =
      deps.runs?.list({ module: "meeting-debrief" }).runs.some((summary) => {
        if (summary.status !== "done") return false;
        const run = deps.runs?.open(summary.id);
        if (!run) return false;
        const published = readPublishedDebrief({ read: (name) => run.readArtifact(name) });
        return (
          published !== null &&
          (published.legacy || published.verified) &&
          published.availability?.completeness !== "incomplete"
        );
      }) ?? false;
  } catch {
    firstDebriefUnavailable = true;
  }
  const operatorStage = (id: string, label: string) => ({
    id,
    label,
    state: "operator-check" as const,
    href: null,
  });
  return {
    goal,
    complete: steps.every((step) => step.done),
    steps,
    otherSetup: {
      complete: general.every((step) => step.done),
      steps: general,
    },
    guidedSetup: {
      stages: [
        operatorStage("preflight", "Preflight and paths"),
        operatorStage("backup", "Required Workspace backup when migrating"),
        operatorStage("migration-check", "Check migration and confirm"),
        {
          id: "google-client",
          label: "Installation Google client",
          state: googleClientReady ? "confirmed" : "to-do",
          href: "/settings#api-key",
        },
        {
          id: "provider-key",
          label: "Installation provider key or Ollama",
          state: modelReady ? "confirmed" : "to-do",
          href: "/settings#api-key",
        },
        operatorStage("migration-apply", "Apply migration and verify destination"),
        {
          id: "restart",
          label: "Restart and verify installation",
          state: googleClientReady && modelReady ? "confirmed" : "to-do",
          href: "/settings#api-key",
        },
        {
          id: "owner-consent",
          label: "Owner Google consent",
          state: google.state === "connected" ? "confirmed" : "to-do",
          href: "/settings#group-google",
        },
        {
          id: "intake",
          label: "Provider, model, and Transcript Intake",
          state: meetingReady ? "confirmed" : "to-do",
          href: "/onboarding?goal=meetings",
        },
        {
          id: "first-result",
          label: "Verify the first Debrief",
          state: firstDebriefReady
            ? "confirmed"
            : firstDebriefUnavailable
              ? "unavailable"
              : "waiting",
          href: "/meetings",
        },
      ],
    },
  };
}
