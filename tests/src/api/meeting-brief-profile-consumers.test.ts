import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type {
  MeetingBriefMeasurements,
  MeetingBriefPersonProfileReadModel,
  MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { openRuns } from "../../../apps/server/src/runs";

describe("Meeting Brief-owned Person Profile consumer read model", () => {
  it("derives refresh state without changing the immutable Run result", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-brief-profile-read-"));
    const runs = openRuns(workspaceDir);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(workspaceDir),
      now: () => new Date("2026-08-31T16:00:00.000Z"),
      lifecycle: [],
    });
    const profile = people.create({ fullName: "Grace Hopper", role: "Rear Admiral" });
    const run = runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "calendar",
      sourceUrl: null,
      externalId: "evt::occurrence",
    });
    const stored = fromPartial<MeetingBriefRunResult>({
      version: 1,
      personProfileLinks: [
        {
          guestEmail: "grace@example.com",
          profileId: profile.id,
          profileRevision: 1,
        },
      ],
    });
    run.writeArtifact("result.json", `${JSON.stringify(stored, null, 2)}\n`);
    people.correct(profile.id, { role: "Professor" });
    const host = new MeetingBriefHost({ runs, workspaceDir, personProfiles: people });
    const app = fastify({ logger: false });
    await host.routes(app);
    await app.ready();

    const response = await app.inject({
      url: `/api/meeting-brief/runs/${run.id}/profile-consumers`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<MeetingBriefPersonProfileReadModel>().consumers[0]).toMatchObject({
      link: {
        guestEmail: "grace@example.com",
        profileId: profile.id,
        profileRevision: 1,
      },
      state: {
        currentProfileId: profile.id,
        currentProfileRevision: 2,
        refreshRequired: true,
        invalidations: [{ kind: "correction", affectedRevision: 1 }],
      },
    });
    expect(JSON.parse(run.readArtifact("result.json")!)).toEqual(stored);
    await app.close();
  });
});

describe("Meeting Brief measurement read model (issue #362)", () => {
  it("counts generation and delivery separately and exposes classified errors only", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-brief-measurements-"));
    const runs = openRuns(workspaceDir);
    const run = runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "calendar",
      sourceUrl: null,
      externalId: "evt::occurrence",
    });
    const result = fromPartial<MeetingBriefRunResult>({
      version: 1,
      meetingBrief: {
        version: 1,
        summary: "Renewal conversation",
        uncertainty: ["SOURCE-ONLY-SENTENCE"],
      },
      delivery: { status: "failed", attempts: 2, sentAt: null, messageId: null, recipient: null },
    });
    run.writeArtifact("result.json", `${JSON.stringify(result, null, 2)}\n`);
    // The two events a refused reconciliation actually writes: the refusal
    // itself, and the delivery failure that carries the classified code.
    run.appendEvent("brief_delivery_failed", {
      deliveryId: "mb-deliver-evt::occurrence-v1",
      error: "Gmail reconciliation is ambiguous: refusing to resend (SOURCE-ONLY-SENTENCE)",
      attempts: 2,
      errorCode: "reconciliation_ambiguous",
    });
    run.appendEvent("brief_reconciliation_refused", {
      deliveryId: "mb-deliver-evt::occurrence-v1",
      errorCode: "reconciliation_ambiguous",
      candidates: 2,
    });

    const host = new MeetingBriefHost({ runs, workspaceDir });
    const app = fastify({ logger: false });
    await host.routes(app);
    await app.ready();

    const response = await app.inject({ url: "/api/meeting-brief/measurements" });
    expect(response.statusCode).toBe(200);
    const measurements = response.json<MeetingBriefMeasurements>();
    // The retained Run is still pending, so it is both completed work (a Brief
    // exists) and queue depth; generation and delivery stay separate counts.
    expect(measurements.generation).toMatchObject({ runs: 1, completed: 1, queued: 1 });
    expect(measurements.generation.byStatus.pending).toBe(1);
    expect(measurements.delivery).toMatchObject({
      briefs: 1,
      attempts: 2,
      ambiguous: 1,
      unreadable: 0,
    });
    expect(measurements.delivery.byStatus.failed).toBe(1);
    expect(measurements.errors).toEqual([
      { stage: "deliver", code: "reconciliation_ambiguous", count: 1 },
    ]);
    // Source text never reaches the measurement, even though the Run keeps it.
    expect(JSON.stringify(measurements)).not.toContain("SOURCE-ONLY-SENTENCE");
    await app.close();
  });
});
