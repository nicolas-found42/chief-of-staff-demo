import type { MeetingHandoff } from "@chief-of-staff-demo/shared";

export function operationalHandoff(overrides: Partial<MeetingHandoff> = {}): MeetingHandoff {
  return {
    version: 2,
    commitment: "explicit",
    purpose: { text: "Let the team review the rollout", provenance: "suggested", sources: [] },
    responsibility: {
      names: ["Alice"],
      basis: "explicit",
      reason: "Alice committed to sharing it",
    },
    completionCriteria: [
      { text: "The team can read the plan", provenance: "suggested", sources: [] },
    ],
    requiredInputs: [],
    missingInputs: [],
    dependencies: [],
    timing: {
      kind: "deadline" as const,
      stated: "tomorrow",
      referenceDate: "2026-09-09",
      reasoning: "Relative to the trusted meeting date",
    },
    evidence: [
      { quote: "I will share the plan tomorrow", speaker: "Invented speaker", timestamp: "99:99" },
    ],
    statusReasoning: "No later completion was reported",
    ...overrides,
  };
}

export function checkedCandidateFacts(action: {
  title: string;
  dueDate?: string | null;
  handoff: unknown;
}) {
  const { commitment, responsibility, timing, evidence, statusReasoning } =
    action.handoff as MeetingHandoff;
  return {
    title: action.title,
    dueDate: action.dueDate ?? null,
    commitment,
    responsibility,
    timing,
    evidence,
    statusReasoning,
  };
}

export function sourceStatusFixture(
  request: import("../../../apps/server/src/llm/providers").CompletionRequest,
) {
  const rows = JSON.parse(
    request.user.split("<untrusted-candidates>\n")[1].split("\n</untrusted-candidates>")[0],
  ) as { id: string; quote: string }[];
  return {
    dispositions: rows.map((row) => ({
      candidateId: row.id,
      disposition: "retained",
      nextStep: "Perform the quoted commitment",
      reason: "Fixture commitment awaits verification",
      evidence: [row.quote],
    })),
  };
}

export function responsibilityFixture(
  request: import("../../../apps/server/src/llm/providers").CompletionRequest,
) {
  const rows = JSON.parse(
    request.user.split("<checked-actions>\n")[1].split("\n</checked-actions>")[0],
  ) as {
    candidateId: string;
    facts: {
      responsibility: MeetingHandoff["responsibility"];
      evidence: MeetingHandoff["evidence"];
    };
  }[];
  return {
    responsibilities: rows.map((row) => {
      const evidence = row.facts.evidence;
      const promises = evidence.filter(
        (quote) => /\bI (?:will|shall|promise|am going to)\b/i.test(quote.quote) && quote.speaker,
      );
      const speakers = [...new Set(promises.map((quote) => quote.speaker!))];
      const responsibility =
        speakers.length === 1
          ? { names: speakers, basis: "explicit", reason: "First-person source commitment" }
          : row.facts.responsibility;
      const bindings = responsibility.names.map((name) => ({
        name,
        evidence: evidence
          .filter((quote) => quote.speaker === name || quote.quote.includes(name))
          .map((quote) => quote.quote),
      }));
      return {
        candidateId: row.candidateId,
        responsibility: bindings.some((binding) => binding.evidence.length === 0)
          ? { names: [], basis: "unknown", reason: "No source role binding" }
          : responsibility,
        bindings: bindings.some((binding) => binding.evidence.length === 0) ? [] : bindings,
      };
    }),
  };
}

/** Model adapter fixture for the candidate extraction protocol; no production helpers mocked. */
export function accountedHandoffModel(reply: {
  version: number;
  summary: string;
  decisions: unknown[];
  openQuestions: unknown[];
  effectivenessEvidence: string;
  coachingAdvice: string;
  suggestedRecipients: unknown[];
  actionItems: Array<{
    title: string;
    evidence: string;
    owner: string | null;
    handoff: unknown;
    ownerMentionId?: null;
    ownerProfileId?: null;
    dueDate?: string | null;
  }>;
}): import("../../../apps/server/src/llm/providers").CompleteJson {
  return async (request) => {
    if (request.system.startsWith("VERIFY DECISION STATUS")) {
      const decisions = JSON.parse(
        request.user.split("<proposed-decisions>\n")[1].split("\n</proposed-decisions>")[0],
      ) as { decisionId: string; evidence: string | null }[];
      return {
        decisions: decisions.map((decision) => ({
          decisionId: decision.decisionId,
          status:
            decision.evidence && request.user.split("</transcript>")[0].includes(decision.evidence)
              ? "settled"
              : "unsupported",
          reason: "Fixture decision classification",
          evidence: decision.evidence ? [decision.evidence] : [],
        })),
      };
    }
    if (request.system.startsWith("VERIFY RESPONSIBILITY")) return responsibilityFixture(request);
    if (request.system.startsWith("CLASSIFY SOURCE STATUS")) return sourceStatusFixture(request);
    if (request.system.startsWith("AUDIT FINAL COVERAGE")) return { candidates: [] };
    if (request.system.startsWith("AUDIT SOURCE COVERAGE")) return { candidates: [] };
    if (request.system.startsWith("REPAIR CHECKED DUPLICATES"))
      return { groups: [], corrections: [] };
    if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) return { groups: [] };
    if (request.system.startsWith("DISCOVER CANDIDATES")) {
      return {
        candidates: reply.actionItems.map((action) => ({
          work: action.title,
          quote: action.evidence,
          speaker: action.owner,
        })),
      };
    }
    if (
      request.system.startsWith("RECONCILE CANDIDATES") ||
      request.system.startsWith("VERIFY ACTION FACTS")
    ) {
      const candidates = JSON.parse(
        request.user.split("<untrusted-candidates>\n")[1].split("\n</untrusted-candidates>")[0],
      ) as { id: string; work?: string; quote: string }[];
      return {
        dispositions: candidates.map((candidate) => ({
          candidateId: candidate.id,
          disposition: "retained",
          targetId: null,
          reason: "The commitment remains pending",
          evidence: [],
          facts: checkedCandidateFacts(
            reply.actionItems.find(
              (action) => action.title === candidate.work || action.evidence === candidate.quote,
            )!,
          ),
        })),
      };
    }
    if (request.system.startsWith("ENRICH CANDIDATE")) {
      const group = JSON.parse(
        request.user
          .split("<untrusted-candidate-group>\n")[1]
          .split("\n</untrusted-candidate-group>")[0],
      ) as { id: string; work?: string; quote: string }[];
      const found = reply.actionItems.find(
        (action) => action.title === group[0].work || action.evidence === group[0].quote,
      );
      if (!found) throw new Error("Missing fixture action");
      const { evidence: _quote, ...action } = found;
      return {
        candidateId: group[0].id,
        action: { ownerMentionId: null, ownerProfileId: null, dueDate: null, ...action },
      };
    }
    const { actionItems: _actions, ...overview } = reply;
    return overview;
  };
}
