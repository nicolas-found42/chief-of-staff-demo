import { randomUUID } from "node:crypto";
import type {
  ActionItemPolicy,
  AutomaticPromotionAuthorization,
  AutomaticPromotionAuthorizationFacts,
  AutomaticPromotionStatus,
} from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../config.js";

/**
 * The authorization automatic promotion is reserved under (issue #360,
 * ADR-0083, spec #343 §7).
 *
 * Three facts decide it, and they are deliberately three:
 *
 * - the **release restriction** — a recorded release, standing on retained
 *   evidence, that code tests cannot lift on their own;
 * - the owner's **explicit enablement**, recorded *after* that release, so a
 *   preference saved earlier is never resumed by the release itself;
 * - the owner's **Action Item Policy preference**, which is what they asked
 *   for but never by itself permission.
 *
 * An enablement that predates the release conveys nothing, and the record says
 * so. There is no path here that reads a saved preference as authorization,
 * because the whole point of the restriction is that a preference saved while
 * it held was never an answer to the question the release gate asks.
 *
 * The state is read when an operation is reserved, never when one is
 * committed, so enablement applies only to future first extractions: an
 * operation reserved before it carries `review-only` for good, and nothing
 * re-reads the live state to reopen it.
 */
export interface PromotionAuthorizationDeps {
  configStore: ConfigStore;
  now?: () => Date;
}

/**
 * Whether facts authorize automatic promotion. The stored form names the
 * preference as a string, so a reservation recorded under a policy this build
 * no longer offers authorizes nothing.
 */
export function authorizationAuthorizes(
  facts: { released: boolean; enabledAt: string | null; preference: string } | null,
): boolean {
  return (
    facts !== null &&
    facts.released &&
    facts.enabledAt !== null &&
    facts.preference === "auto-create-mine"
  );
}

/** What one recorded release stands on: identified retained evidence, never its content. */
export interface PromotionReleaseEvidence {
  /** Where the retained release evidence lives; an operator's own reference. */
  reference: string;
  /** sha256 of the retained evidence, so the release names exact bytes. */
  checksum: string;
}

export class WorkspacePromotionAuthorization {
  private readonly configStore: ConfigStore;
  private readonly now: () => Date;

  constructor(deps: PromotionAuthorizationDeps) {
    this.configStore = deps.configStore;
    this.now = deps.now ?? (() => new Date());
  }

  /** The stored state; a config written before this existed reads as restricted. */
  read(): AutomaticPromotionAuthorization {
    return this.configStore.get().tasks.promotion;
  }

  /**
   * The authorization facts in force right now, for the policy preference the
   * owner has. Enablement recorded before the release is reported as none: the
   * release makes enablement *available*, it does not resume a saved choice.
   */
  facts(preference: ActionItemPolicy): AutomaticPromotionAuthorizationFacts {
    const state = this.read();
    const last = state.decisions[state.decisions.length - 1] ?? null;
    if (state.release.state !== "released")
      return {
        released: false,
        enabledAt: null,
        preference,
        basis: `release-restriction:${state.release.basis}`,
      };
    if (last?.kind !== "enable")
      return {
        released: true,
        enabledAt: null,
        preference,
        basis: last ? `disabled-at:${last.at}` : "not-enabled-since-release",
      };
    if (last.at < state.release.releasedAt)
      return {
        released: true,
        enabledAt: null,
        preference,
        basis: `enablement-predates-release:${last.at}`,
      };
    return {
      released: true,
      enabledAt: last.at,
      preference,
      basis: `enabled-at:${last.at}`,
    };
  }

  /**
   * Whether these reserved facts authorize automatic promotion. Only the facts
   * recorded at reservation are consulted: the live state is compared against
   * them at the commit boundary rather than consulted in their place.
   */
  authorizes(facts: AutomaticPromotionAuthorizationFacts | null): boolean {
    return authorizationAuthorizes(facts);
  }

  /**
   * The compact public projection of the authorization facts. Release
   * evidence and the decision timestamp remain internal; the browser learns
   * whether the saved preference is effective and what it can do next.
   */
  status(preference: ActionItemPolicy): AutomaticPromotionStatus {
    const facts = this.facts(preference);
    const effective = this.authorizes(facts);
    if (!facts.released) {
      return {
        effective: false,
        state: "unavailable",
        message:
          preference === "auto-create-mine"
            ? "Your preference is saved, but automatic creation is unavailable in this release and is not active. If a later release makes it available, you must explicitly enable it again."
            : "Automatic creation is unavailable in this release. Stage all remains active.",
        nextAction: null,
      };
    }
    if (effective) {
      return {
        effective: true,
        state: "active",
        message: "Automatic creation is active for future eligible first extractions.",
        nextAction: "disable",
      };
    }
    if (facts.enabledAt === null) {
      return {
        effective: false,
        state: "available",
        message:
          preference === "auto-create-mine"
            ? "Automatic creation is available in this release, but it is not active. Enable it when you are ready."
            : "Automatic creation is available in this release, but Stage all keeps it inactive. Choose Automatically create my Tasks when you are ready.",
        nextAction: "enable",
      };
    }
    return {
      effective: false,
      state: "available",
      message: "Stage all keeps automatic creation inactive.",
      nextAction: "disable",
    };
  }

  /**
   * Record the release the dedicated fixtures and the live-output audit
   * produced. The evidence is identified, never uploaded: the Workspace keeps
   * the operator's reference and the checksum of the bytes it stood on, and
   * one evidence record cannot be replaced by another.
   */
  recordRelease(evidence: PromotionReleaseEvidence): AutomaticPromotionAuthorization {
    const state = this.read();
    if (state.release.state === "released") {
      if (
        state.release.evidence.reference !== evidence.reference ||
        state.release.evidence.checksum !== evidence.checksum
      )
        throw new PromotionAuthorizationError(
          "promotion-already-released",
          "Automatic promotion has already been released; a different evidence record cannot replace it.",
        );
      return state;
    }
    const next: AutomaticPromotionAuthorization = {
      version: 1,
      release: {
        state: "released",
        basis: `release-evidence:${evidence.reference}`,
        since: state.release.since,
        releasedAt: this.now().toISOString(),
        evidence: { reference: evidence.reference, checksum: evidence.checksum },
      },
      decisions: state.decisions,
    };
    this.configStore.setPromotionAuthorization(next);
    return next;
  }

  /**
   * The owner's explicit enablement, recorded as its own act after the
   * release. Refused while the restriction stands: the gate makes enablement
   * available, it does not anticipate it.
   */
  enable(): AutomaticPromotionAuthorization {
    const state = this.read();
    if (state.release.state !== "released")
      throw new PromotionAuthorizationError(
        "promotion-restricted",
        `Automatic promotion is restricted in this release (${state.release.basis}); explicit enablement is not available yet.`,
      );
    const last = state.decisions[state.decisions.length - 1] ?? null;
    if (last?.kind === "enable") return state;
    const next: AutomaticPromotionAuthorization = {
      ...state,
      decisions: [
        ...state.decisions,
        { id: `promotion_${randomUUID()}`, kind: "enable", at: this.now().toISOString() },
      ],
    };
    this.configStore.setPromotionAuthorization(next);
    return next;
  }

  /**
   * Turn automatic promotion off. Idempotent, and the recorded history keeps
   * both acts, so a later enablement is a new authorization rather than a
   * resumed one — and only operations reserved after it are eligible.
   */
  disable(): AutomaticPromotionAuthorization {
    const state = this.read();
    const last = state.decisions[state.decisions.length - 1] ?? null;
    if (last?.kind !== "enable") return state;
    const next: AutomaticPromotionAuthorization = {
      ...state,
      decisions: [
        ...state.decisions,
        { id: `promotion_${randomUUID()}`, kind: "disable", at: this.now().toISOString() },
      ],
    };
    this.configStore.setPromotionAuthorization(next);
    return next;
  }
}

/** A refused authorization command. Stable code, message a surface can show. */
export class PromotionAuthorizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromotionAuthorizationError";
  }
}
