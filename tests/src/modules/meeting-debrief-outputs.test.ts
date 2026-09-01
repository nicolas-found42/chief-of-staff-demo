import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { MEETING_DEBRIEF_MODULE_ID, type TranscriptRecord } from "@chief-of-staff-demo/shared";
import { MeetingDebriefHost } from "../../../apps/server/src/modules/meeting-debrief/host";
import type {
  DebriefDraft,
  DebriefExtractInput,
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
    roster: [
      { displayName: "Owner", email: OWNER_EMAIL },
      { displayName: "Alice", email: "alice@example.com" },
    ],
  };
}

function fakeExtraction(input: DebriefExtractInput) {
  return {
    version: 1 as const,
    summary: `Review of ${input.record.source.fileName}`,
    decisions: [{ statement: "Ship on Friday", evidence: null }],
    actionItems: [
      {
        title: "Follow up with Alice",
        owner: "Owner",
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
  createDraft: (d: DebriefDraft) => Promise<string>;
} {
  const drafts: DebriefDraft[] = [];
  return {
    drafts,
    createDraft: (draft: DebriefDraft) => {
      drafts.push(draft);
      return Promise.resolve(`draft_${drafts.length}`);
    },
  };
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
  const host = new MeetingDebriefHost({
    runs,
    catalog: { getTranscript: (id) => catalog.get(id) ?? null },
    identity: { reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }) },
    extract: (input) => Promise.resolve(fakeExtraction(input)),
    profiles: workspaceProfileDirectory(people),
    ownerEmail: () => OWNER_EMAIL,
    outputs: { createDraft: outputs.createDraft },
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
