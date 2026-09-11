import type {
  ResponsibilityClaim,
  ResponsibilityLaterUpdate,
  ResponsibilityLaterUpdateKind,
  ResponsibilityOccurrence,
  ResponsibilityRelationship,
} from "@chief-of-staff-demo/shared";
import {
  RESPONSIBILITY_CLAIM_VALIDATOR_VERSION,
  RESPONSIBILITY_CLAIM_VERSION,
} from "@chief-of-staff-demo/shared";

/**
 * The structured exact-obligation claim (issue #360, MWR-013/014; ADR-0083,
 * spec #343 §1-§2).
 *
 * The model judges the relationship — that is the semantic half, and it is the
 * only half a model can do. Everything in this file is the deterministic half:
 * each cited turn has to resolve to one real source turn, the speaker comes
 * from the source rather than from the model, the performer comes from the
 * already-verified responsibility binding rather than from a fresh guess, and
 * a relationship whose own evidence contradicts it becomes `unresolved`
 * instead of a supported claim.
 *
 * Grounding is deliberately not treated as meaning: finding the quotation
 * proves the words were said, never that they mean what the model says they
 * mean. That is why a claim can be structurally perfect and still authorize
 * nothing — the promotion gate reads the relationship too, and the release
 * evidence audit is what decides whether the judgements are any good.
 */
export interface ClaimTurn {
  /** 1-based index among the spoken turns of this source revision. */
  index: number;
  quote: string;
  /** The source's own label; anonymous labels such as `Speaker 2` are labels. */
  speaker: string | null;
  timestamp: string | null;
}

/** One request, acceptance or later change the model cited, by source reference. */
export interface ClaimJudgement {
  relationship: ResponsibilityRelationship;
  /** The turn that states the obligation: a displayed source id or its quotation. */
  statement: string;
  assignment: string | null;
  acceptance: string | null;
  laterUpdates: Array<{ kind: ResponsibilityLaterUpdateKind; turn: string }>;
  unresolvedReasons: string[];
}

/** The contract facts the claim is bound to; the Module supplies them. */
export interface ClaimContractBinding {
  transcriptId: string;
  observedRevision: number | null;
  checksum: string | null;
  /** The frozen extraction context the claim was checked under. */
  contextChecksum: string;
  validatedAt: string;
}

/** A citation that resolves to no source turn is recorded, never silently dropped. */
export interface ClaimBuild {
  claim: ResponsibilityClaim;
  /** References that did not resolve; non-empty means the claim is unresolved. */
  unresolved: string[];
}

const ANONYMOUS_SPEAKER = /^speaker\s+\d+$/i;

/**
 * The spoken turns of one source revision, in order. A line that is not a
 * transcript turn (a blank separator, a heading) is not a turn and cannot be
 * cited as one.
 */
export function claimTurns(
  parse: (text: string) => { text: string; speaker: string; timestamp: string | null } | null,
  normalizedText: string,
): ClaimTurn[] {
  const turns: ClaimTurn[] = [];
  for (const line of normalizedText.split("\n")) {
    const turn = parse(line);
    if (!turn || !turn.text.trim()) continue;
    turns.push({
      index: turns.length + 1,
      quote: turn.text,
      speaker: turn.speaker,
      timestamp: turn.timestamp,
    });
  }
  return turns;
}

function occurrence(turn: ClaimTurn): ResponsibilityOccurrence {
  return {
    quote: turn.quote,
    speaker: turn.speaker,
    timestamp: turn.timestamp,
    locator: `turn:${turn.index}`,
  };
}

/** One cited turn, resolved to the source turn it names, or null. */
export type TurnResolver = (reference: string) => ClaimTurn | null;

/**
 * Build one claim from a judgement. The result always exists: a judgement the
 * evidence contradicts becomes an `unresolved` claim that carries the reasons,
 * because a claim that disappears would leave the owner with nothing to read
 * and automation with nothing to decline.
 */
export function buildResponsibilityClaim(input: {
  obligation: string;
  judgement: ClaimJudgement;
  performer: { name: string | null; basis: "explicit" | "inferred" | "unknown" };
  binding: ClaimContractBinding;
  resolve: TurnResolver;
}): ClaimBuild {
  const unresolved: string[] = [];
  const problem = (reason: string): null => {
    unresolved.push(reason);
    return null;
  };
  const statement = input.resolve(input.judgement.statement);
  if (!statement)
    problem(`the obligation's own turn could not be resolved: ${input.judgement.statement}`);
  const statementTurn = statement ?? input.resolve(input.judgement.assignment ?? "");
  const assignment = input.judgement.assignment
    ? (input.resolve(input.judgement.assignment) ??
      problem(`the assignment turn could not be resolved: ${input.judgement.assignment}`))
    : null;
  const acceptance = input.judgement.acceptance
    ? (input.resolve(input.judgement.acceptance) ??
      problem(`the acceptance turn could not be resolved: ${input.judgement.acceptance}`))
    : null;
  const laterUpdates: ResponsibilityLaterUpdate[] = [];
  for (const update of input.judgement.laterUpdates) {
    const turn = input.resolve(update.turn);
    if (!turn) problem(`a ${update.kind} turn could not be resolved: ${update.turn}`);
    else laterUpdates.push({ kind: update.kind, occurrence: occurrence(turn) });
  }
  const performer = input.performer;
  if (performer.name === null)
    problem(`the obligation has no sole explicit performer (basis ${performer.basis})`);
  let relationship = input.judgement.relationship;
  if (statementTurn === null) {
    problem("no source turn establishes this obligation, so nothing supports its responsibility");
    if (relationship !== "unresolved") {
      relationship = "unresolved";
      problem("the obligation's own turn did not resolve, so no relationship can be supported");
    }
  }
  const speaker = statementTurn?.speaker ?? null;
  const anonymousSpeaker = speaker !== null && ANONYMOUS_SPEAKER.test(speaker);
  if (relationship === "self-commitment") {
    /* The performer's own commitment: the statement has to be theirs. An
       anonymous label is allowed — the Catalog's identity review is what may
       resolve it later — but a *named* speaker who is somebody else
       contradicts the judgement outright. */
    if (
      performer.name !== null &&
      speaker !== null &&
      !anonymousSpeaker &&
      speaker !== performer.name
    ) {
      relationship = "unresolved";
      problem(
        `the statement is ${speaker}'s, not the named performer ${performer.name}'s, so this is not a self-commitment`,
      );
    }
    if (input.judgement.acceptance !== null)
      problem("a self-commitment needs no acceptance turn; the judgement supplied one");
  } else if (relationship === "accepted-request") {
    if (assignment === null) {
      relationship = "unresolved";
      problem("an accepted request has no resolvable request or assignment turn");
    }
    if (acceptance === null) {
      relationship = "unresolved";
      problem("the request was never unambiguously accepted for this obligation");
    } else if (
      performer.name !== null &&
      acceptance.speaker !== null &&
      !ANONYMOUS_SPEAKER.test(acceptance.speaker) &&
      acceptance.speaker !== performer.name
    ) {
      relationship = "unresolved";
      problem(`the acceptance is ${acceptance.speaker}'s, not the performer ${performer.name}'s`);
    }
  } else if (relationship === "request") {
    if (assignment === null) problem("a request has no resolvable request or assignment turn");
    if (acceptance !== null) {
      relationship = "unresolved";
      problem("the judgement recorded an acceptance for a request it calls unanswered");
    }
  } else if (relationship === "shared") {
    if (performer.basis === "explicit" && performer.name !== null) {
      relationship = "unresolved";
      problem("shared work cannot carry one sole explicit performer");
    }
  } else if (relationship === "unresolved" && input.judgement.unresolvedReasons.length === 0) {
    problem("the relationship is unresolved without saying why");
  }
  const reasons = [...new Set([...input.judgement.unresolvedReasons, ...unresolved])];
  return {
    claim: {
      version: RESPONSIBILITY_CLAIM_VERSION,
      obligation: input.obligation,
      speaker,
      statement: statementTurn
        ? occurrence(statementTurn)
        : {
            quote: input.judgement.statement,
            speaker: null,
            timestamp: null,
            locator: "unresolved",
          },
      performer,
      relationship,
      assignment: assignment ? occurrence(assignment) : null,
      acceptance: acceptance ? occurrence(acceptance) : null,
      laterUpdates,
      unresolvedReasons: reasons,
      contract: {
        contractVersion: RESPONSIBILITY_CLAIM_VERSION,
        validatorVersion: RESPONSIBILITY_CLAIM_VALIDATOR_VERSION,
        source: {
          transcriptId: input.binding.transcriptId,
          observedRevision: input.binding.observedRevision,
          checksum: input.binding.checksum,
        },
        contextChecksum: input.binding.contextChecksum,
        validatedAt: input.binding.validatedAt,
      },
    },
    unresolved,
  };
}
