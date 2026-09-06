import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composePersonProfiles,
  type ConfirmedTranscript,
  type PersonProfilesComposition,
  type PersonProfilesCompositionDeps,
} from "../../../apps/server/src/person-profile/composition";

/**
 * The Person Profiles product, composed without a Shell.
 *
 * Every question below used to be answerable only by composing the whole
 * application: the research queue's evidence revision, the upcoming-meeting
 * enqueue, the confirmed Transcripts research is allowed to read, and the two
 * transcript-deletion registries were all closures written inline in
 * `composeShell`. They are this module's own now, so they are reachable from a
 * test that builds one product over one temporary Workspace.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  root: string;
  people: PersonProfilesComposition;
  /** What the Catalog would answer, under this test's control. */
  evidence: Map<string, ConfirmedTranscript[]>;
  upcoming: string[];
  enabled: { value: boolean };
}

function compose(overrides: Partial<PersonProfilesCompositionDeps> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "person-profiles-composition-"));
  roots.push(root);
  const evidence = new Map<string, ConfirmedTranscript[]>();
  const upcoming: string[] = [];
  const enabled = { value: true };
  const people = composePersonProfiles({
    workspaceDir: root,
    search: async () => [],
    complete: () => async () => ({ fullName: null, claims: [] }),
    confirmedTranscripts: (profileId) => evidence.get(profileId) ?? [],
    transcriptStillConfirmed: (profileId, transcriptId, checksum) =>
      (evidence.get(profileId) ?? []).some(
        (entry) => entry.transcriptId === transcriptId && entry.checksum === checksum,
      ),
    researchEnabled: () => enabled.value,
    upcomingParticipantEmails: () => upcoming,
    ...overrides,
  });
  return { root, people, evidence, upcoming, enabled };
}

describe("the Person Profiles composition", () => {
  it("gives every handle one Workspace, so a Profile created through one is seen by the rest", () => {
    const h = compose();
    const created = h.people.profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });

    expect(h.people.store.list().map((profile) => profile.id)).toContain(created.id);
    expect(h.people.profiles.get(created.id)?.fullName).toBe("Grace Hopper");
    /* The resolver reads the same store rather than a second copy of it. */
    expect(h.people.resolver.get(created.id)?.fullName).toBe("Grace Hopper");
  });

  it("re-enqueues a Profile when its confirmed Transcript evidence changes", async () => {
    const h = compose();
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c1",
      },
    ]);

    await h.people.queue.tick();
    const first = h.people.queue.status().jobs.find((job) => job.profileId === profile.id);
    expect(first?.evidenceRevision).toBe(JSON.stringify([["drive_a_r1", "c1"]]));

    /* A re-ingested Transcript with new bytes is new evidence: the Catalog
       answers with a different checksum, and the research has to be redone. */
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c2",
      },
    ]);
    await h.people.queue.tick();

    const second = h.people.queue.status().jobs.find((job) => job.profileId === profile.id);
    expect(second?.evidenceRevision).not.toBe(first?.evidenceRevision);
    expect(second?.reasons).toContain("evidence");
    expect(second?.attempts).toBe(2);
  });

  it("derives one evidence pair per Confirmed Identity Decision, not per Transcript", async () => {
    const h = compose();
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    const once: ConfirmedTranscript = {
      transcriptId: "drive_a_r1",
      fileName: "Sync.md",
      text: "Grace shipped Atlas.",
      checksum: "c1",
    };
    h.evidence.set(profile.id, [once]);
    await h.people.queue.tick();
    const oneDecision = h.people.queue
      .status()
      .jobs.find((job) => job.profileId === profile.id)?.evidenceRevision;

    /* Two Confirmed Identity Decisions naming the same Transcript are two
       entries. Collapsing them would change every stored revision at once
       and re-research the whole Workspace for nothing. */
    h.evidence.set(profile.id, [once, once]);
    await h.people.queue.tick();

    expect(
      h.people.queue.status().jobs.find((job) => job.profileId === profile.id)?.evidenceRevision,
    ).not.toBe(oneDecision);
  });

  it("enqueues the Profiles that a participant email of an upcoming Meeting names", async () => {
    const h = compose();
    const attending = h.people.profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    const absent = h.people.profiles.create({
      fullName: "Alan Turing",
      primaryEmail: "alan@example.com",
    });
    h.upcoming.push("grace@example.com");

    await h.people.queue.tick();

    const jobs = h.people.queue.status().jobs;
    expect(jobs.find((entry) => entry.profileId === attending.id)?.reasons).toContain("meeting");
    /* Everyone is backfilled; only the attendee is queued for the Meeting. */
    expect(jobs.find((entry) => entry.profileId === absent.id)?.reasons).not.toContain("meeting");
  });

  it("holds research while the Workspace says it is not enabled", async () => {
    const h = compose();
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.enabled.value = false;

    await h.people.queue.tick();

    const job = h.people.queue.status().jobs.find((entry) => entry.profileId === profile.id);
    expect(job).toBeUndefined();
    expect(h.people.queue.status().usedCalls).toBe(0);
    expect(h.people.dossiers.get(profile.id)).toBeNull();
  });

  it("researches duplicate confirmed mentions once and purges the resulting dossier claims", async () => {
    let extractions = 0;
    const h = compose({
      complete: () => async () => {
        extractions += 1;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [
            {
              id: "atlas",
              section: "work",
              statement: "Grace shipped Atlas.",
              status: "supported",
              nature: "statement",
              matchConfidence: "high",
              effectiveFrom: null,
              effectiveTo: null,
              citations: [{ sourceId: "source", quote: "Grace shipped Atlas." }],
              supports: [],
              supersedes: [],
              changeReason: null,
            },
          ],
          works: [],
          expertise: [],
          connections: [],
          sections: [],
        };
      },
    });
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    const transcript: ConfirmedTranscript = {
      transcriptId: "drive_a_r1",
      fileName: "Sync.md",
      text: "Grace shipped Atlas.",
      checksum: "c1",
    };
    h.evidence.set(profile.id, [transcript, transcript]);

    await h.people.queue.tick();

    expect(extractions).toBe(1);
    const dossier = h.people.dossiers.get(profile.id)!;
    expect(dossier.claims).toHaveLength(1);
    expect(
      h.people.dossiers.source(profile.id, dossier.claims[0].citations[0].sourceId),
    ).toMatchObject({
      transcriptId: transcript.transcriptId,
      visibility: "private",
      text: transcript.text,
    });
    const consumer = h.people.transcriptConsumers.find(
      (entry) => entry.consumer === "person-dossiers",
    )!;
    expect(consumer.purge(transcript.transcriptId)).toBe(1);
    expect(h.people.dossiers.get(profile.id)?.claims).toEqual([]);
    expect(consumer.purge(transcript.transcriptId)).toBe(0);
  });

  it("does not retain a Transcript whose confirmation or checksum is no longer current", async () => {
    const h = compose({ transcriptStillConfirmed: () => false });
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c1",
      },
    ]);

    await h.people.queue.tick();

    expect(h.people.dossiers.get(profile.id)?.sourceIds ?? []).toEqual([]);
  });

  it("does not publish claims when a Transcript is invalidated during extraction", async () => {
    let confirmed = true;
    let extractions = 0;
    const h = compose({
      transcriptStillConfirmed: () => confirmed,
      complete: () => async () => {
        extractions += 1;
        confirmed = false;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [
            {
              id: "atlas",
              section: "work",
              statement: "Grace shipped Atlas.",
              status: "supported",
              nature: "statement",
              matchConfidence: "high",
              effectiveFrom: null,
              effectiveTo: null,
              citations: [{ sourceId: "source", quote: "Grace shipped Atlas." }],
              supports: [],
              supersedes: [],
              changeReason: null,
            },
          ],
          works: [],
          expertise: [],
          connections: [],
          sections: [],
        };
      },
    });
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c1",
      },
    ]);

    await h.people.queue.tick();

    expect(extractions).toBe(1);
    expect(h.people.dossiers.get(profile.id)?.claims).toEqual([]);
  });

  it("privacy-deletes the dossier and queued research through the Profiles handle", async () => {
    const h = compose();
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c1",
      },
    ]);
    await h.people.queue.tick();
    expect(h.people.queue.status().jobs).toHaveLength(1);
    expect(h.people.dossiers.get(profile.id)?.sourceIds).toHaveLength(1);

    h.people.profiles.privacyDelete(profile.id, { confirmation: "DELETE PROFILE" });

    expect(h.people.profiles.get(profile.id)).toBeNull();
    expect(h.people.dossiers.get(profile.id)).toBeNull();
    expect(h.people.queue.status().jobs).toEqual([]);
  });

  it("registers both of Person Profiles' transcript-deletion consumers", () => {
    const h = compose();

    expect(h.people.transcriptConsumers.map((registry) => registry.consumer)).toEqual([
      "person-profiles",
      "person-dossiers",
    ]);
  });
});
