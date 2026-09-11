import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEETING_DEBRIEF_MODULE_ID,
  type MeetingDebriefExtraction,
  type MeetingDebriefReviewState,
  type ActionItemMaterializationMapping,
  type MeetingDebriefRunResult,
  type TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import {
  MeetingDebriefHost,
  type MeetingDebriefHostDeps,
} from "../../../apps/server/src/modules/meeting-debrief/host";
import type {
  DebriefCatalogReader,
  DebriefExtractInput,
  DebriefIdentityReviewReader,
} from "../../../apps/server/src/modules/meeting-debrief/module";
import { reconcileDebrief } from "../../../apps/server/src/modules/meeting-debrief/publication";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

/**
 * Durable Debrief publication (#358, ADR-0084).
 *
 * These run through the real Module, the real Run store and the real HTTP
 * surface, with one controlled provider and one controlled Workspace
 * materializer. What they are here to prove: a Run finishes because its
 * committed bytes verify, not because a file exists.
 */

const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z");

function makeRecord(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    id: "drive_pubA_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "pubA",
      fileName: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
      sourceUrl: null,
      checksum: "deadbeef",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: "Alice: We decided to ship on Friday.\nBob: I will own the follow-up.\n",
    meetingDate: "2026-08-17",
    occurrence: null,
    speakers: ["Alice", "Bob"],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
    association: null,
    ...overrides,
  };
}

function extractionWith(
  overrides: Partial<MeetingDebriefExtraction> = {},
): MeetingDebriefExtraction {
  return {
    version: 1,
    summary: "Review of the weekly sync",
    decisions: [{ statement: "Ship the billing fix on Friday", evidence: "We decided to ship" }],
    actionItems: [
      {
        title: "Follow up on the billing fix",
        owner: "Alice",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: "2026-08-22",
      },
    ],
    openQuestions: [{ question: "Is the rollout on track?", raisedBy: "Alice" }],
    effectivenessEvidence: "Decisions were made crisply.",
    coachingAdvice: "Close open questions before the next sync.",
    suggestedRecipients: [],
    ...overrides,
  };
}

type Materializer = NonNullable<MeetingDebriefHostDeps["materializeActionItems"]>;
type Handover = Parameters<Materializer>[0];

interface Harness {
  workspaceDir: string;
  runs: Runs;
  host: MeetingDebriefHost;
  catalog: Map<string, TranscriptRecord>;
  extractInputs: DebriefExtractInput[];
  handovers: Handover[];
  app: FastifyInstance;
  /** The next materialization refuses, as a Workspace store can. */
  failNextMaterialize: () => void;
  /** The next materialization returns nothing for what was checked. */
  dropNextMaterialize: () => void;
  /** What the provider answers with next; generation-numbered by default. */
  answerWith: (extraction: MeetingDebriefExtraction) => void;
  setPolicy: (policy: "stage-all" | "auto-create-mine" | null) => void;
}

function makeHarness(): Harness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "debrief-publication-"));
  const runs = openRuns(workspaceDir);
  const catalog = new Map<string, TranscriptRecord>();
  const extractInputs: DebriefExtractInput[] = [];
  const handovers: Handover[] = [];
  let generation = 0;
  let failNext = false;
  let dropNext = false;
  let extraction = extractionWith();
  let policy: "stage-all" | "auto-create-mine" | null = null;

  const catalogReader: DebriefCatalogReader = { getTranscript: (id) => catalog.get(id) ?? null };
  const identityReader: DebriefIdentityReviewReader = {
    reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }),
  };
  const materialize: Materializer = (handover) => {
    handovers.push(structuredClone(handover));
    if (failNext) {
      failNext = false;
      throw new Error("workspace store refused the write");
    }
    if (dropNext) {
      dropNext = false;
      return [];
    }
    return handover.actionItems.map((item, index) => ({
      key: `materialization:v1:${handover.debriefRunId}:ce_${index}`,
      debriefRunId: handover.debriefRunId,
      outputEntryId: `ce_${index}`,
      candidateAlias: handover.candidateAliases?.[index] ?? null,
      payloadChecksum: `sha256:checked-${index}`,
      actionItemId: `ai_${handover.debriefRunId}_${index}`,
      proposalRevision: 1,
      allocatedAt: new Date(BASE_TIME).toISOString(),
      /* What the checked entry's dependencies resolved to against the output
         this materializer was handed. */
      dependencies: (item.handoff?.dependencies ?? []).map((dependency, position) => ({
        index: position,
        wording: dependency.actionTitle,
        target: {
          kind: "output" as const,
          outputEntryId: `ce_${
            handover.actionItems.findIndex(
              (candidate) => candidate.title === dependency.actionTitle,
            ) >= 0
              ? handover.actionItems.findIndex(
                  (candidate) => candidate.title === dependency.actionTitle,
                )
              : index
          }`,
        },
      })),
    }));
  };

  const host = new MeetingDebriefHost({
    runs,
    catalog: catalogReader,
    identity: identityReader,
    materializeActionItems: materialize,
    now: () => new Date(BASE_TIME),
    policy: () => ({
      capturedAt: new Date(BASE_TIME).toISOString(),
      actionItemPolicy: policy,
    }),
    extract: async (input) => {
      extractInputs.push(input);
      generation = Math.max(generation + 1, extractInputs.length);
      return { ...extraction, summary: `${extraction.summary} (generation ${generation})` };
    },
    log: () => {},
  });
  const app = fastify({ logger: false });
  host.routes(app);

  return {
    workspaceDir,
    runs,
    host,
    catalog,
    extractInputs,
    handovers,
    app,
    failNextMaterialize: () => {
      failNext = true;
    },
    dropNextMaterialize: () => {
      dropNext = true;
    },
    answerWith: (next) => {
      extraction = next;
    },
    setPolicy: (next) => {
      policy = next;
    },
  };
}

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

function artifact(runId: string, name: string): string | null {
  return h.runs.open(runId)!.readArtifact(name);
}

function readJson<T>(runId: string, name: string): T {
  const raw = artifact(runId, name);
  expect(raw, `${name} is missing`).not.toBeNull();
  return JSON.parse(raw!) as T;
}

interface PublicationRecord {
  generation: number;
  revisionId: string;
  revision: number;
  manifestArtifact: string;
  manifestChecksum: string;
  publicationId: string;
}

async function start(record: TranscriptRecord): Promise<string> {
  const before = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs.map((run) => run.id);
  h.catalog.set(record.id, record);
  await h.host.process(record);
  await h.host.idle();
  const created = h.runs
    .list({ module: MEETING_DEBRIEF_MODULE_ID })
    .runs.map((run) => run.id)
    .filter((id) => !before.includes(id));
  expect(created).toHaveLength(1);
  return created[0];
}

describe("Debrief publication (#358)", () => {
  it("publishes one immutable revision, a pointer and a completion receipt", async () => {
    const runId = await start(makeRecord());

    const meta = h.runs.open(runId)!.read();
    expect(meta.status).toBe("done");

    const publication = readJson<PublicationRecord>(runId, "publication.json");
    expect(publication.generation).toBe(1);
    expect(publication.revisionId).toBe("r1");
    expect(publication.revision).toBe(1);

    const manifest = readJson<{
      revisionId: string;
      resultChecksum: string;
      materialization: { surface: string; expectedOutputCount: number; outputs: unknown[] };
      completeness: { required: string; sections: string[] };
    }>(runId, publication.manifestArtifact);
    expect(manifest.revisionId).toBe("r1");
    expect(manifest.materialization.surface).toBe("workspace");
    expect(manifest.materialization.expectedOutputCount).toBe(1);
    expect(manifest.materialization.outputs).toHaveLength(1);
    expect(manifest.completeness.required).toBe("complete");

    const receipt = readJson<{ publicationGeneration: number; revisionId: string }>(
      runId,
      "completion.json",
    );
    expect(receipt.publicationGeneration).toBe(1);
    expect(receipt.revisionId).toBe("r1");

    // The checked output became exactly one Workspace mapping.
    expect(h.handovers).toHaveLength(1);
    expect(h.handovers[0].actionItems).toHaveLength(1);

    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(detail.extraction.summary).toContain("generation 1");
  });

  it("records the operation, the lineage claim and the policy before any model call", async () => {
    h.setPolicy("auto-create-mine");
    const runId = await start(makeRecord());

    const operation = readJson<{
      operationId: string;
      runId: string;
      transcriptId: string;
      firstExtraction: { claim: string; basis: string; lineageRunId: string | null };
      policy: { actionItemPolicy: string | null };
    }>(runId, "operation.json");
    expect(operation.runId).toBe(runId);
    expect(operation.transcriptId).toBe("drive_pubA_r1");
    expect(operation.firstExtraction.claim).toBe("first");
    expect(operation.policy.actionItemPolicy).toBe("auto-create-mine");

    // The reservation is on the timeline before the revision it paid for.
    const events = h.runs.detail(runId)!.events.map((event) => event.type);
    expect(events.indexOf("debrief_operation_reserved")).toBeLessThan(
      events.indexOf("debrief_revision_written"),
    );

    // The materialization was told what was reserved, not asked to re-derive it.
    expect(h.handovers[0].firstExtraction).toEqual({
      operationId: operation.operationId,
      claim: "first",
      basis: "no-retained-first-reservation",
    });
  });

  it("keeps the retained first reservation across a later revision of the same source", async () => {
    h.setPolicy("auto-create-mine");
    h.answerWith(extractionWith({ actionItems: [] }));
    await start(makeRecord({ id: "drive_pubA_r1" }));

    // A later source revision of the same Drive file is the same lineage: the
    // zero-action first extraction left its reservation behind, so this Run is
    // review-only rather than a second chance at automatic acceptance.
    h.answerWith(extractionWith());
    const second = await start(makeRecord({ id: "drive_pubA_r2" }));

    const operation = readJson<{ firstExtraction: { claim: string; lineageRunId: string | null } }>(
      second,
      "operation.json",
    );
    expect(operation.firstExtraction.claim).toBe("review-only");
    const runs = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs;
    expect(operation.firstExtraction.lineageRunId).toBe(runs.find((run) => run.id !== second)!.id);
    expect(h.handovers[1].firstExtraction?.claim).toBe("review-only");
  });

  it("publishes a regeneration as its own revision, keeping the pointer's lineage", async () => {
    const runId = await start(makeRecord());
    const first = readJson<PublicationRecord>(runId, "publication.json");

    const posted = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    expect(posted.statusCode).toBe(200);
    await h.host.idle();

    expect(h.runs.open(runId)!.read().status).toBe("done");
    const second = readJson<PublicationRecord & { predecessorPublicationId: string | null }>(
      runId,
      "publication.json",
    );
    expect(second.generation).toBe(2);
    expect(second.revisionId).toBe("r2");
    expect(second.predecessorPublicationId).toBe(first.publicationId);

    const manifest = readJson<{ revision: number; predecessorRevisionId: string | null }>(
      runId,
      second.manifestArtifact,
    );
    expect(manifest.revision).toBe(2);
    expect(manifest.predecessorRevisionId).toBe("r1");

    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(detail.extraction.summary).toContain("generation 2");
    expect(
      readJson<{ publicationGeneration: number }>(runId, "completion.json").publicationGeneration,
    ).toBe(2);
  });

  it("reads a pre-publication Run as legacy rather than as a verified publication", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    const legacy = h.runs.create({
      module: MEETING_DEBRIEF_MODULE_ID,
      moduleVersion: 1,
      intake: "transcript-catalog",
      fileName: record.source.fileName,
      sourceUrl: null,
      externalId: record.id,
    });
    /* What a Run written by the build before #358 holds: a result and nothing
       behind it. It stays readable — the extraction is real work — and it
       never claims the current contract. */
    legacy.writeArtifact(
      "result.json",
      `${JSON.stringify(
        {
          version: 1,
          transcriptId: record.id,
          extractedAt: new Date(BASE_TIME).toISOString(),
          debrief: extractionWith({ summary: "Legacy summary" }),
        } satisfies MeetingDebriefRunResult,
        null,
        2,
      )}\n`,
    );
    legacy.finished({ status: "done", summary: "2 decisions" });

    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${legacy.id}` })
    ).json();
    expect(detail.extraction.summary).toBe("Legacy summary");
    expect(artifact(legacy.id, "publication.json")).toBeNull();

    // The sweep leaves historical work exactly where it is.
    expect(await h.host.recover()).toBe(0);
    expect(artifact(legacy.id, "publication.json")).toBeNull();
    expect(h.extractInputs).toHaveLength(0);
  });

  it("publishes a validated zero-action extraction", async () => {
    h.answerWith(extractionWith({ actionItems: [] }));
    const runId = await start(makeRecord());

    expect(h.runs.open(runId)!.read().status).toBe("done");
    const publication = readJson<PublicationRecord>(runId, "publication.json");
    const manifest = readJson<{
      materialization: { expectedOutputCount: number; outputs: unknown[] };
    }>(runId, publication.manifestArtifact);
    expect(manifest.materialization.expectedOutputCount).toBe(0);
    expect(manifest.materialization.outputs).toHaveLength(0);
    expect(artifact(runId, "completion.json")).not.toBeNull();
  });
});

describe("Debrief recovery through one reconciler (#358)", () => {
  it("finishes intact prepared work with zero model calls after an interrupted commit", async () => {
    h.failNextMaterialize();
    const runId = await start(makeRecord());

    expect(h.runs.open(runId)!.read().status).toBe("failed");
    expect(h.extractInputs).toHaveLength(1);
    // Prepared: the checked bytes reached the Run even though the commit did not.
    expect(artifact(runId, "revision-r1.result.json")).not.toBeNull();
    expect(artifact(runId, "publication.json")).toBeNull();

    await h.host.retryRun(runId);
    await h.host.idle();

    expect(h.runs.open(runId)!.read().status).toBe("done");
    expect(h.extractInputs).toHaveLength(1);
    expect(h.runs.detail(runId)!.events.map((event) => event.type)).toContain("debrief_published");
  });

  it("finishes an interrupted preparation on the startup sweep, still without a model call", async () => {
    h.failNextMaterialize();
    const runId = await start(makeRecord());
    expect(h.runs.open(runId)!.read().status).toBe("failed");

    const recovered = await h.host.recover();

    expect(recovered).toBeGreaterThan(0);
    expect(h.runs.open(runId)!.read().status).toBe("done");
    expect(h.extractInputs).toHaveLength(1);
    const reconciled = h.runs
      .detail(runId)!
      .events.filter((event) => event.type === "debrief_reconciled")
      .at(-1);
    // Adopted, not re-derived: the checked bytes were already committed.
    expect(reconciled?.detail).toMatchObject({ modelCalls: 0, reconciled: "recovered" });
    expect(readJson<PublicationRecord>(runId, "publication.json").generation).toBe(1);
  });

  it("adopts a revision whose result was written before its manifest", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    const orphan = h.runs.create({
      module: MEETING_DEBRIEF_MODULE_ID,
      moduleVersion: 2,
      intake: "transcript-catalog",
      fileName: record.source.fileName,
      sourceUrl: null,
      externalId: record.id,
    });
    /* Exactly the interruption shape: the checked bytes and the context are
       committed, the manifest they would be marked by is not. */
    orphan.writeArtifact(
      "context-snapshot.json",
      JSON.stringify({
        version: 1,
        capturedAt: new Date(BASE_TIME).toISOString(),
        source: { transcriptId: record.id },
      }),
    );
    orphan.writeArtifact(
      "revision-r1.result.json",
      `${JSON.stringify(
        {
          version: 1,
          transcriptId: record.id,
          extractedAt: new Date(BASE_TIME).toISOString(),
          debrief: extractionWith(),
        } satisfies MeetingDebriefRunResult,
        null,
        2,
      )}\n`,
    );

    h.host.start();
    await vi.waitFor(() => expect(h.runs.open(orphan.id)!.read().status).toBe("done"));
    h.host.stop();

    expect(h.extractInputs).toHaveLength(0);
    const publication = readJson<PublicationRecord>(orphan.id, "publication.json");
    expect(publication.revisionId).toBe("r1");
    expect(
      readJson<{ revisionId: string }>(orphan.id, publication.manifestArtifact).revisionId,
    ).toBe("r1");
  });

  it("refuses damaged accepted bytes instead of regenerating under the old identities", async () => {
    const runId = await start(makeRecord());
    const before = readJson<PublicationRecord>(runId, "publication.json");
    const resultRaw = artifact(runId, "revision-r1.result.json")!;

    // The accepted bytes no longer say what their receipt says they say.
    h.runs
      .open(runId)!
      .writeArtifact("revision-r1.result.json", resultRaw.replace("generation 1", "generation 9"));

    await h.host.recover();

    expect(h.runs.open(runId)!.read().status).toBe("failed");
    expect(h.extractInputs).toHaveLength(1);
    expect(readJson<PublicationRecord>(runId, "publication.json")).toEqual(before);

    // Repeated recovery converges: the integrity failure is already in front
    // of the owner, so the sweep does not keep re-running it.
    const events = h.runs.detail(runId)!.events.length;
    expect(await h.host.recover()).toBe(0);
    expect(h.runs.detail(runId)!.events).toHaveLength(events);
  });

  it("keeps the previous publication when a replacement cannot be completed", async () => {
    const runId = await start(makeRecord());
    const before = readJson<PublicationRecord>(runId, "publication.json");
    const resultBefore = artifact(runId, "result.json");

    // A regeneration whose checked output never reaches the Workspace: the new
    // revision is incomplete, so it must not become the published one.
    h.dropNextMaterialize();
    const posted = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    expect(posted.statusCode).toBe(200);
    await h.host.idle();

    expect(h.runs.open(runId)!.read().status).toBe("failed");
    expect(readJson<PublicationRecord>(runId, "publication.json")).toEqual(before);
    expect(artifact(runId, "result.json")).toBe(resultBefore);

    // The previous revision is still what readers get.
    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(detail.extraction.summary).toContain("generation 1");

    expect(await h.host.recover()).toBe(0);
    expect(readJson<PublicationRecord>(runId, "publication.json")).toEqual(before);
  });
});

describe("Debrief reads fail closed on integrity failures (#358)", () => {
  it("answers 500 rather than serving a stale extraction when the manifest is damaged", async () => {
    const runId = await start(makeRecord());
    const publication = readJson<PublicationRecord>(runId, "publication.json");
    const manifestRaw = artifact(runId, publication.manifestArtifact)!;
    h.runs
      .open(runId)!
      .writeArtifact(publication.manifestArtifact, manifestRaw.replace('"r1"', '"r7"'));

    const response = await h.app.inject({
      method: "GET",
      url: `/api/meeting-debrief/${runId}`,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("not sound");
  });

  it("repairs a projection its pointer no longer has, without a model call", async () => {
    const runId = await start(makeRecord());
    const expected = artifact(runId, "revision-r1.result.json")!;
    h.runs.open(runId)!.deleteArtifact("result.json");
    expect(artifact(runId, "result.json")).toBeNull();

    // Readers still get the published revision: the pointer is the authority.
    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(detail.extraction.summary).toContain("generation 1");

    await h.host.recover();
    expect(artifact(runId, "result.json")).toBe(expected);
    expect(h.extractInputs).toHaveLength(1);
  });

  it("re-verifies a published revision whose receipt went missing without touching its review", async () => {
    const runId = await start(makeRecord());
    const state = readJson<MeetingDebriefReviewState>(runId, "review.json");
    const decided: MeetingDebriefReviewState = {
      ...state,
      roster: { ...state.roster, status: "confirmed" },
      recipients: {
        additional: [{ profileId: "profile_bob", profileRevision: 1, email: "bob@example.com" }],
      },
    };
    h.runs.open(runId)!.writeArtifact("review.json", `${JSON.stringify(decided, null, 2)}\n`);
    h.runs.open(runId)!.deleteArtifact("completion.json");

    const recovered = await h.host.recover();

    expect(recovered).toBe(1);
    expect(h.runs.open(runId)!.read().status).toBe("done");
    expect(h.extractInputs).toHaveLength(1);
    // The owner's roster and recipient decisions are not reset by recovery.
    expect(readJson<MeetingDebriefReviewState>(runId, "review.json")).toEqual(decided);
    expect(artifact(runId, "completion.json")).not.toBeNull();
  });

  it("does not complete a Run whose checked output has no mapping", async () => {
    h.dropNextMaterialize();
    const runId = await start(makeRecord());

    expect(h.runs.open(runId)!.read().status).toBe("failed");
    expect(artifact(runId, "publication.json")).toBeNull();
    expect(h.runs.open(runId)!.read().failureHint).toBeTruthy();
  });

  it("refuses a corrupt review record rather than replacing it with defaults", async () => {
    const runId = await start(makeRecord());
    const publication = readJson<PublicationRecord>(runId, "publication.json");
    const damaged = '{"review": ';
    h.runs.open(runId)!.writeArtifact("review.json", damaged);

    // The owner asks for a regeneration. The review record is what the turn
    // reads first, and an unreadable one is refused at the route rather than
    // re-created empty under the decisions it cannot read.
    const posted = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    expect(posted.statusCode).toBe(409);
    await h.host.idle();

    expect(artifact(runId, "review.json")).toBe(damaged);
    expect(h.extractInputs).toHaveLength(1);
    expect(readJson<PublicationRecord>(runId, "publication.json")).toEqual(publication);
    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(detail.extraction.summary).toContain("generation 1");
  });

  it("keeps a corrupt review record through the publication sweep too", async () => {
    const runId = await start(makeRecord());
    const damaged = '{"review": ';
    h.runs.open(runId)!.writeArtifact("review.json", damaged);

    await h.host.recover();

    expect(h.runs.open(runId)!.read().status).toBe("failed");
    expect(artifact(runId, "review.json")).toBe(damaged);
    expect(h.extractInputs).toHaveLength(1);
  });
});

describe("Debrief final-write faults (#358)", () => {
  const reconcileRecord = makeRecord({ id: "drive_pubF_r1" });

  /** The reconciler's artifact surface as a map, with an optional refusal. */
  interface MemoryIo {
    files: Map<string, string>;
    read: (name: string) => string | null;
    write: (name: string, text: string) => void;
    names: () => string[];
  }

  function memoryIo(refuse?: (name: string) => boolean): MemoryIo {
    const files = new Map<string, string>();
    return {
      files,
      read: (name: string) => files.get(name) ?? null,
      write: (name: string, text: string) => {
        if (refuse?.(name)) throw new Error(`refused: ${name}`);
        files.set(name, text);
      },
      names: () => [...files.keys()],
    };
  }

  function reconcileInput(
    io: MemoryIo,
    produce: () => Promise<string>,
    modelCalls: { count: number },
  ) {
    return {
      io,
      names: () => io.names(),
      runId: "run_pubF_1",
      record: reconcileRecord,
      context: { version: 1, capturedAt: new Date(BASE_TIME).toISOString() } as never,
      firstExtraction: {
        claim: "first" as const,
        basis: "test",
        reservedAt: new Date(BASE_TIME).toISOString(),
        lineageRunId: null,
      },
      policy: { capturedAt: new Date(BASE_TIME).toISOString(), actionItemPolicy: null },
      intent: "publish" as const,
      now: () => new Date(BASE_TIME),
      produce: async () => {
        modelCalls.count += 1;
        return produce();
      },
      materialize: () => [
        {
          key: "materialization:v1:run_pubF_1:ce_0",
          debriefRunId: "run_pubF_1",
          outputEntryId: "ce_0",
          candidateAlias: null,
          payloadChecksum: "sha256:checked-0",
          actionItemId: "ai_run_pubF_1_0",
          proposalRevision: 1,
          allocatedAt: new Date(BASE_TIME).toISOString(),
          dependencies: [],
        },
      ],
      hasMaterializationSurface: true,
      ensureReview: () => {
        io.write(
          "review.json",
          JSON.stringify({ review: { droppedActionItems: [], completedActionItems: [] } }),
        );
      },
      event: () => {},
    };
  }

  it("commits the result before the manifest, so a refused marker is not a publication", async () => {
    const refused = memoryIo((name) => name.endsWith(".manifest.json"));
    const modelCalls = { count: 0 };
    const producedText = `${JSON.stringify(
      {
        version: 1,
        transcriptId: reconcileRecord.id,
        extractedAt: new Date(BASE_TIME).toISOString(),
        debrief: extractionWith(),
      } satisfies MeetingDebriefRunResult,
      null,
      2,
    )}\n`;

    await expect(
      reconcileDebrief(reconcileInput(refused, async () => producedText, modelCalls)),
    ).rejects.toThrow(/refused/);

    // The checked bytes reached the Run; the marker that would have made them
    // a preparation did not, and nothing was published.
    expect(refused.files.get("revision-r1.result.json")).toBe(producedText);
    expect(refused.files.get("context-snapshot.json")).toBeTruthy();
    expect([...refused.files.keys()].some((name) => name.endsWith(".manifest.json"))).toBe(false);
    expect(refused.files.get("publication.json")).toBeUndefined();
    expect(refused.files.get("completion.json")).toBeUndefined();

    // The next reconciliation adopts exactly those bytes: zero model calls.
    const writable = memoryIo();
    for (const [name, text] of refused.files) writable.files.set(name, text);
    const outcome = await reconcileDebrief(
      reconcileInput(
        writable,
        async () => {
          throw new Error("the model must not be asked again");
        },
        modelCalls,
      ),
    );

    expect(modelCalls.count).toBe(1);
    expect(outcome.reconciled).toBe("recovered");
    expect(outcome.publication.revisionId).toBe("r1");
    expect(writable.files.get("completion.json")).toBeTruthy();
  });
});
/**
 * The immutable dependency map travels with the publication (#347, MWR-048).
 * A revision's manifest records what each checked entry depended on, resolved
 * to the entries that revision actually checked — and refuses a map naming
 * anything else rather than publishing a reference nothing can resolve.
 */
describe("Debrief dependency map (MWR-048)", () => {
  const record = makeRecord({ id: "drive_pubD_r1" });

  function io() {
    const files = new Map<string, string>();
    return {
      files,
      read: (name: string) => files.get(name) ?? null,
      write: (name: string, text: string) => void files.set(name, text),
      names: () => [...files.keys()],
    };
  }

  async function publish(dependencies: ActionItemMaterializationMapping["dependencies"]) {
    const surface = io();
    const outcome = await reconcileDebrief({
      io: surface,
      names: () => surface.names(),
      runId: "run_pubD_1",
      record,
      context: { version: 1, capturedAt: new Date(BASE_TIME).toISOString() } as never,
      firstExtraction: {
        claim: "first" as const,
        basis: "test",
        reservedAt: new Date(BASE_TIME).toISOString(),
        lineageRunId: null,
      },
      policy: { capturedAt: new Date(BASE_TIME).toISOString(), actionItemPolicy: null },
      intent: "publish" as const,
      now: () => new Date(BASE_TIME),
      produce: async () =>
        `${JSON.stringify(
          {
            version: 1,
            transcriptId: record.id,
            extractedAt: new Date(BASE_TIME).toISOString(),
            debrief: extractionWith(),
          } satisfies MeetingDebriefRunResult,
          null,
          2,
        )}\n`,
      materialize: () => [
        {
          key: "materialization:v1:run_pubD_1:ce_0",
          debriefRunId: "run_pubD_1",
          outputEntryId: "ce_0",
          candidateAlias: null,
          payloadChecksum: "sha256:checked-0",
          actionItemId: "ai_run_pubD_1_0",
          proposalRevision: 1,
          allocatedAt: new Date(BASE_TIME).toISOString(),
          dependencies,
        },
      ],
      hasMaterializationSurface: true,
      ensureReview: () =>
        void surface.write(
          "review.json",
          `${JSON.stringify({
            version: 1,
            runId: "run_pubD_1",
            email: null,
            roster: { status: "unconfirmed", confirmedAt: null, entries: [] },
            recipients: { additional: [] },
            review: { droppedActionItems: [], completedActionItems: [] },
            request: null,
            approval: null,
          } satisfies MeetingDebriefReviewState)}\n`,
        ),
      event: () => {},
    });
    return { surface, outcome };
  }

  it("records each entry's resolved targets in the manifest", async () => {
    const { surface, outcome } = await publish([
      { index: 0, wording: "Approve the rollout plan", target: { kind: "external" } },
      { index: 1, wording: "Draft the plan", target: { kind: "output", outputEntryId: "ce_0" } },
      {
        index: 2,
        wording: "Book the room",
        target: { kind: "unresolved", reason: "ambiguous-title" },
      },
    ]);

    expect(outcome.reconciled).toBe("extracted");
    const manifest = JSON.parse(surface.files.get("revision-r1.manifest.json")!) as {
      materialization: { outputs: unknown[] };
    };
    expect(manifest.materialization.outputs).toEqual([
      {
        entryId: "ce_0",
        materializationKey: "materialization:v1:run_pubD_1:ce_0",
        payloadChecksum: "sha256:checked-0",
        candidateAlias: null,
        actionItemId: "ai_run_pubD_1_0",
        proposalRevision: 1,
        dependencies: [
          { index: 0, wording: "Approve the rollout plan", target: { kind: "external" } },
          {
            index: 1,
            wording: "Draft the plan",
            target: { kind: "output", outputEntryId: "ce_0" },
          },
          {
            index: 2,
            wording: "Book the room",
            target: { kind: "unresolved", reason: "ambiguous-title" },
          },
        ],
      },
    ]);
    expect(surface.files.get("completion.json")).toBeTruthy();
  });

  it("refuses a dependency map naming an entry the revision did not check", async () => {
    await expect(
      publish([
        {
          index: 0,
          wording: "Draft the plan",
          target: { kind: "output", outputEntryId: "ce_404" },
        },
      ]),
    ).rejects.toThrow(/dependency-target:ce_0/);
  });
});
