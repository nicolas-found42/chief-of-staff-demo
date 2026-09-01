import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENT_PROJECT_TARGETS,
  type AuthorizedAuthorPolicy,
  type ContentProject,
  type ContentProjectAuthorReference,
  type ContentProjectCreateInput,
  type ContentProjectEvidenceAttachment,
  type ContentProjectEvidenceFreeze,
  type ContentProjectEvidenceSelection,
  type ContentProjectGate,
  type ContentProjectIntentPatch,
  type ContentProjectReadiness,
  type ContentProjectRevision,
  type ContentProjectSubject,
  type ContentVoiceRevision,
  type OutlineBrief,
  type OutlineBriefApproval,
  type OutlineBriefProposalInput,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceBrandProfileStore } from "../brand-profile/store.js";
import type { OwnerOnboarding } from "../onboarding/owner.js";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";

interface ContentProjectState {
  projects: ContentProject[];
  authorPolicies: AuthorizedAuthorPolicy[];
  contentVoices: ContentVoiceRevision[];
}

type ContentProjectRevisionSeed = Omit<
  ContentProjectRevision,
  "frozenEvidence" | "outlineBriefs" | "outlineBriefApprovals"
>;

export class ContentProjectError extends Error {
  constructor(
    public readonly code:
      | "invalid-project-input"
      | "owner-not-confirmed"
      | "profile-not-found"
      | "author-forbidden"
      | "project-not-found"
      | "evidence-freeze-blocked"
      | "invalid-evidence-selection"
      | "outline-brief-blocked"
      | "outline-brief-not-found",
    message: string,
    public readonly missingGates: ContentProjectGate[] = [],
  ) {
    super(message);
    this.name = "ContentProjectError";
  }
}

/**
 * The Content Project deep interface from spec #117. It owns durable project
 * intent and author policy while reading canonical owner, Brand Profile, and
 * Person Profile state only through their Workspace-owned interfaces.
 */
export class WorkspaceContentProjects {
  private readonly stateFile: string;
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      workspaceDir: string;
      people: WorkspacePersonProfiles;
      ownerOnboarding: OwnerOnboarding;
      brandProfiles: WorkspaceBrandProfileStore;
      now?: () => Date;
    },
  ) {
    this.stateFile = join(deps.workspaceDir, "content-engine", "projects.json");
    this.now = deps.now ?? (() => new Date());
  }

  authorizeAuthor(profileId: string): AuthorizedAuthorPolicy {
    this.requireSelectableProfile(profileId);
    const state = this.readState();
    const existing = state.authorPolicies.find((policy) => policy.profileId === profileId);
    if (existing) return clone(existing);
    const policy = { profileId, authorizedAt: this.now().toISOString() };
    state.authorPolicies.push(policy);
    this.writeState(state);
    return clone(policy);
  }

  approveContentVoice(profileId: string, markdown: string): ContentVoiceRevision {
    this.requireSelectableProfile(profileId);
    const text = requiredText(markdown, "Content Voice");
    if (!this.isAuthorized(profileId)) {
      throw new ContentProjectError(
        "author-forbidden",
        "Authorize this Person Profile before approving its Content Voice.",
      );
    }
    const state = this.readState();
    const prior = state.contentVoices.filter((voice) => voice.profileId === profileId);
    const revision: ContentVoiceRevision = {
      id: identifier("voice", this.now()),
      profileId,
      revision: prior.length + 1,
      markdown: `${text.trimEnd()}\n`,
      approvedAt: this.now().toISOString(),
    };
    state.contentVoices.push(revision);
    this.writeState(state);
    return clone(revision);
  }

  create(input: ContentProjectCreateInput): ContentProject {
    const author = this.selectAuthor(input.authorProfileId);
    const revision = this.initialRevision(input, author);
    const timestamp = this.now().toISOString();
    const project: ContentProject = {
      id: identifier("project", this.now()),
      createdAt: timestamp,
      updatedAt: timestamp,
      revisions: [revision],
    };
    const state = this.readState();
    state.projects.push(project);
    this.writeState(state);
    return clone(project);
  }

  get(projectId: string): ContentProject | null {
    const project = this.readState().projects.find((candidate) => candidate.id === projectId);
    return project ? clone(project) : null;
  }

  reviseIntent(projectId: string, patch: ContentProjectIntentPatch): ContentProjectRevision {
    const state = this.readState();
    const project = requireProject(state, projectId);
    const previous = currentRevision(project);
    const revision = buildRevision({
      revision: previous.revision + 1,
      createdAt: this.now().toISOString(),
      subject:
        patch.subject === undefined ? clone(previous.subject) : this.resolveSubject(patch.subject),
      author: this.selectAuthor(
        patch.authorProfileId ?? previous.author.profileId,
        patch.authorProfileId === undefined ? previous.author.profileRevision : undefined,
      ),
      objective:
        patch.objective === undefined
          ? previous.objective
          : requiredText(patch.objective, "objective"),
      audience:
        patch.audience === undefined ? previous.audience : requiredText(patch.audience, "audience"),
      constraints:
        patch.constraints === undefined
          ? clone(previous.constraints)
          : cleanList(patch.constraints),
      targets: patch.targets === undefined ? previous.targets : patch.targets,
      researchMode: "researchMode" in patch ? (patch.researchMode ?? null) : previous.researchMode,
      seedMaterial:
        patch.seedMaterial === undefined
          ? clone(previous.seedMaterial)
          : cleanList(patch.seedMaterial),
      evidenceReview: null,
    });
    project.revisions.push(revision);
    this.touch(project);
    this.writeState(state);
    return clone(revision);
  }

  attachEvidence(
    projectId: string,
    attachment: ContentProjectEvidenceAttachment,
  ): ContentProjectRevision {
    const state = this.readState();
    const project = requireProject(state, projectId);
    let revision = currentRevision(project);
    if (
      revision.frozenEvidence !== null ||
      revision.outlineBriefs.length > 0 ||
      revision.outlineBriefApprovals.length > 0
    ) {
      revision = nextRevision(revision, this.now().toISOString());
      project.revisions.push(revision);
    }
    const ids = attachment.sourceItems.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      throw new ContentProjectError(
        "invalid-evidence-selection",
        "Attached Source Items must have unique ids.",
      );
    }
    revision.evidenceReview = {
      attachedAt: this.now().toISOString(),
      sourceItems: clone(attachment.sourceItems),
      diagnostics: clone(attachment.diagnostics),
    };
    this.touch(project);
    this.writeState(state);
    return clone(revision);
  }

  freezeEvidence(
    projectId: string,
    selection: ContentProjectEvidenceSelection,
  ): ContentProjectEvidenceFreeze {
    const state = this.readState();
    const project = requireProject(state, projectId);
    let revision = currentRevision(project);
    if (revision.frozenEvidence !== null) {
      const previous = revision;
      revision = nextRevision(previous, this.now().toISOString(), previous.evidenceReview);
      project.revisions.push(revision);
    }
    const missing = this.missingFreezeGates(revision);
    if (missing.length > 0) {
      throw new ContentProjectError(
        "evidence-freeze-blocked",
        `Evidence cannot be frozen until these gates are present: ${missing.join(", ")}.`,
        missing,
      );
    }
    if (
      revision.researchMode === "no-external-research" &&
      !selection.noExternalResearchAcknowledged
    ) {
      throw new ContentProjectError(
        "evidence-freeze-blocked",
        "No external research requires an explicit acknowledgement.",
        ["no-research-acknowledgement"],
      );
    }
    const review = revision.evidenceReview;
    const selectedIds = [...new Set(selection.includedSourceItemIds)];
    if (revision.researchMode !== "no-external-research" && selectedIds.length === 0) {
      throw new ContentProjectError(
        "evidence-freeze-blocked",
        "External research requires at least one included reviewed Source Item; choose no external research and acknowledge it when no source is selected.",
        ["evidence-review"],
      );
    }
    if (
      revision.researchMode === "no-external-research" &&
      (selectedIds.length > 0 ||
        (review?.sourceItems.length ?? 0) > 0 ||
        (review?.diagnostics.length ?? 0) > 0)
    ) {
      throw new ContentProjectError(
        "invalid-evidence-selection",
        "A no-external-research Project cannot include attached Source Items or diagnostics.",
      );
    }
    const known = new Map(review?.sourceItems.map((item) => [item.id, item]) ?? []);
    if (selectedIds.some((id) => !known.has(id))) {
      throw new ContentProjectError(
        "invalid-evidence-selection",
        "Every included Source Item must come from the attached evidence review.",
      );
    }
    const brandVoice = this.deps.brandProfiles.current()!;
    const contentVoice = this.currentVoice(revision.author.profileId)!;
    const authorProjection = this.deps.people.project("public-safe", revision.author.profileId, {
      revision: revision.author.profileRevision,
    });
    if (authorProjection?.purpose !== "public-safe") {
      throw new ContentProjectError(
        "profile-not-found",
        "The pinned author Profile is unavailable.",
      );
    }
    const profileProjections: ContentProjectEvidenceFreeze["profileProjections"] = [
      { role: "author", projection: authorProjection },
    ];
    if (revision.subject.kind === "person-profile") {
      const subjectProjection = this.deps.people.project(
        "public-safe",
        revision.subject.profileId,
        { revision: revision.subject.profileRevision },
      );
      if (subjectProjection?.purpose !== "public-safe") {
        throw new ContentProjectError(
          "profile-not-found",
          "The pinned subject Person Profile is unavailable.",
        );
      }
      profileProjections.push({ role: "subject", projection: subjectProjection });
    }
    const frozen: ContentProjectEvidenceFreeze = {
      frozenAt: this.now().toISOString(),
      sourceItems: selectedIds.map((id) => known.get(id)!),
      diagnostics: clone(review?.diagnostics ?? []),
      brandVoice: clone(brandVoice),
      contentVoice: clone(contentVoice),
      profileProjections: clone(profileProjections),
      userMaterial: clone(revision.seedMaterial),
      noExternalResearchAcknowledged: selection.noExternalResearchAcknowledged,
    };
    revision.frozenEvidence = frozen;
    this.touch(project);
    this.writeState(state);
    return clone(frozen);
  }

  readiness(projectId: string): ContentProjectReadiness {
    const project = requireProject(this.readState(), projectId);
    const revision = currentRevision(project);
    const missing = this.missingGates(revision);
    return { ready: missing.length === 0, missingGates: missing };
  }

  proposeOutlineBrief(projectId: string, input: OutlineBriefProposalInput): OutlineBrief {
    const state = this.readState();
    const project = requireProject(state, projectId);
    const revision = currentRevision(project);
    const missing = this.missingGates(revision);
    if (missing.length > 0) {
      throw new ContentProjectError(
        "outline-brief-blocked",
        `An Outline Brief cannot be proposed until these gates are present: ${missing.join(", ")}.`,
        missing,
      );
    }
    const frozen = revision.frozenEvidence!;
    const selectedIds = new Set(frozen.sourceItems.map((item) => item.id));
    if (input.evidenceMap.some((entry) => entry.sourceItemIds.some((id) => !selectedIds.has(id)))) {
      throw new ContentProjectError(
        "invalid-evidence-selection",
        "The Outline Brief may cite only Source Items in the frozen evidence selection.",
      );
    }
    const brief: OutlineBrief = {
      id: identifier("brief", this.now()),
      projectId,
      projectRevision: revision.revision,
      version: revision.outlineBriefs.length + 1,
      proposedAt: this.now().toISOString(),
      subject: clone(revision.subject),
      author: clone(revision.author),
      audience: revision.audience,
      objective: revision.objective,
      constraints: clone(revision.constraints),
      thesis: requiredText(input.thesis, "thesis"),
      angle: requiredText(input.angle, "angle"),
      claims: cleanList(input.claims),
      evidenceMap: clone(input.evidenceMap),
      ctaIntent: input.ctaIntent === null ? null : requiredText(input.ctaIntent, "CTA intent"),
      brandVoiceRevisionId: frozen.brandVoice.id,
      targets: clone(revision.targets),
    };
    revision.outlineBriefs.push(brief);
    this.touch(project);
    this.writeState(state);
    return clone(brief);
  }

  approveOutlineBrief(projectId: string, outlineBriefId: string): OutlineBriefApproval {
    const state = this.readState();
    const project = requireProject(state, projectId);
    const revision = currentRevision(project);
    const missing = this.missingGates(revision);
    if (missing.length > 0) {
      throw new ContentProjectError(
        "outline-brief-blocked",
        `An Outline Brief cannot be approved until these gates are present: ${missing.join(", ")}.`,
        missing,
      );
    }
    if (!revision.outlineBriefs.some((brief) => brief.id === outlineBriefId)) {
      throw new ContentProjectError(
        "outline-brief-not-found",
        "The Outline Brief does not belong to the current Project revision.",
      );
    }
    const existing = revision.outlineBriefApprovals.find(
      (approval) => approval.outlineBriefId === outlineBriefId,
    );
    if (existing) return clone(existing);
    const approval = { outlineBriefId, approvedAt: this.now().toISOString() };
    revision.outlineBriefApprovals.push(approval);
    this.touch(project);
    this.writeState(state);
    return clone(approval);
  }

  private initialRevision(
    input: ContentProjectCreateInput,
    author: ContentProjectAuthorReference,
  ): ContentProjectRevision {
    const objective = requiredText(input.objective, "objective");
    const audience = requiredText(input.audience, "audience");
    const subject = this.resolveSubject(input.subject);
    return buildRevision({
      revision: 1,
      createdAt: this.now().toISOString(),
      subject,
      author,
      objective,
      audience,
      constraints: cleanList(input.constraints),
      targets: input.targets,
      researchMode: input.researchMode,
      seedMaterial: cleanList(input.seedMaterial),
      evidenceReview: null,
    });
  }

  private resolveSubject(input: ContentProjectCreateInput["subject"]): ContentProjectSubject {
    if (input.kind === "topic") {
      return { kind: "topic", topic: requiredText(input.topic, "Topic") };
    }
    const profile = this.requireSelectableProfile(input.profileId);
    return { kind: "person-profile", profileId: profile.id, profileRevision: profile.revision };
  }

  private selectAuthor(
    profileId?: string,
    pinnedProfileRevision?: number,
  ): ContentProjectAuthorReference {
    const owner = this.deps.ownerOnboarding.confirmed();
    const selectedProfileId = profileId ?? owner?.profileId;
    if (!selectedProfileId) {
      throw new ContentProjectError(
        "owner-not-confirmed",
        "Confirm the canonical owner Profile before using the default author.",
      );
    }
    if (owner?.profileId === selectedProfileId) {
      const confirmedRevision = this.deps.people.getRevision(
        owner.profileId,
        owner.profileRevision,
      );
      if (!confirmedRevision) {
        throw new ContentProjectError(
          "profile-not-found",
          "The onboarding-confirmed owner Profile revision is unavailable.",
        );
      }
      return { profileId: owner.profileId, profileRevision: owner.profileRevision };
    }
    const profile = this.requireSelectableProfile(selectedProfileId);
    if (!this.hasApprovedAuthor(profile.id)) {
      throw new ContentProjectError(
        "author-forbidden",
        "Another Person Profile is selectable only after author authorization and Content Voice approval.",
      );
    }
    if (
      pinnedProfileRevision !== undefined &&
      !this.deps.people.getRevision(profile.id, pinnedProfileRevision)
    ) {
      throw new ContentProjectError(
        "profile-not-found",
        "The pinned author Person Profile revision is unavailable.",
      );
    }
    return {
      profileId: profile.id,
      profileRevision: pinnedProfileRevision ?? profile.revision,
    };
  }

  private requireSelectableProfile(profileId: string) {
    const profile = this.deps.people.get(profileId);
    if (!profile || profile.archivedAt !== null) {
      throw new ContentProjectError(
        "profile-not-found",
        `No active Person Profile exists with id ${profileId}.`,
      );
    }
    return profile;
  }

  private hasApprovedAuthor(profileId: string): boolean {
    const state = this.readState();
    return (
      state.authorPolicies.some((policy) => policy.profileId === profileId) &&
      state.contentVoices.some((voice) => voice.profileId === profileId)
    );
  }

  private currentVoice(profileId: string): ContentVoiceRevision | null {
    return (
      this.readState()
        .contentVoices.filter((voice) => voice.profileId === profileId)
        .at(-1) ?? null
    );
  }

  private missingFreezeGates(revision: ContentProjectRevision): ContentProjectGate[] {
    const missing: ContentProjectGate[] = [];
    if (!this.deps.brandProfiles.current()) missing.push("brand-voice");
    if (!this.currentVoice(revision.author.profileId)) missing.push("content-voice");
    if (revision.researchMode === null) {
      missing.push("research-mode");
    } else if (
      revision.researchMode !== "no-external-research" &&
      (revision.evidenceReview === null || revision.evidenceReview.sourceItems.length === 0)
    ) {
      missing.push("evidence-review");
    }
    return missing;
  }

  private missingGates(revision: ContentProjectRevision): ContentProjectGate[] {
    const missing: ContentProjectGate[] = [];
    const owner = this.deps.ownerOnboarding.confirmed();
    if (!owner) missing.push("canonical-owner");
    if (!revision.frozenEvidence?.brandVoice && !this.deps.brandProfiles.current()) {
      missing.push("brand-voice");
    }
    const authorAuthorized =
      owner?.profileId === revision.author.profileId ||
      this.readState().authorPolicies.some(
        (policy) => policy.profileId === revision.author.profileId,
      );
    if (!authorAuthorized) missing.push("author-authority");
    if (!revision.frozenEvidence?.contentVoice && !this.currentVoice(revision.author.profileId)) {
      missing.push("content-voice");
    }
    if (!revision.researchMode) missing.push("research-mode");
    if (!revision.frozenEvidence) missing.push("evidence-review");
    if (
      revision.researchMode === "no-external-research" &&
      !revision.frozenEvidence?.noExternalResearchAcknowledged
    ) {
      missing.push("no-research-acknowledgement");
    }
    if (revision.targets.length === 0) missing.push("target");
    return missing;
  }

  private isAuthorized(profileId: string): boolean {
    const owner = this.deps.ownerOnboarding.confirmed();
    return (
      owner?.profileId === profileId ||
      this.readState().authorPolicies.some((policy) => policy.profileId === profileId)
    );
  }

  private readState(): ContentProjectState {
    if (!existsSync(this.stateFile)) return { projects: [], authorPolicies: [], contentVoices: [] };
    try {
      const parsed = JSON.parse(
        readFileSync(this.stateFile, "utf8"),
      ) as Partial<ContentProjectState>;
      return {
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        authorPolicies: Array.isArray(parsed.authorPolicies) ? parsed.authorPolicies : [],
        contentVoices: Array.isArray(parsed.contentVoices) ? parsed.contentVoices : [],
      };
    } catch {
      return { projects: [], authorPolicies: [], contentVoices: [] };
    }
  }

  private writeState(state: ContentProjectState): void {
    mkdirSync(join(this.deps.workspaceDir, "content-engine"), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporary, this.stateFile);
  }

  private touch(project: ContentProject): void {
    project.updatedAt = this.now().toISOString();
  }
}

function requireProject(state: ContentProjectState, projectId: string): ContentProject {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new ContentProjectError(
      "project-not-found",
      `No Content Project exists with id ${projectId}.`,
    );
  }
  return project;
}

function currentRevision(project: ContentProject): ContentProjectRevision {
  const revision = project.revisions.at(-1);
  if (!revision)
    throw new ContentProjectError("project-not-found", "The Content Project has no revision.");
  return revision;
}

function buildRevision(seed: ContentProjectRevisionSeed): ContentProjectRevision {
  return {
    ...seed,
    subject: clone(seed.subject),
    author: clone(seed.author),
    constraints: cleanList(seed.constraints),
    targets: validatedTargets(seed.targets),
    seedMaterial: cleanList(seed.seedMaterial),
    evidenceReview: clone(seed.evidenceReview),
    frozenEvidence: null,
    outlineBriefs: [],
    outlineBriefApprovals: [],
  };
}

function nextRevision(
  previous: ContentProjectRevision,
  createdAt: string,
  evidenceReview: ContentProjectRevision["evidenceReview"] = null,
): ContentProjectRevision {
  return buildRevision({
    revision: previous.revision + 1,
    createdAt,
    subject: previous.subject,
    author: previous.author,
    objective: previous.objective,
    audience: previous.audience,
    constraints: previous.constraints,
    targets: previous.targets,
    researchMode: previous.researchMode,
    seedMaterial: previous.seedMaterial,
    evidenceReview,
  });
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new ContentProjectError("invalid-project-input", `${label} is required.`);
  return text;
}

function cleanList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function validatedTargets(
  values: ContentProjectRevision["targets"],
): ContentProjectRevision["targets"] {
  if (values.some((target) => !CONTENT_PROJECT_TARGETS.includes(target))) {
    throw new ContentProjectError(
      "invalid-project-input",
      "The Project contains an unknown target.",
    );
  }
  return [...new Set(values)];
}

function identifier(prefix: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}_${stamp}_${randomBytes(4).toString("hex")}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
