import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MEETING_DEBRIEF_MODULE_ID,
  type IdentityDecision,
  type TranscriptMention,
  type TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { MeetingDebriefHost } from "../../../apps/server/src/modules/meeting-debrief/host";
import type {
  DebriefDraft,
  DebriefExtractInput,
  DebriefIdentityReview,
  DebriefTask,
} from "../../../apps/server/src/modules/meeting-debrief/deps";
import { workspaceProfileDirectory } from "../../../apps/server/src/modules/meeting-debrief/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

const OWNER_EMAIL = "owner@example.com";

function makeRecord(): TranscriptRecord {
  return {
    id: "drive_outputsA_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "outputsA",
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
    occurrence: {
      occurrenceKey: "evt_outputsA:2026-08-17T13:00:00.000Z",
      calendarEventId: "evt_outputsA",
    },
    speakers: ["Alice"],
    speakerIdentityMappings: [],
    meetingId: null,
    roster: [
      { displayName: "Owner", email: OWNER_EMAIL },
      { displayName: "Alice", email: "alice@example.com" },
    ],
  };
}

/* The Catalog's identity review: one mention, linked by an owner decision to
   the Workspace owner's Profile. That decision is the only thing that can put
   a Profile id on an action item — a model's guess never survives. */
const OWNER_MENTION_ID = "mention_owner";
let identityReview: DebriefIdentityReview = {
  mentions: [],
  decisions: [],
  organizations: [],
};

function ownerLinkedIdentity(profileId: string): DebriefIdentityReview {
  const mention: TranscriptMention = {
    id: OWNER_MENTION_ID,
    kind: "person",
    surfaceText: "Owner",
    normalizedForms: ["owner"],
    emails: [OWNER_EMAIL],
    profileUrls: [],
    verifiedHandles: {},
    externalContactIds: [],
    speakerCalendarEmail: OWNER_EMAIL,
    titles: [],
    roles: [],
    aliases: [],
    relationshipAssertions: [],
    rosterContext: [],
    organizationContext: null,
    attendeeStatus: "speaker",
    confidence: "high",
    minedAt: "2026-08-31T12:00:00.000Z",
    algorithmVersion: 1,
    provenance: {
      transcriptId: "drive_outputsA_r1",
      spanStart: 0,
      spanEnd: 5,
      quote: "Alice",
      timestamp: null,
      speakerLabel: "Alice",
      meetingDate: "2026-08-17",
    },
  };
  const decision: IdentityDecision = {
    id: "decision_owner",
    mentionId: OWNER_MENTION_ID,
    transcriptId: "drive_outputsA_r1",
    action: "confirm",
    outcome: "linked",
    profileId,
    profileRevision: 1,
    decidedBy: "owner",
    decidedAt: "2026-08-31T12:00:00.000Z",
    note: null,
    mappingAuthority: null,
  };
  return { mentions: [mention], decisions: [decision], organizations: [] };
}

function fakeExtraction(input: DebriefExtractInput) {
  return {
    version: 1 as const,
    summary: `Review of ${input.record.source.fileName}`,
    decisions: [{ statement: "Ship on Friday", evidence: null }],
    actionItems: [
      /* Confidently the owner's: the Catalog linked its mention to the
         owner's Profile. This one becomes a Task. */
      {
        title: "Send the release note",
        owner: "Owner",
        ownerMentionId: OWNER_MENTION_ID,
        ownerProfileId: null,
        dueDate: "2026-08-21",
      },
      /* Named, but the Catalog resolved nothing. An unresolved owner is not
         the Workspace owner, so it creates no Task. */
      {
        title: "Follow up with Alice",
        owner: "Alice",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: null,
      },
    ],
    openQuestions: [],
    effectivenessEvidence: "Decisions were made crisply.",
    coachingAdvice: "Close open questions before the next sync.",
    suggestedRecipients: [] as Array<{ name: string; email: string | null }>,
  };
}

/**
 * Records what the Module asked the outward surface to do, in order. A fake at
 * the port, not a mock of an internal: the assertions are about what reached
 * the boundary, never about how the Module got there.
 */
function recordingOutputs(): {
  drafts: DebriefDraft[];
  tasks: DebriefTask[];
  failTasks: boolean;
  createDraft: (d: DebriefDraft) => Promise<string>;
  createTask: (t: DebriefTask) => Promise<string>;
} {
  const drafts: DebriefDraft[] = [];
  const tasks: DebriefTask[] = [];
  const surface = {
    drafts,
    tasks,
    failTasks: false,
    createDraft: (draft: DebriefDraft) => {
      drafts.push(draft);
      return Promise.resolve(`draft_${drafts.length}`);
    },
    createTask: (task: DebriefTask) => {
      if (surface.failTasks) return Promise.reject(new Error("tasks unavailable"));
      tasks.push(task);
      return Promise.resolve(`task_${tasks.length}`);
    },
  };
  return surface;
}

interface Harness {
  runs: Runs;
  host: MeetingDebriefHost;
  people: WorkspacePersonProfiles;
  catalog: Map<string, TranscriptRecord>;
  app: FastifyInstance;
  outputs: ReturnType<typeof recordingOutputs>;
}

let h: Harness;

beforeEach(() => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-debrief-outputs-"));
  const runs = openRuns(workspaceDir);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  const catalog = new Map<string, TranscriptRecord>();
  const outputs = recordingOutputs();
  identityReview = { mentions: [], decisions: [], organizations: [] };
  const host = new MeetingDebriefHost({
    runs,
    catalog: { getTranscript: (id) => catalog.get(id) ?? null },
    identity: { reviewFor: () => identityReview },
    extract: (input) => Promise.resolve(fakeExtraction(input)),
    profiles: workspaceProfileDirectory(people),
    ownerEmail: () => OWNER_EMAIL,
    outputs: { createDraft: outputs.createDraft, createTask: outputs.createTask },
    log: () => {},
  });
  const app = fastify({ logger: false });
  host.routes(app);
  h = { runs, host, people, catalog, app, outputs };
});

function anchoredProfile(fullName: string, email: string): void {
  const { profile } = h.people.ensureCalendarAttendeeProfile({
    email: email.trim().toLowerCase(),
    provenance: "unit test — Calendar attendee",
  });
  h.people.correct(profile.id, { fullName });
}

async function startRun(record: TranscriptRecord): Promise<string> {
  h.catalog.set(record.id, record);
  await h.host.process(record);
  await h.host.idle();
  return h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id;
}

describe("Meeting Debrief outward writes (#141)", () => {
  it("writes nothing outward until terminal approval, then creates exactly one Gmail draft", async () => {
    anchoredProfile("Owner", OWNER_EMAIL);
    anchoredProfile("Alice", "alice@example.com");
    const runId = await startRun(makeRecord());

    const roster = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner" },
          { email: "alice@example.com", displayName: "Alice" },
        ],
      },
    });
    expect(roster.statusCode).toBe(200);

    /* Extracted, reviewed, roster confirmed — everything short of approval.
       The outward surface has not been touched. */
    expect(h.outputs.drafts).toEqual([]);

    const approved = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    await h.host.idle();

    /* Approval is the sole transition to outward writes, and it creates one
       draft — not one per recipient, and not one per approval attempt. */
    expect(h.outputs.drafts).toHaveLength(1);
  });
});

describe("Meeting Debrief approval outputs — Tasks and retry (#141)", () => {
  /** Roster-confirm helper: everything up to, but not including, approval. */
  async function readyToApprove(): Promise<string> {
    const { profile } = h.people.ensureCalendarAttendeeProfile({
      email: OWNER_EMAIL,
      provenance: "unit test — Calendar attendee",
    });
    h.people.correct(profile.id, { fullName: "Owner" });
    anchoredProfile("Alice", "alice@example.com");
    identityReview = ownerLinkedIdentity(profile.id);
    const runId = await startRun(makeRecord());
    const roster = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner" },
          { email: "alice@example.com", displayName: "Alice" },
        ],
      },
    });
    expect(roster.statusCode).toBe(200);
    return runId;
  }

  function approve(runId: string): Promise<{ statusCode: number }> {
    return h.app.inject({ method: "POST", url: `/api/meeting-debrief/${runId}/approve` });
  }

  it("creates Tasks only for actions confidently assigned to the owner", async () => {
    const runId = await readyToApprove();
    await approve(runId);
    await h.host.idle();

    /* Two action items; only the one the Catalog linked to the owner's own
       Profile becomes a Task. "Follow up with Alice" is someone else's, and
       an unresolved owner is not the Workspace owner. */
    expect(h.outputs.tasks.map((task) => task.title)).toEqual(["Send the release note"]);
    expect(h.outputs.tasks[0]?.due).toBe("2026-08-21");
  });

  it("preserves the draft receipt when Tasks fail and creates only what is missing", async () => {
    const runId = await readyToApprove();
    h.outputs.failTasks = true;
    await approve(runId);
    await h.host.idle();

    /* The draft is out. Tasks are not, and the Run is not done. */
    expect(h.outputs.drafts).toHaveLength(1);
    expect(h.outputs.tasks).toEqual([]);

    /* The retry heals the Task without sending a second draft to everyone
       who already received the first — the receipt is what prevents it. */
    h.outputs.failTasks = false;
    await h.host.retryRun(runId);
    await h.host.idle();

    expect(h.outputs.drafts).toHaveLength(1);
    expect(h.outputs.tasks.map((task) => task.title)).toEqual(["Send the release note"]);
  });
});
