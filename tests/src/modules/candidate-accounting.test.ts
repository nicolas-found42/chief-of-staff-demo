import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import { expect, it } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { MeetingDebriefDetail, TranscriptRecord } from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../../../apps/server/src/llm/providers";
import { MeetingDebriefHost } from "../../../apps/server/src/modules/meeting-debrief/host";
import {
  operationalHandoff,
  accountedHandoffModel,
  checkedCandidateFacts,
  sourceStatusFixture,
  responsibilityFixture,
} from "../helpers/operational-handoff";
import { openRuns } from "../../../apps/server/src/runs";

const overview = {
  version: 1,
  summary: "Plan and references",
  decisions: [],
  openQuestions: [],
  effectivenessEvidence: "",
  coachingAdvice: "",
  suggestedRecipients: [],
};
const candidate = {
  work: "Request a reference after the workshop",
  quote: "After the workshop, I will ask for a reference.",
  speaker: "Alice",
};
const referenceFacts = checkedCandidateFacts({
  title: candidate.work,
  dueDate: null,
  handoff: operationalHandoff({
    timing: {
      kind: "trigger",
      stated: "After the workshop",
      referenceDate: "2026-09-09",
      reasoning: "Conditional promise",
    },
    evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
  }),
});
async function extract(complete: CompleteJson, source?: string, retry = false) {
  const record = fromPartial<TranscriptRecord>({
    id: "accounting",
    source: { fileName: "2026-09-09.md" },
    meetingDate: "2026-09-09",
    meetingId: null,
    occurrence: null,
    roster: [],
    speakers: ["Alice"],
    speakerIdentityMappings: [],
    normalizedText:
      source ??
      "[00:01–00:05] Alice: After the workshop, I will ask for a reference.\n[00:06–00:09] Alice: I already sent the old plan.\n[00:10–00:15] Alice: Why don't we just put something in the calendar as a reminder?\n[00:16–00:20] Alice: I just sent the reminder.\n[00:21–00:26] Alice: We could build a premium course someday.\n[00:27–00:30] Bob: Maybe; no decision on that today.\n[00:31–00:36] Alice: I've checked two items already.\n[00:37–00:42] Alice: I will finish the other three tomorrow.\n[00:43–00:48] Alice: I will review the draft today.\n[00:49–00:54] Bob: I will review the draft tomorrow.\n[00:55–01:00] Alice: I will email Bob and I will call Carol.\n",
  });
  const runs = openRuns(mkdtempSync(join(tmpdir(), "candidate-accounting-")));
  const host = new MeetingDebriefHost({
    runs,
    catalog: { getTranscript: () => record },
    identity: { reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }) },
    getCompleteJson: () => complete,
    log: () => {},
  });
  const app = fastify();
  host.routes(app);
  try {
    await host.process(record);
    await host.idle();
    const runId = runs.list({ module: "meeting-debrief" }).runs[0].id;
    if (retry && runs.open(runId)?.read().status === "failed") {
      await host.retryRun(runId);
      await host.idle();
    }
    return (await app.inject(`/api/meeting-debrief/${runId}`)).json<MeetingDebriefDetail>();
  } finally {
    await app.close();
  }
}

it("fails the meeting extraction when a discovered commitment has no disposition", async () => {
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES")) return { candidates: [candidate] };
    if (request.system.startsWith("VERIFY RESPONSIBILITY")) return responsibilityFixture(request);
    if (request.system.startsWith("CLASSIFY SOURCE STATUS")) return sourceStatusFixture(request);
    if (request.system.startsWith("AUDIT FINAL COVERAGE")) return { candidates: [] };
    if (request.system.startsWith("AUDIT SOURCE COVERAGE")) return { candidates: [] };
    if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) return { groups: [] };
    if (
      request.system.startsWith("RECONCILE CANDIDATES") ||
      request.system.startsWith("VERIFY ACTION FACTS")
    )
      return { dispositions: [] };
    return { ...overview, actionItems: [] };
  });
  expect(detail.status).toBe("failed");
  expect(detail.extraction).toBeNull();
});

it.each([
  "@line:1",
  "@1",
  "@line:00:01",
  // mistral-nemo echoes the displayed line after its identifier (#402); the
  // remainder is verified verbatim against that line's speech, then the
  // identifier alone grounds the evidence.
  "@line:1 [00:01–00:05] Alice: After the workshop, I will ask for a reference.",
  "@line:1 After the workshop, I will ask",
])(
  "expands selected source span %s into literal evidence without asking the model to copy speech",
  async (reference) => {
    const model = accountedHandoffModel({
      ...overview,
      actionItems: [
        {
          title: candidate.work,
          owner: "Alice",
          evidence: candidate.quote,
          handoff: operationalHandoff({
            evidence: [{ quote: reference, speaker: "Wrong name", timestamp: "99:99" }],
          }),
        },
      ],
    });
    const detail = await extract(async (request) => {
      if (request.system.startsWith("DISCOVER CANDIDATES")) {
        expect(request.user).toContain("@line:1 [00:01–00:05] Alice:");
        return { candidates: [{ ...candidate, quote: reference }] };
      }
      if (request.system.startsWith("CLASSIFY SOURCE STATUS")) {
        const reply = sourceStatusFixture(request);
        return {
          dispositions: reply.dispositions.map((row) => ({ ...row, evidence: [reference] })),
        };
      }
      return model(request);
    });
    expect(detail.status).toBe("done");
    expect(detail.extraction?.actionItems[0].handoff?.evidence).toEqual([
      { quote: candidate.quote, speaker: "Alice", timestamp: "00:01" },
    ]);
  },
);

it.each([
  "@line:999999",
  "@999999",
  "@line:999999 Alice: After the workshop, I will ask for a reference.",
  "@line:1 [00:01–00:05] Alice: After the workshop I ask for a reference.",
  "@line:1 [00:01–00:05] Alice: I already sent the old plan.",
  "@line:1 @line:2",
])("never admits invented source span %s as coverage evidence", async (reference) => {
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES")) return { candidates: [] };
    if (request.system.startsWith("AUDIT SOURCE COVERAGE"))
      return { candidates: [{ ...candidate, quote: reference }] };
    return overview;
  });
  expect(detail.status).toBe("failed");
  expect(detail.extraction).toBeNull();
});

it("materializes source references in decisions and excludes unsupported decision observations", async () => {
  const model = accountedHandoffModel({ ...overview, actionItems: [] });
  const detail = await extract(async (request) => {
    if (request.system.startsWith("OVERVIEW ONLY"))
      return {
        ...overview,
        decisions: [
          { statement: "The reference request follows the workshop", evidence: "@line:1" },
          { statement: "An unsupported decision observation", evidence: "@line:999999" },
        ],
      };
    return model(request);
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.decisions.map((decision) => decision.evidence)).toEqual([
    candidate.quote,
  ]);
});

it("preserves two distinct promises made in the same source span", async () => {
  const quote = "I will email Bob and I will call Carol.";
  const actions = ["Email Bob", "Call Carol"].map((title) => ({
    title,
    owner: "Alice",
    evidence: quote,
    handoff: operationalHandoff({ evidence: [{ quote, speaker: "Alice", timestamp: null }] }),
  }));
  const model = accountedHandoffModel({ ...overview, actionItems: actions });
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES"))
      return {
        candidates: actions.map((action) => ({
          work: action.title,
          quote: "@line:11",
          speaker: "Alice",
        })),
      };
    if (request.system.startsWith("CLASSIFY SOURCE STATUS")) {
      const rows = JSON.parse(
        request.user.split("<untrusted-candidates>\n")[1].split("\n</untrusted-candidates>")[0],
      ) as { id: string; observedWork: string }[];
      expect(rows.map((row) => row.observedWork)).toEqual(["Email Bob", "Call Carol"]);
      return {
        dispositions: rows.map((row) => ({
          candidateId: row.id,
          disposition: "retained",
          nextStep: row.observedWork,
          reason: "A distinct first-person promise within the shared turn",
          evidence: ["@line:11"],
        })),
      };
    }
    if (request.system.startsWith("VERIFY ACTION FACTS")) {
      const rows = JSON.parse(
        request.user
          .split("<checked-source-statuses>\n")[1]
          .split("\n</checked-source-statuses>")[0],
      ) as { candidateId: string; nextStep: string }[];
      return {
        dispositions: rows.map((row) => ({
          candidateId: row.candidateId,
          disposition: "retained",
          targetId: null,
          reason: "Still pending",
          evidence: ["@line:11"],
          facts: checkedCandidateFacts(actions.find((action) => action.title === row.nextStep)!),
        })),
      };
    }
    return model(request);
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems.map((item) => item.title)).toEqual([
    "Email Bob",
    "Call Carol",
  ]);
});

it("offers the model no valid retained state without its required facts", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        owner: "Alice",
        evidence: candidate.quote,
        handoff: operationalHandoff({
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  const detail = await extract(async (request) => {
    const reply = await model(request);
    if (request.system.startsWith("VERIFY ACTION FACTS")) {
      const result = reply as { dispositions: Array<Record<string, unknown>> };
      const missingFacts = {
        dispositions: result.dispositions.map((row) => ({ ...row, facts: null })),
      };
      // A schema-constrained provider may choose any valid branch; the retained
      // branch cannot offer omission of the facts it is being asked to verify.
      if (request.schema.safeParse(missingFacts).success) return missingFacts;
    }
    return reply;
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems[0]).toMatchObject({
    title: candidate.work,
    owner: "Alice",
  });
});

it("recovers a source commitment missed by the first discovery pass", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: null,
        handoff: operationalHandoff({
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES")) return { candidates: [] };
    if (request.system.startsWith("AUDIT SOURCE COVERAGE")) return { candidates: [candidate] };
    return model(request);
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems.map((item) => item.title)).toEqual([candidate.work]);
});

it("repairs a coverage quote before admitting a missed commitment", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        handoff: operationalHandoff({
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  let audits = 0;
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES")) return { candidates: [] };
    if (request.system.startsWith("AUDIT SOURCE COVERAGE"))
      return {
        candidates: [
          {
            ...candidate,
            quote: audits++ === 0 ? "Alice promised a reference later" : candidate.quote,
          },
        ],
      };
    return model(request);
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems[0].title).toBe(candidate.work);
});

it("grounds coverage evidence spanning consecutive turns by the same speaker", async () => {
  const quote = "I've checked two items already. I will finish the other three tomorrow.";
  const action = {
    title: "Finish the remaining three items",
    owner: "Alice",
    dueDate: "2026-09-10",
    evidence: quote,
    handoff: operationalHandoff({ evidence: [{ quote, speaker: "Alice", timestamp: null }] }),
  };
  const model = accountedHandoffModel({ ...overview, actionItems: [action] });
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES")) return { candidates: [] };
    if (request.system.startsWith("AUDIT SOURCE COVERAGE"))
      return { candidates: [{ work: action.title, quote, speaker: "Alice" }] };
    return model(request);
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems[0].handoff?.evidence).toEqual([
    { quote, speaker: "Alice", timestamp: "00:31" },
  ]);
});

it("preserves checked responsibility and timing when enrichment tries to replace them", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: null,
        handoff: operationalHandoff({
          timing: {
            kind: "trigger",
            stated: "After the workshop",
            referenceDate: "2026-09-09",
            reasoning: "Conditional, not a deadline",
          },
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  const detail = await extract(async (request) => {
    const reply = await model(request);
    if (request.system.startsWith("ENRICH CANDIDATE")) {
      const result = reply as { candidateId: string; action: Record<string, unknown> };
      return {
        ...result,
        action: {
          ...result.action,
          title: "Ask the note taker for a reference",
          owner: "Note taker",
          dueDate: "2026-09-10",
        },
      };
    }
    return reply;
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems[0]).toMatchObject({
    title: candidate.work,
    owner: "Alice",
    dueDate: null,
  });
});

it("recovers the committing speaker when a proposed responsible name is unsupported", async () => {
  const detail = await extract(
    accountedHandoffModel({
      ...overview,
      actionItems: [
        {
          title: candidate.work,
          evidence: candidate.quote,
          owner: "Unverified person",
          handoff: operationalHandoff({
            responsibility: {
              names: ["Unverified person"],
              basis: "explicit",
              reason: "A nearby name was guessed",
            },
            evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
          }),
        },
      ],
    }),
  );
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems[0]).toMatchObject({
    owner: "Alice",
    handoff: { responsibility: { names: ["Alice"], basis: "explicit" } },
  });
});

it("keeps an unagreed idea out of pending work after source verification corrects its classification", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: "Build a premium course",
        evidence: "We could build a premium course someday.",
        owner: "Alice",
        handoff: operationalHandoff({
          evidence: [
            {
              quote: "We could build a premium course someday.",
              speaker: "Alice",
              timestamp: null,
            },
          ],
        }),
      },
    ],
  });
  const detail = await extract(async (request) => {
    const result = await model(request);
    if (request.system.startsWith("VERIFY ACTION FACTS")) {
      const reply = result as { dispositions: Array<Record<string, unknown>> };
      return {
        dispositions: reply.dispositions.map((row) => ({
          ...row,
          disposition: "optional",
          targetId: null,
          facts: null,
          reason: "The idea was discussed but no one agreed to do it",
        })),
      };
    }
    return result;
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toEqual([]);
});

it("requires an unfinished obligation before asking for a handoff", async () => {
  const quote = "We could build a premium course someday.";
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: "Build a premium course",
        owner: "Alice",
        evidence: quote,
        handoff: operationalHandoff({ evidence: [{ quote, speaker: "Alice", timestamp: null }] }),
      },
    ],
  });
  const detail = await extract(async (request) => {
    if (request.system.startsWith("CLASSIFY SOURCE STATUS")) {
      const rows = JSON.parse(
        request.user.split("<untrusted-candidates>\n")[1].split("\n</untrusted-candidates>")[0],
      ) as { id: string }[];
      return {
        dispositions: rows.map((row) => ({
          candidateId: row.id,
          disposition: "optional",
          nextStep: null,
          reason: "A possible future course was discussed without agreement",
          evidence: [quote],
        })),
      };
    }
    return model(request);
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toEqual([]);
});

it("repairs an incomplete verification once before publishing a complete debrief", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        handoff: operationalHandoff({
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  let verification = 0;
  const detail = await extract(async (request) => {
    if (request.system.startsWith("VERIFY ACTION FACTS") && verification++ === 0)
      return { dispositions: [] };
    return model(request);
  });
  expect(detail.status, JSON.stringify(detail)).toBe("done");
  expect(detail.extraction?.actionItems.map((item) => item.title)).toEqual([candidate.work]);
});

it("preserves verified remaining work when its evidence also describes completed steps", async () => {
  const detail = await extract(
    accountedHandoffModel({
      ...overview,
      actionItems: [
        {
          title: "Finish the remaining three items",
          owner: "Alice",
          dueDate: "2026-09-10",
          evidence: "I've checked two items already.",
          handoff: operationalHandoff({
            evidence: [
              { quote: "I've checked two items already.", speaker: "Alice", timestamp: null },
              {
                quote: "I will finish the other three tomorrow.",
                speaker: "Alice",
                timestamp: null,
              },
            ],
            statusReasoning:
              "Two items are completed, three remain explicitly promised for tomorrow",
          }),
        },
      ],
    }),
  );
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems[0]).toMatchObject({
    title: "Finish the remaining three items",
    owner: "Alice",
    dueDate: "2026-09-10",
  });
});

it("carries the checked remaining step into fact verification after partial completion", async () => {
  const nextStep = "Finish the remaining three items";
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: nextStep,
        owner: "Alice",
        dueDate: "2026-09-10",
        evidence: "I've checked two items already.",
        handoff: operationalHandoff({
          evidence: [
            { quote: "I will finish the other three tomorrow.", speaker: "Alice", timestamp: null },
          ],
        }),
      },
    ],
  });
  const detail = await extract(async (request) => {
    if (request.system.startsWith("CLASSIFY SOURCE STATUS")) {
      const result = sourceStatusFixture(request);
      return {
        dispositions: result.dispositions.map((row) => ({
          ...row,
          nextStep,
          reason: "Two items are complete; only the remaining three are still promised",
          evidence: ["I will finish the other three tomorrow."],
        })),
      };
    }
    if (request.system.startsWith("VERIFY ACTION FACTS")) {
      const statuses = JSON.parse(
        request.user
          .split("<checked-source-statuses>\n")[1]
          .split("\n</checked-source-statuses>")[0],
      ) as { nextStep: string; reason: string }[];
      expect(statuses).toEqual([
        expect.objectContaining({
          nextStep,
          reason: "Two items are complete; only the remaining three are still promised",
        }),
      ]);
    }
    return model(request);
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toEqual([
    expect.objectContaining({ title: nextStep, owner: "Alice", dueDate: "2026-09-10" }),
  ]);
});

it("preserves distinct people and dates when deduplication proposes one shared assignment", async () => {
  const actions = [
    {
      title: "Review the draft today",
      owner: "Alice",
      dueDate: "2026-09-09",
      stated: "today",
      quote: "I will review the draft today.",
    },
    {
      title: "Review the draft tomorrow",
      owner: "Bob",
      dueDate: "2026-09-10",
      stated: "tomorrow",
      quote: "I will review the draft tomorrow.",
    },
  ];
  const model = accountedHandoffModel({
    ...overview,
    actionItems: actions.map((action) => ({
      title: action.title,
      owner: action.owner,
      dueDate: action.dueDate,
      evidence: action.quote,
      handoff: operationalHandoff({
        responsibility: {
          names: [action.owner],
          basis: "explicit",
          reason: "First-person promise",
        },
        timing: {
          kind: "deadline",
          stated: action.stated,
          referenceDate: "2026-09-09",
          reasoning: "Stated execution date",
        },
        evidence: [{ quote: action.quote, speaker: action.owner, timestamp: null }],
      }),
    })),
  });
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) {
      const rows = JSON.parse(
        request.user.split("<checked-actions>\n")[1].split("\n</checked-actions>")[0],
      ) as { candidateId: string }[];
      return {
        groups: [
          {
            verdict: "same_deliverable",
            candidateIds: rows.map((row) => row.candidateId),
            reason: "Both review the same draft",
            evidence: actions.map((action) => action.quote),
          },
        ],
      };
    }
    return model(request);
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toMatchObject([
    { owner: "Alice", dueDate: "2026-09-09" },
    { owner: "Bob", dueDate: "2026-09-10" },
  ]);
});

it("keeps a retained forward-looking request whose evidence contains just", async () => {
  const quote = "Why don't we just put something in the calendar as a reminder?";
  const detail = await extract(
    accountedHandoffModel({
      ...overview,
      actionItems: [
        {
          title: "Add a calendar reminder",
          owner: null,
          ownerMentionId: null,
          ownerProfileId: null,
          dueDate: null,
          evidence: quote,
          handoff: operationalHandoff({ evidence: [{ quote, speaker: "Alice", timestamp: null }] }),
        },
      ],
    }),
  );
  expect(detail.status, detail.summary ?? "no summary").toBe("done");
  expect(detail.extraction?.actionItems).toHaveLength(1);
  expect(detail.extraction?.actionItems[0].title).toBe("Add a calendar reminder");
});

it("keeps verified completed work out of pending actions", async () => {
  const quote = "I just sent the reminder.";
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: "Send the reminder",
        owner: "Alice",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: null,
        evidence: quote,
        handoff: operationalHandoff({ evidence: [{ quote, speaker: "Alice", timestamp: null }] }),
      },
    ],
  });
  const detail = await extract(async (request) => {
    const reply = await model(request);
    if (request.system.startsWith("VERIFY ACTION FACTS")) {
      const result = reply as { dispositions: Array<Record<string, unknown>> };
      return {
        dispositions: result.dispositions.map((row) => ({
          ...row,
          disposition: "completed",
          facts: null,
          targetId: null,
          evidence: [quote],
          reason: "The reminder was already sent",
        })),
      };
    }
    return reply;
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toEqual([]);
});

it("retains a conditional commitment through enrichment and records completed work separately", async () => {
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES"))
      return {
        candidates: [
          candidate,
          { work: "Send the old plan", quote: "I already sent the old plan.", speaker: "Alice" },
        ],
      };
    if (request.system.startsWith("VERIFY RESPONSIBILITY")) return responsibilityFixture(request);
    if (request.system.startsWith("CLASSIFY SOURCE STATUS")) return sourceStatusFixture(request);
    if (request.system.startsWith("AUDIT FINAL COVERAGE")) return { candidates: [] };
    if (request.system.startsWith("AUDIT SOURCE COVERAGE")) return { candidates: [] };
    if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) return { groups: [] };
    if (
      request.system.startsWith("RECONCILE CANDIDATES") ||
      request.system.startsWith("VERIFY ACTION FACTS")
    ) {
      const rows = JSON.parse(
        request.user.split("<untrusted-candidates>\n")[1].split("\n</untrusted-candidates>")[0],
      ) as { id: string }[];
      return {
        dispositions: rows.map((row, index) => ({
          candidateId: row.id,
          disposition: index === 0 ? "retained" : "completed",
          targetId: null,
          reason: index === 0 ? "Conditional promise remains" : "Plan already sent",
          evidence: [index === 0 ? candidate.quote : "I already sent the old plan."],
          facts: index === 0 ? referenceFacts : null,
        })),
      };
    }
    if (request.system.startsWith("ENRICH CANDIDATE")) {
      const rows = JSON.parse(
        request.user
          .split("<untrusted-candidate-group>\n")[1]
          .split("\n</untrusted-candidate-group>")[0],
      ) as { id: string }[];
      return {
        candidateId: rows[0].id,
        action: {
          title: candidate.work,
          owner: "Alice",
          ownerMentionId: null,
          ownerProfileId: null,
          dueDate: null,
          handoff: operationalHandoff({
            timing: {
              kind: "trigger",
              stated: "After the workshop",
              referenceDate: "2026-09-09",
              reasoning: "No calendar deadline stated",
            },
            evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: "00:01" }],
          }),
        },
      };
    }
    return {
      ...overview,
      summary: "The old plan was already sent. A reference will be requested after the workshop.",
    };
  });
  expect(detail.status, detail.summary ?? "no summary").toBe("done");
  expect(detail.extraction?.actionItems).toMatchObject([
    {
      title: candidate.work,
      owner: "Alice",
      dueDate: null,
      handoff: { timing: { kind: "trigger" } },
    },
  ]);
  expect(detail.extraction?.actionItems).toHaveLength(1);
  expect(detail.extraction?.summary).toContain("already sent");
});

it.each(["duplicate", "unknown", "merge-cycle", "missing-enrichment"] as const)(
  "fails instead of publishing an extraction with %s candidate accounting",
  async (fault) => {
    const detail = await extract(async (request) => {
      if (request.system.startsWith("DISCOVER CANDIDATES"))
        return { candidates: [candidate, candidate] };
      if (request.system.startsWith("VERIFY RESPONSIBILITY")) return responsibilityFixture(request);
      if (request.system.startsWith("CLASSIFY SOURCE STATUS")) return sourceStatusFixture(request);
      if (request.system.startsWith("AUDIT FINAL COVERAGE")) return { candidates: [] };
      if (request.system.startsWith("AUDIT SOURCE COVERAGE")) return { candidates: [] };
      if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) return { groups: [] };
      if (
        request.system.startsWith("RECONCILE CANDIDATES") ||
        request.system.startsWith("VERIFY ACTION FACTS")
      ) {
        const rows = JSON.parse(
          request.user.split("<untrusted-candidates>\n")[1].split("\n</untrusted-candidates>")[0],
        ) as { id: string }[];
        return {
          dispositions: rows.map((row, index) => ({
            candidateId:
              fault === "duplicate" ? rows[0].id : fault === "unknown" ? "invented-id" : row.id,
            disposition: fault === "merge-cycle" ? "merged" : "retained",
            targetId: fault === "merge-cycle" ? rows[1 - index].id : null,
            reason: "Check this candidate",
            evidence: [candidate.quote],
            facts: fault === "merge-cycle" ? null : referenceFacts,
          })),
        };
      }
      if (request.system.startsWith("ENRICH CANDIDATE"))
        return { candidateId: "invented-id", action: null };
      return overview;
    });
    expect(detail.status).toBe("failed");
    expect(detail.extraction).toBeNull();
  },
);

it("merges duplicate candidates into one retained Action Item", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: null,
        handoff: operationalHandoff({
          timing: {
            kind: "trigger",
            stated: "After the workshop",
            referenceDate: "2026-09-09",
            reasoning: "Conditional",
          },
        }),
      },
    ],
  });
  let duplicateIds: string[] = [];
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DEDUPE CHECKED ACTIONS"))
      return {
        groups: [
          {
            verdict: "same_deliverable",
            candidateIds: duplicateIds,
            reason: "The same promise appears twice",
            evidence: [candidate.quote],
          },
        ],
      };
    if (request.system.startsWith("DISCOVER CANDIDATES"))
      return { candidates: [candidate, candidate] };
    if (request.system.startsWith("VERIFY RESPONSIBILITY")) return responsibilityFixture(request);
    if (request.system.startsWith("CLASSIFY SOURCE STATUS")) return sourceStatusFixture(request);
    if (request.system.startsWith("AUDIT FINAL COVERAGE")) return { candidates: [] };
    if (request.system.startsWith("AUDIT SOURCE COVERAGE")) return { candidates: [] };
    if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) return { groups: [] };
    if (
      request.system.startsWith("RECONCILE CANDIDATES") ||
      request.system.startsWith("VERIFY ACTION FACTS")
    ) {
      const rows = JSON.parse(
        request.user.split("<untrusted-candidates>\n")[1].split("\n</untrusted-candidates>")[0],
      ) as { id: string }[];
      duplicateIds = rows.map((row) => row.id);
      return {
        dispositions: rows.map((row) => ({
          candidateId: row.id,
          disposition: "retained",
          targetId: null,
          reason: "Same promise repeated in overlap",
          evidence: [candidate.quote],
          facts: referenceFacts,
        })),
      };
    }
    return model(request);
  });
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toHaveLength(1);
  expect(detail.extraction?.actionItems[0].title).toBe(candidate.work);
});

it("grounds Markdown turn labels and preserves their named executor", async () => {
  const quote = "I will test the app tomorrow.";
  const detail = await extract(
    accountedHandoffModel({
      ...overview,
      actionItems: [
        {
          title: "Test the app",
          owner: "Adejoke Olaosebikan",
          evidence: quote,
          handoff: operationalHandoff({
            responsibility: {
              names: ["Adejoke Olaosebikan"],
              basis: "explicit",
              reason: "First-person promise",
            },
            evidence: [{ quote, speaker: null, timestamp: null }],
          }),
        },
      ],
    }),
    `**Adejoke Olaosebikan** *[00:00]*: ${quote}`,
  );
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems[0]).toMatchObject({
    owner: "Adejoke Olaosebikan",
    handoff: { evidence: [{ quote, speaker: "Adejoke Olaosebikan", timestamp: "00:00" }] },
  });
});

it("checks action-specific role binding even when the proposed name is a known speaker", async () => {
  const quote = "Pricing is the priority; we have not chosen who will redo it.";
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: "Redo pricing",
        owner: "Richard",
        evidence: quote,
        handoff: operationalHandoff({
          responsibility: {
            names: ["Richard"],
            basis: "inferred",
            reason: "Richard stated priorities; the executor is uncertain",
          },
          evidence: [{ quote, speaker: "Richard", timestamp: null }],
        }),
      },
    ],
  });
  let roleChecks = 0;
  const detail = await extract(async (request) => {
    if (request.system.startsWith("VERIFY RESPONSIBILITY")) {
      roleChecks++;
      const rows = JSON.parse(
        request.user.split("<checked-actions>\n")[1].split("\n</checked-actions>")[0],
      ) as { candidateId: string }[];
      return {
        responsibilities: rows.map((row) => ({
          candidateId: row.candidateId,
          responsibility: {
            names: [],
            basis: "unknown",
            reason: "The source does not assign an executor",
          },
          bindings: [],
        })),
      };
    }
    return model(request);
  }, `Richard: ${quote}`);
  expect(detail.status).toBe("done");
  expect(roleChecks).toBe(1);
  expect(detail.extraction?.actionItems[0]).toMatchObject({
    owner: null,
    handoff: { responsibility: { names: [], basis: "unknown" } },
  });
});

it("preserves an anonymous speaker's payment promise after an unsupported real-name guess", async () => {
  const quote = "I will make the payment tomorrow.";
  const detail = await extract(
    accountedHandoffModel({
      ...overview,
      actionItems: [
        {
          title: "Make the payment",
          owner: "Katrina",
          evidence: quote,
          handoff: operationalHandoff({
            responsibility: {
              names: ["Katrina"],
              basis: "explicit",
              reason: "Guessed real identity",
            },
            evidence: [{ quote, speaker: "Speaker 2", timestamp: null }],
          }),
        },
      ],
    }),
    `Katrina: I am taking notes.\nSpeaker 2: ${quote}`,
  );
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems[0]).toMatchObject({
    owner: "Speaker 2",
    handoff: { responsibility: { names: ["Speaker 2"], basis: "explicit" } },
  });
});

it.each([false, true])(
  "repairs invalid merge references and refuses unresolved proposals (invalid=%s)",
  async (stillInvalid) => {
    const model = accountedHandoffModel({
      ...overview,
      actionItems: [
        {
          title: candidate.work,
          owner: "Alice",
          evidence: candidate.quote,
          handoff: operationalHandoff({
            evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
          }),
        },
      ],
    });
    let ids: string[] = [];
    let repairs = 0;
    const detail = await extract(async (request) => {
      if (request.system.startsWith("DISCOVER CANDIDATES"))
        return { candidates: [candidate, candidate] };
      if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) {
        ids = (
          JSON.parse(
            request.user.split("<checked-actions>\n")[1].split("\n</checked-actions>")[0],
          ) as { candidateId: string }[]
        ).map((row) => row.candidateId);
        return {
          groups: [
            {
              verdict: "same_deliverable",
              candidateIds: ids,
              reason: "Same deliverable",
              evidence: ["@line:99:59"],
            },
          ],
        };
      }
      if (request.system.startsWith("REPAIR CHECKED DUPLICATES")) {
        repairs++;
        expect(request.user).toContain("@line:1 [00:01");
        return {
          groups: [
            {
              verdict: "same_deliverable",
              candidateIds: ids,
              reason: "Same source promise",
              evidence: [stillInvalid ? "@line:99:59" : "@line:1"],
            },
          ],
          corrections: [],
        };
      }
      return model(request);
    });
    expect(repairs).toBe(1);
    expect(detail.status).toBe(stillInvalid ? "failed" : "done");
    if (stillInvalid) expect(detail.extraction).toBeNull();
    else expect(detail.extraction?.actionItems).toHaveLength(1);
  },
);

it("checks final coverage and verifies a missing booking prerequisite separately from the session", async () => {
  const actions = [
    {
      title: "Hold the workshop",
      quote: "We will hold the workshop next week.",
      owner: "Speaker 1",
    },
    {
      title: "Find a suitable time and book the workshop",
      quote: "I will find a time suitable for everyone and book it.",
      owner: "Speaker 2",
    },
  ].map((item) => ({
    title: item.title,
    evidence: item.quote,
    owner: item.owner,
    handoff: operationalHandoff({
      responsibility: { names: [item.owner], basis: "explicit", reason: "Source promise" },
      evidence: [{ quote: item.quote, speaker: item.owner, timestamp: null }],
    }),
  }));
  const model = accountedHandoffModel({ ...overview, actionItems: actions });
  let finalChecks = 0;
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES"))
      return {
        candidates: [{ work: actions[0].title, quote: actions[0].evidence, speaker: "Speaker 1" }],
      };
    if (request.system.startsWith("AUDIT FINAL COVERAGE")) {
      finalChecks++;
      expect(request.user).toContain("Hold the workshop");
      return { candidates: [{ work: actions[1].title, quote: "@line:2", speaker: "Speaker 2" }] };
    }
    return model(request);
  }, `Speaker 1: ${actions[0].evidence}\nSpeaker 2: ${actions[1].evidence}`);
  expect(finalChecks).toBe(1);
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toMatchObject([
    { title: actions[0].title, owner: "Speaker 1" },
    {
      title: actions[1].title,
      owner: "Speaker 2",
      handoff: { evidence: [{ quote: actions[1].evidence, speaker: "Speaker 2" }] },
    },
  ]);
});

it("reconciles a mistaken checked date from source before merging duplicate deliverables", async () => {
  const quote = "I will review the draft tomorrow.";
  const action = {
    title: "Review the draft",
    owner: "Alice",
    dueDate: "2026-09-10",
    evidence: quote,
    handoff: operationalHandoff({ evidence: [{ quote, speaker: "Alice", timestamp: null }] }),
  };
  const model = accountedHandoffModel({ ...overview, actionItems: [action] });
  let rows: { candidateId: string; facts: ReturnType<typeof checkedCandidateFacts> }[] = [];
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES"))
      return { candidates: [0, 1].map(() => ({ work: action.title, quote, speaker: "Alice" })) };
    if (request.system.startsWith("VERIFY ACTION FACTS")) {
      const result = (await model(request)) as {
        dispositions: { facts: ReturnType<typeof checkedCandidateFacts> }[];
      };
      result.dispositions[0].facts.dueDate = "2026-09-09";
      return result;
    }
    if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) {
      rows = JSON.parse(
        request.user.split("<checked-actions>\n")[1].split("\n</checked-actions>")[0],
      );
      return {
        groups: [
          {
            verdict: "same_deliverable",
            candidateIds: rows.map((row) => row.candidateId),
            reason: "Same draft promise",
            evidence: ["@line:1"],
          },
        ],
      };
    }
    if (request.system.startsWith("REPAIR CHECKED DUPLICATES"))
      return {
        groups: [
          {
            verdict: "same_deliverable",
            candidateIds: rows.map((row) => row.candidateId),
            reason: "The same draft and explicit tomorrow date",
            evidence: ["@line:1"],
          },
        ],
        corrections: [
          {
            candidateId: rows[0].candidateId,
            facts: {
              ...checkedCandidateFacts(action),
              evidence: [{ quote: "@line:1", speaker: null, timestamp: null }],
            },
          },
        ],
      };
    return model(request);
  }, `Alice: ${quote}`);
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toHaveLength(1);
  expect(detail.extraction?.actionItems[0]).toMatchObject({
    owner: "Alice",
    dueDate: "2026-09-10",
    handoff: { evidence: [{ quote, speaker: "Alice" }] },
  });
});

it.each([false, true])(
  "binds a repeated acceptance turn, repairing the wrong speaker when needed (%s)",
  async (repair) => {
    const quote = "Alice, please send the document.";
    const model = accountedHandoffModel({
      ...overview,
      actionItems: [
        {
          title: "Send the document",
          owner: "Alice",
          evidence: quote,
          handoff: operationalHandoff({
            responsibility: {
              names: ["Alice"],
              basis: "explicit",
              reason: "Alice accepted the request",
            },
            evidence: [{ quote, speaker: "Bob", timestamp: null }],
          }),
        },
      ],
    });
    const detail = await extract(async (request) => {
      if (request.system.startsWith("VERIFY RESPONSIBILITY")) {
        const rows = JSON.parse(
          request.user.split("<checked-actions>\n")[1].split("\n</checked-actions>")[0],
        ) as { candidateId: string }[];
        return {
          responsibilities: rows.map((row) => ({
            candidateId: row.candidateId,
            responsibility: {
              names: ["Alice"],
              basis: "explicit",
              reason: "Alice accepts Bob's request at line 2",
            },
            bindings: [
              {
                name: "Alice",
                evidence: [
                  repair && !request.user.includes("<unsupported-source-bindings>")
                    ? "@line:3"
                    : "@line:2",
                ],
              },
            ],
          })),
        };
      }
      return model(request);
    }, `Bob: ${quote}\nAlice: Okay.\nBob: Okay.`);
    expect(detail.status).toBe("done");
    expect(detail.extraction?.actionItems[0]).toMatchObject({
      owner: "Alice",
      handoff: { responsibility: { names: ["Alice"], basis: "explicit" } },
    });
  },
);

it.each([false, true])(
  "resolves first-name assignments only when the speaker is unambiguous (%s)",
  async (ambiguous) => {
    const quote = "Alice will send the document tomorrow.";
    const model = accountedHandoffModel({
      ...overview,
      actionItems: [
        {
          title: "Send the document",
          owner: "Alice Brown",
          evidence: quote,
          handoff: operationalHandoff({
            responsibility: {
              names: ["Alice Brown"],
              basis: "explicit",
              reason: "Bob assigns the document to Alice",
            },
            evidence: [{ quote, speaker: "Bob", timestamp: null }],
          }),
        },
      ],
    });
    const detail = await extract(
      async (request) => {
        if (request.system.startsWith("VERIFY RESPONSIBILITY")) {
          const rows = JSON.parse(
            request.user.split("<checked-actions>\n")[1].split("\n</checked-actions>")[0],
          ) as { candidateId: string }[];
          return {
            responsibilities: rows.map((row) => ({
              candidateId: row.candidateId,
              responsibility: {
                names: ["Alice Brown"],
                basis: "explicit",
                reason: "Bob assigns the document to the only Alice in this meeting",
              },
              bindings: [{ name: "Alice Brown", evidence: [ambiguous ? "@line:3" : "@line:2"] }],
            })),
          };
        }
        return model(request);
      },
      `Alice Brown: Hello.\n${ambiguous ? "Alice Green: Hello.\n" : ""}Bob: ${quote}`,
    );
    expect(detail.status).toBe(ambiguous ? "failed" : "done");
    if (ambiguous) expect(detail.extraction).toBeNull();
    else expect(detail.extraction?.actionItems[0].owner).toBe("Alice Brown");
  },
);

it("preserves a separate-deliverables verdict even when the people and dates match", async () => {
  const actions = [
    { title: "Email the document", quote: "I will email the document tomorrow." },
    { title: "Call the supplier", quote: "I will call the supplier tomorrow." },
  ].map((item) => ({
    title: item.title,
    evidence: item.quote,
    owner: "Alice",
    handoff: operationalHandoff({
      evidence: [{ quote: item.quote, speaker: "Alice", timestamp: null }],
    }),
  }));
  const model = accountedHandoffModel({ ...overview, actionItems: actions });
  const detail = await extract(
    async (request) => {
      if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) {
        const rows = JSON.parse(
          request.user.split("<checked-actions>\n")[1].split("\n</checked-actions>")[0],
        ) as { candidateId: string }[];
        return {
          groups: [
            {
              candidateIds: rows.map((row) => row.candidateId),
              verdict: "separate",
              reason: "Emailing the document and calling the supplier are different deliverables",
              evidence: ["@line:1", "@line:2"],
            },
          ],
        };
      }
      return model(request);
    },
    actions.map((action) => `Alice: ${action.evidence}`).join("\n"),
  );
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems.map((item) => item.title)).toEqual(
    actions.map((action) => action.title),
  );
});

it("keeps a proposed pricing model out of settled decisions", async () => {
  const quote = "We could sell the proposed course for a one-time fee with annual maintenance.";
  const model = accountedHandoffModel({ ...overview, actionItems: [] });
  const detail = await extract(async (request) => {
    if (request.system.startsWith("OVERVIEW ONLY"))
      return {
        ...overview,
        decisions: [
          {
            statement: "Sell the course for a one-time fee with annual maintenance",
            evidence: "@line:1",
          },
        ],
      };
    if (request.system.startsWith("VERIFY DECISION STATUS"))
      return {
        decisions: [
          {
            decisionId: "decision-0",
            status: "proposal",
            reason: "A hypothetical commercial model, not an adopted decision",
            evidence: ["@line:1"],
          },
        ],
      };
    return model(request);
  }, `Alice: ${quote}`);
  expect(detail.status).toBe("done");
  expect(detail.extraction?.decisions).toEqual([]);
});

it("reconciles duplicate facts explicitly when a merge repair describes agreement but omits corrections", async () => {
  const quote = "I will review the draft tomorrow.";
  const action = {
    title: "Review the draft",
    owner: "Alice",
    dueDate: "2026-09-10",
    evidence: quote,
    handoff: operationalHandoff({ evidence: [{ quote, speaker: "Alice", timestamp: null }] }),
  };
  const model = accountedHandoffModel({ ...overview, actionItems: [action] });
  let ids: string[] = [];
  const detail = await extract(async (request) => {
    if (request.system.startsWith("DISCOVER CANDIDATES"))
      return { candidates: [0, 1].map(() => ({ work: action.title, quote, speaker: "Alice" })) };
    if (request.system.startsWith("VERIFY ACTION FACTS")) {
      const result = (await model(request)) as {
        dispositions: { facts: ReturnType<typeof checkedCandidateFacts> }[];
      };
      result.dispositions[0].facts.dueDate = "2026-09-09";
      return result;
    }
    if (request.system.startsWith("DEDUPE CHECKED ACTIONS")) {
      ids = (
        JSON.parse(
          request.user.split("<checked-actions>\n")[1].split("\n</checked-actions>")[0],
        ) as { candidateId: string }[]
      ).map((row) => row.candidateId);
      return {
        groups: [
          {
            candidateIds: ids,
            verdict: "same_deliverable",
            reason: "One draft",
            evidence: ["@line:1"],
          },
        ],
      };
    }
    if (request.system.startsWith("REPAIR CHECKED DUPLICATES"))
      return {
        groups: [
          {
            candidateIds: ids,
            verdict: "same_deliverable",
            reason: "The source establishes the same tomorrow date",
            evidence: ["@line:1"],
          },
        ],
        corrections: [],
      };
    if (request.system.startsWith("RECONCILE DUPLICATE FACTS"))
      return {
        verdict: "same_deliverable",
        reason: "One draft and one explicit tomorrow deadline",
        facts: {
          ...checkedCandidateFacts(action),
          evidence: [{ quote: "@line:1", speaker: null, timestamp: null }],
        },
      };
    return model(request);
  }, `Alice: ${quote}`);
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toHaveLength(1);
  expect(detail.extraction?.actionItems[0]).toMatchObject({
    owner: "Alice",
    dueDate: "2026-09-10",
  });
});

it("bounds concurrent extraction work without serializing independent candidate batches and actions", async () => {
  const actionItems = Array.from({ length: 11 }, (_, index) => {
    const quote = `I will deliver report ${index} tomorrow.`;
    return {
      title: `Deliver report ${index}`,
      evidence: quote,
      owner: "Alice",
      handoff: operationalHandoff({
        evidence: [{ quote, speaker: "Alice", timestamp: null }],
      }),
    };
  });
  const model = accountedHandoffModel({ ...overview, actionItems });
  let active = 0;
  let maximum = 0;
  const byStage = new Map<string, number>();
  const maximumByStage = new Map<string, number>();
  const detail = await extract(
    async (request) => {
      const stage = request.system.split("\n")[0];
      active++;
      maximum = Math.max(maximum, active);
      const count = (byStage.get(stage) ?? 0) + 1;
      byStage.set(stage, count);
      maximumByStage.set(stage, Math.max(maximumByStage.get(stage) ?? 0, count));
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await model(request);
      } finally {
        active--;
        byStage.set(stage, (byStage.get(stage) ?? 1) - 1);
      }
    },
    actionItems.map((action) => `Alice: ${action.evidence}`).join("\n"),
  );
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems.map((action) => action.title)).toEqual(
    actionItems.map((action) => action.title),
  );
  expect(maximum).toBeLessThanOrEqual(4);
  expect(maximumByStage.get("CLASSIFY SOURCE STATUS")).toBeGreaterThan(1);
  expect(maximumByStage.get("ENRICH CANDIDATE")).toBeGreaterThan(1);
});

it("resumes a failed extraction without repeating successful model requests", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        handoff: operationalHandoff({
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  const counts = new Map<string, number>();
  let failed = false;
  const detail = await extract(
    async (request) => {
      const stage = request.system.split("\n")[0];
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
      if (stage === "VERIFY RESPONSIBILITY" && counts.get(stage) === 1) {
        const invalid = responsibilityFixture(request);
        for (const row of invalid.responsibilities)
          for (const binding of row.bindings) binding.evidence = ["@line:99999"];
        return invalid;
      }
      if (stage === "OVERVIEW ONLY" && !failed) {
        failed = true;
        throw new Error("Provider timed out after the action checks succeeded");
      }
      return model(request);
    },
    undefined,
    true,
  );
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toHaveLength(1);
  expect(counts.get("OVERVIEW ONLY")).toBe(2);
  expect(counts.get("DISCOVER CANDIDATES")).toBe(1);
  expect(counts.get("ENRICH CANDIDATE")).toBe(1);
  expect(counts.get("VERIFY RESPONSIBILITY")).toBe(2);
});

it("uses source references instead of repeating literal evidence in the final coverage ledger", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        handoff: operationalHandoff({
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  let audited = false;
  const detail = await extract(async (request) => {
    if (request.system.startsWith("AUDIT FINAL COVERAGE")) {
      const ledger = request.user
        .split("<verified-dispositions>\n")[1]
        .split("\n</verified-dispositions>")[0];
      expect(ledger).toContain('"quote":"@line:1"');
      expect(ledger).not.toContain(candidate.quote);
      expect(request.user).toContain(`@line:1 [00:01–00:05] Alice: ${candidate.quote}`);
      audited = true;
    }
    return model(request);
  });
  expect(audited).toBe(true);
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems[0].handoff?.evidence[0].quote).toBe(candidate.quote);
});

it("does not offer blank transcript lines as evidence references", async () => {
  const model = accountedHandoffModel({ ...overview, actionItems: [] });
  const requests: string[] = [];
  const detail = await extract(async (request) => {
    requests.push(request.user);
    return model(request);
  }, "Alice: We discussed the plan.\n\nAlice: No follow-up is needed.");
  expect(detail.status).toBe("done");
  expect(requests.every((text) => !/^@line:2\s*$/m.test(text))).toBe(true);
  expect(requests.some((text) => text.includes("@line:3 Alice:"))).toBe(true);
});

it("accepts a validated bare discovery array without losing candidate accounting", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        handoff: operationalHandoff({
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  const detail = await extract(async (request) =>
    request.system.startsWith("DISCOVER CANDIDATES") ? [candidate] : model(request),
  );
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toHaveLength(1);
});

it("retries a semantically invalid repair instead of replaying it forever", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        handoff: operationalHandoff({
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  let responsibilityCalls = 0;
  const detail = await extract(
    async (request) => {
      if (request.system.startsWith("VERIFY RESPONSIBILITY")) {
        responsibilityCalls++;
        const result = responsibilityFixture(request);
        if (responsibilityCalls === 2) {
          const contextual = structuredClone(result);
          contextual.responsibilities[0].responsibility.basis = "explicit";
          contextual.responsibilities[0].bindings[0].evidence = ["@line:6"];
          expect(request.schema.safeParse(contextual).success).toBe(false);
          contextual.responsibilities[0].responsibility.basis = "inferred";
          expect(request.schema.safeParse(contextual).success).toBe(true);
        }
        if (responsibilityCalls <= 2)
          for (const row of result.responsibilities)
            for (const binding of row.bindings) binding.evidence = ["@line:99999"];
        return result;
      }
      return model(request);
    },
    undefined,
    true,
  );
  expect(detail.status).toBe("done");
  expect(responsibilityCalls).toBe(3);
  expect(detail.extraction?.actionItems).toHaveLength(1);
});

it("constrains status repair evidence to spoken source IDs in the provider schema", async () => {
  const model = accountedHandoffModel({
    ...overview,
    actionItems: [
      {
        title: candidate.work,
        evidence: candidate.quote,
        owner: "Alice",
        handoff: operationalHandoff({
          evidence: [{ quote: candidate.quote, speaker: "Alice", timestamp: null }],
        }),
      },
    ],
  });
  let calls = 0;
  const detail = await extract(async (request) => {
    if (request.system.startsWith("CLASSIFY SOURCE STATUS")) {
      calls++;
      const result = sourceStatusFixture(request);
      result.dispositions[0].evidence = ["@line:2"];
      if (calls === 2) {
        expect(request.schema.safeParse(result).success).toBe(false);
        result.dispositions[0].evidence = ["@line:1"];
        expect(request.schema.safeParse(result).success).toBe(true);
      }
      return result;
    }
    return model(request);
  }, `Alice: ${candidate.quote}\n\nAlice: End of meeting.`);
  expect(calls).toBe(2);
  expect(detail.status).toBe("done");
});

it("repairs only invalid responsibility rows without reopening validated assignments", async () => {
  const actionItems = ["Email Bob", "Call Carol"].map((title) => ({
    title,
    evidence: `I will ${title.toLowerCase()}.`,
    owner: "Alice",
    handoff: operationalHandoff({
      evidence: [{ quote: `I will ${title.toLowerCase()}.`, speaker: "Alice", timestamp: null }],
    }),
  }));
  const model = accountedHandoffModel({ ...overview, actionItems });
  let calls = 0;
  const detail = await extract(
    async (request) => {
      if (request.system.startsWith("VERIFY RESPONSIBILITY")) {
        calls++;
        const result = responsibilityFixture(request);
        if (calls === 1) result.responsibilities[0].bindings[0].evidence = ["@line:99999"];
        if (calls === 2) expect(result.responsibilities).toHaveLength(1);
        return result;
      }
      return model(request);
    },
    actionItems.map((action) => `Alice: ${action.evidence}`).join("\n"),
  );
  expect(calls).toBe(2);
  expect(detail.status).toBe("done");
  expect(detail.extraction?.actionItems).toHaveLength(2);
});

it("rejects ambiguous timestamp evidence instead of choosing one speaker's turn", async () => {
  const model = accountedHandoffModel({ ...overview, actionItems: [] });
  const detail = await extract(async (request) => {
    if (
      request.system.startsWith("DISCOVER CANDIDATES") ||
      request.system.startsWith("AUDIT SOURCE COVERAGE")
    )
      return { candidates: [{ ...candidate, quote: "@line:00:01" }] };
    return model(request);
  }, `[00:01] Alice: ${candidate.quote}\n[00:01] Bob: I disagree.`);
  expect(detail.status).toBe("failed");
  expect(detail.extraction).toBeNull();
});
