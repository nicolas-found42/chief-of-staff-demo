import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import { expect, it } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { MeetingDebriefDetail, TranscriptRecord } from "@chief-of-staff-demo/shared";
import { MeetingDebriefHost } from "../../../apps/server/src/modules/meeting-debrief/host";
import { openRuns } from "../../../apps/server/src/runs";
import { operationalHandoff, accountedHandoffModel } from "../helpers/operational-handoff";

it.each([
  ["deadline", "tomorrow", "2026-09-10"],
  ["trigger", "tomorrow", null],
  ["deadline", "Thursday", "2026-09-10"],
  ["deadline", "September 10", "2026-09-10"],
  ["deadline", "2026-09-10", "2026-09-10"],
  ["deadline", "today", "2026-09-09"],
  ["deadline", "tomorrow morning", "2026-09-10"],
  ["deadline", "tomorrow afternoon", "2026-09-10"],
] as const)("grounds evidence for %s timing %s", async (kind, stated, expectedDate) => {
  const record = fromPartial<TranscriptRecord>({
    id: "transcript-handoff",
    source: { fileName: "2026-09-09.md" },
    meetingDate: "2026-09-09",
    meetingId: null,
    occurrence: null,
    roster: [],
    speakers: ["Alice"],
    speakerIdentityMappings: [],
    normalizedText:
      stated === "tomorrow afternoon"
        ? "[01:12–01:15] Alice: I will share the plan\n[01:15–01:18] Bob: tomorrow afternoon.\n"
        : stated === "tomorrow morning"
          ? "[01:12–01:15] Alice: I will share the plan\n[01:15–01:18] Alice: tomorrow morning.\n"
          : `[01:12–01:18] Alice: I will share the plan ${stated}.\n`,
  });
  const runs = openRuns(mkdtempSync(join(tmpdir(), "handoff-extraction-")));
  const host = new MeetingDebriefHost({
    runs,
    catalog: { getTranscript: () => record },
    identity: { reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }) },
    getCompleteJson: () =>
      accountedHandoffModel({
        version: 1,
        summary: "Plan sharing",
        decisions: [],
        openQuestions: [],
        effectivenessEvidence: "",
        coachingAdvice: "",
        suggestedRecipients: [],
        actionItems: [
          {
            title: "Share the plan",
            owner: "Alice",
            ownerMentionId: null,
            ownerProfileId: null,
            dueDate: expectedDate ?? "2026-09-10",
            evidence:
              stated === "tomorrow afternoon"
                ? "I will share the plan"
                : `I will share the plan ${stated}`,
            handoff: {
              ...operationalHandoff(),
              timing: { ...operationalHandoff().timing, kind, stated },
              evidence: [
                ...(stated === "tomorrow afternoon"
                  ? [
                      {
                        quote: "I will share the plan",
                        speaker: "Invented speaker",
                        timestamp: "99:99",
                      },
                      {
                        quote: "tomorrow afternoon",
                        speaker: "Invented speaker",
                        timestamp: "99:99",
                      },
                    ]
                  : []),
                {
                  quote: `I will share the plan ${stated}`,
                  speaker: "Invented speaker",
                  timestamp: "99:99",
                },
                { quote: "Invented commitment", speaker: "Alice", timestamp: "00:00" },
              ],
            },
          },
        ],
      }),
    log: () => {},
  });
  const app = fastify();
  host.routes(app);
  try {
    await host.process(record);
    await host.idle();
    const runId = runs.list({ module: "meeting-debrief" }).runs[0].id;
    const response = await app.inject(`/api/meeting-debrief/${runId}`);
    expect(response.statusCode).toBe(200);
    const detail = response.json<MeetingDebriefDetail>();
    expect(detail.extraction?.actionItems[0]?.handoff?.evidence).toEqual(
      stated === "tomorrow afternoon"
        ? [
            { quote: "I will share the plan", speaker: "Alice", timestamp: "01:12" },
            { quote: "tomorrow afternoon", speaker: "Bob", timestamp: "01:15" },
          ]
        : [{ quote: `I will share the plan ${stated}`, speaker: "Alice", timestamp: "01:12" }],
    );
    expect(detail.extraction?.actionItems[0]?.dueDate).toBe(expectedDate);
  } finally {
    await app.close();
  }
});

it.each([
  { label: "invalid root", reply: { invalid: true } },
  {
    label: "missing new handoff",
    reply: {
      version: 1,
      summary: "Plan",
      decisions: [],
      openQuestions: [],
      effectivenessEvidence: "",
      coachingAdvice: "",
      suggestedRecipients: [],
      actionItems: [
        {
          title: "Send plan",
          evidence: "I will send the plan",
          owner: "Alice",
          ownerMentionId: null,
          ownerProfileId: null,
          dueDate: null,
        },
      ],
    },
  },
])(
  "rejects $label without multiplying provider retries at the Module boundary",
  async ({ reply }) => {
    const record = fromPartial<TranscriptRecord>({
      id: "transcript-invalid",
      source: { fileName: "test.md" },
      meetingDate: null,
      meetingId: null,
      occurrence: null,
      roster: [],
      speakers: [],
      speakerIdentityMappings: [],
      normalizedText: "Alice: I will send the plan.",
    });
    const runs = openRuns(mkdtempSync(join(tmpdir(), "handoff-retry-")));
    let calls = 0;
    const host = new MeetingDebriefHost({
      runs,
      catalog: { getTranscript: () => record },
      identity: { reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }) },
      getCompleteJson: () => async () => {
        calls++;
        return reply;
      },
      log: () => {},
    });
    await host.process(record);
    await host.idle();
    expect(calls).toBe(1);
    expect(runs.list({ module: "meeting-debrief" }).runs[0]?.status).toBe("failed");
  },
);

/**
 * Structured provenance for purpose, criteria, inputs and retrieval steps
 * (MWR-046, spec #347). The extraction's claims are checked against the
 * transcript: what the source states keeps its occurrences, what the model
 * asserts without them is a suggestion, and a suggested retrieval step is
 * never another commitment.
 */
it("grounds supported details and reads a claim without support as a suggestion", async () => {
  const record = fromPartial<TranscriptRecord>({
    id: "transcript-provenance",
    source: { fileName: "2026-09-09.md" },
    meetingDate: "2026-09-09",
    meetingId: null,
    occurrence: null,
    roster: [],
    speakers: ["Alice"],
    speakerIdentityMappings: [],
    normalizedText:
      "[01:12–01:18] Alice: I will share the plan with the team, and they can read it once the budget is approved.\n",
  });
  const runs = openRuns(mkdtempSync(join(tmpdir(), "handoff-provenance-")));
  const host = new MeetingDebriefHost({
    runs,
    catalog: { getTranscript: () => record },
    identity: { reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }) },
    getCompleteJson: () =>
      accountedHandoffModel({
        version: 1,
        summary: "Plan sharing",
        decisions: [],
        openQuestions: [],
        effectivenessEvidence: "",
        coachingAdvice: "",
        suggestedRecipients: [],
        actionItems: [
          {
            title: "Share the plan",
            owner: "Alice",
            ownerMentionId: null,
            ownerProfileId: null,
            dueDate: null,
            evidence: "I will share the plan with the team",
            handoff: {
              ...operationalHandoff(),
              purpose: {
                text: "Keep the rollout verifiable",
                provenance: "supported",
                sources: [
                  { quote: "Nobody said this in the meeting", speaker: null, timestamp: null },
                ],
              },
              completionCriteria: [
                {
                  text: "The team can read the plan",
                  provenance: "supported",
                  sources: [
                    {
                      quote: "they can read it once the budget is approved",
                      speaker: "Invented speaker",
                      timestamp: "99:99",
                    },
                  ],
                },
                { text: "A rollout owner is named", provenance: "suggested", sources: [] },
              ],
              missingInputs: [
                {
                  information: { text: "Deployment access", provenance: "suggested", sources: [] },
                  obtainBy: {
                    text: "Ask the deployment administrator",
                    provenance: "suggested",
                    sources: [],
                  },
                },
              ],
              dependencies: [
                {
                  actionTitle: "Approve the budget",
                  condition: "Only after approval",
                  provenance: "suggested",
                  sources: [],
                  references: "external",
                },
              ],
            },
          },
        ],
      }),
    log: () => {},
  });
  const app = fastify();
  host.routes(app);
  try {
    await host.process(record);
    await host.idle();
    const runId = runs.list({ module: "meeting-debrief" }).runs[0].id;
    const response = await app.inject(`/api/meeting-debrief/${runId}`);
    const detail = response.json<MeetingDebriefDetail>();
    const items = detail.extraction?.actionItems ?? [];
    /* The suggested retrieval step is detail about the commitment, not another
       commitment: nothing was extracted beside it. */
    expect(items).toHaveLength(1);
    expect(items[0]?.handoff).toMatchObject({
      version: 2,
      purpose: { text: "Keep the rollout verifiable", provenance: "suggested", sources: [] },
      completionCriteria: [
        {
          text: "The team can read the plan",
          provenance: "supported",
          sources: [
            {
              quote: "they can read it once the budget is approved",
              speaker: "Alice",
              timestamp: "01:12",
            },
          ],
        },
        { text: "A rollout owner is named", provenance: "suggested", sources: [] },
      ],
      missingInputs: [
        {
          information: { text: "Deployment access", provenance: "suggested", sources: [] },
          obtainBy: {
            text: "Ask the deployment administrator",
            provenance: "suggested",
            sources: [],
          },
        },
      ],
      dependencies: [
        {
          actionTitle: "Approve the budget",
          condition: "Only after approval",
          provenance: "suggested",
          references: "external",
        },
      ],
    });
    expect(items[0]?.handoff?.dependencies[0]).not.toHaveProperty("target");
  } finally {
    await app.close();
  }
});

it("keeps an internal dependency's own wording and its claim to name another proposal", async () => {
  const record = fromPartial<TranscriptRecord>({
    id: "transcript-dependency",
    source: { fileName: "2026-09-09.md" },
    meetingDate: "2026-09-09",
    meetingId: null,
    occurrence: null,
    roster: [],
    speakers: ["Alice", "Bob"],
    speakerIdentityMappings: [],
    normalizedText:
      "[01:20] Alice: I will draft the rollout plan.\n[01:21] Bob: I will review the rollout plan once Alice shares it.\n",
  });
  const runs = openRuns(mkdtempSync(join(tmpdir(), "handoff-dependency-")));
  const host = new MeetingDebriefHost({
    runs,
    catalog: { getTranscript: () => record },
    identity: { reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }) },
    getCompleteJson: () =>
      accountedHandoffModel({
        version: 1,
        summary: "Rollout planning",
        decisions: [],
        openQuestions: [],
        effectivenessEvidence: "",
        coachingAdvice: "",
        suggestedRecipients: [],
        actionItems: [
          {
            title: "Draft the rollout plan",
            owner: "Alice",
            ownerMentionId: null,
            ownerProfileId: null,
            dueDate: null,
            evidence: "I will draft the rollout plan",
            handoff: operationalHandoff(),
          },
          {
            title: "Review the rollout plan",
            owner: "Bob",
            ownerMentionId: null,
            ownerProfileId: null,
            dueDate: null,
            evidence: "I will review the rollout plan once Alice shares it",
            handoff: {
              ...operationalHandoff(),
              responsibility: {
                names: ["Bob"],
                basis: "explicit",
                reason: "Bob committed to reviewing it",
              },
              dependencies: [
                {
                  actionTitle: "Draft the rollout plan",
                  condition: "Once Alice shares it",
                  provenance: "supported",
                  sources: [
                    {
                      quote: "once Alice shares it",
                      speaker: "Invented speaker",
                      timestamp: "99:99",
                    },
                  ],
                  references: "extracted",
                },
              ],
            },
          },
        ],
      }),
    log: () => {},
  });
  const app = fastify();
  host.routes(app);
  try {
    await host.process(record);
    await host.idle();
    const runId = runs.list({ module: "meeting-debrief" }).runs[0].id;
    const detail = (await app.inject(`/api/meeting-debrief/${runId}`)).json<MeetingDebriefDetail>();
    const dependency = detail.extraction?.actionItems[1]?.handoff?.dependencies[0];
    expect(dependency).toEqual({
      actionTitle: "Draft the rollout plan",
      condition: "Once Alice shares it",
      provenance: "supported",
      sources: [{ quote: "once Alice shares it", speaker: "Bob", timestamp: "01:21" }],
      references: "extracted",
    });
    /* The identity is the materialization's answer, resolved against the
       checked output — never the artifact's own guess. */
    expect(dependency).not.toHaveProperty("target");
  } finally {
    await app.close();
  }
});
