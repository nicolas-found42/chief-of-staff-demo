import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import type {
  TranscriptIdentityExtractionResult,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import {
  ConsentRequiredError,
  TRANSCRIPT_CATALOG_EXTRACTOR_VERSION,
  TranscriptCatalog,
} from "../../../apps/server/src/transcript-catalog/catalog";
import { TranscriptCatalogStore } from "../../../apps/server/src/transcript-catalog/store";
import { TranscriptIdentityStore } from "../../../apps/server/src/transcript-catalog/identity-store";

const NOW = () => new Date("2026-08-31T12:00:00.000Z");

import {
  extractMentions as extractMentionsWithModel,
  IDENTITY_MINING_ALGORITHM_VERSION,
} from "../../../apps/server/src/transcript-catalog/identity-extraction";
import {
  TranscriptIdentityService,
  type TranscriptIdentityExtractor,
} from "../../../apps/server/src/transcript-catalog/identity";

const EMPTY_EXTRACTION: TranscriptIdentityExtractionResult = {
  version: 1,
  mentions: [],
  organizations: [],
};

function extractMentions(record: TranscriptRecord) {
  return extractMentionsWithModel(record, EMPTY_EXTRACTION);
}

function makeRecord(text: string, id = "drive_file1_r1"): TranscriptRecord {
  return {
    id,
    source: {
      sourceSystem: "drive",
      externalFileId: "file1",
      fileName: "Weekly sync.md",
      sourceUrl: null,
      checksum: "deadbeef",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: text,
    meetingDate: "2026-08-17",
    occurrence: null,
    speakers: [],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
  };
}

interface Harness {
  workspaceDir: string;
  service: TranscriptIdentityService;
  people: WorkspacePersonProfiles;
  store: TranscriptIdentityStore;
}

function makeHarness(
  extractor: TranscriptIdentityExtractor = {
    version: "test-empty-v1",
    extract() {
      return EMPTY_EXTRACTION;
    },
  },
): Harness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "transcript-identity-"));
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    now: NOW,
    lifecycle: [],
  });
  const store = new TranscriptIdentityStore(workspaceDir);
  const service = new TranscriptIdentityService({
    store,
    people,
    extractor,
    now: NOW,
  });
  return { workspaceDir, service, people, store };
}

const SYNC_TEXT = `[00:00] Grace Hopper: Hi all, quick update on the Nimbus rollout.
[00:12] Grace Hopper: Alan Turing from Acme Corp joined the review.
[00:45] Sam: Grace Hopper will run point; Grace, can you walk us through the new Atlas dashboard?
Email questions to grace@example.com before Friday.`;

function catalogFor(h: Harness, body: string): TranscriptCatalog {
  return new TranscriptCatalog({
    workspaceDir: h.workspaceDir,
    source: {
      async folder() {
        return { folderId: "folder-1", folderName: "Transcripts" };
      },
      async listFiles() {
        return [
          {
            externalFileId: "file1",
            fileName: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
            sizeBytes: Buffer.byteLength(body),
            modifiedAt: null,
            sourceUrl: null,
          },
        ];
      },
      async fetch() {
        return Buffer.from(body);
      },
    },
    disclosure: { provider: "test-provider", model: "test-model" },
    identity: h.service,
    now: NOW,
  });
}

describe("Transcript Catalog identity processing", () => {
  it("populates the shared Review queue without creating a Profile", async () => {
    const h = makeHarness();
    const catalog = new TranscriptCatalog({
      workspaceDir: h.workspaceDir,
      source: {
        async folder() {
          return { folderId: "folder-1", folderName: "Transcripts" };
        },
        async listFiles() {
          return [
            {
              externalFileId: "file1",
              fileName: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
              sizeBytes: Buffer.byteLength(SYNC_TEXT),
              modifiedAt: null,
              sourceUrl: null,
            },
          ];
        },
        async fetch() {
          return Buffer.from(SYNC_TEXT);
        },
      },
      disclosure: { provider: "test-provider", model: "test-model" },
      identity: h.service,
      now: NOW,
    });

    await expect(catalog.processAvailable()).rejects.toBeInstanceOf(ConsentRequiredError);
    await catalog.grantConsent();
    await catalog.whenIdle();

    expect(catalog.getTranscript("drive_file1_r1")?.extractorVersion).toBe(
      TRANSCRIPT_CATALOG_EXTRACTOR_VERSION,
    );
    expect(
      h.service.reviewQueue().items.some((item) => item.mention.surfaceText === "Alan Turing"),
    ).toBe(true);
    expect(h.people.search({ includeArchived: true })).toEqual([]);
  });

  it("backfills an unchanged Transcript and rematches when Profiles change across restart", async () => {
    const h = makeHarness();
    const body = "Email grace@example.com before the review.";
    const record = makeRecord(body);
    const catalogStore = new TranscriptCatalogStore(h.workspaceDir);
    catalogStore.writeConsent({
      folderId: "folder-1",
      folderName: "Transcripts",
      consentedAt: NOW().toISOString(),
    });
    catalogStore.saveTranscript(record);
    catalogStore.saveLedgerEntry({
      sourceSystem: "drive",
      externalFileId: "file1",
      fileName: record.source.fileName,
      observedRevision: 1,
      checksum: createHash("sha256").update(body).digest("hex"),
      state: "processed",
      attempts: 1,
      transcriptId: record.id,
      reason: null,
      updatedAt: NOW().toISOString(),
    });
    const source = {
      async folder() {
        return { folderId: "folder-1", folderName: "Transcripts" };
      },
      async listFiles() {
        return [
          {
            externalFileId: "file1",
            fileName: record.source.fileName,
            sizeBytes: Buffer.byteLength(body),
            modifiedAt: null,
            sourceUrl: null,
          },
        ];
      },
      async fetch() {
        return Buffer.from(body);
      },
    };
    const firstEra = new TranscriptCatalog({
      workspaceDir: h.workspaceDir,
      source,
      disclosure: { provider: "test-provider", model: "test-model" },
      identity: h.service,
      now: NOW,
    });

    expect(await firstEra.processAvailable()).toMatchObject({ unchanged: 1 });
    expect(h.service.reviewQueue().items).toHaveLength(1);

    const grace = h.people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    const restartedIdentity = new TranscriptIdentityService({
      store: new TranscriptIdentityStore(h.workspaceDir),
      people: h.people,
      extractor: { version: "test-empty-v1", extract: () => EMPTY_EXTRACTION },
      now: NOW,
    });
    const secondEra = new TranscriptCatalog({
      workspaceDir: h.workspaceDir,
      source,
      disclosure: { provider: "test-provider", model: "test-model" },
      identity: restartedIdentity,
      now: NOW,
    });

    expect(await secondEra.processAvailable()).toMatchObject({ unchanged: 1 });
    expect(restartedIdentity.reviewQueue().items[0]).toMatchObject({
      decision: {
        profileId: expect.any(String),
        decidedBy: "policy",
      },
    });
    expect(restartedIdentity.reviewQueue().items[0]?.candidates).toContainEqual(
      expect.objectContaining({ profileId: grace.id }),
    );
  });

  it("reprocesses a previously rejected URL when a Profile adds it as known identity", async () => {
    const h = makeHarness();
    const profile = h.people.create({ fullName: "Known Personal Site" });
    const body = "Personal page: https://about.me/grace";
    const firstEra = catalogFor(h, body);
    await firstEra.grantConsent();
    await firstEra.whenIdle();
    expect(h.service.reviewQueue().items.flatMap((item) => item.mention.profileUrls)).toEqual([]);

    new PersonProfileStore(h.workspaceDir).save({
      ...profile,
      profileUrls: ["https://about.me/grace"],
    });
    const restartedIdentity = new TranscriptIdentityService({
      store: new TranscriptIdentityStore(h.workspaceDir),
      people: h.people,
      extractor: { version: "test-empty-v1", extract: () => EMPTY_EXTRACTION },
      now: NOW,
    });
    const secondEra = catalogFor({ ...h, service: restartedIdentity }, body);

    expect(await secondEra.processAvailable()).toMatchObject({ unchanged: 1 });
    expect(restartedIdentity.reviewQueue().items).toContainEqual(
      expect.objectContaining({
        mention: expect.objectContaining({ profileUrls: ["https://about.me/grace"] }),
        decision: expect.objectContaining({ profileId: profile.id, decidedBy: "policy" }),
      }),
    );
  });

  it("reprocesses an unchanged Transcript when the strict extractor version changes", async () => {
    const body = "operator";
    const h = makeHarness({ version: "strict-v1", extract: () => EMPTY_EXTRACTION });
    const profile = h.people.create({ fullName: "Grace Hopper" });
    const firstEra = catalogFor(h, body);
    await firstEra.grantConsent();
    await firstEra.whenIdle();
    expect(h.service.reviewQueue().items).toEqual([]);

    const restartedIdentity = new TranscriptIdentityService({
      store: new TranscriptIdentityStore(h.workspaceDir),
      people: h.people,
      extractor: {
        version: "strict-v2",
        extract() {
          return {
            version: 1,
            mentions: [
              {
                spanStart: 0,
                spanEnd: body.length,
                kind: "person",
                confidence: "high",
                titles: [],
                roles: [],
                aliases: ["Grace Hopper"],
                relationshipAssertions: [],
              },
            ],
            organizations: [],
          } satisfies TranscriptIdentityExtractionResult;
        },
      },
      now: NOW,
    });
    const secondEra = catalogFor({ ...h, service: restartedIdentity }, body);

    expect(await secondEra.processAvailable()).toMatchObject({ unchanged: 1 });
    expect(restartedIdentity.reviewQueue().items[0]?.candidates).toContainEqual(
      expect.objectContaining({ profileId: profile.id }),
    );
  });

  it("persists Calendar/provider speaker signals and reprocesses identity through Catalog", async () => {
    const h = makeHarness();
    const grace = h.people.create({
      fullName: "Admiral Hopper",
      primaryEmail: "grace@example.com",
    });
    const alan = h.people.create({ fullName: "The Cryptographer" });
    const jose = h.people.create({ fullName: "The Researcher" });
    const profiles = new PersonProfileStore(h.workspaceDir);
    profiles.save({ ...alan, handles: { github: ["aturing"] } });
    profiles.save({
      ...jose,
      externalContactIds: [{ system: "hubspot", externalId: "café-42" }],
    });
    const body = "Grace Hopper: Ready.\nAlan Turing: Ready.\nJosé Álvarez: Ready.";
    const catalog = catalogFor(h, body);
    await catalog.grantConsent();
    await catalog.whenIdle();
    expect(h.service.reviewQueue().items.every((item) => item.decision === null)).toBe(true);

    const associated = await catalog.associateOccurrence("drive_file1_r1", {
      occurrence: { occurrenceKey: "evt-42::2026-08-17", calendarEventId: "evt-42" },
      speakerIdentityMappings: [
        {
          speakerLabel: "Grace Hopper",
          calendarEmail: "GRACE@example.com",
          verifiedHandles: {},
          externalContactIds: [],
        },
        {
          speakerLabel: "Alan Turing",
          calendarEmail: null,
          verifiedHandles: { GitHub: ["@ATuring"] },
          externalContactIds: [],
        },
        {
          speakerLabel: "Jose\u0301 A\u0301lvarez",
          calendarEmail: null,
          verifiedHandles: {},
          externalContactIds: [{ system: "HubSpot", externalId: "cafe\u0301-42" }],
        },
      ],
      roster: [],
    });

    expect(associated.speakerIdentityMappings).toHaveLength(3);
    expect(catalog.getTranscript("drive_file1_r1")?.speakerIdentityMappings).toEqual(
      associated.speakerIdentityMappings,
    );
    const bySurface = new Map(
      h.service.reviewQueue().items.map((item) => [item.mention.surfaceText, item]),
    );
    expect(bySurface.get("Grace Hopper")?.decision).toMatchObject({
      profileId: grace.id,
      decidedBy: "policy",
    });
    expect(bySurface.get("Alan Turing")?.decision).toMatchObject({
      profileId: alan.id,
      decidedBy: "policy",
    });
    expect(bySurface.get("José Álvarez")?.decision).toMatchObject({
      profileId: jose.id,
      decidedBy: "policy",
    });
    expect(
      bySurface
        .get("José Álvarez")
        ?.candidates[0]?.signals.find((signal) => signal.signal === "external-contact-id"),
    ).toMatchObject({ matched: true });
  });

  it("supplements deterministic spans with a strict extraction Result Shape", async () => {
    const body = "Grace Hopper from Acme Corp joined the review.";
    const graceStart = body.indexOf("Grace Hopper");
    const acmeStart = body.indexOf("Acme Corp");
    const h = makeHarness({
      version: "test-strict-v1",
      extract() {
        return {
          version: 1,
          mentions: [
            {
              spanStart: graceStart,
              spanEnd: graceStart + "Grace Hopper".length,
              kind: "person",
              confidence: "high",
              titles: ["Rear Admiral"],
              roles: ["technical advisor"],
              aliases: ["Amazing Grace"],
              relationshipAssertions: [
                { subject: "Grace Hopper", relationship: "advises", object: "Acme Corp" },
              ],
            },
          ],
          organizations: [
            {
              spanStart: acmeStart,
              spanEnd: acmeStart + "Acme Corp".length,
              confidence: "high",
              aliases: ["Acme"],
              domains: ["acme.example"],
              externalCompanyIds: [{ system: "HubSpot", externalId: "company-7" }],
              relationshipAssertions: [
                { subject: "Grace Hopper", relationship: "advises", object: "Acme Corp" },
              ],
            },
          ],
        } satisfies TranscriptIdentityExtractionResult;
      },
    });
    const catalog = catalogFor(h, body);

    await catalog.grantConsent();
    await catalog.whenIdle();

    const grace = h.service
      .reviewQueue()
      .items.find((item) => item.mention.surfaceText === "Grace Hopper")!;
    expect(grace.mention).toMatchObject({
      titles: ["Rear Admiral"],
      roles: ["technical advisor"],
      aliases: ["Amazing Grace"],
      relationshipAssertions: [
        { subject: "Grace Hopper", relationship: "advises", object: "Acme Corp" },
      ],
    });
    expect(h.service.reviewQueue().organizations[0]?.organization).toMatchObject({
      aliases: ["Acme"],
      domains: ["acme.example"],
      externalCompanyIds: [{ system: "hubspot", externalId: "company-7" }],
      relationshipAssertions: [
        { subject: "Grace Hopper", relationship: "advises", object: "Acme Corp" },
      ],
    });
  });

  it("retrieves candidates from aliases, titles, roles, and Calendar roster context", async () => {
    const body = "Grace Hopper: Ready for review.";
    const start = body.indexOf("Grace Hopper");
    const h = makeHarness({
      version: "test-strict-v1",
      extract() {
        return {
          version: 1,
          mentions: [
            {
              spanStart: start,
              spanEnd: start + "Grace Hopper".length,
              kind: "person",
              confidence: "high",
              titles: ["Rear Admiral"],
              roles: ["technical advisor"],
              aliases: ["Amazing Grace"],
              relationshipAssertions: [],
            },
          ],
          organizations: [],
        } satisfies TranscriptIdentityExtractionResult;
      },
    });
    const preferred = h.people.create({
      fullName: "Amazing Grace",
      primaryEmail: "grace@example.com",
      role: "Rear Admiral and technical advisor",
    });
    const namesake = h.people.create({
      fullName: "Amazing Grace",
      primaryEmail: "other@example.com",
    });
    const catalog = catalogFor(h, body);
    await catalog.grantConsent();
    await catalog.whenIdle();

    await catalog.associateOccurrence("drive_file1_r1", {
      occurrence: { occurrenceKey: "evt-roster::occ", calendarEventId: "evt-roster" },
      speakerIdentityMappings: [],
      roster: [{ displayName: "Grace Hopper", email: "grace@example.com" }],
    });

    const item = h.service
      .reviewQueue()
      .items.find((candidate) => candidate.mention.surfaceText === "Grace Hopper")!;
    const preferredCandidate = item.candidates.find(
      (candidate) => candidate.profileId === preferred.id,
    )!;
    expect(preferredCandidate.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: "alias", matched: true }),
        expect.objectContaining({ signal: "title", matched: true }),
        expect.objectContaining({ signal: "role", matched: true }),
        expect.objectContaining({ signal: "roster-context", matched: true }),
      ]),
    );
    const namesakeCandidate = item.candidates.find(
      (candidate) => candidate.profileId === namesake.id,
    )!;
    expect(namesakeCandidate.conflicts).toContainEqual(
      expect.objectContaining({ kind: "roster-email-belongs-elsewhere", hard: true }),
    );
    expect(item.decision).toBeNull();
  });

  it("derives durable organization context from validated strict relationship assertions", async () => {
    const body = "ada works at engine works.";
    const personStart = body.indexOf("ada");
    const organizationStart = body.indexOf("engine works");
    const assertion = { subject: "ada", relationship: "works at", object: "engine works" };
    const h = makeHarness({
      version: "test-relationships-v1",
      extract() {
        return {
          version: 1,
          mentions: [
            {
              spanStart: personStart,
              spanEnd: personStart + "ada".length,
              kind: "person",
              confidence: "high",
              titles: [],
              roles: [],
              aliases: ["Ada Lovelace"],
              relationshipAssertions: [],
            },
          ],
          organizations: [
            {
              spanStart: organizationStart,
              spanEnd: organizationStart + "engine works".length,
              confidence: "high",
              aliases: ["Engine Works"],
              domains: [],
              externalCompanyIds: [],
              relationshipAssertions: [assertion],
            },
          ],
        } satisfies TranscriptIdentityExtractionResult;
      },
    });
    const profile = h.people.create({
      fullName: "Ada Lovelace",
      currentEmployer: "Engine Works",
    });
    const catalog = catalogFor(h, body);

    await catalog.grantConsent();
    await catalog.whenIdle();

    const item = h.service
      .reviewQueue()
      .items.find((candidate) => candidate.mention.surfaceText === "ada")!;
    expect(item.mention.organizationContext).toBe("engine works");
    expect(
      item.candidates.find((candidate) => candidate.profileId === profile.id)?.signals,
    ).toContainEqual(expect.objectContaining({ signal: "employer-hint", matched: true }));
    expect(h.service.reviewQueue().organizations[0]?.relatedPeople).toEqual([
      { mentionId: item.mention.id, surfaceText: "ada" },
    ]);
  });

  it("persists versioned Organization merge decisions with provenance and audit history", async () => {
    const body = "Acme Corp met Acme Incorporated.";
    const first = body.indexOf("Acme Corp");
    const second = body.indexOf("Acme Incorporated");
    const extraction: TranscriptIdentityExtractionResult = {
      version: 1,
      mentions: [],
      organizations: [
        {
          spanStart: first,
          spanEnd: first + "Acme Corp".length,
          confidence: "high",
          aliases: ["Acme"],
          domains: ["acme.example"],
          externalCompanyIds: [],
          relationshipAssertions: [],
        },
        {
          spanStart: second,
          spanEnd: second + "Acme Incorporated".length,
          confidence: "high",
          aliases: ["Acme"],
          domains: [],
          externalCompanyIds: [],
          relationshipAssertions: [],
        },
      ],
    };
    const h = makeHarness({ version: "test-strict-v1", extract: () => extraction });
    const catalog = catalogFor(h, body);
    await catalog.grantConsent();
    await catalog.whenIdle();
    const organizations = h.service.reviewQueue().organizations;
    const source = organizations.find(
      (item) => item.organization.surfaceText === "Acme Incorporated",
    )!;
    const target = organizations.find((item) => item.organization.surfaceText === "Acme Corp")!;

    const decision = h.service.mergeOrganizations({
      sourceOrganizationMentionId: source.organization.id,
      targetOrganizationMentionId: target.organization.id,
      note: "Same company in this transcript.",
    });

    expect(decision).toMatchObject({
      action: "merge",
      sourceOrganizationMentionId: source.organization.id,
      targetOrganizationMentionId: target.organization.id,
      decisionVersion: 1,
      algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
      decidedBy: "owner",
      note: "Same company in this transcript.",
      provenance: {
        source: { quote: "Acme Incorporated", transcriptId: "drive_file1_r1" },
        target: { quote: "Acme Corp", transcriptId: "drive_file1_r1" },
      },
    });
    expect(
      h.service
        .reviewQueue()
        .organizations.find((item) => item.organization.id === source.organization.id)
        ?.mergeDecision,
    ).toEqual(decision);
    expect(h.service.organizationDecisions()).toEqual([decision]);

    const restarted = new TranscriptIdentityService({
      store: new TranscriptIdentityStore(h.workspaceDir),
      people: h.people,
      extractor: { version: "test-empty-v1", extract: () => EMPTY_EXTRACTION },
      now: NOW,
    });
    expect(restarted.organizationDecisions()).toEqual([decision]);
    expect(
      restarted
        .reviewQueue()
        .organizations.find((item) => item.organization.id === source.organization.id)
        ?.mergeDecision,
    ).toEqual(decision);
  });

  it("rejects non-strict extraction adapter output before persisting identity", async () => {
    const h = makeHarness({
      version: "invalid-test-v1",
      extract() {
        return {
          version: 1,
          mentions: [],
          organizations: [],
          unexpected: true,
        } as unknown as TranscriptIdentityExtractionResult;
      },
    });
    const catalog = catalogFor(h, "Grace Hopper: Ready.");

    await catalog.grantConsent();
    await catalog.whenIdle();

    expect(catalog.status()).toMatchObject({ failed: 1 });
    expect(h.service.reviewQueue()).toEqual({ items: [], organizations: [] });
  });
});

describe("deterministic mention extraction", () => {
  it("preserves span, quote, timestamp, speaker label, provenance, and classification", async () => {
    const { mentions } = extractMentions(makeRecord(SYNC_TEXT));

    const alan = mentions.find((m) => m.surfaceText === "Alan Turing");
    expect(alan).toBeDefined();
    expect(alan!.kind).toBe("person");
    expect(alan!.normalizedForms).toContain("alan turing");
    expect(alan!.attendeeStatus).toBe("third-person");
    expect(alan!.organizationContext).toBe("acme corp");
    expect(alan!.provenance.transcriptId).toBe("drive_file1_r1");
    expect(alan!.provenance.quote).toBe("Alan Turing");
    // The span must address the exact characters of the preserved quote.
    expect(alan!.provenance.spanEnd).toBe(alan!.provenance.spanStart + "Alan Turing".length);
    expect(SYNC_TEXT.slice(alan!.provenance.spanStart, alan!.provenance.spanEnd)).toBe(
      "Alan Turing",
    );
    expect(alan!.provenance.timestamp).toBe("00:12");
    expect(alan!.provenance.speakerLabel).toBe("Grace Hopper");
    expect(alan!.provenance.meetingDate).toBe("2026-08-17");
    expect(alan!.algorithmVersion).toBe(IDENTITY_MINING_ALGORITHM_VERSION);
    expect(alan!.minedAt).toBe("2026-08-31T12:00:00.000Z");
  });

  it("keeps source speaker labels as speaker person mentions", async () => {
    const { mentions } = extractMentions(makeRecord(SYNC_TEXT));
    const grace = mentions.filter((m) => m.surfaceText === "Grace Hopper");
    expect(grace.length).toBeGreaterThanOrEqual(1);
    expect(grace.some((m) => m.attendeeStatus === "speaker")).toBe(true);
    const sam = mentions.find((m) => m.surfaceText === "Sam");
    expect(sam).toBeDefined();
    expect(sam!.attendeeStatus).toBe("speaker");
  });

  it("yields the speaker mention when the label colon is followed by several spaces", async () => {
    const body = "Grace Hopper:  I agree.";
    const { mentions } = extractMentions(makeRecord(body, "drive_wide_gap_r1"));
    const speaker = mentions.find((m) => m.surfaceText === "Grace Hopper");
    expect(speaker).toBeDefined();
    expect(speaker!.attendeeStatus).toBe("speaker");
    expect(body.slice(speaker!.provenance.spanStart, speaker!.provenance.spanEnd)).toBe(
      "Grace Hopper",
    );
  });

  it("retains organizations with normalized names and person relationships", async () => {
    const { mentions, organizations } = extractMentions(makeRecord(SYNC_TEXT));
    const acme = organizations.find((o) => o.normalizedName === "acme corp");
    expect(acme).toBeDefined();
    expect(acme!.surfaceText).toBe("Acme Corp");
    expect(acme!.confidence).toBe("high");
    const alan = mentions.find((m) => m.surfaceText === "Alan Turing")!;
    expect(acme!.relatedMentionIds).toContain(alan.id);
  });

  it("remaps organization links when the strict model reclassifies a related span", async () => {
    const body = "Alan Turing from Acme Corp joined the review.";
    const alanStart = body.indexOf("Alan Turing");
    const supplement: TranscriptIdentityExtractionResult = {
      version: 1,
      mentions: [
        {
          spanStart: alanStart,
          spanEnd: alanStart + "Alan Turing".length,
          kind: "unknown",
          confidence: "high",
          titles: [],
          roles: [],
          aliases: [],
          relationshipAssertions: [],
        },
      ],
      organizations: [],
    };
    const { mentions, organizations } = extractMentionsWithModel(
      makeRecord(body, "drive_reclass_r1"),
      supplement,
    );
    const acme = organizations.find((o) => o.normalizedName === "acme corp")!;
    expect(acme).toBeDefined();
    // The supplement reclassified "Alan Turing" from person to unknown, which
    // gives the span a new mention id; the organization must never reference
    // a nonexistent mention.
    const mentionIds = new Set(mentions.map((mention) => mention.id));
    expect(acme.relatedMentionIds.length).toBeGreaterThan(0);
    expect(acme.relatedMentionIds.every((id) => mentionIds.has(id))).toBe(true);
    const reclassified = mentions.find(
      (m) => m.provenance.spanStart === alanStart && m.kind === "unknown",
    );
    expect(reclassified).toBeDefined();
    expect(acme.relatedMentionIds).toContain(reclassified!.id);
  });

  it("retains organizations named without a related person", async () => {
    const { mentions, organizations } = extractMentions(
      makeRecord("[00:01] Sam: We reviewed the proposal with OpenAI."),
    );

    expect(organizations).toContainEqual(
      expect.objectContaining({ surfaceText: "OpenAI", normalizedName: "openai" }),
    );
    expect(mentions.some((mention) => mention.surfaceText === "OpenAI")).toBe(false);
  });

  it("does not coerce a non-attendee person into an Organization after a preposition", async () => {
    const { mentions, organizations } = extractMentions(
      makeRecord("[00:01] Sam: I met with Alan Turing."),
    );

    expect(mentions).toContainEqual(
      expect.objectContaining({ surfaceText: "Alan Turing", kind: "person" }),
    );
    expect(organizations.some((organization) => organization.surfaceText === "Alan Turing")).toBe(
      false,
    );
  });

  it("classifies product-cued names as products, never person candidates", async () => {
    const { mentions } = extractMentions(makeRecord(SYNC_TEXT));
    const atlas = mentions.find((m) => m.surfaceText === "Atlas");
    expect(atlas).toBeDefined();
    expect(atlas!.kind).toBe("product");
  });

  it("retains unknown entities without coercing them into people", async () => {
    const { mentions } = extractMentions(makeRecord("[00:01] Sam: GDPR came up in review."));
    const gdpr = mentions.find((mention) => mention.surfaceText === "GDPR");

    expect(gdpr).toBeDefined();
    expect(gdpr!.kind).toBe("unknown");
  });

  it("retains ambiguous single names and third-person references without coercion", async () => {
    const { mentions } = extractMentions(makeRecord(SYNC_TEXT));
    const graceRef = mentions.find((m) => m.surfaceText === "Grace" && m.kind === "ambiguous-name");
    expect(graceRef).toBeDefined();
    expect(graceRef!.attendeeStatus).toBe("third-person");
    // Common sentence words, days, and greetings are not mentions at all.
    const surfaces = mentions.map((m) => m.surfaceText);
    for (const noise of ["Hi", "Friday", "Email", "Hi all"]) {
      expect(surfaces).not.toContain(noise);
    }
  });

  it("captures emails as exact stable identifiers on person mentions", async () => {
    const { mentions } = extractMentions(makeRecord(SYNC_TEXT));
    const email = mentions.find((m) => m.emails.includes("grace@example.com"));
    expect(email).toBeDefined();
    expect(email!.kind).toBe("person");
    expect(email!.normalizedForms).toContain("grace@example.com");
  });

  it("normalizes honorifics and credentials into comparison forms", async () => {
    const { mentions } = extractMentions(makeRecord("[00:01] Dr. Ada Lovelace, PhD: Ready."));
    const ada = mentions.find((m) => m.surfaceText === "Dr. Ada Lovelace");
    expect(ada).toBeDefined();
    expect(ada!.normalizedForms).toContain("ada lovelace");
  });
});

describe("candidate generation and auto-link policy", () => {
  it("auto-links only a non-conflicting exact stable identifier, by policy", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    await h.service.process(makeRecord(SYNC_TEXT));

    const queue = h.service.reviewQueue();
    const emailMention = queue.items.find((i) => i.mention.emails.includes("grace@example.com"));
    expect(emailMention).toBeDefined();
    expect(emailMention!.candidates).toHaveLength(1);
    const candidate = emailMention!.candidates[0];
    expect(candidate.policyClass).toBe("confirmed");
    const emailSignal = candidate.signals.find((s) => s.signal === "exact-email");
    expect(emailSignal!.matched).toBe(true);
    expect(emailSignal!.explanation).toContain("grace@example.com");
    // The one permitted auto-link: a policy-made decision, never a Profile creation.
    expect(emailMention!.decision).toMatchObject({
      action: "confirm",
      outcome: "linked",
      profileId: h.people.search({ query: "grace" })[0].id,
      decidedBy: "policy",
    });
    expect(candidate.algorithmVersion).toBe(IDENTITY_MINING_ALGORITHM_VERSION);
  });

  it("normalizes and auto-links an exact canonical Profile URL", async () => {
    const h = makeHarness();
    const profile = h.people.create({ fullName: "Grace Hopper" });
    new PersonProfileStore(h.workspaceDir).save({
      ...profile,
      profileUrls: ["https://linkedin.com/in/grace-hopper"],
    });

    await h.service.process(
      makeRecord(
        "Profile: https://LINKEDIN.com/in/grace-hopper/?trk=meeting#biography",
        "drive_url_r1",
      ),
    );
    const item = h.service
      .reviewQueue()
      .items.find((candidate) => candidate.mention.profileUrls.length > 0)!;

    expect(item.mention.profileUrls).toEqual(["https://linkedin.com/in/grace-hopper"]);
    expect(item.candidates[0].signals).toContainEqual(
      expect.objectContaining({ signal: "exact-profile-url", matched: true }),
    );
    expect(item.decision).toMatchObject({ profileId: profile.id, decidedBy: "policy" });
  });

  it("does not treat product, organization, docs, or meeting HTTP URLs as person identity", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Unrelated Person" });
    const catalog = catalogFor(
      h,
      [
        "Docs: https://docs.example.com/people/grace",
        "Product: https://example.com/products/atlas",
        "Organization: https://linkedin.com/company/openai",
        "Meeting: https://meet.example.com/room/42",
      ].join("\n"),
    );

    await catalog.grantConsent();
    await catalog.whenIdle();

    expect(h.service.reviewQueue().items.flatMap((item) => item.mention.profileUrls)).toEqual([]);
    expect(h.service.reviewQueue().items.every((item) => item.decision === null)).toBe(true);
  });

  it("accepts an exact known Profile URL and rejects unknown person URLs", async () => {
    const h = makeHarness();
    const known = h.people.create({ fullName: "Known Personal Site" });
    const profiles = new PersonProfileStore(h.workspaceDir);
    profiles.save({ ...known, profileUrls: ["https://about.me/grace"] });
    const catalog = catalogFor(
      h,
      [
        "Known: https://ABOUT.me/grace/?utm_source=meeting#bio",
        "Rejected: https://github.com/orgs/openai/projects/1",
      ].join("\n"),
    );

    await catalog.grantConsent();
    await catalog.whenIdle();

    const urlItems = h.service
      .reviewQueue()
      .items.filter((item) => item.mention.profileUrls.length > 0);
    expect(urlItems).toHaveLength(1);
    expect(urlItems[0]?.decision).toMatchObject({ profileId: known.id, decidedBy: "policy" });
    expect(urlItems[0]?.mention.profileUrls).toEqual(["https://about.me/grace"]);
    expect(h.service.reviewQueue().items.flatMap((item) => item.mention.profileUrls)).not.toContain(
      "https://github.com/orgs/openai/projects/1",
    );
  });

  it("normalizes composed and decomposed Unicode before name comparison", async () => {
    const h = makeHarness();
    const profile = h.people.create({ fullName: "José Álvarez" });
    await h.service.process(makeRecord("Jose\u0301 A\u0301lvarez: Ready.", "drive_unicode_r1"));

    const item = h.service
      .reviewQueue()
      .items.find((candidate) => candidate.mention.surfaceText === "Jose\u0301 A\u0301lvarez")!;
    expect(item.candidates[0]).toMatchObject({ profileId: profile.id, policyClass: "probable" });
    expect(item.candidates[0]?.signals).toContainEqual(
      expect.objectContaining({ signal: "normalized-full-name", matched: true }),
    );
    expect(item.decision).toBeNull();
  });

  it("auto-links a source speaker through an exact Calendar email mapping", async () => {
    const h = makeHarness();
    const profile = h.people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    await h.service.process({
      ...makeRecord("[00:00] Grace Hopper: Ready.", "drive_calendar_r1"),
      speakerIdentityMappings: [
        {
          speakerLabel: "Grace Hopper",
          calendarEmail: "GRACE@example.com",
          verifiedHandles: {},
          externalContactIds: [],
        },
      ],
    });
    const item = h.service
      .reviewQueue()
      .items.find((candidate) => candidate.mention.surfaceText === "Grace Hopper")!;

    expect(item.mention.speakerCalendarEmail).toBe("grace@example.com");
    expect(item.candidates[0].signals).toContainEqual(
      expect.objectContaining({ signal: "speaker-calendar-email", matched: true }),
    );
    expect(item.decision).toMatchObject({ profileId: profile.id, decidedBy: "policy" });
  });

  it("auto-links a source-verified handle but never treats it as name evidence", async () => {
    const h = makeHarness();
    const profile = h.people.create({ fullName: "Admiral Hopper" });
    new PersonProfileStore(h.workspaceDir).save({
      ...profile,
      handles: { github: ["ghopper"] },
    });
    await h.service.process({
      ...makeRecord("[00:00] Grace: Ready.", "drive_handle_r1"),
      speakerIdentityMappings: [
        {
          speakerLabel: "Grace",
          calendarEmail: null,
          verifiedHandles: { GitHub: ["@GHopper"] },
          externalContactIds: [],
        },
      ],
    });
    const item = h.service
      .reviewQueue()
      .items.find((candidate) => candidate.mention.surfaceText === "Grace")!;

    expect(item.mention.verifiedHandles).toEqual({ github: ["ghopper"] });
    expect(item.candidates[0].signals).toContainEqual(
      expect.objectContaining({ signal: "verified-handle", matched: true }),
    );
    expect(item.decision).toMatchObject({ profileId: profile.id, decidedBy: "policy" });
  });

  it("auto-links an exact external contact identifier from verified speaker metadata", async () => {
    const h = makeHarness();
    const profile = h.people.create({ fullName: "Admiral Hopper" });
    new PersonProfileStore(h.workspaceDir).save({
      ...profile,
      externalContactIds: [{ system: "hubspot", externalId: "contact-42" }],
    });
    await h.service.process({
      ...makeRecord("[00:00] Grace: Ready.", "drive_contact_r1"),
      speakerIdentityMappings: [
        {
          speakerLabel: "Grace",
          calendarEmail: null,
          verifiedHandles: {},
          externalContactIds: [{ system: "HubSpot", externalId: "contact-42" }],
        },
      ],
    });
    const item = h.service
      .reviewQueue()
      .items.find((candidate) => candidate.mention.surfaceText === "Grace")!;

    expect(item.mention.externalContactIds).toEqual([
      { system: "hubspot", externalId: "contact-42" },
    ]);
    expect(item.candidates[0].signals).toContainEqual(
      expect.objectContaining({ signal: "external-contact-id", matched: true }),
    );
    expect(item.decision).toMatchObject({ profileId: profile.id, decidedBy: "policy" });
  });

  it("keeps name-only matches reviewable with a signal-by-signal explanation", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    await h.service.process(makeRecord(SYNC_TEXT));

    const queue = h.service.reviewQueue();
    const speaker = queue.items.find(
      (i) => i.mention.surfaceText === "Grace Hopper" && i.mention.attendeeStatus === "speaker",
    );
    expect(speaker).toBeDefined();
    expect(speaker!.decision).toBeNull();
    expect(speaker!.candidates).toHaveLength(1);
    const candidate = speaker!.candidates[0];
    expect(candidate.policyClass).toBe("probable");
    expect(candidate.score).toBeGreaterThan(0);
    const nameSignal = candidate.signals.find((s) => s.signal === "normalized-full-name");
    expect(nameSignal!.matched).toBe(true);
    const emailSignal = candidate.signals.find((s) => s.signal === "exact-email");
    expect(emailSignal!.matched).toBe(false);
    expect(candidate.evidence[0].quote).toBe("Grace Hopper");
  });

  it("retains every plausible candidate when two Profiles share a name", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Grace Hopper" });
    h.people.create({ fullName: "Grace Hopper" });
    await h.service.process(makeRecord(SYNC_TEXT));

    const speaker = h.service
      .reviewQueue()
      .items.find(
        (i) => i.mention.surfaceText === "Grace Hopper" && i.mention.attendeeStatus === "speaker",
      );
    expect(speaker!.candidates).toHaveLength(2);
    expect(speaker!.candidates.every((c) => c.policyClass === "ambiguous")).toBe(true);
    expect(speaker!.candidates[0].leadOverNext).toBe(0);
    expect(speaker!.candidates[1].leadOverNext).toBeNull();
    expect(speaker!.decision).toBeNull();
  });

  it("prevents linking when the mention's email belongs to a different Profile", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    h.people.create({ fullName: "Grace Hopper" }); // same name, no email
    // The name and the email occur on one span, so one mention carries both
    // pieces of evidence and the email-less namesake becomes a hard conflict.
    await h.service.process(
      makeRecord("Grace Hopper grace@example.com will brief.\n", "drive_file9_r1"),
    );
    const named = h.service.reviewQueue().items.find((i) => i.transcriptId === "drive_file9_r1");
    const emailMention = named!;
    const withoutEmail = emailMention.candidates.find((c) => {
      const profile = h.people.get(c.profileId)!;
      return profile.primaryEmail === null;
    });
    expect(withoutEmail).toBeDefined();
    const conflict = withoutEmail!.conflicts.find((c) => c.hard);
    expect(conflict!.kind).toBe("email-belongs-elsewhere");
    expect(withoutEmail!.policyClass).toBe("ambiguous");
    // The email-owning Profile stays confirmed; the other stays reviewable.
    expect(emailMention.candidates.some((c) => c.policyClass === "confirmed")).toBe(true);
  });

  it("hard-conflicts every candidate when an exact stable identifier has duplicate owners", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    const duplicate = h.people.create({
      fullName: "Grace Namesake",
      primaryEmail: "other@example.com",
    });
    new PersonProfileStore(h.workspaceDir).save({
      ...duplicate,
      primaryEmail: "grace@example.com",
      emails: ["grace@example.com"],
    });

    await h.service.process(makeRecord("Grace Hopper grace@example.com joined the review."));
    const item = h.service
      .reviewQueue()
      .items.find((candidate) => candidate.mention.emails.includes("grace@example.com"))!;

    expect(item.candidates).toHaveLength(2);
    expect(
      item.candidates.every((candidate) =>
        candidate.conflicts.some(
          (conflict) => conflict.kind === "duplicate-stable-id" && conflict.hard,
        ),
      ),
    ).toBe(true);
    expect(item.candidates.every((candidate) => candidate.policyClass === "ambiguous")).toBe(true);
    expect(item.decision).toBeNull();
  });

  it("scores employer context as a weaker signal with a persisted lead", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Alan Turing", currentEmployer: "Acme Corp" });
    h.people.create({ fullName: "Alan Turing" });
    await h.service.process(makeRecord(SYNC_TEXT));

    const alan = h.service.reviewQueue().items.find((i) => i.mention.surfaceText === "Alan Turing");
    const withEmployer = alan!.candidates.find(
      (c) => h.people.get(c.profileId)!.currentEmployer === "Acme Corp",
    );
    expect(withEmployer).toBeDefined();
    const hint = withEmployer!.signals.find((s) => s.signal === "employer-hint");
    expect(hint!.matched).toBe(true);
    expect(withEmployer!.score).toBeGreaterThan(0);
    expect(withEmployer!.leadOverNext).toBeGreaterThan(0);
  });

  it("never creates a Profile from any mining path", async () => {
    const h = makeHarness();
    await h.service.process(makeRecord(SYNC_TEXT));
    expect(h.people.search({ includeArchived: true })).toEqual([]);
  });
});

describe("review decisions", () => {
  async function harnessed() {
    const h = makeHarness();
    await h.service.process(makeRecord(SYNC_TEXT));
    return h;
  }

  it("confirms a probable candidate and links the existing Profile", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    await h.service.process(makeRecord(SYNC_TEXT));
    const speaker = h.service
      .reviewQueue()
      .items.find(
        (i) => i.mention.surfaceText === "Grace Hopper" && i.mention.attendeeStatus === "speaker",
      )!;
    const decision = h.service.decide({
      mentionId: speaker.mention.id,
      action: "confirm",
      profileId: speaker.candidates[0].profileId,
    });
    expect(decision).toMatchObject({
      action: "confirm",
      outcome: "linked",
      decidedBy: "owner",
      profileRevision: 1,
    });
  });

  it("links an alternate existing Profile on request", async () => {
    const h = await harnessed();
    const other = h.people.create({ fullName: "Grace Murray Hopper" });
    const grace = h.service
      .reviewQueue()
      .items.find((i) => i.mention.kind === "ambiguous-name" && i.mention.surfaceText === "Grace")!;
    const decision = h.service.decide({
      mentionId: grace.mention.id,
      action: "alternate-profile",
      profileId: other.id,
    });
    expect(decision.outcome).toBe("linked");
    expect(decision.profileId).toBe(other.id);
  });

  it("creates a Profile only on an explicit review action and prefills stable evidence", async () => {
    const h = await harnessed();
    const emailMention = h.service
      .reviewQueue()
      .items.find((item) => item.mention.emails.includes("grace@example.com"))!;

    const decision = h.service.decide({
      mentionId: emailMention.mention.id,
      action: "create-profile",
    });

    expect(decision).toMatchObject({ outcome: "created", decidedBy: "owner" });
    expect(h.people.get(decision.profileId!)).toMatchObject({
      fullName: null,
      primaryEmail: "grace@example.com",
      revision: 1,
    });
  });

  it("marks an archived Profile as a hard conflict and never auto-links it", async () => {
    const h = makeHarness();
    const archived = h.people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    const profile = h.people.get(archived.id)!;
    new PersonProfileStore(h.workspaceDir).save({ ...profile, archivedAt: NOW().toISOString() });
    await h.service.process(makeRecord(SYNC_TEXT));

    const emailMention = h.service
      .reviewQueue()
      .items.find((i) => i.mention.emails.includes("grace@example.com"));
    expect(emailMention!.candidates).toHaveLength(1);
    expect(emailMention!.candidates[0].policyClass).toBe("ambiguous");
    const conflict = emailMention!.candidates[0].conflicts.find((c) => c.hard);
    expect(conflict!.kind).toBe("archived-profile");
    expect(emailMention!.decision).toBeNull();
  });

  it("records not-a-person and unresolved outcomes without identity", async () => {
    const h = await harnessed();
    const sam = h.service.reviewQueue().items.find((i) => i.mention.surfaceText === "Sam")!;
    const rejected = h.service.decide({ mentionId: sam.mention.id, action: "not-a-person" });
    expect(rejected.outcome).toBe("not-a-person");
    expect(rejected.profileId).toBeNull();

    const other = h.service
      .reviewQueue()
      .items.find((i) => i.mention.kind === "ambiguous-name" && i.mention.surfaceText === "Grace")!;
    const unresolved = h.service.decide({ mentionId: other.mention.id, action: "unresolved" });
    expect(unresolved.outcome).toBe("unresolved");
    expect(unresolved.profileId).toBeNull();
  });

  it("applies an ordinary review decision only to the named mention", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    await h.service.process(makeRecord(SYNC_TEXT));
    const formItems = h.service
      .reviewQueue()
      .items.filter((i) => i.mention.normalizedForms.includes("grace hopper"));
    // The source speaker label and the third-person utterance share a form.
    expect(formItems.length).toBe(2);
    const undecided = formItems.find((i) => i.decision === null)!;
    h.service.decide({
      mentionId: undecided.mention.id,
      action: "confirm",
      profileId: h.people.search({ query: "grace" })[0].id,
    });
    const after = h.service
      .reviewQueue()
      .items.filter((i) => i.mention.normalizedForms.includes("grace hopper"));
    expect(after.find((item) => item.mention.id === undecided.mention.id)?.decision).not.toBeNull();
    expect(after.find((item) => item.mention.id !== undecided.mention.id)?.decision).toBeNull();
  });

  it.each(["alternate-profile", "create-profile", "not-a-person", "unresolved"] as const)(
    "keeps %s decisions mention-local",
    async (action) => {
      const h = await harnessed();
      const sameForm = h.service
        .reviewQueue()
        .items.filter((item) => item.mention.normalizedForms.includes("grace hopper"));
      const target = sameForm[0];
      if (action === "alternate-profile") {
        const alternate = h.people.create({ fullName: "Grace Murray Hopper" });
        h.service.decide({ mentionId: target.mention.id, action, profileId: alternate.id });
      } else {
        h.service.decide({ mentionId: target.mention.id, action });
      }

      const after = h.service
        .reviewQueue()
        .items.filter((item) => item.mention.normalizedForms.includes("grace hopper"));
      expect(after.find((item) => item.mention.id === target.mention.id)?.decision?.action).toBe(
        action,
      );
      expect(after.find((item) => item.mention.id !== target.mention.id)?.decision).toBeNull();
    },
  );

  it("refuses decisions that name an unknown mention or unknown Profile", async () => {
    const h = await harnessed();
    expect(() =>
      h.service.decide({ mentionId: "nope", action: "confirm", profileId: "person_x" }),
    ).toThrow();
    const sam = h.service.reviewQueue().items.find((i) => i.mention.surfaceText === "Sam")!;
    expect(() =>
      h.service.decide({ mentionId: sam.mention.id, action: "confirm", profileId: "person_x" }),
    ).toThrow();
  });
});

describe("remembered mappings", () => {
  it("stores an opt-in, scoped, versioned mapping and replays it in scope only", async () => {
    const h = makeHarness();
    const grace = h.people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    await h.service.process(makeRecord(SYNC_TEXT));
    const speaker = h.service
      .reviewQueue()
      .items.find(
        (i) => i.mention.surfaceText === "Grace Hopper" && i.mention.attendeeStatus === "speaker",
      )!;

    const decision = h.service.decide({
      mentionId: speaker.mention.id,
      action: "remember-mapping",
      profileId: grace.id,
      scope: "transcript",
    });
    expect(decision.outcome).toBe("linked");

    const mappings = h.service.mappings();
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      scope: "transcript",
      scopeId: "drive_file1_r1",
      profileId: grace.id,
      mappingVersion: 1,
      revokedAt: null,
    });

    // A different transcript with the same name: out of this mapping's scope.
    await h.service.process(makeRecord("Grace Hopper: solo note.\n", "drive_file2_r1"));
    const otherItem = h.service
      .reviewQueue()
      .items.find(
        (i) => i.mention.surfaceText === "Grace Hopper" && i.transcriptId === "drive_file2_r1",
      )!;
    expect(otherItem.decision).toBeNull();
    expect(otherItem.candidates.every((c) => c.policyClass !== "confirmed")).toBe(true);
    expect(otherItem.rememberedMapping).toBeNull();

    // Explicitly remembering the mapping applies it to other same-form
    // mentions already present in this immutable Transcript.
    const replayed = h.service
      .reviewQueue()
      .items.find(
        (i) =>
          i.transcriptId === "drive_file1_r1" &&
          i.mention.id !== speaker.mention.id &&
          i.mention.normalizedForms.includes("grace hopper"),
      )!;
    expect(replayed.decision).toMatchObject({
      action: "remember-mapping",
      outcome: "linked",
      decidedBy: "owner",
      profileId: grace.id,
    });
  });

  it("prefers active transcript authority over a higher-version workspace lineage", async () => {
    const h = makeHarness();
    const transcriptId = "drive_mapping_precedence_r1";
    const grace = h.people.create({ fullName: "Grace Hopper" });
    const murray = h.people.create({ fullName: "Grace Murray Hopper" });
    const initial = makeRecord("Grace Hopper: ready.", transcriptId);
    initial.source.checksum = "mapping-precedence-v1";
    await h.service.process(initial);
    const named = h.service.reviewQueue().items.find((item) => item.transcriptId === transcriptId)!;

    h.service.decide({
      mentionId: named.mention.id,
      action: "remember-mapping",
      profileId: grace.id,
      scope: "workspace",
    });
    h.service.decide({
      mentionId: named.mention.id,
      action: "remember-mapping",
      profileId: murray.id,
      scope: "workspace",
    });
    const transcriptDecision = h.service.decide({
      mentionId: named.mention.id,
      action: "remember-mapping",
      profileId: grace.id,
      scope: "transcript",
    });
    const transcriptMapping = h.service
      .mappings()
      .find((mapping) => mapping.scope === "transcript")!;
    expect(transcriptDecision.mappingAuthority).toEqual({
      lineageId: transcriptMapping.lineageId,
      mappingId: transcriptMapping.id,
      mappingVersion: 1,
    });

    const expanded = makeRecord("Grace Hopper: ready.\nGrace Hopper joined later.", transcriptId);
    expanded.source.checksum = "mapping-precedence-v2";
    await h.service.process(expanded);
    const later = h.service
      .reviewQueue()
      .items.find(
        (item) => item.transcriptId === transcriptId && item.mention.provenance.spanStart > 0,
      )!;

    expect(later.decision).toMatchObject({
      profileId: grace.id,
      mappingAuthority: {
        lineageId: transcriptMapping.lineageId,
        mappingId: transcriptMapping.id,
        mappingVersion: 1,
      },
    });
    expect(later.rememberedMapping).toMatchObject({ id: transcriptMapping.id });
  });

  it("ignores a revoked workspace lineage while an active transcript lineage remains", async () => {
    const h = makeHarness();
    const transcriptId = "drive_mapping_revoked_workspace_r1";
    const grace = h.people.create({ fullName: "Grace Hopper" });
    const murray = h.people.create({ fullName: "Grace Murray Hopper" });
    const initial = makeRecord("Grace Hopper: ready.", transcriptId);
    initial.source.checksum = "mapping-revoked-v1";
    await h.service.process(initial);
    const named = h.service.reviewQueue().items.find((item) => item.transcriptId === transcriptId)!;
    h.service.decide({
      mentionId: named.mention.id,
      action: "remember-mapping",
      profileId: murray.id,
      scope: "workspace",
    });
    const workspace = h.service.mappings()[0];
    h.service.decide({
      mentionId: named.mention.id,
      action: "remember-mapping",
      profileId: grace.id,
      scope: "transcript",
    });
    const transcriptMapping = h.service
      .mappings()
      .find((mapping) => mapping.scope === "transcript")!;
    h.service.revokeMapping(workspace.id);

    const expanded = makeRecord("Grace Hopper: ready.\nGrace Hopper joined later.", transcriptId);
    expanded.source.checksum = "mapping-revoked-v2";
    await h.service.process(expanded);
    const later = h.service
      .reviewQueue()
      .items.find(
        (item) => item.transcriptId === transcriptId && item.mention.provenance.spanStart > 0,
      )!;

    expect(later.decision).toMatchObject({
      profileId: grace.id,
      mappingAuthority: { lineageId: transcriptMapping.lineageId },
    });
    expect(later.rememberedMapping).toMatchObject({ id: transcriptMapping.id });
  });

  it("keeps conflicting active lineages reviewable instead of applying either one", async () => {
    const h = makeHarness();
    const first = h.people.create({ fullName: "First Profile" });
    const second = h.people.create({ fullName: "Second Profile" });
    for (const [lineageId, profileId] of [
      ["legacy_lineage_first", first.id],
      ["legacy_lineage_second", second.id],
    ] as const) {
      h.store.appendMapping({
        id: `${lineageId}_v1`,
        lineageId,
        supersedesMappingId: null,
        scope: "workspace",
        scopeId: null,
        normalizedForm: "grace hopper",
        surfaceText: "Grace Hopper",
        profileId,
        mappingVersion: 1,
        createdAt: NOW().toISOString(),
        revokedAt: null,
      });
    }

    await h.service.process(makeRecord("Grace Hopper: ready.", "drive_mapping_conflict_r1"));
    const item = h.service
      .reviewQueue()
      .items.find((candidate) => candidate.transcriptId === "drive_mapping_conflict_r1")!;
    expect(item.decision).toBeNull();
    expect(item.rememberedMapping).toBeNull();
    expect(item.candidates.map((candidate) => candidate.profileId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(
      item.candidates.every((candidate) =>
        candidate.signals.some(
          (signal) => signal.signal === "remembered-mapping" && signal.matched,
        ),
      ),
    ).toBe(true);
  });

  it("keeps immutable mapping lineage and revokes links applied by every version", async () => {
    const h = makeHarness();
    const grace = h.people.create({ fullName: "Grace Hopper" });
    const murray = h.people.create({ fullName: "Grace Murray Hopper" });
    await h.service.process(makeRecord(SYNC_TEXT));
    const speaker = h.service
      .reviewQueue()
      .items.find(
        (i) => i.mention.surfaceText === "Grace Hopper" && i.mention.attendeeStatus === "speaker",
      )!;
    const v1Decision = h.service.decide({
      mentionId: speaker.mention.id,
      action: "remember-mapping",
      profileId: grace.id,
      scope: "workspace",
    });
    await h.service.process(makeRecord("Grace Hopper: v1 applies.\n", "drive_mapping_v1_r1"));
    const v1Applied = h.service
      .reviewQueue()
      .items.find((item) => item.transcriptId === "drive_mapping_v1_r1")!;

    const v2Decision = h.service.decide({
      mentionId: speaker.mention.id,
      action: "remember-mapping",
      profileId: murray.id,
      scope: "workspace",
    });
    const mappings = h.service.mappings();
    expect(mappings).toHaveLength(2);
    expect(mappings[0]).toMatchObject({
      mappingVersion: 1,
      profileId: grace.id,
      supersedesMappingId: null,
      revokedAt: null,
    });
    expect(mappings[1]).toMatchObject({
      mappingVersion: 2,
      profileId: murray.id,
      lineageId: mappings[0].lineageId,
      supersedesMappingId: mappings[0].id,
      revokedAt: null,
    });
    expect(v1Decision).toMatchObject({
      mappingAuthority: {
        lineageId: mappings[0].lineageId,
        mappingId: mappings[0].id,
        mappingVersion: 1,
      },
    });
    expect(v1Applied.decision).toMatchObject({
      mappingAuthority: {
        lineageId: mappings[0].lineageId,
        mappingId: mappings[0].id,
        mappingVersion: 1,
      },
    });
    expect(v2Decision).toMatchObject({
      mappingAuthority: {
        lineageId: mappings[1].lineageId,
        mappingId: mappings[1].id,
        mappingVersion: 2,
      },
    });

    await h.service.process(makeRecord("Grace Hopper: v2 applies.\n", "drive_mapping_v2_r1"));
    const v2Applied = h.service
      .reviewQueue()
      .items.find((item) => item.transcriptId === "drive_mapping_v2_r1")!;
    expect(v2Applied.decision).toMatchObject({
      mappingAuthority: { mappingId: mappings[1].id, mappingVersion: 2 },
    });

    const revoked = h.service.revokeMapping(mappings[1].id);
    expect(revoked).toMatchObject({
      lineageId: mappings[0].lineageId,
      mappingVersion: 3,
      supersedesMappingId: mappings[1].id,
      revokedAt: NOW().toISOString(),
    });
    expect(h.service.mappings()).toHaveLength(3);
    expect(h.service.mappings()[0]).toEqual(mappings[0]);
    expect(h.service.mappings()[1]).toEqual(mappings[1]);
    for (const transcriptId of ["drive_mapping_v1_r1", "drive_mapping_v2_r1"]) {
      expect(
        h.service.reviewQueue().items.find((item) => item.transcriptId === transcriptId)?.decision,
      ).toMatchObject({ action: "unresolved", outcome: "unresolved", profileId: null });
    }
  });

  it("applies mappings as reversible owner decisions without promoting name evidence", async () => {
    const h = makeHarness();
    const grace = h.people.create({ fullName: "Grace Hopper" });
    await h.service.process(makeRecord(SYNC_TEXT));
    const speaker = h.service
      .reviewQueue()
      .items.find(
        (i) => i.mention.surfaceText === "Grace Hopper" && i.mention.attendeeStatus === "speaker",
      )!;
    h.service.decide({
      mentionId: speaker.mention.id,
      action: "remember-mapping",
      profileId: grace.id,
      scope: "workspace",
    });
    await h.service.process(makeRecord("[00:03] Grace Hopper: back again.\n", "drive_file3_r1"));
    const applied = h.service
      .reviewQueue()
      .items.find((item) => item.transcriptId === "drive_file3_r1")!;
    expect(applied.candidates.every((candidate) => candidate.policyClass !== "confirmed")).toBe(
      true,
    );
    expect(applied.decision).toMatchObject({
      action: "remember-mapping",
      outcome: "linked",
      profileId: grace.id,
      decidedBy: "owner",
    });

    h.service.revokeMapping(h.service.mappings()[0].id);
    expect(h.service.mappings().at(-1)?.revokedAt).not.toBeNull();
    const reversed = h.service
      .reviewQueue()
      .items.find((item) => item.transcriptId === "drive_file3_r1")!;
    expect(reversed.decision).toMatchObject({
      action: "unresolved",
      outcome: "unresolved",
      profileId: null,
      decidedBy: "owner",
    });

    await h.service.process(makeRecord("[00:04] Grace Hopper: later.\n", "drive_file4_r1"));
    const future = h.service
      .reviewQueue()
      .items.find((item) => item.transcriptId === "drive_file4_r1")!;
    expect(future.decision).toBeNull();
  });
});

describe("rematching against changed Profiles and authority", () => {
  const EMAIL_LINE = "Email questions to grace@example.com before Friday.";

  function emailItem(h: Harness) {
    return h.service
      .reviewQueue()
      .items.find((item) => item.mention.emails.includes("grace@example.com"))!;
  }

  it("follows a merged-away Profile to its survivor instead of holding the stale link", async () => {
    const h = makeHarness();
    const survivor = h.people.create({ fullName: "Grace Hopper" });
    const duplicate = h.people.create({
      fullName: "Grace M Hopper",
      primaryEmail: "grace@example.com",
    });
    await h.service.process(makeRecord(EMAIL_LINE));
    expect(emailItem(h).decision).toMatchObject({
      profileId: duplicate.id,
      decidedBy: "policy",
    });

    h.people.merge(survivor.id, {
      duplicateId: duplicate.id,
      resolutions: { fullName: "Grace Hopper" },
    });
    h.service.rematch();

    expect(emailItem(h).decision).toMatchObject({
      action: "confirm",
      outcome: "linked",
      profileId: survivor.id,
      decidedBy: "policy",
    });
    expect(emailItem(h).candidates.map((candidate) => candidate.profileId)).toEqual([survivor.id]);
  });

  it("withdraws an auto-link once the Profile it linked is archived", async () => {
    const h = makeHarness();
    const grace = h.people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    await h.service.process(makeRecord(EMAIL_LINE));
    expect(emailItem(h).decision).toMatchObject({ profileId: grace.id, decidedBy: "policy" });

    new PersonProfileStore(h.workspaceDir).save(
      fromPartial({ ...h.people.get(grace.id)!, archivedAt: NOW().toISOString() }),
    );
    h.service.rematch();

    expect(emailItem(h).decision).toMatchObject({
      action: "unresolved",
      outcome: "unresolved",
      profileId: null,
      decidedBy: "policy",
    });
    expect(emailItem(h).candidates[0]).toMatchObject({ policyClass: "ambiguous" });
  });

  it("re-pins an owner confirmation to the revision that superseded the invalidated one", async () => {
    const h = makeHarness();
    const grace = h.people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    await h.service.process(makeRecord(SYNC_TEXT));
    const speaker = h.service
      .reviewQueue()
      .items.find(
        (i) => i.mention.surfaceText === "Grace Hopper" && i.mention.attendeeStatus === "speaker",
      )!;
    const confirmed = h.service.decide({
      mentionId: speaker.mention.id,
      action: "confirm",
      profileId: grace.id,
    });
    expect(confirmed).toMatchObject({ profileRevision: 1, decidedBy: "owner" });

    h.people.correct(grace.id, { role: "Rear Admiral" });
    h.service.rematch();

    const repaired = h.service
      .reviewQueue()
      .items.find((item) => item.mention.id === speaker.mention.id)!;
    expect(repaired.decision).toMatchObject({
      action: "confirm",
      outcome: "linked",
      profileId: grace.id,
      profileRevision: 2,
      decidedBy: "owner",
    });
  });

  it("falls back to the broader active mapping when the narrower one is revoked", async () => {
    const h = makeHarness();
    const workspaceProfile = h.people.create({ fullName: "Grace Hopper" });
    const transcriptProfile = h.people.create({ fullName: "Grace Murray Hopper" });
    await h.service.process(makeRecord("Grace Hopper: ready.", "drive_fallback_r1"));
    const named = h.service
      .reviewQueue()
      .items.find((item) => item.transcriptId === "drive_fallback_r1")!;

    h.service.decide({
      mentionId: named.mention.id,
      action: "remember-mapping",
      profileId: workspaceProfile.id,
      scope: "workspace",
    });
    h.service.decide({
      mentionId: named.mention.id,
      action: "remember-mapping",
      profileId: transcriptProfile.id,
      scope: "transcript",
    });
    const narrower = h.service.mappings().find((mapping) => mapping.scope === "transcript")!;
    expect(
      h.service.reviewQueue().items.find((item) => item.mention.id === named.mention.id)?.decision,
    ).toMatchObject({ profileId: transcriptProfile.id });

    h.service.revokeMapping(narrower.id);

    expect(
      h.service.reviewQueue().items.find((item) => item.mention.id === named.mention.id)?.decision,
    ).toMatchObject({
      action: "remember-mapping",
      outcome: "linked",
      profileId: workspaceProfile.id,
    });
  });

  it("appends nothing when rematching leaves every outcome unchanged", async () => {
    const h = makeHarness();
    h.people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    await h.service.process(makeRecord(SYNC_TEXT));
    const settled = h.store.readDecisions().length;
    expect(settled).toBeGreaterThan(0);

    h.service.rematch();
    h.service.rematch();
    await h.service.process(makeRecord(SYNC_TEXT));

    expect(h.store.readDecisions()).toHaveLength(settled);
  });

  it("rematches the corpus when a review action creates a Profile", async () => {
    const h = makeHarness();
    await h.service.process(makeRecord(SYNC_TEXT));
    await h.service.process(makeRecord("Reach grace@example.com for notes.", "drive_other_r1"));
    const seed = emailItem(h);

    h.service.decide({ mentionId: seed.mention.id, action: "create-profile" });

    const elsewhere = h.service
      .reviewQueue()
      .items.find(
        (item) =>
          item.transcriptId === "drive_other_r1" &&
          item.mention.emails.includes("grace@example.com"),
      )!;
    expect(elsewhere.decision).toMatchObject({ outcome: "linked", decidedBy: "policy" });
  });
});
