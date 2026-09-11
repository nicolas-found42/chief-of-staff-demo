import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MeetingBrief,
  MeetingBriefEnrichmentSection,
  MeetingBriefEvent,
  MeetingBriefRunResult,
  MeetingBriefMeasurements,
} from "@chief-of-staff-demo/shared";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import {
  FakeCalendarProvider,
  type CalendarEvent,
} from "../../../apps/server/src/modules/meeting-brief-generator/calendar";
import {
  FakeGmailDeliveryProvider,
  type GmailDeliveryProvider,
  type GmailReconciliation,
} from "../../../apps/server/src/modules/meeting-brief-generator/google/gmailDelivery";
import type { MeetingBriefGeneratorOptions } from "../../../apps/server/src/modules/meeting-brief-generator/generator";

/**
 * Issue #362 / MWR-049 — composition freezes occurrence and researched-context
 * dependencies; delivery rechecks them. Cancellation, decline, guest removal,
 * reschedule and attendee changes after composition must never email stale
 * details, an ambiguous reconciliation must never resend, and a restart on
 * either side of the outward write must leave exactly one message.
 */

const START_AT = "2026-08-28T15:00:00.000Z";
const DUE_AT = "2026-08-28T11:00:00.000Z";
const T0 = "2026-08-28T10:00:00.000Z";
// A clock at or after DUE_AT is what makes the durable Intake schedule due.
const DUE_NOW = new Date(DUE_AT);

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "cal_primary",
    eventId: "evt_recovery",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Acme negotiation",
    startAt: START_AT,
    endAt: "2026-08-28T16:00:00.000Z",
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
      },
      { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
    ],
    attachments: [],
    status: "confirmed",
    ...overrides,
  };
}

function calFromFixture(f: MeetingBriefEvent): CalendarEvent {
  return {
    calendarId: f.calendarId,
    eventId: f.eventId,
    occurrenceId: f.occurrenceId,
    version: f.version,
    summary: f.summary,
    startAt: f.startAt,
    endAt: f.endAt,
    location: f.location ?? null,
    conferenceLink: f.conferenceLink ?? null,
    ...(f.organizer !== undefined ? { organizer: f.organizer } : {}),
    attendees: f.attendees,
    status: f.status,
    ...(f.attachments !== undefined ? { attachments: f.attachments } : {}),
  };
}

function fixtureEnrich(): MeetingBriefGeneratorOptions["enrich"] {
  return async () => ({
    sections: [
      {
        source: "gmail-exact",
        guest: "alice@external.co",
        status: "completed",
        evidence: ["Prior negotiation thread"],
        references: ["https://mail.example/thread-1"],
      } satisfies MeetingBriefEnrichmentSection,
    ],
    evidence: ["Prior negotiation thread"],
  });
}

function fixtureBrief(input: MeetingBriefEvent): MeetingBrief {
  return {
    version: 1,
    eventId: input.eventId,
    occurrenceId: input.occurrenceId,
    eventVersion: input.version,
    generatedAt: new Date(T0).toISOString(),
    logistics: {
      title: input.summary,
      startAt: input.startAt,
      endAt: input.endAt,
      location: input.location ?? null,
      conferenceLink: input.conferenceLink ?? null,
      organizer: input.organizer ?? null,
    },
    summary: `Brief for ${input.summary}`,
    guests: [
      {
        email: "alice@external.co",
        name: "Alice",
        role: "CTO",
        background: null,
        relationshipHistory: [],
        crmContext: null,
        talkingPoints: [],
        uncertainty: [],
        evidenceReferences: ["https://mail.example/thread-1"],
      },
    ],
    companies: [],
    conversationStarters: ["How is the negotiation going?", "What changed since last time?"],
    sourceReferences: ["https://mail.example/thread-1"],
    missingEvidence: [],
    uncertainty: [],
  };
}

/**
 * A file-backed stand-in for the external mailbox: what one host instance
 * "sent" is visible to the next, which is exactly what an in-memory fake
 * cannot show across a restart.
 */
class DurableFakeGmailProvider implements GmailDeliveryProvider {
  private readonly mailboxPath: string;

  constructor(
    workspaceDir: string,
    private readonly behaviour: "acceptThenLoseAck" | "failBeforeWrite",
  ) {
    this.mailboxPath = join(workspaceDir, "fake-mailbox.json");
  }

  /** Attempts and accepted rows both survive a restart, like the real mailbox would. */
  private read(): {
    attempts: number;
    rows: Array<{ messageId: string; recipient: string; deliveryId: string }>;
  } {
    try {
      return JSON.parse(readFileSync(this.mailboxPath, "utf8")) as {
        attempts: number;
        rows: Array<{ messageId: string; recipient: string; deliveryId: string }>;
      };
    } catch {
      return { attempts: 0, rows: [] };
    }
  }

  private write(state: {
    attempts: number;
    rows: Array<{ messageId: string; recipient: string; deliveryId: string }>;
  }): void {
    writeFileSync(this.mailboxPath, JSON.stringify(state), "utf8");
  }

  get messages(): Array<{ messageId: string; recipient: string; deliveryId: string }> {
    return this.read().rows;
  }

  async send(params: {
    subject: string;
    text: string;
    html: string;
    deliveryId: string;
  }): Promise<{ messageId: string; recipient: string }> {
    const state = this.read();
    const attempt = state.attempts + 1;
    if (this.behaviour === "failBeforeWrite" && attempt === 1) {
      this.write({ attempts: attempt, rows: state.rows });
      throw new Error("Fake transient failure before the outward write");
    }
    const messageId = `durable-${params.deliveryId}-${attempt}`;
    const row = { messageId, recipient: "owner@example.com", deliveryId: params.deliveryId };
    this.write({ attempts: attempt, rows: [...state.rows, row] });
    if (this.behaviour === "acceptThenLoseAck") {
      throw new Error("Fake lost acknowledgement after send");
    }
    return { messageId, recipient: "owner@example.com" };
  }

  async findByDeliveryId(deliveryId: string): Promise<GmailReconciliation> {
    const found = this.read().rows.find((row) => row.deliveryId === deliveryId);
    if (!found) return { kind: "none" };
    return { kind: "found", messageId: found.messageId, recipient: found.recipient };
  }
}

interface Harness {
  host: MeetingBriefHost;
  runs: Runs;
  fakeCal: FakeCalendarProvider;
  fakeGmail: FakeGmailDeliveryProvider;
  logs: string[];
  now: () => Date;
  setNow: (value: string) => void;
  restart: () => Harness;
  /** Reads the durable mailbox, when this harness uses one. */
  durableMailbox: () => Array<{ messageId: string; recipient: string; deliveryId: string }>;
}

interface HarnessOptions {
  workspaceDir?: string;
  gmailMode?: "normal" | "unavailable" | "lostAck" | "permanentFailure";
  failOnAttempt?: number | null;
  reconciliation?: "derived" | "ambiguous" | "unreadable";
  logs?: string[];
  enrich?: MeetingBriefGeneratorOptions["enrich"];
  /** Replaces the in-memory fake, e.g. with a mailbox that survives a restart. */
  durableGmail?: "acceptThenLoseAck" | "failBeforeWrite";
}

function makeHarness(options: HarnessOptions): Harness {
  const workspaceDir = options.workspaceDir ?? mkdtempSync(join(tmpdir(), "mb-recovery-"));
  const runs = openRuns(workspaceDir);
  let now = new Date(T0);
  const fakeCal = new FakeCalendarProvider();
  const fakeGmail = new FakeGmailDeliveryProvider({
    ownerEmail: "owner@example.com",
    mode: options.gmailMode ?? "normal",
    ...(options.failOnAttempt !== undefined ? { failOnAttempt: options.failOnAttempt } : {}),
    ...(options.reconciliation ? { reconciliation: options.reconciliation } : {}),
  });
  const durableGmail = options.durableGmail
    ? new DurableFakeGmailProvider(workspaceDir, options.durableGmail)
    : null;
  const logs = options.logs ?? [];
  const host = new MeetingBriefHost({
    runs,
    workspaceDir,
    now: () => new Date(now),
    log: (message) => {
      logs.push(message);
    },
    calendarProvider: fakeCal,
    calendarUse: "recheck",
    gmailDeliveryProvider: durableGmail ?? fakeGmail,
    getOwnerEmail: () => "owner@example.com",
    getInternalDomains: () => ["example.com"],
    enrich: options.enrich ?? fixtureEnrich(),
    completeBrief: async (input) => fixtureBrief(input),
  });
  const harness: Harness = {
    host,
    runs,
    fakeCal,
    fakeGmail,
    logs,
    now: () => new Date(now),
    setNow: (value) => {
      now = new Date(value);
    },
    durableMailbox: () => durableGmail?.messages ?? [],
    restart: () =>
      makeHarness({
        workspaceDir,
        ...(options.gmailMode !== undefined ? { gmailMode: options.gmailMode } : {}),
        ...(options.failOnAttempt !== undefined ? { failOnAttempt: options.failOnAttempt } : {}),
        reconciliation: options.reconciliation ?? "derived",
        logs,
        ...(options.enrich !== undefined ? { enrich: options.enrich } : {}),
        ...(options.durableGmail !== undefined ? { durableGmail: options.durableGmail } : {}),
      }),
  };
  return harness;
}

/** Compose a brief, fail its delivery once, and stop with the result on disk. */
async function composeThenFailDelivery(harness: Harness): Promise<string> {
  harness.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
  harness.host.scheduleOccurrence(fixtureEvent(), new Date(DUE_AT));
  const runIds = await harness.host.processDueSchedules(DUE_NOW);
  await harness.host.idle();
  const runId = runIds[0] ?? "";
  expect(runId).not.toBe("");
  const detail = harness.runs.detail(runId);
  expect(detail?.status).toBe("failed");
  expect(detail?.failedStage).toBe("deliver");
  const result = JSON.parse(
    harness.runs.open(runId)!.readArtifact("result.json")!,
  ) as MeetingBriefRunResult;
  expect(result.meetingBrief).toBeTruthy();
  return runId;
}

async function retry(harness: Harness, runId: string): Promise<void> {
  await harness.host.retryRun(runId);
  await harness.host.idle();
}

function deliveryAudit(harness: Harness, runId: string): Record<string, unknown> {
  return JSON.parse(harness.runs.open(runId)!.readArtifact("delivery.json")!) as Record<
    string,
    unknown
  >;
}

describe("delivery rechecks material changes after composition (issue #362)", () => {
  it("cancellation after composition skips delivery and sends nothing", async () => {
    const harness = makeHarness({ gmailMode: "unavailable" });
    const runId = await composeThenFailDelivery(harness);

    harness.fakeCal.setEvents([
      calFromFixture(fixtureEvent({ status: "cancelled", version: "v2" })),
    ]);
    await retry(harness, runId);

    expect(harness.fakeGmail.messages).toHaveLength(0);
    const meta = harness.runs.open(runId)!.read();
    expect(meta.status).toBe("skipped");
    expect(meta.skipReason).toBe("cancelled");
    expect(deliveryAudit(harness, runId).skippedReason).toBe("cancelled");
  });

  it("the owner declining after composition skips delivery and sends nothing", async () => {
    const harness = makeHarness({ gmailMode: "unavailable" });
    const runId = await composeThenFailDelivery(harness);

    harness.fakeCal.setEvents([
      calFromFixture(
        fixtureEvent({
          version: "v2",
          attendees: [
            {
              email: "owner@example.com",
              displayName: "Owner",
              responseStatus: "declined",
              organizer: true,
            },
            { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
          ],
        }),
      ),
    ]);
    await retry(harness, runId);

    expect(harness.fakeGmail.messages).toHaveLength(0);
    expect(harness.runs.open(runId)!.read().skipReason).toBe("not_eligible_at_delivery");
  });

  it("removing the last external guest after composition skips delivery", async () => {
    const harness = makeHarness({ gmailMode: "unavailable" });
    const runId = await composeThenFailDelivery(harness);

    harness.fakeCal.setEvents([
      calFromFixture(
        fixtureEvent({
          version: "v2",
          attendees: [
            {
              email: "owner@example.com",
              displayName: "Owner",
              responseStatus: "accepted",
              organizer: true,
            },
          ],
        }),
      ),
    ]);
    await retry(harness, runId);

    expect(harness.fakeGmail.messages).toHaveLength(0);
    expect(harness.runs.open(runId)!.read().skipReason).toBe("not_eligible_at_delivery");
  });

  it("a reschedule after composition supersedes the frozen brief without email", async () => {
    const harness = makeHarness({ gmailMode: "unavailable" });
    const runId = await composeThenFailDelivery(harness);

    harness.fakeCal.setEvents([
      calFromFixture(
        fixtureEvent({
          version: "v2",
          startAt: "2026-08-28T17:00:00.000Z",
          endAt: "2026-08-28T18:00:00.000Z",
        }),
      ),
    ]);
    await retry(harness, runId);

    expect(harness.fakeGmail.messages).toHaveLength(0);
    const result = JSON.parse(
      harness.runs.open(runId)!.readArtifact("result.json")!,
    ) as MeetingBriefRunResult;
    expect(result.delivery.status).toBe("superseded");
    expect(deliveryAudit(harness, runId).supersededReason).toBe("obsolete_revision");
    expect(harness.runs.open(runId)!.read().status).toBe("done");
  });

  it("an attendee change after composition supersedes the frozen brief without email", async () => {
    const harness = makeHarness({ gmailMode: "unavailable" });
    const runId = await composeThenFailDelivery(harness);

    harness.fakeCal.setEvents([
      calFromFixture(
        fixtureEvent({
          version: "v2",
          attendees: [
            {
              email: "owner@example.com",
              displayName: "Owner",
              responseStatus: "accepted",
              organizer: true,
            },
            { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
            { email: "bob@external.co", displayName: "Bob", responseStatus: "tentative" },
          ],
        }),
      ),
    ]);
    await retry(harness, runId);

    expect(harness.fakeGmail.messages).toHaveLength(0);
    const result = JSON.parse(
      harness.runs.open(runId)!.readArtifact("result.json")!,
    ) as MeetingBriefRunResult;
    expect(result.delivery.status).toBe("superseded");
  });

  it("an unchanged eligible occurrence retries delivery without recomposition", async () => {
    const harness = makeHarness({ failOnAttempt: 1 });
    const runId = await composeThenFailDelivery(harness);
    const composedAt = (
      JSON.parse(harness.runs.open(runId)!.readArtifact("result.json")!) as MeetingBriefRunResult
    ).composeAt;

    await retry(harness, runId);

    const result = JSON.parse(
      harness.runs.open(runId)!.readArtifact("result.json")!,
    ) as MeetingBriefRunResult;
    // The composed Brief is reused, not recomposed: only the delivery moved.
    expect(result.composeAt).toBe(composedAt);
    expect(result.delivery.status).toBe("sent");
    expect(harness.fakeGmail.messages).toHaveLength(1);
  });
});

describe("reconciliation never resends on an unsettled answer (issue #362)", () => {
  it("refuses to resend when two messages carry the delivery identity", async () => {
    const harness = makeHarness({ reconciliation: "ambiguous" });
    harness.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    harness.host.scheduleOccurrence(fixtureEvent(), new Date(DUE_AT));
    const [runId] = await harness.host.processDueSchedules(DUE_NOW);
    await harness.host.idle();

    expect(harness.fakeGmail.messages).toHaveLength(0);
    expect(harness.runs.open(runId)!.read().status).toBe("failed");
    const audit = deliveryAudit(harness, runId);
    expect(audit.errorCode).toBe("reconciliation_ambiguous");
    expect(String(audit.error)).toContain("refusing to resend");
  });

  it("refuses to resend when a candidate message cannot be inspected", async () => {
    const harness = makeHarness({ reconciliation: "unreadable" });
    harness.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    harness.host.scheduleOccurrence(fixtureEvent(), new Date(DUE_AT));
    const [runId] = await harness.host.processDueSchedules(DUE_NOW);
    await harness.host.idle();

    expect(harness.fakeGmail.messages).toHaveLength(0);
    const audit = deliveryAudit(harness, runId);
    expect(audit.errorCode).toBe("reconciliation_unreadable");
    expect(String(audit.error)).toContain("refusing to resend");
  });
});

describe("two restarts leave exactly one controlled delivery (issue #362)", () => {
  it("recovery after a lost acknowledgement converges instead of resending", async () => {
    const first = makeHarness({ durableGmail: "acceptThenLoseAck" });
    first.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    first.host.scheduleOccurrence(fixtureEvent(), new Date(DUE_AT));
    const [runId] = await first.host.processDueSchedules(DUE_NOW);
    await first.host.idle();
    expect(runId).toBeTruthy();
    // The provider accepted the message and then lost the acknowledgement.
    expect(first.durableMailbox()).toHaveLength(1);
    expect(first.runs.open(runId)!.read().status).toBe("failed");

    // Restart 1: the message exists externally, the local receipt does not, so
    // the retry reconciles and nothing new is sent.
    const second = first.restart();
    // A restarted host re-reads Calendar; the occurrence is still there.
    second.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    await second.host.recover();
    await second.host.idle();
    await second.host.retryRun(runId);
    await second.host.idle();

    const reconciled = second.runs.detail(runId)!;
    expect((reconciled.result as MeetingBriefRunResult).delivery.status).toBe("reconciled");
    expect(second.durableMailbox()).toHaveLength(1);

    // Restart 2: nothing new is sent, and the receipt still names one message.
    const third = second.restart();
    third.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    await third.host.recover();
    await third.host.idle();
    expect(third.durableMailbox()).toHaveLength(1);
    const audit = deliveryAudit(third, runId);
    expect(audit.status).toBe("reconciled");
    expect(audit.attempts).toBe(2);
    expect(third.host.measurements().delivery.reconciled).toBe(1);
  });

  it("recovery before the outward write sends once, and a later restart sends nothing", async () => {
    // The first outward write fails before anything is accepted.
    const first = makeHarness({ durableGmail: "failBeforeWrite" });
    first.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    first.host.scheduleOccurrence(fixtureEvent(), new Date(DUE_AT));
    const [runId] = await first.host.processDueSchedules(DUE_NOW);
    await first.host.idle();
    expect(first.durableMailbox()).toHaveLength(0);
    expect(first.runs.open(runId)!.read().status).toBe("failed");

    // Restart 1: a genuinely new write, sent exactly once.
    const second = first.restart();
    second.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    await second.host.recover();
    await second.host.idle();
    await second.host.retryRun(runId);
    await second.host.idle();
    expect((second.runs.detail(runId)!.result as MeetingBriefRunResult).delivery.status).toBe(
      "sent",
    );
    expect(second.durableMailbox()).toHaveLength(1);

    // Restart 2: a completed Run is not re-delivered.
    const third = second.restart();
    third.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    await third.host.recover();
    await third.host.idle();
    expect(third.durableMailbox()).toHaveLength(1);
    expect((third.runs.detail(runId)!.result as MeetingBriefRunResult).delivery.status).toBe(
      "sent",
    );
    expect(third.host.measurements().errors).toContainEqual({
      stage: "deliver",
      code: "send_failed",
      count: 1,
    });
  });
});

describe("generation and delivery are measured separately, source-free (issue #362)", () => {
  it("counts generation and delivery apart and keeps source text out of logs and measurement", async () => {
    const sourceSecret = "SOURCE-ONLY-SENTENCE-NEVER-IN-LOGS";
    const enrich: MeetingBriefGeneratorOptions["enrich"] = async () => ({
      sections: [
        {
          source: "gmail-exact",
          guest: "alice@external.co",
          status: "completed",
          evidence: [sourceSecret],
          references: ["https://mail.example/thread-1"],
        },
      ],
      evidence: [sourceSecret],
    });
    const harness = makeHarness({ failOnAttempt: 1, enrich });
    harness.fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    harness.host.scheduleOccurrence(fixtureEvent(), new Date(DUE_AT));
    const [runId] = await harness.host.processDueSchedules(DUE_NOW);
    await harness.host.idle();
    await retry(harness, runId);

    const measurements: MeetingBriefMeasurements = harness.host.measurements();
    expect(measurements.generation).toMatchObject({ runs: 1, completed: 1, failed: 0 });
    expect(measurements.delivery.briefs).toBe(1);
    expect(measurements.delivery.byStatus.sent).toBe(1);
    expect(measurements.delivery.attempts).toBeGreaterThan(0);
    // The failed first write is visible as a classified deliver error.
    expect(measurements.errors).toContainEqual({ stage: "deliver", code: "send_failed", count: 1 });

    const serialized = JSON.stringify(measurements);
    expect(serialized).not.toContain(sourceSecret);
    expect(serialized).not.toContain("https://mail.example");
    for (const line of harness.logs) {
      expect(line).not.toContain(sourceSecret);
    }
    // The evidence itself is retained on the Run; only the measurement is stripped.
    expect(harness.runs.open(runId)!.readArtifact("enrich.json")).toContain(sourceSecret);
  });
});
