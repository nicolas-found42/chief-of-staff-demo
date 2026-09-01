import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfirmedOwnerReference, OwnerOnboardingProposal } from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";

/**
 * Owner onboarding (issue #123): the preserved connected-Google identity
 * proposes the Workspace owner's canonical Person Profile, and only an
 * explicit owner action confirms it. The proposal never creates, enriches,
 * or confirms anything; the confirmed reference pins both the Profile ID and
 * the exact revision (spec #117, Implementation Decisions 5), and it is held
 * for one Google identity only — a changed or disconnected connection
 * invalidates it (ADR-0036: the identity is read once and held until the
 * connection changes, and invalidation is load-bearing).
 */
export class OwnerOnboarding {
  private readonly people: WorkspacePersonProfiles;
  private readonly stateFile: string;
  private readonly now: () => Date;
  /**
   * The connected Google identity, read once and held. The Shell refreshes it
   * on connection change; a held confirmation never outlives the identity it
   * was confirmed under.
   */
  private connectedEmail: string | null = null;

  constructor(deps: { people: WorkspacePersonProfiles; workspaceDir: string; now?: () => Date }) {
    this.people = deps.people;
    this.stateFile = join(deps.workspaceDir, "onboarding", "owner-confirmation.json");
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Shell-called: the connected Google account changed, so hold the new one.
   * Any held confirmation confirmed for a different identity — including no
   * identity at all, i.e. a disconnect — is voided here and stays voided
   * across restarts: reconnecting the same account later still requires an
   * explicit re-confirmation, so a stale reference can never outlive the
   * connection event that made it stale (ADR-0036).
   */
  setConnectedIdentity(email: string | null): void {
    const next = email?.trim().toLowerCase() ?? null;
    const changed = next !== this.connectedEmail;
    this.connectedEmail = next;
    if (changed) {
      const stored = this.read();
      if (stored && stored.confirmedForGoogleEmail !== next) this.write(null);
    }
  }

  /**
   * The email owner-identity-dependent outward workflows (Content Research's
   * owner digest, Meeting Brief delivery) may act on: the held connected
   * identity, and only while a confirmed owner Profile reference stands.
   * Without confirmation this is null — the typed owner-missing state those
   * workflows already treat as "cannot proceed", not an error.
   */
  outwardOwnerEmail(): string | null {
    return this.confirmed() ? this.connectedEmail : null;
  }

  /**
   * What onboarding shows the owner: the connected identity and the one
   * Profile whose stable identifier (exact email) already matches. A null
   * match is the create-and-confirm path, not an error.
   */
  proposal(): OwnerOnboardingProposal | null {
    if (!this.connectedEmail) return null;
    const matched = this.people
      .search({ query: this.connectedEmail })
      .find((profile) => profile.emails.includes(this.connectedEmail!));
    return {
      googleEmail: this.connectedEmail,
      matchedProfileId: matched?.id ?? null,
      matchedProfileRevision: matched?.revision ?? null,
    };
  }

  /**
   * The explicit owner action: select the proposed Profile, correct the
   * proposal by naming a different one, or create a Profile first and confirm
   * that. It pins the exact revision the Profile carries now; later Profile
   * revisions supersede it without silently re-pinning (consumers re-confirm
   * deliberately). Confirmation is only meaningful for the identity held at
   * the moment, so it refuses to run without one.
   */
  confirm(profileId: string): ConfirmedOwnerReference {
    if (!this.connectedEmail) {
      throw new OwnerOnboardingError(
        "no-connected-identity",
        "Connect a Google identity before confirming the owner Profile.",
      );
    }
    const profile = this.people.get(profileId);
    if (!profile) {
      throw new OwnerOnboardingError(
        "unknown-profile",
        `No Person Profile exists with id ${profileId}.`,
      );
    }
    const reference: ConfirmedOwnerReference = {
      profileId: profile.id,
      profileRevision: profile.revision,
      confirmedAt: this.now().toISOString(),
      confirmedForGoogleEmail: this.connectedEmail,
    };
    this.write(reference);
    return reference;
  }

  confirmed(): ConfirmedOwnerReference | null {
    const stored = this.read();
    if (!stored) return null;
    if (stored.confirmedForGoogleEmail !== this.connectedEmail) return null;
    return stored;
  }

  private read(): ConfirmedOwnerReference | null {
    if (!existsSync(this.stateFile)) return null;
    return JSON.parse(readFileSync(this.stateFile, "utf8")) as ConfirmedOwnerReference;
  }

  /** Null removes the file: a voided confirmation stays voided on disk. */
  private write(reference: ConfirmedOwnerReference | null): void {
    if (!reference) {
      if (existsSync(this.stateFile)) rmSync(this.stateFile);
      return;
    }
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, `${JSON.stringify(reference, null, 2)}\n`);
  }
}

/** Typed failure classification for onboarding actions, for API mapping. */
export class OwnerOnboardingError extends Error {
  constructor(
    public readonly code: "no-connected-identity" | "unknown-profile",
    message: string,
  ) {
    super(message);
  }
}
