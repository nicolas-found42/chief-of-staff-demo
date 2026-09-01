import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterDiagnostic, SourceItem } from "@chief-of-staff-demo/shared";
import { WorkspaceBrandProfileStore } from "../../../apps/server/src/brand-profile/store";
import {
  ContentProjectError,
  WorkspaceContentProjects,
} from "../../../apps/server/src/content-projects/projects";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";

const NOW = new Date("2026-08-31T18:00:00.000Z");

const SOURCE_ITEM: SourceItem = {
  id: "source_1",
  externalId: "article-1",
  targetId: "target_1",
  adapterId: "website",
  canonicalUrl: "https://evidence.example/article",
  author: "Researcher",
  title: "Evidence-backed content",
  body: "Reviewed public evidence.",
  description: null,
  publishedAt: "2026-08-30T12:00:00.000Z",
  discoveredAt: "2026-08-31T17:00:00.000Z",
  media: [],
  transcript: null,
  comments: [],
  evidence: [
    { route: "https://evidence.example/article", retrievedAt: "2026-08-31T17:00:00.000Z" },
  ],
  completeness: {
    title: "available",
    body: "available",
    description: "unsupported",
    transcript: "unsupported",
    comments: "unsupported",
    media: "unsupported",
  },
};

const DIAGNOSTIC: AdapterDiagnostic = {
  classification: "items_found",
  route: "https://evidence.example/article",
  status: 200,
  contentType: "text/html",
  parserStage: "readability",
  responseHash: "response-hash",
  adapterVersion: "1",
  startedAt: "2026-08-31T17:00:00.000Z",
  finishedAt: "2026-08-31T17:00:01.000Z",
  retries: 0,
  affectedCapabilities: ["body"],
  causeChain: [],
};

function setup() {
  const workspaceDir = mkdtempSync(join(tmpdir(), "content-projects-"));
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    now: () => NOW,
  });
  const owner = people.create({ fullName: "Workspace Owner", primaryEmail: "owner@example.com" });
  const ownerOnboarding = new OwnerOnboarding({ people, workspaceDir, now: () => NOW });
  ownerOnboarding.setConnectedIdentity("owner@example.com");
  ownerOnboarding.confirm(owner.id);
  const brandProfiles = new WorkspaceBrandProfileStore(workspaceDir, () => NOW);
  const projects = new WorkspaceContentProjects({
    workspaceDir,
    people,
    ownerOnboarding,
    brandProfiles,
    now: () => NOW,
  });
  return { workspaceDir, people, owner, ownerOnboarding, brandProfiles, projects };
}

describe("WorkspaceContentProjects creation and author policy", () => {
  it("starts from a Topic or confirmed Person Profile and defaults authorship to the owner", () => {
    const { people, owner, projects } = setup();
    const subject = people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });

    const topicProject = projects.create({
      subject: { kind: "topic", topic: "Why compiler feedback should be conversational" },
      objective: "establish-authority",
      audience: "Engineering leaders",
      constraints: ["Do not overstate the evidence"],
      targets: ["linkedin-standard-post"],
      researchMode: "no-external-research",
      seedMaterial: ["The audience already uses typed languages."],
    });
    expect(topicProject.revisions[0]).toMatchObject({
      revision: 1,
      subject: { kind: "topic", topic: "Why compiler feedback should be conversational" },
      author: { profileId: owner.id, profileRevision: 1 },
      objective: "establish-authority",
      audience: "Engineering leaders",
      constraints: ["Do not overstate the evidence"],
      targets: ["linkedin-standard-post"],
      researchMode: "no-external-research",
      seedMaterial: ["The audience already uses typed languages."],
    });

    const profileProject = projects.create({
      subject: { kind: "person-profile", profileId: subject.id },
      objective: "educate",
      audience: "Software historians",
      constraints: [],
      targets: [],
      researchMode: null,
      seedMaterial: [],
    });
    expect(profileProject.revisions[0]?.subject).toEqual({
      kind: "person-profile",
      profileId: subject.id,
      profileRevision: 1,
    });

    expect(() =>
      projects.create({
        subject: { kind: "topic", topic: "Grace's perspective" },
        authorProfileId: subject.id,
        objective: "educate",
        audience: "Software historians",
        constraints: [],
        targets: ["website-blog-article"],
        researchMode: "existing-workspace-evidence",
        seedMaterial: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({ code: "author-forbidden" }),
    );

    projects.authorizeAuthor(subject.id);
    expect(() =>
      projects.create({
        subject: { kind: "topic", topic: "Grace's perspective" },
        authorProfileId: subject.id,
        objective: "educate",
        audience: "Software historians",
        constraints: [],
        targets: ["website-blog-article"],
        researchMode: "existing-workspace-evidence",
        seedMaterial: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({ code: "author-forbidden" }),
    );

    projects.approveContentVoice(subject.id, "Precise, direct, and grounded in lived experience.");
    const authorized = projects.create({
      subject: { kind: "topic", topic: "Grace's perspective" },
      authorProfileId: subject.id,
      objective: "educate",
      audience: "Software historians",
      constraints: [],
      targets: ["website-blog-article"],
      researchMode: "existing-workspace-evidence",
      seedMaterial: [],
    });
    expect(authorized.revisions[0]?.author).toEqual({
      profileId: subject.id,
      profileRevision: 1,
    });
  });
});

describe("WorkspaceContentProjects Outline Brief gate", () => {
  it("freezes reviewed evidence and permits a separately approved immutable Brief only when every gate is present", () => {
    const { projects, owner, brandProfiles } = setup();
    projects.approveContentVoice(owner.id, "Clear, practical, and evidence-led.");
    const brand = brandProfiles.accept({
      markdown: "# Brand Profile\n\n## Voice\nUseful and specific.",
      sourceScan: {
        websiteUrl: "https://brand.example/",
        includedUrls: ["https://brand.example/"],
        excludedUrls: [],
      },
    });
    const project = projects.create({
      subject: { kind: "topic", topic: "Durable approval gates" },
      objective: "educate",
      audience: "Workflow builders",
      constraints: ["Separate facts from author claims"],
      targets: ["linkedin-standard-post", "email-newsletter"],
      researchMode: "existing-workspace-evidence",
      seedMaterial: ["A frozen input should survive later changes."],
    });

    expect(() =>
      projects.proposeOutlineBrief(project.id, {
        thesis: "Approval gates make generated work reproducible.",
        angle: "Treat evidence review as product state.",
        claims: ["Frozen inputs preserve lineage."],
        evidenceMap: [{ claim: "Frozen inputs preserve lineage.", sourceItemIds: ["source_1"] }],
        ctaIntent: "Review the evidence before generation.",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "outline-brief-blocked",
        missingGates: ["evidence-review"],
      }),
    );

    projects.attachEvidence(project.id, { sourceItems: [SOURCE_ITEM], diagnostics: [DIAGNOSTIC] });
    const frozen = projects.freezeEvidence(project.id, {
      includedSourceItemIds: [SOURCE_ITEM.id],
      noExternalResearchAcknowledged: false,
    });
    expect(frozen).toMatchObject({
      brandVoice: { id: brand.id, markdown: brand.markdown },
      contentVoice: { profileId: owner.id, markdown: "Clear, practical, and evidence-led.\n" },
      sourceItems: [{ id: SOURCE_ITEM.id }],
      diagnostics: [{ classification: "items_found" }],
      userMaterial: ["A frozen input should survive later changes."],
    });

    const proposal = projects.proposeOutlineBrief(project.id, {
      thesis: "Approval gates make generated work reproducible.",
      angle: "Treat evidence review as product state.",
      claims: ["Frozen inputs preserve lineage."],
      evidenceMap: [{ claim: "Frozen inputs preserve lineage.", sourceItemIds: ["source_1"] }],
      ctaIntent: "Review the evidence before generation.",
    });
    expect(proposal).toMatchObject({
      projectId: project.id,
      projectRevision: 1,
      version: 1,
      subject: { kind: "topic", topic: "Durable approval gates" },
      author: { profileId: owner.id },
      audience: "Workflow builders",
      objective: "educate",
      thesis: "Approval gates make generated work reproducible.",
      angle: "Treat evidence review as product state.",
      claims: ["Frozen inputs preserve lineage."],
      evidenceMap: [{ claim: "Frozen inputs preserve lineage.", sourceItemIds: ["source_1"] }],
      ctaIntent: "Review the evidence before generation.",
      brandVoiceRevisionId: brand.id,
      targets: ["linkedin-standard-post", "email-newsletter"],
    });
    const approval = projects.approveOutlineBrief(project.id, proposal.id);
    expect(approval).toMatchObject({ outlineBriefId: proposal.id, approvedAt: NOW.toISOString() });
    expect(projects.readiness(project.id)).toEqual({ ready: true, missingGates: [] });
  });

  it("classifies every missing prerequisite and requires the no-research acknowledgement", () => {
    const { projects, owner, ownerOnboarding, brandProfiles } = setup();
    const project = projects.create({
      subject: { kind: "topic", topic: "An incomplete Project" },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: [],
      researchMode: null,
      seedMaterial: [],
    });
    expect(projects.readiness(project.id)).toEqual({
      ready: false,
      missingGates: ["brand-voice", "content-voice", "research-mode", "evidence-review", "target"],
    });

    projects.approveContentVoice(owner.id, "Approved owner voice.");
    brandProfiles.accept({
      markdown: "# Brand Profile\n\n## Voice\nApproved Brand Voice.",
      sourceScan: {
        websiteUrl: "https://brand.example/",
        includedUrls: ["https://brand.example/"],
        excludedUrls: [],
      },
    });
    expect(() =>
      projects.freezeEvidence(project.id, {
        includedSourceItemIds: [],
        noExternalResearchAcknowledged: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "evidence-freeze-blocked",
        missingGates: ["research-mode"],
      }),
    );
    projects.reviseIntent(project.id, {
      targets: ["linkedin-standard-post"],
      researchMode: "no-external-research",
    });
    expect(() =>
      projects.freezeEvidence(project.id, {
        includedSourceItemIds: [],
        noExternalResearchAcknowledged: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "evidence-freeze-blocked",
        missingGates: ["no-research-acknowledgement"],
      }),
    );

    projects.attachEvidence(project.id, {
      sourceItems: [SOURCE_ITEM],
      diagnostics: [DIAGNOSTIC],
    });
    expect(() =>
      projects.freezeEvidence(project.id, {
        includedSourceItemIds: [SOURCE_ITEM.id],
        noExternalResearchAcknowledged: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({ code: "invalid-evidence-selection" }),
    );

    ownerOnboarding.setConnectedIdentity(null);
    expect(projects.readiness(project.id).missingGates).toEqual([
      "canonical-owner",
      "author-authority",
      "evidence-review",
      "no-research-acknowledgement",
    ]);
  });

  it("rechecks authority when a proposed Brief is approved", () => {
    const { projects, owner, ownerOnboarding, brandProfiles } = setup();
    projects.approveContentVoice(owner.id, "Approved Content Voice.");
    brandProfiles.accept({
      markdown: "# Brand Profile\n\n## Voice\nApproved Brand Voice.",
      sourceScan: {
        websiteUrl: "https://brand.example/",
        includedUrls: ["https://brand.example/"],
        excludedUrls: [],
      },
    });
    const project = projects.create({
      subject: { kind: "topic", topic: "Approval authority" },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "no-external-research",
      seedMaterial: [],
    });
    projects.freezeEvidence(project.id, {
      includedSourceItemIds: [],
      noExternalResearchAcknowledged: true,
    });
    const proposal = projects.proposeOutlineBrief(project.id, {
      thesis: "Approval must retain author authority.",
      angle: "Recheck at the durable decision.",
      claims: [],
      evidenceMap: [],
      ctaIntent: null,
    });

    ownerOnboarding.setConnectedIdentity(null);
    expect(() => projects.approveOutlineBrief(project.id, proposal.id)).toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "outline-brief-blocked",
        missingGates: ["canonical-owner", "author-authority"],
      }),
    );
    expect(projects.get(project.id)?.revisions[0]?.outlineBriefApprovals).toEqual([]);
  });
});

describe("WorkspaceContentProjects revisions", () => {
  it("creates a new unapproved revision for an intent or target change without mutating prior artifacts", () => {
    const { projects, owner, brandProfiles } = setup();
    projects.approveContentVoice(owner.id, "Clear, practical, and evidence-led.");
    brandProfiles.accept({
      markdown: "# Brand Profile\n\n## Voice\nUseful and specific.",
      sourceScan: {
        websiteUrl: "https://brand.example/",
        includedUrls: ["https://brand.example/"],
        excludedUrls: [],
      },
    });
    const project = projects.create({
      subject: { kind: "topic", topic: "Durable approval gates" },
      objective: "educate",
      audience: "Workflow builders",
      constraints: ["Separate facts from author claims"],
      targets: ["linkedin-standard-post"],
      researchMode: "no-external-research",
      seedMaterial: ["A frozen input should survive later changes."],
    });
    projects.freezeEvidence(project.id, {
      includedSourceItemIds: [],
      noExternalResearchAcknowledged: true,
    });
    const firstBrief = projects.proposeOutlineBrief(project.id, {
      thesis: "Approval gates make generated work reproducible.",
      angle: "Treat evidence review as product state.",
      claims: ["This is an author-supplied claim."],
      evidenceMap: [],
      ctaIntent: null,
    });
    projects.approveOutlineBrief(project.id, firstBrief.id);

    const revised = projects.reviseIntent(project.id, {
      audience: "Product and engineering leaders",
      targets: ["email-newsletter"],
    });
    expect(revised).toMatchObject({
      revision: 2,
      audience: "Product and engineering leaders",
      targets: ["email-newsletter"],
      evidenceReview: null,
      frozenEvidence: null,
      outlineBriefs: [],
      outlineBriefApprovals: [],
    });
    expect(projects.readiness(project.id)).toEqual({
      ready: false,
      missingGates: ["evidence-review", "no-research-acknowledgement"],
    });

    const reread = projects.get(project.id)!;
    expect(reread.revisions).toHaveLength(2);
    expect(reread.revisions[0]).toMatchObject({
      revision: 1,
      audience: "Workflow builders",
      targets: ["linkedin-standard-post"],
      outlineBriefs: [{ id: firstBrief.id }],
      outlineBriefApprovals: [{ outlineBriefId: firstBrief.id }],
    });
  });

  it("moves a changed evidence selection to a new revision and keeps exact public-safe snapshots across restart", () => {
    const { workspaceDir, projects, owner, ownerOnboarding, people, brandProfiles } = setup();
    const firstVoice = projects.approveContentVoice(owner.id, "First approved Content Voice.");
    const firstBrand = brandProfiles.accept({
      markdown: "# Brand Profile\n\n## Voice\nFirst approved Brand Voice.",
      sourceScan: {
        websiteUrl: "https://brand.example/",
        includedUrls: ["https://brand.example/"],
        excludedUrls: [],
      },
    });
    const subject = people.create({
      fullName: "Private Subject",
      primaryEmail: "private-subject@example.com",
    });
    const seedMaterial = ["Exact user-supplied note."];
    const project = projects.create({
      subject: { kind: "person-profile", profileId: subject.id },
      objective: "provoke-discussion",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "existing-workspace-evidence",
      seedMaterial,
    });
    seedMaterial[0] = "Mutated after creation.";
    const firstSource = structuredClone(SOURCE_ITEM);
    const secondSource = {
      ...structuredClone(SOURCE_ITEM),
      id: "source_2",
      externalId: "article-2",
      canonicalUrl: "https://evidence.example/article-2",
      body: "Second reviewed public source.",
    };
    projects.attachEvidence(project.id, {
      sourceItems: [firstSource, secondSource],
      diagnostics: [DIAGNOSTIC],
    });
    const firstFreeze = projects.freezeEvidence(project.id, {
      includedSourceItemIds: [firstSource.id],
      noExternalResearchAcknowledged: false,
    });
    const firstBrief = projects.proposeOutlineBrief(project.id, {
      thesis: "The first selection has its own lineage.",
      angle: "Start from the first source.",
      claims: ["The first source was reviewed."],
      evidenceMap: [{ claim: "The first source was reviewed.", sourceItemIds: [firstSource.id] }],
      ctaIntent: null,
    });
    projects.approveOutlineBrief(project.id, firstBrief.id);

    brandProfiles.accept({
      markdown: "# Brand Profile\n\n## Voice\nSecond approved Brand Voice.",
      sourceScan: {
        websiteUrl: "https://brand.example/",
        includedUrls: ["https://brand.example/"],
        excludedUrls: [],
      },
    });
    projects.approveContentVoice(owner.id, "Second approved Content Voice.");
    firstSource.body = "Mutated after attachment.";

    const evidenceRevision = projects.attachEvidence(project.id, {
      sourceItems: [firstSource, secondSource],
      diagnostics: [{ ...DIAGNOSTIC, adapterVersion: "2" }],
    });
    expect(evidenceRevision.revision).toBe(2);
    const secondFreeze = projects.freezeEvidence(project.id, {
      includedSourceItemIds: [secondSource.id],
      noExternalResearchAcknowledged: false,
    });

    const reread = projects.get(project.id)!;
    expect(reread.revisions[0]?.frozenEvidence).toEqual(firstFreeze);
    expect(reread.revisions[0]?.outlineBriefApprovals).toEqual([
      { outlineBriefId: firstBrief.id, approvedAt: NOW.toISOString() },
    ]);
    expect(reread.revisions[1]).toMatchObject({
      revision: 2,
      outlineBriefs: [],
      outlineBriefApprovals: [],
      frozenEvidence: {
        sourceItems: [{ id: secondSource.id }],
        diagnostics: [{ adapterVersion: "2" }],
        userMaterial: ["Exact user-supplied note."],
      },
    });
    expect(firstFreeze.brandVoice.id).toBe(firstBrand.id);
    expect(firstFreeze.contentVoice.id).toBe(firstVoice.id);
    expect(secondFreeze.brandVoice.id).not.toBe(firstBrand.id);
    expect(secondFreeze.contentVoice.id).not.toBe(firstVoice.id);
    const renderedProfiles = JSON.stringify(secondFreeze.profileProjections);
    expect(renderedProfiles).not.toContain("owner@example.com");
    expect(renderedProfiles).not.toContain("private-subject@example.com");
    expect(secondFreeze.profileProjections.map((snapshot) => snapshot.role)).toEqual([
      "author",
      "subject",
    ]);

    const restarted = new WorkspaceContentProjects({
      workspaceDir,
      people,
      ownerOnboarding,
      brandProfiles,
      now: () => NOW,
    });
    expect(restarted.get(project.id)).toEqual(reread);
  });

  it("creates a new revision when a frozen selection is replaced directly", () => {
    const { projects, owner, brandProfiles } = setup();
    projects.approveContentVoice(owner.id, "Approved Content Voice.");
    brandProfiles.accept({
      markdown: "# Brand Profile\n\n## Voice\nApproved Brand Voice.",
      sourceScan: {
        websiteUrl: "https://brand.example/",
        includedUrls: ["https://brand.example/"],
        excludedUrls: [],
      },
    });
    const secondSource = { ...structuredClone(SOURCE_ITEM), id: "source_2" };
    const project = projects.create({
      subject: { kind: "topic", topic: "Evidence selection" },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "existing-workspace-evidence",
      seedMaterial: [],
    });
    projects.attachEvidence(project.id, {
      sourceItems: [SOURCE_ITEM, secondSource],
      diagnostics: [DIAGNOSTIC],
    });
    projects.freezeEvidence(project.id, {
      includedSourceItemIds: [SOURCE_ITEM.id],
      noExternalResearchAcknowledged: false,
    });

    projects.freezeEvidence(project.id, {
      includedSourceItemIds: [secondSource.id],
      noExternalResearchAcknowledged: false,
    });

    const reread = projects.get(project.id)!;
    expect(reread.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    expect(reread.revisions[0]?.frozenEvidence?.sourceItems.map((item) => item.id)).toEqual([
      SOURCE_ITEM.id,
    ]);
    expect(reread.revisions[1]?.frozenEvidence?.sourceItems.map((item) => item.id)).toEqual([
      secondSource.id,
    ]);
    expect(reread.revisions[1]?.outlineBriefApprovals).toEqual([]);
  });
});
