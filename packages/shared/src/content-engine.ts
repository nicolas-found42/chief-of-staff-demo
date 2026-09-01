import type { BrandProfileRevision } from "./content-scout.js";
import type { PersonProfilePublicSafeProjection } from "./person-profile.js";
import type { AdapterDiagnostic, SourceItem } from "./source-items.js";

export const CONTENT_PROJECT_TARGETS = [
  "linkedin-standard-post",
  "linkedin-carousel",
  "linkedin-long-article",
  "website-blog-article",
  "email-newsletter",
  "youtube-short",
  "youtube-long-video",
  "instagram-reel",
  "tiktok-video",
] as const;

export type ContentProjectTarget = (typeof CONTENT_PROJECT_TARGETS)[number];

export type ContentProjectResearchMode =
  "no-external-research" | "existing-workspace-evidence" | "fresh-bounded-research";

export type ContentProjectSubjectInput =
  { kind: "topic"; topic: string } | { kind: "person-profile"; profileId: string };

export type ContentProjectSubject =
  | { kind: "topic"; topic: string }
  | { kind: "person-profile"; profileId: string; profileRevision: number };

export interface ContentProjectCreateInput {
  subject: ContentProjectSubjectInput;
  authorProfileId?: string;
  objective: string;
  audience: string;
  constraints: string[];
  targets: ContentProjectTarget[];
  researchMode: ContentProjectResearchMode | null;
  seedMaterial: string[];
}

export interface ContentProjectIntentPatch {
  subject?: ContentProjectSubjectInput;
  authorProfileId?: string;
  objective?: string;
  audience?: string;
  constraints?: string[];
  targets?: ContentProjectTarget[];
  researchMode?: ContentProjectResearchMode | null;
  seedMaterial?: string[];
}

export interface ContentProjectAuthorReference {
  profileId: string;
  profileRevision: number;
}

// ---------------------------------------------------------------------------
// Research Requests (issue #130; spec #117 "fresh bounded research")
// ---------------------------------------------------------------------------

/**
 * The class of a Workspace-held identifier that an anonymous public query was
 * built from. Only the class is ever recorded: the identifier value itself
 * stays inside the Person Profiles interface.
 */
export type ResearchIdentifierClass =
  "email" | "full-name" | "handle" | "profile-url" | "employer-hint";

/** Why an identifier was sent: to locate the person, or to pair them with the Project subject. */
export type ResearchIdentifierPurpose = "person-identification" | "topic-evidence";

/** One audited use of one identifier class by one provider at one moment. */
export interface ResearchIdentifierUse {
  identifierClass: ResearchIdentifierClass;
  providerId: string;
  usedAt: string;
  purpose: ResearchIdentifierPurpose;
}

/**
 * The providers a Research Request is explicitly configured with. An
 * `all-providers` bundle is the strict selection of spec #117: it reports
 * incomplete until every provider in it succeeds. A `best-effort` bundle keeps
 * whatever succeeded, because Source Adapters stay independent (ADR-0028).
 */
export interface ResearchProviderBundle {
  providerIds: string[];
  completeness: "best-effort" | "all-providers";
}

/** What makes a Research Request finite: it asks a bounded number of bounded questions. */
export interface ResearchRequestLimits {
  maxQueriesPerProvider: number;
  maxSourceItems: number;
}

/** The explicit scope one Research Request was allowed to ask about. */
export interface ResearchRequestScope {
  question: string;
  terms: string[];
  subject: ContentProjectSubject;
}

export interface ResearchRequestInput {
  question: string;
  terms: string[];
  bundle: ResearchProviderBundle;
  limits: ResearchRequestLimits;
}

/** What one configured provider did during one Research Request. */
export interface ResearchProviderOutcome {
  providerId: string;
  queries: number;
  itemsFound: number;
  diagnostic: AdapterDiagnostic;
}

/**
 * One finite, Project-owned piece of fresh public research. It terminates: it
 * carries a `finishedAt` and holds no checkpoint, conditional validator,
 * baseline, schedule or watch state, so nothing about it recurs and nothing
 * about it belongs to Content Research.
 */
export interface ResearchRequest {
  id: string;
  projectId: string;
  projectRevision: number;
  scope: ResearchRequestScope;
  bundle: ResearchProviderBundle;
  limits: ResearchRequestLimits;
  startedAt: string;
  finishedAt: string;
  completeness: "complete" | "incomplete";
  providerOutcomes: ResearchProviderOutcome[];
  identifierUses: ResearchIdentifierUse[];
  /** Exactly the evidence the providers returned, before the owner reviews it. */
  sourceItems: SourceItem[];
}

export interface ContentProjectRevision {
  revision: number;
  createdAt: string;
  subject: ContentProjectSubject;
  author: ContentProjectAuthorReference;
  objective: string;
  audience: string;
  constraints: string[];
  targets: ContentProjectTarget[];
  researchMode: ContentProjectResearchMode | null;
  seedMaterial: string[];
  researchRequest: ResearchRequest | null;
  evidenceReview: ContentProjectEvidenceReview | null;
  frozenEvidence: ContentProjectEvidenceFreeze | null;
  outlineBriefs: OutlineBrief[];
  outlineBriefApprovals: OutlineBriefApproval[];
  platformOutlines: PlatformOutline[];
  platformOutlineApprovals: PlatformOutlineApproval[];
  drafts: ContentEngineDraft[];
}

export interface ContentProject {
  id: string;
  createdAt: string;
  updatedAt: string;
  revisions: ContentProjectRevision[];
}

export interface AuthorizedAuthorPolicy {
  profileId: string;
  authorizedAt: string;
}

export interface ContentVoiceRevision {
  id: string;
  profileId: string;
  revision: number;
  markdown: string;
  approvedAt: string;
}

export interface ContentProjectEvidenceReview {
  attachedAt: string;
  sourceItems: SourceItem[];
  diagnostics: AdapterDiagnostic[];
}

export interface ContentProjectProfileSnapshot {
  role: "author" | "subject";
  projection: PersonProfilePublicSafeProjection;
}

export interface ContentProjectEvidenceFreeze {
  frozenAt: string;
  sourceItems: SourceItem[];
  diagnostics: AdapterDiagnostic[];
  brandVoice: BrandProfileRevision;
  contentVoice: ContentVoiceRevision;
  profileProjections: ContentProjectProfileSnapshot[];
  userMaterial: string[];
  noExternalResearchAcknowledged: boolean;
}

/**
 * What a Content Engine generator may put in a prompt: the frozen public
 * evidence and the approved voice, and nothing else. Search diagnostics and the
 * Research Request's identifier bookkeeping are structurally absent here, so an
 * operational failure or a private identifier class can never be handed to a
 * model as a factual content claim.
 */
export interface ContentProjectPromptEvidence {
  projectId: string;
  projectRevision: number;
  sourceItems: SourceItem[];
  brandVoice: BrandProfileRevision;
  contentVoice: ContentVoiceRevision;
  profileProjections: ContentProjectProfileSnapshot[];
  userMaterial: string[];
}

export interface ContentProjectEvidenceAttachment {
  sourceItems: SourceItem[];
  diagnostics: AdapterDiagnostic[];
}

export interface ContentProjectEvidenceSelection {
  includedSourceItemIds: string[];
  noExternalResearchAcknowledged: boolean;
}

export const CONTENT_PROJECT_GATES = [
  "canonical-owner",
  "brand-voice",
  "author-authority",
  "content-voice",
  "research-mode",
  "evidence-review",
  "no-research-acknowledgement",
  "target",
] as const;
export type ContentProjectGate = (typeof CONTENT_PROJECT_GATES)[number];

export interface ContentProjectReadiness {
  ready: boolean;
  missingGates: ContentProjectGate[];
}

export interface OutlineBriefEvidenceMapEntry {
  claim: string;
  sourceItemIds: string[];
}

export interface OutlineBriefProposalInput {
  thesis: string;
  angle: string;
  claims: string[];
  evidenceMap: OutlineBriefEvidenceMapEntry[];
  ctaIntent: string | null;
}

export interface OutlineBrief extends OutlineBriefProposalInput {
  id: string;
  projectId: string;
  projectRevision: number;
  version: number;
  proposedAt: string;
  subject: ContentProjectSubject;
  author: ContentProjectAuthorReference;
  audience: string;
  objective: string;
  constraints: string[];
  brandVoiceRevisionId: string;
  targets: ContentProjectTarget[];
}

/** Approval is a separate immutable decision so the proposed Brief never changes in place. */
export interface OutlineBriefApproval {
  outlineBriefId: string;
  approvedAt: string;
}

// ---------------------------------------------------------------------------
// Platform Outlines and Content Engine Drafts (issue #131; spec #117
// generation and revision rules)
// ---------------------------------------------------------------------------

export interface PlatformOutlineBeat {
  position: number;
  direction: string;
  evidence: OutlineBriefEvidenceMapEntry;
  examples: string[];
}

export interface PlatformOutline {
  id: string;
  projectId: string;
  projectRevision: number;
  target: ContentProjectTarget;
  outlineBriefId: string;
  outlineBriefVersion: number;
  version: number;
  generatedAt: string;
  /** The bounded regeneration instruction that produced this version, if any. */
  instruction: string | null;
  title: string;
  hookDirection: string;
  /** Pinned from the approved Outline Brief; regeneration cannot alter it. */
  thesis: string;
  beats: PlatformOutlineBeat[];
  ctaIntent: string | null;
  targetLength: string;
  constraints: string[];
  warnings: string[];
  productionNotes: string[];
}

/** Approval is a separate immutable decision so the Outline never changes in place. */
export interface PlatformOutlineApproval {
  platformOutlineId: string;
  target: ContentProjectTarget;
  approvedAt: string;
}

export const CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY = "mark-unsupported" as const;

export interface ContentEngineDraftClaim {
  text: string;
  sourceItemIds: string[];
  /**
   * Computed by the Content Project against the approved Brief's evidence map;
   * a provider or regeneration instruction can never set it.
   */
  supported: boolean;
}

export interface ContentEngineDraft {
  id: string;
  projectId: string;
  projectRevision: number;
  target: ContentProjectTarget;
  platformOutlineId: string;
  outlineVersion: number;
  version: number;
  generatedAt: string;
  /** The bounded regeneration instruction that produced this version, if any. */
  instruction: string | null;
  copy: string;
  /** Pinned from the approved Outline Brief; regeneration cannot alter it. */
  thesis: string;
  /** Pinned from the approved Outline Brief; regeneration cannot alter it. */
  evidence: OutlineBriefEvidenceMapEntry[];
  claims: ContentEngineDraftClaim[];
  unsupportedClaimPolicy: typeof CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY;
  productionNotes: string[];
}
