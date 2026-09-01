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
  evidenceReview: ContentProjectEvidenceReview | null;
  frozenEvidence: ContentProjectEvidenceFreeze | null;
  outlineBriefs: OutlineBrief[];
  outlineBriefApprovals: OutlineBriefApproval[];
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
