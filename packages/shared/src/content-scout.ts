export const CONTENT_SCOUT_MODULE_ID = "content-scout";
export const CONTENT_SCOUT_MODULE_VERSION = 1;

export const SOURCE_ADAPTER_STATES = ["available", "experimental", "coming_later"] as const;
export type SourceAdapterState = (typeof SOURCE_ADAPTER_STATES)[number];

export const SOURCE_FIELD_STATES = ["available", "unavailable", "unsupported", "failed"] as const;
export type SourceFieldState = (typeof SOURCE_FIELD_STATES)[number];

export const SOURCE_DIAGNOSTIC_CLASSIFICATIONS = [
  "items_found",
  "legitimate_empty",
  "no_new_material",
  "unsupported_capability",
  "blocked_access",
  "response_shape_change",
  "rate_limit",
  "timeout",
  "parser_failure",
  "internal_failure",
] as const;
export type SourceDiagnosticClassification = (typeof SOURCE_DIAGNOSTIC_CLASSIFICATIONS)[number];

/** One classification boundary shared by server health and receipt rendering. */
export function isSuccessfulSourceDiagnostic(
  classification: SourceDiagnosticClassification,
): boolean {
  return (
    classification === "items_found" ||
    classification === "legitimate_empty" ||
    classification === "no_new_material"
  );
}

export const SOURCE_PARSER_STAGES = [
  "adapter_boundary",
  "conditional_request",
  "embedded_public_data",
  "fetch",
  "public_embedded_data",
  "readability",
  "reddit_html_parse",
  "reddit_json_parse",
  "rss",
  "rss_parse",
  "browser_render",
  "youtube",
  "youtube_data_api",
  "yt_dlp",
  "instaloader",
  "unknown_stage",
] as const;
export type SourceParserStage = (typeof SOURCE_PARSER_STAGES)[number];

export const SOURCE_CAPABILITIES = [
  "body",
  "channel",
  "comments",
  "description",
  "items",
  "source_target",
  "title",
  "transcript",
  "youtube",
  "unknown_capability",
] as const;
export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];

export interface SourceEvidenceReceipt {
  route: string;
  retrievedAt: string;
}

export interface SourceComment {
  author: string | null;
  publishedAt: string | null;
  url: string | null;
  text: string;
  engagement: number | null;
}

export interface SourceItem {
  id: string;
  externalId: string;
  targetId: string;
  adapterId: string;
  canonicalUrl: string;
  author: string | null;
  title: string | null;
  body: string | null;
  description: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  media: { type: "image" | "audio" | "video"; url: string }[];
  transcript: string | null;
  comments: SourceComment[];
  evidence: SourceEvidenceReceipt[];
  completeness: {
    title: SourceFieldState;
    body: SourceFieldState;
    description: SourceFieldState;
    transcript: SourceFieldState;
    comments: SourceFieldState;
    media: SourceFieldState;
  };
  /** Adapter-supplied stable story identity when the platform exposes one. */
  storyKey?: string;
  /** Deterministic claim support produced by extraction/enrichment, when known. */
  claims?: {
    text: string;
    state: "supported" | "unsupported";
    sourceUrls: string[];
  }[];
}

export interface SourceStoryGroup {
  canonicalKey: string;
  sourceItemIds: string[];
}

export interface AdapterDiagnostic {
  classification: SourceDiagnosticClassification;
  route: string;
  status: number | null;
  contentType: string | null;
  parserStage: SourceParserStage;
  responseHash: string;
  adapterVersion: string;
  startedAt: string;
  finishedAt: string;
  retries: number;
  affectedCapabilities: SourceCapability[];
  causeChain: string[];
  /** Parsed Retry-After delay supplied by the remote host, when present. */
  retryAfterMs?: number;
}

export interface SourceCollectionAttemptReceipt {
  targetId: string;
  adapterId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  outcome: SourceDiagnosticClassification;
  checkpointBefore: string | null;
  checkpointAfter: string | null;
  conditionalRequest: { etag: string | null; lastModified: string | null } | null;
  conditionalResponse: { etag: string | null; lastModified: string | null } | null;
  backoffMs: number;
  /** Present on receipts written since Module version 1 diagnostics were completed. */
  diagnostic?: AdapterDiagnostic;
  itemsFound?: number;
}

/** The only user-requested backfill windows a Source Adapter may declare support for. */
export const SOURCE_BACKFILL_WINDOWS_DAYS = [7, 30, 90] as const;
export type SourceBackfillWindowDays = (typeof SOURCE_BACKFILL_WINDOWS_DAYS)[number];

export interface SourceTarget {
  id: string;
  adapterId: string;
  label: string;
  url: string;
  state: "active" | "archived";
  createdAt: string;
  archivedAt: string | null;
  checkpoint: string | null;
  lastSuccessfulAt: string | null;
  conditional: { etag: string | null; lastModified: string | null } | null;
}

export interface SourceSuggestion {
  id: string;
  adapterId: string;
  label: string;
  url: string;
  state: "proposed" | "approved" | "dismissed";
  discoveredAt: string;
  discoveredBecause: string;
  evidenceUrls: string[];
  similarityFactors: string[];
  decisionReason: string | null;
  sourceTargetId: string | null;
}

export interface ContentScoutScheduleState {
  lastSuccessfulIntakePeriod: string | null;
  lastSuccessfulDiscoveryPeriod: string | null;
}

export interface ContentScoutStorageUse {
  measuredAt: string;
  categories: {
    durableRecords: { files: number; bytes: number };
    sanitizedDiagnostics: { files: number; bytes: number };
    temporaryMedia: { files: number; bytes: number };
    retainedEvidenceTranscripts: { files: number; bytes: number };
  };
}

export interface ContentScoutCleanupPreview {
  scope: "expired_temporary_data";
  measuredAt: string;
  items: {
    id: string;
    category: "sanitized_diagnostics" | "temporary_media";
    relativePath: string;
    bytes: number;
    reason: "older_than_30_days" | "failed_media_older_than_24_hours";
  }[];
  files: number;
  bytes: number;
}

export interface ContentScoutCleanupReceipt extends ContentScoutCleanupPreview {
  id: string;
  executedAt: string;
  dryRun: boolean;
  deleted: number;
}

export type RuntimeCapabilityState = "available" | "unavailable" | "unsupported";

export interface ContentScoutRuntimeCapability {
  id: string;
  category: "browser" | "python" | "media" | "transcription";
  state: RuntimeCapabilityState;
  version: string | null;
  pinnedVersion?: string;
  requiredBy: string[];
  diagnostic: {
    classification: "runtime_available" | "runtime_unavailable" | "runtime_unsupported";
    command: string;
    checkedAt: string;
    causeChain: string[];
  };
}

export interface BrandProfileSourceScan {
  websiteUrl: string;
  includedUrls: string[];
  excludedUrls: string[];
}

export interface BrandProfileRevision {
  id: string;
  createdAt: string;
  markdown: string;
  sourceScan: BrandProfileSourceScan;
  note: string | null;
  changedSections: string[];
  /** Website-derived baseline used only for later three-way comparison. */
  siteBaselineMarkdown?: string;
}

export interface BrandProfileScanPage {
  url: string;
  title: string;
  depth: number;
  included: boolean;
  exclusionReason: string | null;
  text: string;
}

export interface BrandProfileSectionDiff {
  section: string;
  oldWebsiteValue: string;
  currentValue: string;
  proposedValue: string;
  status: "unchanged" | "non_conflicting" | "conflicting";
}

export interface BrandProfileProposal {
  id: string;
  runId: string;
  createdAt: string;
  websiteUrl: string;
  pages: BrandProfileScanPage[];
  proposedMarkdown: string;
  basedOnRevisionId: string | null;
  sectionDiffs: BrandProfileSectionDiff[];
}

export const CONTENT_ANGLE_TYPES = [
  "practical_implication",
  "contrarian_interpretation",
  "myth_correction",
  "trend_analysis",
  "tactical_advice",
  "founder_perspective",
  "customer_implication",
  "forecast",
  "reaction",
  "educational_explanation",
] as const;
export type ContentAngle = (typeof CONTENT_ANGLE_TYPES)[number];

export interface OpportunityScores {
  brandRelevance: number;
  audienceUsefulness: number;
  timeliness: number;
  novelty: number;
  evidenceStrength: number;
  evidenceDiversity: number;
  specificity: number;
  originalPerspective: number;
  packApplicability: number;
  speculationRisk: number;
}

export interface OpportunityMaterialDevelopment {
  explanation: string;
  sourceItemIds: string[];
}

export interface OpportunityEarlyFollowUp {
  kind: "different_angle" | "material_development";
  explanation: string;
}

export interface SourceItemReference {
  id: string;
  canonicalUrl: string;
}

export interface RankedOpportunity {
  id: string;
  canonicalKey: string;
  title: string;
  angle: ContentAngle;
  angleDescription: string;
  materialDevelopment: OpportunityMaterialDevelopment | null;
  urgency: string;
  explanation: string;
  sourceItemIds: string[];
  sourceUrls: string[];
  experimentalEvidence: boolean;
  confidence: number;
  scores: OpportunityScores;
}

export interface ShortlistOpportunity extends RankedOpportunity {
  state: "ready" | "drafted" | "dismissed";
  decision: "draft" | "dismiss_angle" | "not_relevant" | "already_covered" | null;
  earlyFollowUp: OpportunityEarlyFollowUp | null;
  sourceItemReferences: SourceItemReference[];
}

export interface ContentShortlist {
  runId: string;
  createdAt: string;
  brandProfileRevisionId: string;
  opportunities: ShortlistOpportunity[];
  omittedCount: number;
  supersededByRunId: string | null;
}

export interface ContentScoutRunResult {
  /** Present only on a source-backfill Run: what was requested and whether the adapter honored it. */
  backfill?: {
    targetId: string;
    windowDays: SourceBackfillWindowDays;
    adapterId: string;
    supported: boolean;
  };
  adapters: {
    adapterId: string;
    state: SourceAdapterState;
    targetsAttempted: number;
    outcome: SourceDiagnosticClassification;
    itemsFound: number;
    durationMs: number;
    retries: number;
    /** Absent only on durable Runs written before Source Adapter diagnostics were completed. */
    lastSuccessfulRequest?: { at: string; route: string } | null;
    /** Absent only on durable Runs written before Source Adapter diagnostics were completed. */
    errorClassifications?: SourceDiagnosticClassification[];
    affectedCapabilities: SourceCapability[];
    attempts: SourceCollectionAttemptReceipt[];
  }[];
  shortlist: { opportunityCount: number; omittedCount: number };
  warnings: number;
  packs?: {
    id: string;
    opportunityId: string;
    generated: number;
    published: number;
    total: number;
    missingDraftTargets: string[];
    missingNotionPages: string[];
  }[];
}

export interface DraftTargetContract {
  id: string;
  version: 1;
  channel: string;
  format: string;
  objective: string;
  structure: string;
  length: string;
  tone: string;
  cta: string;
  citations: string;
  productionNotes: string;
}

const draftTarget = (
  id: string,
  channel: string,
  format: string,
  objective: string,
  structure: string,
  length: string,
  tone: string,
  cta: string,
  citations: string,
  productionNotes: string,
): DraftTargetContract => ({
  id,
  version: 1,
  channel,
  format,
  objective,
  structure,
  length,
  tone,
  cta,
  citations,
  productionNotes,
});

/** Version 1's binding complete-pack contract: exactly 23 independent targets. */
export const CONTENT_SCOUT_DRAFT_TARGETS_V1: readonly DraftTargetContract[] = [
  draftTarget(
    "linkedin-standard-post",
    "LinkedIn",
    "Standard post",
    "Earn informed discussion",
    "Hook, evidence-led point of view, practical takeaway",
    "900–1,500 characters",
    "Professional and direct",
    "Invite a specific response",
    "Restrained source note or natural link",
    "Suggest line breaks and optional hashtags",
  ),
  draftTarget(
    "linkedin-long-post",
    "LinkedIn",
    "Long post/article",
    "Develop the argument",
    "Headline, thesis, evidence sections, implications, close",
    "1,200–2,000 words",
    "Authoritative and readable",
    "Invite a considered next step",
    "Name and link sources in context",
    "Include suggested headline and deck",
  ),
  draftTarget(
    "linkedin-carousel-outline",
    "LinkedIn",
    "Carousel outline",
    "Teach one idea slide by slide",
    "Cover plus 6–10 slide beats and close",
    "Up to 35 words per slide",
    "Crisp and visual",
    "Final-slide action",
    "Source note on relevant slides",
    "Copy outline only; no artwork",
  ),
  draftTarget(
    "linkedin-poll",
    "LinkedIn",
    "Poll",
    "Test a useful audience belief",
    "Question, 2–4 choices, context paragraph",
    "Question under 140 characters",
    "Neutral and curiosity-led",
    "Ask voters to explain",
    "Link evidence in context",
    "Flag poll duration suggestion",
  ),
  draftTarget(
    "reddit-discussion-post",
    "Reddit",
    "Discussion post",
    "Start a substantive discussion",
    "Context, evidence, open question",
    "250–600 words",
    "Community-first and non-promotional",
    "Ask one answerable question",
    "Use natural source links",
    "Suggest appropriate community criteria",
  ),
  draftTarget(
    "reddit-educational-post",
    "Reddit",
    "Educational/value post",
    "Deliver standalone value",
    "Problem, evidence, worked guidance, caveats",
    "600–1,200 words",
    "Detailed and candid",
    "Optional discussion prompt",
    "Inline natural source links",
    "Avoid sales language",
  ),
  draftTarget(
    "short-blog-post",
    "Website",
    "Short blog post",
    "Explain the timely implication",
    "Headline, lead, 2–4 sections, conclusion",
    "600–900 words",
    "Clear brand voice",
    "One relevant next step",
    "Inline links",
    "Provide title and meta description",
  ),
  draftTarget(
    "long-form-blog-article",
    "Website",
    "Long-form article",
    "Create an evergreen evidence-led resource",
    "Headline, outline, developed sections, conclusion",
    "1,800–2,800 words",
    "Deep but accessible",
    "Contextual next step",
    "Inline links plus source list",
    "Provide SEO title and meta description",
  ),
  draftTarget(
    "substack-note",
    "Substack",
    "Note",
    "Share one sharp useful observation",
    "Observation, evidence, implication",
    "300–600 characters",
    "Personal and concise",
    "Light conversation prompt",
    "Natural source link",
    "No newsletter preamble",
  ),
  draftTarget(
    "substack-article",
    "Substack",
    "Article",
    "Develop a subscriber-worthy perspective",
    "Subject line, opening, sections, close",
    "1,200–2,000 words",
    "Personal expertise",
    "Reply or subscribe prompt",
    "Inline links and end notes",
    "Include subject and preview text",
  ),
  draftTarget(
    "email-newsletter",
    "Email",
    "Newsletter",
    "Inform an owned audience",
    "Subject, preview, opening, main insight, takeaway",
    "700–1,200 words",
    "Warm and useful",
    "One primary action",
    "Readable linked source names",
    "Include subject and preview text",
  ),
  draftTarget(
    "x-single-post",
    "X",
    "Single post",
    "Deliver one defensible insight",
    "Claim plus evidence or implication",
    "280 characters maximum",
    "Compact and specific",
    "Optional question",
    "Link only when needed",
    "State exact character count",
  ),
  draftTarget(
    "x-thread",
    "X",
    "Thread",
    "Unpack the evidence sequentially",
    "Opening plus 5–10 numbered posts",
    "280 characters per post",
    "Energetic and precise",
    "Final-post action",
    "Put links in relevant posts",
    "Number every post",
  ),
  draftTarget(
    "threads-post",
    "Threads",
    "Post",
    "Start conversational engagement",
    "Hook, useful context, point of view",
    "Up to 500 characters",
    "Conversational",
    "Invite replies",
    "Natural attribution",
    "Avoid X-specific conventions",
  ),
  draftTarget(
    "bluesky-post",
    "Bluesky",
    "Post",
    "Share a concise evidence-led view",
    "Claim, implication, optional link",
    "300 characters maximum",
    "Plainspoken and specific",
    "Optional question",
    "Use a direct source link",
    "State exact character count",
  ),
  draftTarget(
    "youtube-shorts-concept",
    "YouTube Shorts",
    "Concept",
    "Define a short video treatment",
    "Hook, visual beats, payoff",
    "30–60 seconds",
    "Fast and educational",
    "One spoken action",
    "Plan spoken/on-screen attribution",
    "Include shots, overlays, and b-roll",
  ),
  draftTarget(
    "youtube-shorts-script",
    "YouTube Shorts",
    "Script",
    "Provide record-ready spoken copy",
    "Hook, body, payoff, CTA",
    "75–150 spoken words",
    "Natural spoken voice",
    "One spoken action",
    "Include spoken/on-screen attribution",
    "Add time-coded delivery notes",
  ),
  draftTarget(
    "instagram-reels-concept",
    "Instagram Reels",
    "Concept",
    "Define a native Reel treatment",
    "Pattern interrupt, beats, payoff",
    "30–60 seconds",
    "Visual and approachable",
    "Save/share prompt when useful",
    "Plan on-screen attribution",
    "Include shots, overlays, caption idea",
  ),
  draftTarget(
    "instagram-reels-script",
    "Instagram Reels",
    "Script",
    "Provide record-ready Reel copy",
    "Hook, spoken beats, payoff, CTA",
    "75–150 spoken words",
    "Conversational spoken voice",
    "One platform-native action",
    "Spoken/on-screen attribution",
    "Add time-coded visual notes",
  ),
  draftTarget(
    "tiktok-concept",
    "TikTok",
    "Concept",
    "Define a TikTok-native treatment",
    "Immediate hook, rapid proof, payoff",
    "20–60 seconds",
    "Direct and culturally literate",
    "Comment/save prompt when useful",
    "Plan spoken/on-screen attribution",
    "Include shots, overlays, sound guidance",
  ),
  draftTarget(
    "tiktok-script",
    "TikTok",
    "Script",
    "Provide record-ready TikTok copy",
    "Hook, tight beats, payoff, CTA",
    "60–150 spoken words",
    "Natural and fast",
    "One platform-native action",
    "Spoken/on-screen attribution",
    "Add time-coded delivery notes",
  ),
  draftTarget(
    "youtube-long-outline",
    "YouTube",
    "Long-form outline",
    "Plan a developed evidence-led video",
    "Cold open, chapters, examples, close",
    "8–15 minute plan",
    "Authoritative and engaging",
    "Relevant subscribe or next step",
    "Plan spoken and on-screen sources",
    "Include chapter timings, visuals, b-roll",
  ),
  draftTarget(
    "youtube-long-script",
    "YouTube",
    "Long-form script",
    "Provide production-ready long-form copy",
    "Cold open, full chapters, transitions, close",
    "1,500–2,500 spoken words",
    "Natural expert delivery",
    "One primary action",
    "Spoken/on-screen attribution and links",
    "Include time codes and production cues",
  ),
];

export interface OpportunityBrief {
  id: string;
  runId: string;
  contentPackId: string;
  createdAt: string;
  /** Frozen opportunity identity: angle, urgency, explanation and ranking dimensions are immutable. */
  opportunity: RankedOpportunity;
  /** Strongest three to eight qualifying Source Items, bounded and with explicit completeness. */
  sourceItems: SourceItem[];
  /** Factual claims stored separately from titles, each grounded to one or more canonical URLs. */
  claims: { claim: string; sourceUrls: string[] }[];
  brandProfileRevisionId: string;
  /** Markdown snapshot frozen at selection time; later Brand Profile edits do not affect this brief. */
  brandProfileMarkdown: string;
}

export interface DraftReviewNote {
  claim: string;
  kind: "fact" | "interpretation" | "opinion" | "prediction" | "uncertainty";
  sourceUrls: string[];
}

export interface ContentDraft {
  id: string;
  contentPackId: string;
  target: DraftTargetContract;
  createdAt: string;
  copy: string;
  productionNotes: string[];
  reviewNotes: DraftReviewNote[];
}

export interface ContentPack {
  id: string;
  runId: string;
  opportunityId: string;
  opportunityTitle: string;
  briefId: string;
  createdAt: string;
  draftIds: string[];
  notionPageKeys: string[];
  notionPages: { key: string; draftId: string; id: string; url: string }[];
  status: "partial" | "complete";
}
export interface SourceAdapterCanaryTarget {
  adapterId: string;
  label: string;
  url: string;
}

export interface SourceCanaryReceipt {
  adapterId: string;
  adapterVersion: string;
  target: SourceAdapterCanaryTarget;
  capability: SourceCapability;
  route: string;
  outcome: SourceDiagnosticClassification;
  diagnostic: AdapterDiagnostic;
  checkedAt: string;
  durationMs: number;
  itemsFound: number;
}

export interface SourceCanaryHealth {
  adapterId: string;
  state: SourceAdapterState;
  version: string;
  canaryTargets: SourceAdapterCanaryTarget[];
  recentReceipts: SourceCanaryReceipt[];
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  degraded: boolean;
  promotionEligible: boolean;
  evidence: {
    requiredSuccesses: number;
    successCount: number;
    version: string;
    recentOutcomes: SourceDiagnosticClassification[];
  };
}

export const CANARY_PROMOTION_REQUIRED_SUCCESSES = 3;
export const CANARY_PROMOTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CANARY_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const CANARY_MIN_TARGETS = 3;

export function isCanarySuccess(receipt: SourceCanaryReceipt): boolean {
  return receipt.outcome === "items_found" && receipt.itemsFound > 0;
}

export function isCanaryPromotionEligible(input: {
  adapter: { id: string; version: string; canaryTargets?: readonly SourceAdapterCanaryTarget[] };
  receipts: readonly SourceCanaryReceipt[];
  now?: Date;
}): boolean {
  const targets = input.adapter.canaryTargets ?? [];
  if (targets.length < CANARY_MIN_TARGETS) return false;
  const now = input.now ?? new Date();
  const windowStart = now.getTime() - CANARY_PROMOTION_WINDOW_MS;
  for (const target of targets) {
    const forTarget = input.receipts.filter(
      (receipt) =>
        receipt.adapterId === input.adapter.id &&
        receipt.adapterVersion === input.adapter.version &&
        receipt.target.url === target.url &&
        Date.parse(receipt.checkedAt) >= windowStart,
    );
    const successes = forTarget.filter(isCanarySuccess);
    if (successes.length < CANARY_PROMOTION_REQUIRED_SUCCESSES) return false;
    const latest = [...forTarget].sort(
      (a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt),
    )[0];
    if (!latest || !isCanarySuccess(latest)) return false;
  }
  return true;
}

export function canaryHealthForAdapter(input: {
  adapter: {
    id: string;
    state: SourceAdapterState;
    version: string;
    canaryTargets?: readonly SourceAdapterCanaryTarget[];
  };
  receipts: readonly SourceCanaryReceipt[];
}): SourceCanaryHealth {
  const targets = [...(input.adapter.canaryTargets ?? [])];
  const forAdapter = [...input.receipts]
    .filter(
      (receipt) =>
        receipt.adapterId === input.adapter.id && receipt.adapterVersion === input.adapter.version,
    )
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
  const recentReceipts = forAdapter.slice(0, 9);
  const lastSuccess = forAdapter.find(isCanarySuccess) ?? null;
  const lastFailure = forAdapter.find((receipt) => !isCanarySuccess(receipt)) ?? null;
  const latestByTarget = new Map<string, SourceCanaryReceipt>();
  for (const receipt of forAdapter) {
    if (!latestByTarget.has(receipt.target.url)) latestByTarget.set(receipt.target.url, receipt);
  }
  const degraded = [...latestByTarget.values()].some((receipt) => !isCanarySuccess(receipt));
  const promotionEligible = isCanaryPromotionEligible({
    adapter: input.adapter,
    receipts: input.receipts,
  });
  return {
    adapterId: input.adapter.id,
    state: input.adapter.state,
    version: input.adapter.version,
    canaryTargets: targets,
    recentReceipts,
    lastSuccessAt: lastSuccess?.checkedAt ?? null,
    lastFailureAt: lastFailure?.checkedAt ?? null,
    degraded,
    promotionEligible,
    evidence: {
      requiredSuccesses: CANARY_PROMOTION_REQUIRED_SUCCESSES,
      successCount: forAdapter.filter(isCanarySuccess).length,
      version: input.adapter.version,
      recentOutcomes: recentReceipts.map((receipt) => receipt.outcome),
    },
  };
}
