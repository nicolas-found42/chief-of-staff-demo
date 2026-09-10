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
