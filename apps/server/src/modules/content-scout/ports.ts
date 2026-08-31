import type {
  BrandProfileRevision,
  BrandProfileScanPage,
  ContentDraft,
  DraftReviewNote,
  DraftTargetContract,
  OpportunityBrief,
  RankedOpportunity,
  SourceItem,
  SourceTarget,
  SourceSuggestion,
  SourceStoryGroup,
  ContentScoutRuntimeCapability,
} from "@chief-of-staff-demo/shared";

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
