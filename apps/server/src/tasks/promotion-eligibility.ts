import type { ActionItem, ResponsibilityClaim } from "@chief-of-staff-demo/shared";
import {
  RESPONSIBILITY_CLAIM_VALIDATOR_VERSION,
  ResponsibilityClaimSchema,
  actionItemProposal,
  currentReconciliation,
  latestProposalRevision,
} from "@chief-of-staff-demo/shared";

/**
 * Whether automation may answer for this Action Item, and why not when it may
 * not (issue #360, ADR-0083, spec #343 §3-§5).
 *
 * This is the gate the whole ticket exists for, so it is deliberately one
 * pure function over the record: no writes, no clock, no model, and no
 * confidence number. Every clause below is a case where a person's judgment —
 * or a fact the meeting never established — is the only defensible answer, and
 * an ineligible item is left exactly as Stage all would have left it.
 *
 * Two rules hold across all of it:
 *
 * - **The reservation decides, not the live policy.** Eligibility is read from
 *   what was recorded before the model ran, so enabling automation later never
 *   reopens an operation reserved while it was restricted or disabled.
 * - **Absence never authorizes.** A missing reservation, a missing claim, an
 *   unsupported contract version or a source binding that does not match the
 *   record itself all read as unknown, and unknown waits for review.
 */

/** What one gate decision says: whether, which rule, and the sentence a surface shows. */
export interface PromotionEligibility {
  eligible: boolean;
  /** Stable machine code — `eligible` when nothing declined it. */
  code: string;
  /** Why automation declined, in words the review surface shows; empty when eligible. */
  reason: string;
}

const ELIGIBLE: PromotionEligibility = { eligible: true, code: "eligible", reason: "" };

function declined(code: string, reason: string): PromotionEligibility {
  return { eligible: false, code, reason };
}

/**
 * The authorization facts are used twice: the ones recorded at reservation
 * authorize the operation, and the live ones have to still agree. A changed
 * prerequisite is review, never a silent new decision (#343 §6).
 */
/**
 * The facts a record stores. The preference is a stored string rather than
 * today's enum: a historical reservation must stay readable even if the
 * policies this build offers change, and an unrecognized one authorizes
 * nothing.
 */
export interface StoredAuthorizationFacts {
  released: boolean;
  enabledAt: string | null;
  preference: string;
  basis: string;
}

function authorizes(
  facts: { released: boolean; enabledAt: string | null; preference: string } | null,
): boolean {
  return (
    facts !== null &&
    facts.released &&
    facts.enabledAt !== null &&
    facts.preference === "auto-create-mine"
  );
}

/**
 * One claim's reference checks, re-run at the commit boundary. Grounding was
 * proven against the source when the claim was made; what can still be checked
 * here is that the claim is structurally sound, was checked by this build's
 * validator, and names the same source revision the record's own observation
 * recorded. A mismatch is not evidence about the obligation, so it waits.
 */
function claimRefusal(item: ActionItem, claim: ResponsibilityClaim | undefined): string | null {
  if (!claim) return "no supported responsibility claim was recorded for this proposal";
  const parsed = ResponsibilityClaimSchema.safeParse(claim);
  if (!parsed.success) return "the recorded responsibility claim is not structurally sound";
  if (claim.contract.validatorVersion !== RESPONSIBILITY_CLAIM_VALIDATOR_VERSION)
    return `the responsibility claim was checked by validator ${claim.contract.validatorVersion}, which this build does not trust`;
  const observation = item.observations.find(
    (entry) => entry.proposalRevision === item.selectedRevision,
  );
  if (!observation)
    return "this proposal has no recorded source observation to check the claim against";
  if (claim.contract.source.transcriptId !== observation.transcriptId)
    return "the responsibility claim names a different Transcript than this proposal was extracted from";
  if (claim.contract.source.checksum !== observation.transcriptChecksum)
    return "the responsibility claim was checked against a different source revision than this proposal records";
  if (claim.contract.source.observedRevision !== observation.transcriptObservedRevision)
    return "the responsibility claim was checked against a different source revision than this proposal records";
  if (observation.transcriptChecksum === null)
    return "this proposal does not record which source revision it read, so its claim cannot be verified";
  return null;
}

/** The relationship reasons, each naming what the source actually established. */
function relationshipRefusal(claim: ResponsibilityClaim): string | null {
  const performer = claim.performer.name;
  if (claim.performer.basis !== "explicit")
    return "the performer's responsibility is not explicit in the source";
  if (performer === null) return "the source does not name a sole performer for this obligation";
  if (claim.unresolvedReasons.length > 0)
    return `the responsibility claim is unresolved: ${claim.unresolvedReasons.join("; ")}`;
  if (claim.relationship === "self-commitment") {
    if (claim.speaker !== null && claim.speaker !== performer)
      return "the commitment's speaker is not the performer the claim names";
    return null;
  }
  if (claim.relationship === "accepted-request") {
    if (claim.assignment === null)
      return "an accepted request has no recorded request or assignment turn";
    if (claim.acceptance === null)
      return "the request was never unambiguously accepted for this obligation";
    if (claim.acceptance.speaker !== null && claim.acceptance.speaker !== performer)
      return "the acceptance is not the performer's own";
    return null;
  }
  return `the source establishes a ${claim.relationship.replace("-", " ")} relationship, which is not the performer's own commitment or acceptance`;
}

/**
 * The whole decision. `live` is the authorization in force at this commit;
 * `duplicate` is answered by the caller, because only the Tasks store can
 * answer it.
 */
export function promotionEligibility(
  item: ActionItem,
  live: StoredAuthorizationFacts | null,
  duplicate: boolean,
): PromotionEligibility {
  if (item.state !== "pending")
    return declined(
      "already-decided",
      "This proposal already carries the owner's decision; automation does not revisit decisions.",
    );
  if (item.reconciledInto !== null)
    return declined(
      "not-promotable",
      "That Action Item records evidence about earlier work. Attach it there instead of creating a Task.",
    );
  if (currentReconciliation(item)?.disposition === "unresolved")
    return declined(
      "not-promotable",
      "That Action Item may repeat work this Workspace already holds. Resolve the relationship before creating a Task.",
    );
  if (item.reviewedThrough < latestProposalRevision(item))
    return declined(
      "not-promotable",
      "That proposal was corrected after it was reviewed. Select the revision to promote before creating a Task.",
    );
  if (item.proposalRevisions.every((entry) => entry.origin.kind === "legacy-import"))
    return declined(
      "legacy-import",
      "This proposal came from an older Workspace and has no checked extraction behind it; it waits for review.",
    );
  if (item.source.reviewOnly === true)
    return declined(
      "review-only-publication",
      "The Debrief this proposal came from was published incomplete, so its proposals stay review-only.",
    );
  const reservation = item.source.promotion;
  if (!reservation)
    return declined(
      "reservation-missing",
      "Nothing recorded whether this extraction could authorize automation, so it waits for review.",
    );
  if (reservation.claim !== "first")
    return declined(
      "reservation-not-first",
      `This extraction was reserved as ${reservation.claim} (${reservation.basis}), so automation never opens it.`,
    );
  if (!authorizes(reservation.authorization))
    return declined(
      "reservation-unauthorized",
      `Automatic promotion was not authorized when this extraction was reserved (${reservation.authorization?.basis ?? "no authorization recorded"}).`,
    );
  if (!authorizes(live))
    return declined(
      "authorization-withheld",
      `Automatic promotion is not authorized now (${live?.basis ?? "no authorization recorded"}).`,
    );
  if (live?.enabledAt !== reservation.authorization?.enabledAt)
    return declined(
      "authorization-changed",
      "Automatic promotion was enabled again after this extraction was reserved; a new authorization applies to future extractions, not this one.",
    );
  if (item.extractionRevision !== 1)
    return declined(
      "later-extraction",
      "This proposal came from a regeneration, and regeneration always stages for review.",
    );
  if (actionItemProposal(item).responsiblePerson?.kind !== "owner")
    return declined(
      "not-owner",
      "This commitment is not confidently the confirmed owner's, so automation never writes it into their list.",
    );
  const claim = item.responsibilityClaim;
  const claimProblem = claimRefusal(item, claim);
  if (claimProblem)
    return declined(
      "claim-unsupported",
      `Automatic promotion needs a supported responsibility claim: ${claimProblem}.`,
    );
  const relationshipProblem = relationshipRefusal(claim!);
  if (relationshipProblem)
    return declined(
      "claim-unsupported",
      `Automatic promotion declined this proposal: ${relationshipProblem}.`,
    );
  if (claim!.laterUpdates.length > 0)
    return declined(
      "later-update",
      `A later turn changed this obligation (${claim!.laterUpdates
        .map((update) => update.kind)
        .join(", ")}), so it waits for review.`,
    );
  if (duplicate)
    return declined(
      "possible-duplicate",
      "An open Task already looks like this one, so automation declines instead of creating a duplicate.",
    );
  return ELIGIBLE;
}
