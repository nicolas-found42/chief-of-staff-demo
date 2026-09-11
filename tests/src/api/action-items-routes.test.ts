import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActionItem,
  ActionItemIndex,
  DebriefSectionName,
  IdentityDecision,
  MeetingDebriefActionItem,
  MeetingDebriefExtraction,
  TranscriptMention,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { DEBRIEF_SECTIONS, actionItemProposal } from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { materializationIndex } from "../../../apps/server/src/tasks/materialization";
import { MeetingDebriefHost } from "../../../apps/server/src/modules/meeting-debrief/host";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { operationalHandoff } from "../helpers/operational-handoff";

/**
 * Action Items materialized from a Meeting Debrief (issue #177): the Debrief
 * produces them, the Workspace owns them, and the Tasks product reads them
 * without treating one as a Task. The Debrief Host is the real one — its
 * extraction is the only thing standing in — so the hand-off proven here is
 * the hand-off production performs.
 */
let app: FastifyInstance;
let workspaceDir: string;
let runs: Runs;
let host: MeetingDebriefHost;
let ownerProfileId: string | null;
let actionItems: WorkspaceActionItems;
/** What the stand-in extraction proposes; set per test. */
let proposed: MeetingDebriefActionItem[];
/** The Catalog review state the Debrief resolves owners against; set per test. */
let identityReview: { mentions: TranscriptMention[]; decisions: IdentityDecision[] };
const sectionFailures = new Set<DebriefSectionName>();

/** The selected proposal of the queued item with that title. */
function proposalOf(byTitle: Map<string, ActionItem>, title: string) {
  const item = byTitle.get(title);
  if (!item) throw new Error(`No queued Action Item titled ${title}`);
  return actionItemProposal(item);
}

function record(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    id: "drive_fileA_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "fileA",
      fileName: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
      sourceUrl: null,
      checksum: "deadbeef",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: "Alice: We decided to ship on Friday.\n",
    meetingDate: "2026-08-17",
    occurrence: null,
    speakers: ["Alice"],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: "meeting_1",
    association: null,
    ...overrides,
  };
}

/** One mined mention, as the Catalog holds it. */
function mention(id: string, surfaceText: string): TranscriptMention {
  return {
    id,
    kind: "person",
    surfaceText,
    normalizedForms: [surfaceText.toLowerCase()],
    emails: [],
    profileUrls: [],
    verifiedHandles: {},
    externalContactIds: [],
    speakerCalendarEmail: null,
    titles: [],
    roles: [],
    aliases: [],
    relationshipAssertions: [],
    rosterContext: [],
    organizationContext: null,
    attendeeStatus: "speaker",
    confidence: "high",
    provenance: {
      transcriptId: "drive_fileA_r1",
      spanStart: 0,
      spanEnd: surfaceText.length,
      quote: surfaceText,
      timestamp: null,
      speakerLabel: null,
      meetingDate: null,
    },
    minedAt: "2026-08-31T12:00:00.000Z",
    algorithmVersion: 1,
  };
}

/** The owner's review decision linking one mention to a Person Profile. */
function linked(mentionId: string, profileId: string): IdentityDecision {
  return {
    id: `decision_${mentionId}`,
    mentionId,
    transcriptId: "drive_fileA_r1",
    action: "confirm",
    outcome: "linked",
    profileId,
    profileRevision: 1,
    decidedBy: "owner",
    decidedAt: "2026-08-31T12:00:00.000Z",
    note: null,
    mappingAuthority: null,
  };
}

function proposal(overrides: Partial<MeetingDebriefActionItem> = {}): MeetingDebriefActionItem {
  return {
    title: "Follow up on the billing fix",
    owner: "Alice",
    ownerMentionId: "m_alice",
    ownerProfileId: null,
    dueDate: "2026-08-22",
    ...overrides,
  };
}

function extraction(): MeetingDebriefExtraction {
  return {
    version: 1,
    summary: "Review of the weekly sync",
    decisions: [],
    actionItems: proposed,
    openQuestions: [],
    effectivenessEvidence: "",
    coachingAdvice: "",
    suggestedRecipients: [],
  };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-action-items-"));
  runs = openRuns(workspaceDir);
  ownerProfileId = null;
  proposed = [proposal()];
  identityReview = { mentions: [], decisions: [] };
  sectionFailures.clear();
  const store = new TaskStore(workspaceDir);
  actionItems = new WorkspaceActionItems({
    store,
    now: () => new Date("2026-09-04T09:00:00.000Z"),
    ownerProfileId: () => ownerProfileId,
  });
  host = new MeetingDebriefHost({
    runs,
    catalog: { getTranscript: (id) => (id === "drive_fileA_r1" ? record() : null) },
    identity: {
      reviewFor: () => ({ ...identityReview, organizations: [] }),
    },
    extract: () => Promise.resolve(extraction()),
    /* The harness declares which sections its extraction cannot produce
       (#345); the checked Action Items are unaffected. */
    sections: () =>
      DEBRIEF_SECTIONS.map((name) => ({
        name,
        state: sectionFailures.has(name) ? ("failed" as const) : ("validated" as const),
        reason: sectionFailures.has(name) ? "the section provider refused" : null,
      })),
    /* The coordinated materialization (#358) answers with the exact
       mappings the checked entries became, which is what the publication's
       manifest records. */
    materializeActionItems: (handover) =>
      [...materializationIndex(actionItems.materialize(handover)).values()].filter(
        (mapping) => mapping.debriefRunId === handover.debriefRunId,
      ),
    log: () => {},
  });
  app = fastify();
  /* The Debrief's own routes too: regeneration is reached the way the review
     surface reaches it, not by calling into the Module. */
  host.routes(app);
  registerTasksApi(app, {
    tasks: new WorkspaceTasks({ store, now: () => new Date("2026-09-04T09:00:00.000Z") }),
    actionItems,
  });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

/** Run one Debrief to completion and answer with the Run's id. */
async function debrief(): Promise<string> {
  await host.process(record());
  await host.idle();
  const runIds = runs.list({ module: "meeting-debrief" }).runs.map((entry) => entry.id);
  expect(runIds).toHaveLength(1);
  return runIds[0];
}

async function queue(query = ""): Promise<ActionItem[]> {
  const response = await app.inject({ method: "GET", url: `/api/action-items${query}` });
  expect(response.statusCode).toBe(200);
  return response.json<ActionItemIndex>().items;
}

describe("materializing Action Items from a Debrief", () => {
  it("preserves execution context and shared responsibility through canonical promotion", async () => {
    const handoff = {
      version: 1 as const,
      commitment: "explicit" as const,
      purpose: "Make the rollout verifiable",
      responsibility: {
        names: ["Alice", "Bob"],
        basis: "explicit" as const,
        reason: "We will do this together",
      },
      completionCriteria: [{ text: "A recorded successful rollout", basis: "inferred" as const }],
      requiredInputs: ["Rollout plan"],
      missingInputs: [
        {
          information: "Deployment access",
          obtainBy: "Ask the deployment administrator",
          basis: "inferred" as const,
        },
      ],
      dependencies: [
        {
          actionTitle: "Approve the rollout plan",
          condition: "Only after approval",
          basis: "explicit" as const,
        },
      ],
      timing: {
        kind: "deadline" as const,
        stated: "After approval",
        referenceDate: "2026-08-17",
        reasoning: "A trigger, not a deadline",
      },
      evidence: [{ quote: "We will do this together", speaker: "Alice", timestamp: "01:12" }],
      statusReasoning: "The rollout is still outstanding",
    };
    proposed = [{ ...proposal(), handoff }];
    await debrief();
    const [item] = await queue();
    expect(item).toMatchObject({ handoff });
    expect(actionItemProposal(item).responsiblePerson).toBeNull();
    const response = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    const task = response.json<{ task: { notes: string; source: { actionItemId: string } } }>()
      .task;
    expect(task.notes).toContain("Make the rollout verifiable");
    expect(task.notes).toContain("[inferred] A recorded successful rollout");
    expect(task.notes).toContain("Ask the deployment administrator");
    expect(task.notes).toContain("We will do this together");
    expect(task.source.actionItemId).toBe(item.id);
  });

  it("records one Action Item per proposed commitment, retaining its whole source", async () => {
    proposed = [proposal(), proposal({ title: "Send Bob the rollout plan", owner: "Bob" })];

    const runId = await debrief();

    const items = await queue();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: {
        debriefRunId: runId,
        transcriptId: "drive_fileA_r1",
        meetingId: "meeting_1",
      },
      extractionRevision: 1,
      evidence: { responsibleMentionId: "m_alice", responsibleSurfaceName: "Alice" },
      state: "pending",
      promotedTaskId: null,
      decidedAt: null,
      createdAt: "2026-09-04T09:00:00.000Z",
    });
    expect(actionItemProposal(items[0])).toEqual({
      title: "Follow up on the billing fix",
      notes: "",
      dueDate: "2026-08-22",
      responsiblePerson: null,
    });
  });

  it("proposes the owner when the Catalog resolved the commitment to the owner's Profile", async () => {
    ownerProfileId = "profile_owner";
    identityReview = {
      mentions: [mention("m_alice", "Alice"), mention("m_bob", "Bob")],
      decisions: [linked("m_alice", "profile_owner"), linked("m_bob", "profile_bob")],
    };
    proposed = [
      proposal(),
      proposal({ title: "Bob's item", owner: "Bob", ownerMentionId: "m_bob" }),
      proposal({ title: "Nobody's item", owner: null, ownerMentionId: null }),
    ];

    await debrief();

    const byTitle = new Map((await queue()).map((item) => [actionItemProposal(item).title, item]));
    expect(proposalOf(byTitle, "Follow up on the billing fix").responsiblePerson).toEqual({
      kind: "owner",
    });
    expect(proposalOf(byTitle, "Bob's item").responsiblePerson).toEqual({
      kind: "person-profile",
      profileId: "profile_bob",
    });
    expect(proposalOf(byTitle, "Nobody's item").responsiblePerson).toBeNull();
  });

  it("stages a regenerated proposal beside the decisions already made", async () => {
    const runId = await debrief();
    const first = await queue();
    expect(first).toHaveLength(1);

    proposed = [proposal(), proposal({ title: "Book the follow-up session" })];
    const regenerated = await app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "actionItems" },
    });
    expect(regenerated.statusCode).toBe(200);
    await host.idle();

    const after = await queue();
    expect(after).toHaveLength(2);
    /* The proposal that came back unchanged is the same record it was — a
       regeneration reconciles, it does not replace. */
    expect(after[0]).toEqual(first[0]);
    expect(after[1]).toMatchObject({ extractionRevision: 2, state: "pending" });
    expect(actionItemProposal(after[1]).title).toBe("Book the follow-up session");
  });
  it("preserves a dismissed decision across regeneration and stages the newcomer", async () => {
    const runId = await debrief();
    const [first] = await queue();
    const dismissed = await app.inject({
      method: "POST",
      url: `/api/action-items/${first.id}/dismiss`,
    });
    expect(dismissed.statusCode).toBe(200);
    proposed = [proposal(), proposal({ title: "Book the follow-up session" })];
    const regenerated = await app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "actionItems" },
    });
    expect(regenerated.statusCode).toBe(200);
    await host.idle();
    const after = await queue();
    expect(after).toHaveLength(2);
    expect(after.find((item) => item.id === first.id)).toMatchObject({
      state: "dismissed",
      extractionRevision: 1,
    });
    expect(
      after.find((item) => actionItemProposal(item).title === "Book the follow-up session"),
    ).toMatchObject({
      state: "pending",
      extractionRevision: 2,
    });
    const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(tasks.json<{ tasks: unknown[] }>().tasks).toEqual([]);
  });

  it("preserves a promoted decision across regeneration without touching its Task", async () => {
    const runId = await debrief();
    const [first] = await queue();
    const promoted = await app.inject({
      method: "POST",
      url: `/api/action-items/${first.id}/promote`,
      payload: { title: "Accepted billing follow-up", notes: "Owner edited notes" },
    });
    expect(promoted.statusCode).toBe(201);
    const taskId = promoted.json<{ task: { id: string } }>().task.id;
    proposed = [proposal(), proposal({ title: "Book the follow-up session" })];
    const regenerated = await app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "actionItems" },
    });
    expect(regenerated.statusCode).toBe(200);
    await host.idle();
    const after = await queue();
    expect(after.find((item) => item.id === first.id)).toMatchObject({
      state: "promoted",
      promotedTaskId: taskId,
    });
    expect(
      after.find((item) => actionItemProposal(item).title === "Book the follow-up session"),
    ).toMatchObject({
      state: "pending",
    });
    const task = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    expect(task.json<{ title: string; notes: string }>()).toMatchObject({
      title: "Accepted billing follow-up",
      notes: "Owner edited notes",
    });
    const allTasks = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(allTasks.json<{ tasks: unknown[] }>().tasks).toHaveLength(1);
  });

  it("keeps the records and their identities across a restart of the application", async () => {
    const runId = await debrief();
    const before = await queue();

    await app.close();
    const store = new TaskStore(workspaceDir);
    app = fastify();
    registerTasksApi(app, {
      tasks: new WorkspaceTasks({ store }),
      actionItems: new WorkspaceActionItems({ store }),
    });
    await app.ready();

    expect(await queue()).toEqual(before);
    expect(before[0]?.source.debriefRunId).toBe(runId);
  });
});

/**
 * Re-extraction properties at the materialization seam itself. A Debrief Run
 * is created once per Transcript, so the Host cannot re-extract one — but
 * regeneration will, and these are the guarantees it depends on.
 */
describe("accepting work out of an incomplete Debrief (#345)", () => {
  beforeEach(() => {
    /* The harness's extraction is complete; the revision's availability is
       what makes the Action Items review-only, exactly as the Module reads it
       from the reconciler. */
    sectionFailures.clear();
  });

  async function incompleteDebrief(): Promise<string> {
    sectionFailures.add("coachingAdvice");
    return debrief();
  }

  it("refuses a promotion until the missing content is acknowledged", async () => {
    await incompleteDebrief();
    const [item] = await queue();
    expect(item.source.reviewOnly).toBe(true);

    /* Fail closed: no field, a false field and a truthy non-boolean all refuse
       rather than being read as consent. */
    for (const payload of [
      {},
      { missingContentAcknowledged: false },
      { missingContentAcknowledged: "yes" },
    ]) {
      const refused = await app.inject({
        method: "POST",
        url: `/api/action-items/${item.id}/promote`,
        payload,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("action-item-missing-content-acknowledgment");
    }
    expect((await queue()).find((entry) => entry.id === item.id)?.state).toBe("pending");

    const accepted = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: { missingContentAcknowledged: true },
    });
    expect(accepted.statusCode).toBe(201);
    const body = accepted.json<{ task: { id: string }; actionItem: ActionItem }>();
    expect(body.actionItem.state).toBe("promoted");
    expect(body.actionItem.promotedTaskId).toBe(body.task.id);
    /* The acknowledgment is part of the decision history, not a request-only
       detail that vanishes once the Task exists. */
    expect(body.actionItem.decisions.at(-1)).toMatchObject({
      kind: "promote",
      missingContentAcknowledged: true,
    });
  });

  it("accepts a complete Debrief's Action Item without any acknowledgment", async () => {
    await debrief();
    const [item] = await queue();
    expect(item.source.reviewOnly).toBeUndefined();
    const accepted = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });
    expect(accepted.statusCode).toBe(201);
    const acceptedBody = accepted.json<{ actionItem: ActionItem }>();
    expect(acceptedBody.actionItem.decisions.at(-1)).not.toHaveProperty(
      "missingContentAcknowledged",
    );
  });
});

describe("re-extracting one Debrief", () => {
  function materialize(actionItems_: MeetingDebriefActionItem[]): ActionItem[] {
    return actionItems.materialize({
      debriefRunId: "run_1",
      transcriptId: "drive_fileA_r1",
      meetingId: "meeting_1",
      actionItems: actionItems_,
    });
  }

  it("gives an Action Item an identity that does not move when the proposals do", () => {
    const bob = proposal({ title: "Send Bob the rollout plan", owner: "Bob" });
    const first = materialize([proposal(), bob]).map((item) => item.id);

    const reordered = materialize([bob, proposal()]).map((item) => item.id);

    expect(reordered).toEqual([...first].reverse());
  });

  it("adds nothing and changes no record when the same commitments come back", () => {
    const before = materialize([proposal()]);

    expect(materialize([proposal()])).toEqual(before);
    expect(actionItems.list()).toEqual(before);
  });

  it("counts a genuinely new proposal as the next extraction revision", () => {
    materialize([proposal()]);

    materialize([proposal(), proposal({ title: "Book the follow-up session" })]);

    expect(
      actionItems
        .list()
        .map((item) => item.extractionRevision)
        .sort(),
    ).toEqual([1, 2]);
  });
});

describe("reading the Action Item queue", () => {
  it("lists by state and by source", async () => {
    const runId = await debrief();

    expect(await queue("?state=pending")).toHaveLength(1);
    expect(await queue("?state=promoted")).toEqual([]);
    expect(await queue("?state=dismissed")).toEqual([]);
    expect(await queue(`?debriefRunId=${runId}`)).toHaveLength(1);
    expect(await queue("?transcriptId=drive_fileA_r1")).toHaveLength(1);
    expect(await queue("?meetingId=meeting_1")).toHaveLength(1);
    expect(await queue("?meetingId=meeting_other")).toEqual([]);
  });

  it("does not present an Action Item as a Task", async () => {
    await debrief();

    const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(tasks.json<{ tasks: unknown[] }>().tasks).toEqual([]);
  });
});

it("Meeting-filtered review includes source context and truthful missing evidence", async () => {
  await debrief();
  const response = await app.inject("/api/action-items?meetingId=meeting_1&state=pending");
  const body = response.json();
  expect(body.items).toHaveLength(1);
  expect(body.context[body.items[0].id]).toMatchObject({ meeting: null, evidence: null });
});

/**
 * Handoff provenance and stable dependency references (MWR-046/047/048, spec
 * #347). The accepted Task snapshot carries the same labels the review showed,
 * and a dependency resolves to the record it named — never to a guessed id and
 * never to a Task nobody accepted.
 */
describe("handoff provenance and dependency references", () => {
  const supported = (quote: string) => ({ quote, speaker: "Alice", timestamp: "01:12" });

  /** One proposal whose execution detail depends on what the caller names. */
  function dependent(
    ...dependencies: Array<{ actionTitle: string; references: "extracted" | "external" }>
  ) {
    return proposal({
      title: "Follow up on the billing fix",
      handoff: {
        ...operationalHandoff(),
        purpose: {
          text: "Let the team review the rollout",
          provenance: "supported",
          sources: [supported("We will do this together")],
        },
        completionCriteria: [
          { text: "A recorded successful rollout", provenance: "suggested", sources: [] },
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
        dependencies: dependencies.map((dependency) => ({
          ...dependency,
          condition: "Only after approval",
          provenance: "suggested" as const,
          sources: [],
        })),
      },
    });
  }

  async function referencesFor(items: ActionItem[], title: string) {
    const index = (await app.inject("/api/action-items")).json<ActionItemIndex>();
    const item = items.find((entry) => actionItemProposal(entry).title === title);
    return index.dependencies?.[item!.id] ?? [];
  }

  it("promotes the labelled detail into the accepted Task snapshot", async () => {
    proposed = [
      proposal({ title: "Approve the rollout plan" }),
      dependent({ actionTitle: "Approve the rollout plan", references: "extracted" }),
    ];
    await debrief();
    const items = await queue();
    const target = items.find(
      (item) => actionItemProposal(item).title === "Approve the rollout plan",
    )!;
    const item = items.find(
      (item) => actionItemProposal(item).title === "Follow up on the billing fix",
    )!;

    const references = await referencesFor(items, "Follow up on the billing fix");
    expect(references).toEqual([
      {
        wording: "Approve the rollout plan",
        condition: "Only after approval",
        provenance: "suggested",
        target: {
          kind: "action-item",
          actionItemId: target.id,
          proposalRevision: 1,
          redirectedFrom: null,
        },
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    const task = response.json<{ task: { notes: string } }>().task;
    expect(task.notes).toContain("Purpose [supported]: Let the team review the rollout");
    expect(task.notes).toContain("Completion [suggested] A recorded successful rollout");
    expect(task.notes).toContain(
      "Suggested retrieval [suggested]: Ask the deployment administrator",
    );
    expect(task.notes).toContain(
      "Dependency [suggested]: Approve the rollout plan. Only after approval",
    );

    /* A reference is not scheduling: the proposal it named is still a proposal,
       and no Task stands in for it. */
    const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(tasks.json<{ tasks: unknown[] }>().tasks).toHaveLength(1);
    expect((await queue("?state=pending")).map((entry) => actionItemProposal(entry).title)).toEqual(
      ["Approve the rollout plan"],
    );
  });

  it("keeps the reference when the target is renamed, revised or dismissed", async () => {
    proposed = [
      proposal({ title: "Approve the rollout plan" }),
      dependent({ actionTitle: "Approve the rollout plan", references: "extracted" }),
    ];
    await debrief();
    const items = await queue();
    const target = items.find(
      (item) => actionItemProposal(item).title === "Approve the rollout plan",
    )!;
    const item = items.find(
      (item) => actionItemProposal(item).title === "Follow up on the billing fix",
    )!;

    const corrected = await app.inject({
      method: "POST",
      url: `/api/action-items/${target.id}/correct-proposal`,
      payload: {
        content: {
          title: "Approve the revised rollout plan",
          notes: "",
          dueDate: null,
          responsiblePerson: null,
        },
      },
    });
    expect(corrected.statusCode).toBe(200);
    expect(
      (await queue()).find((entry) => entry.id === target.id)?.proposalRevisions.at(-1)?.revision,
    ).toBe(2);

    const renamed = await referencesFor(await queue(), "Follow up on the billing fix");
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({
      /* The wording is the transcript's, not the target's current label. */
      wording: "Approve the rollout plan",
      target: { kind: "action-item", actionItemId: target.id, proposalRevision: 1 },
    });

    const dismissed = await app.inject({
      method: "POST",
      url: `/api/action-items/${target.id}/dismiss`,
    });
    expect(dismissed.statusCode).toBe(200);
    const afterDismissal = await referencesFor(await queue(), "Follow up on the billing fix");
    expect(afterDismissal[0]?.target).toMatchObject({
      kind: "action-item",
      actionItemId: target.id,
    });
    void item;
  });

  it("follows a reconciliation redirect and keeps the identity it originally named", async () => {
    proposed = [
      proposal({ title: "Approve the rollout plan" }),
      proposal({ title: "Previous rollout approval" }),
      dependent({ actionTitle: "Approve the rollout plan", references: "extracted" }),
    ];
    await debrief();
    const items = await queue();
    const target = items.find(
      (item) => actionItemProposal(item).title === "Approve the rollout plan",
    )!;
    const historical = items.find(
      (item) => actionItemProposal(item).title === "Previous rollout approval",
    )!;

    const attached = await app.inject({
      method: "POST",
      url: `/api/action-items/${target.id}/reconcile`,
      payload: { disposition: "evidence-of-historical", targetActionItemId: historical.id },
    });
    expect(attached.statusCode).toBe(200);

    const references = await referencesFor(await queue(), "Follow up on the billing fix");
    expect(references[0]?.target).toEqual({
      kind: "action-item",
      actionItemId: historical.id,
      proposalRevision: 1,
      redirectedFrom: target.id,
    });

    /* A chain that would point back at itself is refused rather than stored. */
    const cycle = await app.inject({
      method: "POST",
      url: `/api/action-items/${historical.id}/reconcile`,
      payload: { disposition: "evidence-of-historical", targetActionItemId: target.id },
    });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json<{ error: string }>().error).toBe("action-item-reconciliation-invalid");
  });

  it("leaves equal titles unresolved and keeps an external target a description", async () => {
    proposed = [
      proposal({ title: "Approve the rollout plan" }),
      proposal({ title: "Approve the rollout plan", owner: "Bob" }),
      dependent(
        { actionTitle: "Approve the rollout plan", references: "extracted" },
        { actionTitle: "Finance approval", references: "external" },
      ),
    ];
    await debrief();
    const items = await queue();
    expect(items).toHaveLength(3);

    const equal = await referencesFor(items, "Follow up on the billing fix");
    expect(equal.map((entry) => entry.target)).toEqual([
      { kind: "unresolved", reason: "ambiguous-title" },
      { kind: "external" },
    ]);

    /* Neither an ambiguous nor an outside target is guessed at, and neither
       creates work: three proposals are still three proposals and no Task
       exists. */
    const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(tasks.json<{ tasks: unknown[] }>().tasks).toEqual([]);
    expect(await queue("?state=pending")).toHaveLength(3);
  });

  it("never resolves an older record's title against today's proposals", () => {
    const legacy = {
      ...proposal({ title: "Follow up on the billing fix" }),
      handoff: {
        version: 1 as const,
        commitment: "explicit" as const,
        purpose: "Make the rollout verifiable",
        responsibility: { names: ["Alice"], basis: "explicit" as const, reason: "She said so" },
        completionCriteria: [{ text: "A recorded rollout", basis: "inferred" as const }],
        requiredInputs: ["Rollout plan"],
        missingInputs: [
          {
            information: "Deployment access",
            obtainBy: "Ask the deployment administrator",
            basis: "inferred" as const,
          },
        ],
        dependencies: [
          {
            actionTitle: "Approve the rollout plan",
            condition: "Only after approval",
            basis: "explicit" as const,
          },
        ],
        timing: {
          kind: "deadline" as const,
          stated: "tomorrow",
          referenceDate: null,
          reasoning: "Relative to the meeting",
        },
        evidence: [{ quote: "We will do this together", speaker: "Alice", timestamp: "01:12" }],
        statusReasoning: "Still outstanding",
      },
    };
    proposed = [proposal({ title: "Approve the rollout plan" }), legacy];
    return debrief().then(async () => {
      const items = await queue();
      const references = await referencesFor(items, "Follow up on the billing fix");
      expect(references).toEqual([
        {
          wording: "Approve the rollout plan",
          condition: "Only after approval",
          provenance: "explicit",
          target: { kind: "unresolved", reason: "not-resolved" },
        },
      ]);
      const stored = items.find(
        (item) => actionItemProposal(item).title === "Follow up on the billing fix",
      );
      /* The record keeps the shape it was written in, and its labels. */
      expect(stored?.handoff?.version).toBe(1);
      /* An unlabelled field of an older record reads as unknown; the labels it
         did carry keep their own words. */
      expect(actionItemProposal(stored!).notes).toContain("Required input [unknown]: Rollout plan");
      expect(actionItemProposal(stored!).notes).toContain(
        "Completion [inferred] A recorded rollout",
      );
      expect(actionItemProposal(stored!).notes).toContain("Dependency [explicit]:");
      /* The one label an older record carried described the gap; its retrieval
         step was always a suggestion and stays one. */
      expect(actionItemProposal(stored!).notes).toContain(
        "Suggested retrieval [inferred]: Ask the deployment administrator",
      );
      expect(actionItemProposal(stored!).notes).not.toContain("Retrieval [explicit]");
    });
  });
});

/**
 * The dependency map reaches the publication, not only the record (#347). The
 * manifest's output mapping is what a later reader can verify the resolution
 * against, so the real materializer's answer must be the one recorded there.
 */
it("records the resolved dependency map in the published revision's manifest", async () => {
  proposed = [
    proposal({ title: "Approve the rollout plan" }),
    proposal({
      title: "Follow up on the billing fix",
      handoff: {
        ...operationalHandoff(),
        dependencies: [
          {
            actionTitle: "Approve the rollout plan",
            condition: "Only after approval",
            provenance: "suggested",
            sources: [],
            references: "extracted",
          },
        ],
      },
    }),
  ];
  const runId = await debrief();
  const manifest = JSON.parse(runs.open(runId)!.readArtifact("revision-r1.manifest.json")!) as {
    materialization: {
      outputs: Array<{
        entryId: string;
        actionItemId: string;
        dependencies: Array<{ wording: string; target: { kind: string; outputEntryId?: string } }>;
      }>;
    };
  };

  const outputs = manifest.materialization.outputs;
  expect(outputs).toHaveLength(2);
  const dependent = outputs.find((output) => output.dependencies.length > 0)!;
  const target = outputs.find((output) => output.entryId !== dependent.entryId)!;
  expect(dependent.dependencies).toEqual([
    {
      index: 0,
      wording: "Approve the rollout plan",
      target: { kind: "output", outputEntryId: target.entryId },
    },
  ]);
  /* The map names only entries this revision checked, and the entry it names is
     the Action Item the target materialized into. */
  expect(outputs.map((output) => output.entryId)).toContain(
    dependent.dependencies[0]?.target.outputEntryId,
  );
  expect(target.actionItemId).toBe(
    (await queue()).find((item) => actionItemProposal(item).title === "Approve the rollout plan")
      ?.id,
  );
});
