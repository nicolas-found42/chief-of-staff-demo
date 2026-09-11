import { describe, expect, it } from "vitest";
import { RESPONSIBILITY_CLAIM_VALIDATOR_VERSION } from "@chief-of-staff-demo/shared";
import {
  buildResponsibilityClaim,
  claimTurns,
  type ClaimJudgement,
} from "../../../apps/server/src/modules/meeting-debrief/responsibility-claim";

/**
 * The deterministic half of the responsibility claim (issue #360, MWR-014):
 * reference validation over the turns the judgement cites, and the coherence
 * checks that turn a judgement its own evidence contradicts into an unresolved
 * claim rather than a supported one.
 */
const PARSE = (
  text: string,
): { text: string; speaker: string; timestamp: string | null } | null => {
  const match = /^\[(?<timestamp>[^\]]+)\]\s*(?<speaker>[^:]+):\s*(?<speech>.+)$/.exec(text.trim());
  if (!match?.groups) return null;
  return {
    text: match.groups.speech,
    speaker: match.groups.speaker,
    timestamp: match.groups.timestamp,
  };
};

const SOURCE = [
  "[00:01] Alice: I will fix the billing flow.",
  "[00:04] Bob: Alice, can you also update the docs?",
  "[00:05] Alice: Yes, I will update the docs today.",
  "[00:09] Bob: Great, thanks.",
  "[00:12] Alice: The docs update is done.",
].join("\n");

const TURNS = claimTurns(PARSE, SOURCE);
const RESOLVE = (reference: string) => {
  const index = Number(/^@turn:(\d+)$/.exec(reference)?.[1] ?? "0");
  return index >= 1 && index <= TURNS.length ? TURNS[index - 1] : null;
};

const BINDING = {
  transcriptId: "drive_fileA_r1",
  observedRevision: 1,
  checksum: "sha256:revision-1",
  contextChecksum: "sha256:context",
  validatedAt: "2026-09-04T09:00:00.000Z",
};

const performer = { name: "Alice", basis: "explicit" as const };

function build(judgement: Partial<ClaimJudgement>) {
  return buildResponsibilityClaim({
    obligation: "Fix the billing flow",
    judgement: {
      relationship: "self-commitment",
      statement: "@turn:1",
      assignment: null,
      acceptance: null,
      laterUpdates: [],
      unresolvedReasons: [],
      ...judgement,
    },
    performer,
    binding: BINDING,
    resolve: RESOLVE,
  }).claim;
}

describe("the source turns a claim can cite", () => {
  it("numbers only the spoken turns, in order", () => {
    expect(TURNS.map((turn) => [turn.index, turn.speaker, turn.quote])).toEqual([
      [1, "Alice", "I will fix the billing flow."],
      [2, "Bob", "Alice, can you also update the docs?"],
      [3, "Alice", "Yes, I will update the docs today."],
      [4, "Bob", "Great, thanks."],
      [5, "Alice", "The docs update is done."],
    ]);
  });
});

describe("building one claim", () => {
  it("records a supported self-commitment with its source occurrence", () => {
    const claim = build({});

    expect(claim.relationship).toBe("self-commitment");
    expect(claim.speaker).toBe("Alice");
    expect(claim.statement).toMatchObject({
      quote: "I will fix the billing flow.",
      speaker: "Alice",
      locator: "turn:1",
    });
    expect(claim.unresolvedReasons).toEqual([]);
    expect(claim.contract).toMatchObject({
      contractVersion: 1,
      validatorVersion: RESPONSIBILITY_CLAIM_VALIDATOR_VERSION,
      source: {
        transcriptId: "drive_fileA_r1",
        observedRevision: 1,
        checksum: "sha256:revision-1",
      },
    });
  });

  it("records a request the performer unambiguously accepted", () => {
    const claim = build({
      relationship: "accepted-request",
      statement: "@turn:2",
      assignment: "@turn:2",
      acceptance: "@turn:3",
    });

    expect(claim.relationship).toBe("accepted-request");
    expect(claim.assignment?.locator).toBe("turn:2");
    expect(claim.acceptance?.locator).toBe("turn:3");
    expect(claim.acceptance?.speaker).toBe("Alice");
    expect(claim.unresolvedReasons).toEqual([]);
  });

  it("turns an accepted request with no acceptance into an unresolved claim", () => {
    const claim = build({ relationship: "accepted-request", statement: "@turn:1" });

    expect(claim.relationship).toBe("unresolved");
    expect(claim.unresolvedReasons.join(" ")).toContain("never unambiguously accepted");
  });

  it("refuses an acceptance that is not the performer's own", () => {
    const claim = build({
      relationship: "accepted-request",
      statement: "@turn:2",
      assignment: "@turn:2",
      acceptance: "@turn:4",
    });

    expect(claim.relationship).toBe("unresolved");
    expect(claim.unresolvedReasons.join(" ")).toContain("not the performer");
  });

  it("refuses a self-commitment the named performer did not speak", () => {
    const claim = build({ statement: "@turn:4" });

    expect(claim.relationship).toBe("unresolved");
    expect(claim.unresolvedReasons.join(" ")).toContain("not a self-commitment");
  });

  it("records a citation that resolves to no source turn instead of dropping it", () => {
    const built = buildResponsibilityClaim({
      obligation: "Fix the billing flow",
      judgement: {
        relationship: "self-commitment",
        statement: "@turn:99",
        assignment: null,
        acceptance: null,
        laterUpdates: [],
        unresolvedReasons: [],
      },
      performer,
      binding: BINDING,
      resolve: RESOLVE,
    });

    expect(built.unresolved).toContain("the obligation's own turn could not be resolved: @turn:99");
    expect(built.claim.relationship).toBe("unresolved");
    expect(built.claim.unresolvedReasons.join(" ")).toContain("@turn:99");
    expect(built.claim.statement.quote).toBe("@turn:99");
  });

  it("keeps later completion, cancellation, reassignment and qualification as later updates", () => {
    const claim = build({
      laterUpdates: [
        { kind: "completion", turn: "@turn:5" },
        { kind: "qualification", turn: "@turn:4" },
      ],
    });

    expect(claim.laterUpdates.map((update) => update.kind)).toEqual([
      "completion",
      "qualification",
    ]);
    expect(claim.laterUpdates[0]?.occurrence.locator).toBe("turn:5");
    expect(claim.unresolvedReasons).toEqual([]);
  });

  it("refuses an unresolved relationship that does not say why", () => {
    const claim = build({ relationship: "unresolved" });

    expect(claim.unresolvedReasons.join(" ")).toContain("without saying why");
  });

  it("requires a sole explicit performer before anything can be supported", () => {
    const claim = buildResponsibilityClaim({
      obligation: "Fix the billing flow",
      judgement: {
        relationship: "self-commitment",
        statement: "@turn:1",
        assignment: null,
        acceptance: null,
        laterUpdates: [],
        unresolvedReasons: [],
      },
      performer: { name: null, basis: "unknown" },
      binding: BINDING,
      resolve: RESOLVE,
    }).claim;

    expect(claim.unresolvedReasons.join(" ")).toContain("no sole explicit performer");
  });
});
