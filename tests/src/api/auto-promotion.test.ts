import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActionItem,
  ActionItemPolicy,
  AutomaticPromotionAuthorizationFacts,
  MeetingDebriefActionItem,
  ResponsibilityClaim,
  ResponsibilityLaterUpdateKind,
  Task,
} from "@chief-of-staff-demo/shared";
import { actionItemProposal } from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { ConfigStore } from "../../../apps/server/src/config";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { materializeUnderPolicy } from "../../../apps/server/src/tasks/auto-promotion";
import { WorkspacePromotionAuthorization } from "../../../apps/server/src/tasks/promotion-authorization";
import { promotionEligibility } from "../../../apps/server/src/tasks/promotion-eligibility";

/**
 * Automatic promotion of the owner's own commitments (ADR-0053/0083, issue
 * #181, #360). The Workspace default stages everything; the exception the
 * owner may turn on is narrow by construction, and these are the cases it
 * declines.
 *
 * Since #360 the exception also needs the source relationship to be supported:
 * the owner's own explicit commitment, or a request of theirs that they
 * unambiguously accepted, for this exact obligation, with nothing later
 * completing, cancelling, reassigning or qualifying it — recorded under an
 * operation that was reserved while automation was *released and enabled*.
 */
const OWNER_PROFILE = "profile_owner";
const TRANSCRIPT = "drive_fileA_r1";
const CHECKSUM = "sha256:source-revision-1";
const NOW = new Date("2026-09-04T09:00:00.000Z");

/** The authorization facts of an operation reserved while automation was on. */
const AUTHORIZED: AutomaticPromotionAuthorizationFacts = {
  released: true,
  enabledAt: "2026-09-01T00:00:00.000Z",
  preference: "auto-create-mine",
  basis: "enabled-at:2026-09-01T00:00:00.000Z",
};

/** The state a Workspace is in before any release has been recorded. */
const RESTRICTED: AutomaticPromotionAuthorizationFacts = {
  released: false,
  enabledAt: null,
  preference: "stage-all",
  basis: "release-restriction:release-evidence-not-recorded",
};

let workspaceDir: string;
let store: TaskStore;
let tasks: WorkspaceTasks;
let actionItems: WorkspaceActionItems;
let policy: ActionItemPolicy;
let authorization: AutomaticPromotionAuthorizationFacts;
let googleTasksEnabled: boolean;
let delivered: string[];

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-auto-promotion-"));
  store = new TaskStore(workspaceDir);
  policy = "stage-all";
  authorization = AUTHORIZED;
  delivered = [];
  googleTasksEnabled = false;
  tasks = new WorkspaceTasks({
    store,
    now: () => NOW,
    isGoogleTasksEnabled: () => googleTasksEnabled,
  });
  actionItems = new WorkspaceActionItems({
    store,
    now: () => NOW,
    ownerProfileId: () => OWNER_PROFILE,
  });
});

afterEach(() => {
  workspaceDir = "";
});

/** A claim the deterministic validator would have accepted for this source. */
function claim(overrides: Partial<ResponsibilityClaim> = {}): ResponsibilityClaim {
  return {
    version: 1,
    obligation: "Follow up on the billing fix",
    speaker: "Alice",
    statement: {
      quote: "I will fix the billing flow.",
      speaker: "Alice",
      timestamp: null,
      locator: "turn:1",
    },
    performer: { name: "Alice", basis: "explicit" },
    relationship: "self-commitment",
    assignment: null,
    acceptance: null,
    laterUpdates: [],
    unresolvedReasons: [],
    contract: {
      contractVersion: 1,
      validatorVersion: 1,
      source: { transcriptId: TRANSCRIPT, observedRevision: 1, checksum: CHECKSUM },
      contextChecksum: "sha256:context",
      validatedAt: NOW.toISOString(),
    },
    ...overrides,
  };
}

/** One extracted proposal, checked and claim-bearing by default. */
function proposal(overrides: Partial<MeetingDebriefActionItem> = {}): MeetingDebriefActionItem {
  return {
    title: "Follow up on the billing fix",
    owner: "Alice",
    ownerMentionId: "m_alice",
    ownerProfileId: OWNER_PROFILE,
    dueDate: "2026-08-22",
    responsibilityClaim: claim(),
    ...overrides,
  };
}

function materialize(
  proposals: MeetingDebriefActionItem[],
  source: {
    debriefRunId?: string;
    transcriptId?: string;
    claim?: "first" | "review-only" | "unknown";
    contract?: "current" | "absent";
    reviewOnly?: boolean;
    reservedAuthorization?: AutomaticPromotionAuthorizationFacts | null;
    liveAuthorization?: AutomaticPromotionAuthorizationFacts;
  } = {},
  deliver?: (taskId: string) => Promise<Task>,
): ActionItem[] {
  return materializeUnderPolicy(
    {
      tasks,
      actionItems,
      /* The composed surface derives the facts from the saved preference, so
         the fixture does too: Stage all leaves the preference at stage-all. */
      authorization: () => source.liveAuthorization ?? { ...authorization, preference: policy },
      ...(deliver ? { deliver } : {}),
    },
    {
      debriefRunId: source.debriefRunId ?? "run_1",
      transcriptId: source.transcriptId ?? TRANSCRIPT,
      meetingId: "meeting_1",
      transcriptObservedRevision: 1,
      transcriptChecksum: CHECKSUM,
      actionItems: proposals,
      ...(source.reviewOnly ? { reviewOnly: true } : {}),
      ...(source.contract === "absent"
        ? {}
        : {
            firstExtraction: {
              operationId: `op_${source.debriefRunId ?? "run_1"}`,
              claim: source.claim ?? "first",
              basis:
                source.claim === "review-only"
                  ? "release-restriction"
                  : "no-retained-first-reservation",
              reservedAt: NOW.toISOString(),
              authorization:
                source.reservedAuthorization === undefined
                  ? { ...AUTHORIZED, preference: policy }
                  : source.reservedAuthorization,
            },
          }),
    },
  );
}

describe("the Stage all default", () => {
  it("leaves every proposal pending, however obviously it is the owner's", () => {
    const [item] = materialize([proposal()]);

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });
});

describe("automatically create my Tasks", () => {
  beforeEach(() => {
    policy = "auto-create-mine";
  });

  it("creates one open Task from the owner's own supported commitment", () => {
    const [item] = materialize([proposal()]);

    expect(item.state).toBe("promoted");
    const created = tasks.list({});
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: "Follow up on the billing fix",
      status: "open",
      dueDate: "2026-08-22",
      responsiblePerson: { kind: "owner" },
      source: { actionItemId: item.id },
    });
    expect(created[0]?.completedAt).toBeNull();
  });

  it("promotes a request the owner unambiguously accepted for that obligation", () => {
    const accepted = proposal({
      responsibilityClaim: claim({
        relationship: "accepted-request",
        speaker: "Bob",
        performer: { name: "Alice", basis: "explicit" },
        assignment: {
          quote: "Alice, can you fix the billing flow?",
          speaker: "Bob",
          timestamp: null,
          locator: "turn:4",
        },
        acceptance: {
          quote: "Yes, I will fix the billing flow.",
          speaker: "Alice",
          timestamp: null,
          locator: "turn:5",
        },
      }),
    });

    const [item] = materialize([accepted]);

    expect(item.state).toBe("promoted");
    expect(tasks.list({})).toHaveLength(1);
  });

  it.each([
    [
      "request",
      claim({
        relationship: "request",
        assignment: {
          quote: "Alice, can you fix it?",
          speaker: "Bob",
          timestamp: null,
          locator: "turn:4",
        },
      }),
      "request",
    ],
    ["reported commitment", claim({ relationship: "reported-commitment" }), "reported"],
    [
      "shared work",
      claim({ relationship: "shared", performer: { name: "Alice", basis: "inferred" } }),
      "shared",
    ],
    [
      "unresolved",
      claim({ relationship: "unresolved", unresolvedReasons: ["the source is ambiguous"] }),
      "unresolved",
    ],
    [
      "ambiguous acknowledgment",
      claim({
        relationship: "request",
        assignment: {
          quote: "Alice, can you fix it?",
          speaker: "Bob",
          timestamp: null,
          locator: "turn:4",
        },
        unresolvedReasons: ["the acknowledgement does not take the work"],
      }),
      "ambiguous",
    ],
  ] as Array<[string, ResponsibilityClaim, string]>)(
    "keeps an unaccepted %s pending",
    (_label, judged, _tag) => {
      const [item] = materialize([proposal({ responsibilityClaim: judged })]);

      expect(item.state).toBe("pending");
      expect(tasks.list({})).toEqual([]);
    },
  );

  it.each([
    "completion",
    "cancellation",
    "reassignment",
    "qualification",
  ] as ResponsibilityLaterUpdateKind[])(
    "declines a commitment a later turn changed by %s",
    (kind) => {
      const changed = claim({
        laterUpdates: [
          {
            kind,
            occurrence: {
              quote: "It is handled.",
              speaker: "Alice",
              timestamp: null,
              locator: "turn:9",
            },
          },
        ],
      });

      const [item] = materialize([proposal({ responsibilityClaim: changed })]);

      expect(item.state).toBe("pending");
      expect(tasks.list({})).toEqual([]);
    },
  );

  it("keeps a proposal whose claim was checked against another source revision pending", () => {
    const stale = claim({
      contract: {
        ...claim().contract,
        source: {
          transcriptId: TRANSCRIPT,
          observedRevision: 1,
          checksum: "sha256:other-revision",
        },
      },
    });

    const [item] = materialize([proposal({ responsibilityClaim: stale })]);

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("keeps a proposal with no supported claim pending, however supported the handoff looks", () => {
    const [item] = materialize([proposal({ responsibilityClaim: undefined })]);

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("keeps a proposal whose claim an older validator checked pending", () => {
    const older = claim({
      contract: { ...claim().contract, validatorVersion: 99 },
    });

    const [item] = materialize([proposal({ responsibilityClaim: older })]);

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("withholds promotion from an operation reserved as review-only", () => {
    const [item] = materialize([proposal()], { claim: "review-only" });

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("withholds promotion when nothing recorded a reservation", () => {
    /* An older writer or a harness: absence is honestly unknown, and unknown
       never authorizes. */
    const [item] = materialize([proposal()], { contract: "absent" });

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("withholds promotion from an operation reserved while the release restriction held", () => {
    const [item] = materialize([proposal()], {
      reservedAuthorization: RESTRICTED,
    });

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("withholds promotion from an operation reserved before the owner enabled it", () => {
    const [item] = materialize([proposal()], {
      reservedAuthorization: { ...AUTHORIZED, enabledAt: null, basis: "not-enabled-since-release" },
    });

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("keeps an extraction reserved while automation was off review-only when it is enabled in flight", () => {
    /* The operation was reserved before inference; enabling afterwards applies
       to future extractions, not to this one (#343 §5). */
    authorization = {
      ...AUTHORIZED,
      enabledAt: "2026-09-03T12:00:00.000Z",
      basis: "enabled-at:2026-09-03T12:00:00.000Z",
    };
    const [item] = materialize([proposal()], {
      reservedAuthorization: { ...AUTHORIZED, enabledAt: null, basis: "not-enabled-since-release" },
    });

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("keeps a proposal whose owner resolution changed after the extraction pending", () => {
    /* The claim still names Alice, but the proposal no longer resolves to the
       confirmed owner: a changed identity decision is review, never a silent
       automatic acceptance. */
    const [item] = materialize([proposal({ owner: "Bob", ownerProfileId: "profile_bob" })]);

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("keeps a proposal corrected after it was reviewed pending", () => {
    const [item] = materialize([proposal()], { claim: "review-only" });
    const corrected = actionItems.correctProposal(item.id, {
      title: "Follow up on the billing fix (revised)",
      notes: "",
      dueDate: null,
      responsiblePerson: { kind: "owner" },
    });

    const [again] = materialize([proposal()]);

    expect(corrected.reviewedThrough).toBeLessThan(corrected.proposalRevisions.length);
    expect(again.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("keeps every proposal of a zero-action first extraction's later extraction review-only", () => {
    /* A zero-action first extraction records its reservation and materializes
       nothing; the next extraction of that lineage is review-only because the
       reservation — not the empty queue — is what remembers (#358/#360). */
    expect(materialize([], { debriefRunId: "run_zero" })).toEqual([]);

    const [later] = materialize([proposal()], { debriefRunId: "run_zero" });

    expect(later.state).toBe("promoted");
    const [regenerated] = materialize([proposal({ title: "Another commitment" })], {
      debriefRunId: "run_regenerated",
    });
    expect(regenerated.state).toBe("pending");
    expect(tasks.list({})).toHaveLength(1);
  });

  it("keeps an incomplete publication's proposals review-only", () => {
    const [item] = materialize([proposal()], { reviewOnly: true });

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("treats a re-enablement after the reservation as a future authorization", () => {
    /* Disable and re-enable: the operation reserved under the first enablement
       is not re-decided by the second (#343 §5). */
    const reEnabled = {
      ...AUTHORIZED,
      enabledAt: "2026-09-03T00:00:00.000Z",
      basis: "enabled-at:2026-09-03T00:00:00.000Z",
    };

    const reserved = materialize([proposal()], { liveAuthorization: reEnabled });
    expect(reserved[0]?.state).toBe("pending");

    // A *new* extraction reserved under the new enablement is eligible.
    /* A *future* first extraction — a different Transcript lineage — reserved
       under the new enablement is eligible. */
    const lineage = "drive_fileB_r1";
    const fresh = materialize(
      [
        proposal({
          title: "Another commitment",
          responsibilityClaim: claim({
            contract: {
              ...claim().contract,
              source: { transcriptId: lineage, observedRevision: 1, checksum: CHECKSUM },
            },
          }),
        }),
      ],
      {
        debriefRunId: "run_2",
        transcriptId: lineage,
        liveAuthorization: reEnabled,
        reservedAuthorization: reEnabled,
      },
    );
    expect(fresh[0]?.state).toBe("promoted");
    expect(tasks.list({})).toHaveLength(1);
  });

  it("declines when the authorization was withdrawn after the reservation", () => {
    const [item] = materialize([proposal()], {
      liveAuthorization: { ...AUTHORIZED, enabledAt: null, basis: "disabled-at:2026-09-04" },
    });

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("refuses a later Run whose lineage already spent its first reservation", () => {
    const [first] = materialize([proposal()]);
    expect(first.state).toBe("promoted");

    // A later extraction of the same Transcript stages, whatever it reserves:
    // even a `first` claim cannot promote a regeneration.
    const [later] = materialize([proposal({ title: "Another commitment" })], {
      debriefRunId: "run_2",
    });
    expect(later.state).toBe("pending");
    expect(tasks.list({})).toHaveLength(1);
  });

  it("leaves an unassigned or another person's commitment pending", () => {
    const items = materialize([
      proposal({ title: "Nobody's job", ownerProfileId: null }),
      proposal({ title: "Bob's job", owner: "Bob", ownerProfileId: "profile_bob" }),
    ]);

    expect(items.map((item) => item.state)).toEqual(["pending", "pending"]);
    expect(tasks.list({})).toEqual([]);
  });

  it("leaves a possible duplicate pending rather than creating a second Task", () => {
    tasks.create({
      title: "Follow up on the billing fix",
      dueDate: "2026-08-22",
      responsiblePerson: { kind: "owner" },
    });

    const [item] = materialize([proposal()]);

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toHaveLength(1);
  });

  it("creates one Task however many times the same extraction is materialized", () => {
    const first = materialize([proposal()]);

    const again = materialize([proposal()]);

    expect(again.map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(again[0]?.promotedTaskId).toBe(first[0]?.promotedTaskId);
    expect(tasks.list({})).toHaveLength(1);
  });

  it("creates no second Task when the same extraction is materialized after a restart", () => {
    const first = materialize([proposal()]);
    expect(first[0]?.state).toBe("promoted");

    /* A second Workspace over the same directory — the shape a restart has.
       Nothing is carried in memory, so the store alone has to say this
       proposal already became a Task. */
    const restartedStore = new TaskStore(workspaceDir);
    const restartedTasks = new WorkspaceTasks({
      store: restartedStore,
      now: () => NOW,
      isGoogleTasksEnabled: () => googleTasksEnabled,
    });
    const restartedActionItems = new WorkspaceActionItems({
      store: restartedStore,
      now: () => NOW,
      ownerProfileId: () => OWNER_PROFILE,
    });
    const again = materializeUnderPolicy(
      { tasks: restartedTasks, actionItems: restartedActionItems, authorization: () => AUTHORIZED },
      {
        debriefRunId: "run_1",
        transcriptId: TRANSCRIPT,
        meetingId: "meeting_1",
        transcriptObservedRevision: 1,
        transcriptChecksum: CHECKSUM,
        actionItems: [proposal()],
      },
    );

    expect(again.map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(again[0]?.promotedTaskId).toBe(first[0]?.promotedTaskId);
    expect(restartedTasks.list({})).toHaveLength(1);
    expect(restartedActionItems.list()).toHaveLength(1);
  });

  it("commits the Task before delivering it, and keeps it when delivery fails", async () => {
    googleTasksEnabled = true;
    tasks.updateList("inbox", {
      defaultDestination: {
        provider: "google-tasks",
        googleTaskListId: "list_1",
        googleTaskListTitle: "Meeting Followups",
      },
    });
    const failures: string[] = [];

    const [item] = materialize([proposal()], {}, (taskId) => {
      delivered.push(taskId);
      failures.push(taskId);
      return Promise.reject(new Error("Google is unavailable"));
    });
    await Promise.resolve();

    expect(item.state).toBe("promoted");
    expect(delivered).toEqual([item.promotedTaskId]);
    expect(failures).toHaveLength(1);
    expect(tasks.list({})).toHaveLength(1);
    expect(tasks.get(item.promotedTaskId ?? "")?.title).toBe("Follow up on the billing fix");
  });

  it("delivers nothing outward for a locally filed Task", () => {
    materialize([proposal()], {}, (taskId) => {
      delivered.push(taskId);
      return Promise.resolve(tasks.get(taskId) as Task);
    });

    expect(delivered).toEqual([]);
  });
});

describe("the release restriction and explicit enablement", () => {
  let app: FastifyInstance;
  let promotion: WorkspacePromotionAuthorization;

  beforeEach(async () => {
    const configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load({ persist: false });
    promotion = new WorkspacePromotionAuthorization({
      configStore,
      now: () => NOW,
    });
    app = fastify();
    registerTasksApi(app, {
      tasks,
      actionItems,
      actionItemPolicy: {
        get: () => configStore.get().tasks.actionItemPolicy,
        set: (next) => configStore.setActionItemPolicy(next),
      },
      promotion: {
        facts: () => promotion.facts(configStore.get().tasks.actionItemPolicy),
        status: () => promotion.status(configStore.get().tasks.actionItemPolicy),
        release: (evidence) => promotion.recordRelease(evidence),
        enable: () => promotion.enable(),
        disable: () => promotion.disable(),
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const evidence = {
    reference: "private-release-evidence/baseline-9",
    checksum: "a".repeat(64),
  };

  async function put(body: Record<string, unknown>) {
    return app.inject({ method: "PUT", url: "/api/action-item-promotion", payload: body });
  }

  it("reports the restriction and a saved preference as ineffective before any release", async () => {
    policy = "auto-create-mine";
    const saved = await app.inject({
      method: "PUT",
      url: "/api/action-item-policy",
      payload: { policy },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      policy: "auto-create-mine",
      automaticPromotion: { effective: false },
    });
    expect(
      saved.json<{ automaticPromotion: { reason: string } }>().automaticPromotion.reason,
    ).toContain("restricted");
  });

  it("refuses explicit enablement while the restriction stands", async () => {
    const response = await put({ action: "enable" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "promotion-restricted" });
  });

  it("refuses a release that names no retained evidence", async () => {
    const response = await put({ action: "release", evidence: { reference: "", checksum: "" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid-release-evidence" });
  });

  it("releases, keeps promotion off, then enables explicitly", async () => {
    const released = await put({ action: "release", evidence });
    expect(released.statusCode).toBe(200);
    expect(
      released.json<{ automaticPromotion: { effective: boolean; reason: string } }>()
        .automaticPromotion,
    ).toMatchObject({ effective: false });

    // A release alone creates no authorization, with the preference on.
    await app.inject({
      method: "PUT",
      url: "/api/action-item-policy",
      payload: { policy: "auto-create-mine" },
    });
    const stillOff = await app.inject({ method: "GET", url: "/api/action-item-policy" });
    expect(
      stillOff.json<{ automaticPromotion: { effective: boolean } }>().automaticPromotion.effective,
    ).toBe(false);

    const enabled = await put({ action: "enable" });
    expect(enabled.statusCode).toBe(200);
    expect(
      enabled.json<{ automaticPromotion: { effective: boolean; enabledAt: string | null } }>()
        .automaticPromotion,
    ).toMatchObject({
      effective: true,
      enabledAt: NOW.toISOString(),
    });
  });

  it("disables and re-enables, and a re-enablement is a new authorization", async () => {
    await put({ action: "release", evidence });
    await app.inject({
      method: "PUT",
      url: "/api/action-item-policy",
      payload: { policy: "auto-create-mine" },
    });
    await put({ action: "enable" });

    const disabled = await put({ action: "disable" });
    expect(
      disabled.json<{ automaticPromotion: { effective: boolean } }>().automaticPromotion.effective,
    ).toBe(false);

    const reEnabled = await put({ action: "enable" });
    expect(
      reEnabled.json<{ automaticPromotion: { effective: boolean } }>().automaticPromotion.effective,
    ).toBe(true);
    expect(promotion.read().decisions.map((decision) => decision.kind)).toEqual([
      "enable",
      "disable",
      "enable",
    ]);
  });

  it("keeps one recorded release: a different evidence record cannot replace it", async () => {
    await put({ action: "release", evidence });

    const second = await put({
      action: "release",
      evidence: { reference: "other", checksum: "b".repeat(64) },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "promotion-already-released" });
  });

  it("answers the per-proposal verdict so review can say why automation declined", async () => {
    await put({ action: "release", evidence });
    await app.inject({
      method: "PUT",
      url: "/api/action-item-policy",
      payload: { policy: "auto-create-mine" },
    });
    await put({ action: "enable" });
    /* Materialized with the authorization the surface actually reports, so the
       reservation is the one a real operation would have recorded. */
    const live = promotion.facts("auto-create-mine");
    actionItems.materialize({
      debriefRunId: "run_1",
      transcriptId: TRANSCRIPT,
      meetingId: "meeting_1",
      transcriptObservedRevision: 1,
      transcriptChecksum: CHECKSUM,
      actionItems: [proposal({ responsibilityClaim: undefined })],
      firstExtraction: {
        operationId: "op_run_1",
        claim: "first",
        basis: "no-retained-first-reservation",
        reservedAt: live.enabledAt ?? NOW.toISOString(),
        authorization: live,
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/action-items" });
    const index = response.json<{
      items: ActionItem[];
      automation: Record<string, { eligible: boolean; code: string; reason: string }>;
    }>();

    const verdict = index.automation[index.items[0].id];
    expect(verdict.eligible).toBe(false);
    expect(verdict.code).toBe("claim-unsupported");
    expect(verdict.reason).toContain("responsibility claim");
  });

  it("reports an eligible verdict for a supported commitment under an authorized reservation", async () => {
    /* Materialized without the policy engine, so the record stays pending and
       its verdict is the gate's own answer rather than a promotion's. */
    await put({ action: "release", evidence });
    await app.inject({
      method: "PUT",
      url: "/api/action-item-policy",
      payload: { policy: "auto-create-mine" },
    });
    await put({ action: "enable" });
    const live = promotion.facts("auto-create-mine");
    const [item] = actionItems.materialize({
      debriefRunId: "run_1",
      transcriptId: TRANSCRIPT,
      meetingId: "meeting_1",
      transcriptObservedRevision: 1,
      transcriptChecksum: CHECKSUM,
      actionItems: [proposal()],
      firstExtraction: {
        operationId: "op_run_1",
        claim: "first",
        basis: "no-retained-first-reservation",
        reservedAt: live.enabledAt ?? NOW.toISOString(),
        authorization: live,
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/action-items" });
    const index = response.json<{
      items: ActionItem[];
      automation?: Record<string, { eligible: boolean; code: string }>;
    }>();

    expect(item.state).toBe("pending");
    expect(index.automation?.[item.id]).toMatchObject({ eligible: true, code: "eligible" });
  });
});

describe("the per-record automation verdict", () => {
  it("names the record's own state rather than the live policy", () => {
    policy = "auto-create-mine";
    const [item] = materialize([proposal()], { reservedAuthorization: RESTRICTED });

    // The reason lives in the shared decision, so the same code the gate uses
    // is what a surface would render.
    const verdict = promotionEligibility(item, RESTRICTED, false);

    expect(verdict.eligible).toBe(false);
    expect(verdict.code).toBe("reservation-unauthorized");
    expect(verdict.reason).toContain("reserved");
  });

  it("keeps the proposal's text untouched by the verdict", () => {
    const [item] = materialize([proposal()], { reviewOnly: true });

    expect(actionItemProposal(item).title).toBe("Follow up on the billing fix");
    expect(item.source.reviewOnly).toBe(true);
  });
});

describe("selecting the policy", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    registerTasksApi(app, {
      tasks,
      actionItems,
      actionItemPolicy: {
        get: () => policy,
        set: (next) => {
          policy = next;
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function put(body: Record<string, unknown>) {
    return app.inject({ method: "PUT", url: "/api/action-item-policy", payload: body });
  }

  it("answers with Stage all and a restriction until the owner chooses otherwise", async () => {
    const response = await app.inject({ method: "GET", url: "/api/action-item-policy" });

    expect(response.json()).toMatchObject({
      policy: "stage-all",
      externalDestination: null,
      automaticPromotion: { effective: false, enabledAt: null },
    });
    expect(
      response.json<{ automaticPromotion: { release: { state: string } } }>().automaticPromotion
        .release.state,
    ).toBe("restricted");
  });

  it("turns the preference on for a locally filed Workspace without ceremony", async () => {
    const response = await put({ policy: "auto-create-mine" });

    expect(response.statusCode).toBe(200);
    expect(policy).toBe("auto-create-mine");
    // Saved, and still not effective: the release restriction is what decides.
    expect(
      response.json<{ automaticPromotion: { effective: boolean } }>().automaticPromotion.effective,
    ).toBe(false);
  });

  it("refuses automatic promotion into a provider until the outbound write is confirmed", async () => {
    googleTasksEnabled = true;
    tasks.updateList("inbox", {
      defaultDestination: {
        provider: "google-tasks",
        googleTaskListId: "list_1",
        googleTaskListTitle: "Meeting Followups",
      },
    });

    const refused = await put({ policy: "auto-create-mine" });

    expect(refused.statusCode).toBe(428);
    expect(refused.json()).toMatchObject({ error: "confirmation-required" });
    expect(refused.json<{ message: string }>().message).toContain("Google Tasks");
    expect(policy).toBe("stage-all");

    const confirmed = await put({ policy: "auto-create-mine", confirmedExternalWrites: true });

    expect(confirmed.statusCode).toBe(200);
    expect(policy).toBe("auto-create-mine");
  });

  it("refuses a policy it does not have", async () => {
    const response = await put({ policy: "create-everything" });

    expect(response.statusCode).toBe(400);
    expect(policy).toBe("stage-all");
  });
});
