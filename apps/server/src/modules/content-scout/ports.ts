import type {
  AdapterDiagnostic,
  BrandProfileRevision,
  BrandProfileScanPage,
  ContentDraft,
  DraftReviewNote,
  DraftTargetContract,
  OpportunityBrief,
  RankedOpportunity,
  SourceAdapterCanaryTarget,
  SourceAdapterState,
  SourceBackfillWindowDays,
  SourceDiagnosticClassification,
  SourceItem,
  SourceTarget,
  SourceSuggestion,
  SourceStoryGroup,
  ContentScoutRuntimeCapability,
} from "@chief-of-staff-demo/shared";

interface SourceCollectionRequest {
  target: SourceTarget;
  since: string;
  until: string;
  checkpoint: string | null;
  conditional?: { etag: string | null; lastModified: string | null } | null;
}

export type SourceCollectionResult = (
  | {
      kind: "completed";
      outcome: "items_found" | "legitimate_empty" | "no_new_material";
      items: SourceItem[];
      checkpoint: string | null;
      conditional?: { etag: string | null; lastModified: string | null } | null;
      diagnostic: AdapterDiagnostic;
    }
  | {
      kind: "failed";
      outcome: Exclude<
        SourceDiagnosticClassification,
        "items_found" | "legitimate_empty" | "no_new_material"
      >;
      items: SourceItem[];
      checkpoint: null;
      conditional?: { etag: string | null; lastModified: string | null } | null;
      diagnostic: AdapterDiagnostic;
    }
) & {
  /** Raw diagnostic material; the shared path sanitizes and bounds it before persistence. */
  diagnosticBody?: { contentType: string; body: string };
};

/** One platform/protocol-specific adapter at the shared Source Item seam. */
export interface SourceAdapter {
  readonly id: string;
  readonly state: SourceAdapterState;
  readonly version: string;
  /**
   * The user-requested backfill windows this Adapter honors with a genuine
   * historical `since`, e.g. `[7, 30, 90]`. Absent or empty means the Adapter
   * has no bounded historical route (a single current-page snapshot, for
   * example), so a requested backfill fails as `unsupported_capability`
   * instead of silently returning today's evidence as if it were history.
   */
  readonly backfillWindowsDays?: readonly SourceBackfillWindowDays[];
  readonly canaryTargets?: readonly SourceAdapterCanaryTarget[];
  supports(target: SourceTarget): boolean;
  collect(request: SourceCollectionRequest): Promise<SourceCollectionResult>;
  /** A bounded anonymous proof route when normal collection is intentionally unavailable. */
  collectCanary?(request: SourceCollectionRequest): Promise<SourceCollectionResult>;
  enrich?(items: SourceItem[]): Promise<SourceItem[]>;
}

export interface OpportunityRanker {
  rank(input: {
    brandProfile: BrandProfileRevision;
    items: SourceItem[];
    storyGroups: SourceStoryGroup[];
    limit: number;
  }): Promise<RankedOpportunity[]>;
}

export interface DraftGenerator {
  generate(input: {
    idempotencyKey: string;
    brief: OpportunityBrief;
    target: DraftTargetContract;
  }): Promise<{
    copy: string;
    productionNotes: string[];
    reviewNotes: DraftReviewNote[];
  }>;
}

export interface NotionPublisher {
  findDraftPage(
    idempotencyKey: string,
    draft?: ContentDraft,
  ): Promise<{ id: string; url: string } | null>;
  createDraftPage(input: {
    idempotencyKey: string;
    draft: ContentDraft;
    brief: OpportunityBrief;
  }): Promise<{ id: string; url: string }>;
}

export interface SourceDiscoverer {
  discover(input: {
    brandProfile: BrandProfileRevision;
    approvedTargets: SourceTarget[];
  }): Promise<
    Omit<SourceSuggestion, "id" | "state" | "discoveredAt" | "decisionReason" | "sourceTargetId">[]
  >;
}

export interface BrandProfileCrawler {
  crawl(input: { websiteUrl: string; maxPages: 25; maxDepth: 2 }): Promise<BrandProfileScanPage[]>;
}

export interface BrandProfileProposer {
  propose(input: { pages: BrandProfileScanPage[] }): Promise<string>;
}

export interface RuntimeInspector {
  inspect(): Promise<ContentScoutRuntimeCapability[]>;
}
