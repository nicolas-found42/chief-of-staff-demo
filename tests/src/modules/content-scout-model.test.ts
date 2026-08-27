import { describe, expect, it } from "vitest";
import {
  CONTENT_SCOUT_DRAFT_TARGETS_V1,
  type BrandProfileRevision,
  type OpportunityBrief,
  type RankedOpportunity,
  type SourceItem,
} from "@chief-of-staff-demo/shared";
import { ModelBoundaryError } from "../../../apps/server/src/llm/failure";
import {
  modelDraftGenerator,
  modelOpportunityRanker,
} from "../../../apps/server/src/modules/content-scout/model";

function capacityFailure(): ModelBoundaryError {
  return new ModelBoundaryError({
    classification: "upstream_error",
    provider: "openrouter",
    model: "test-model",
    upstreamServer: "Nvidia",
    upstreamCode: 503,
    binding: "forced_tool_call",
    status: 200,
    finishReason: null,
    bodyBytes: 42,
    topLevelKeys: ["error"],
    populatedFields: [],
    emptyFields: [],
    timeoutMs: null,
  });
}

const profile = {
  id: "brand-1",
  createdAt: "2026-08-25T12:00:00.000Z",
  markdown: "# Brand",
  sourceScan: { websiteUrl: "https://brand.example", includedUrls: [], excludedUrls: [] },
  note: null,
  changedSections: [],
} satisfies BrandProfileRevision;

const sourceItem = {
  id: "source-1",
  externalId: "external-1",
  targetId: "target-1",
  adapterId: "rss",
  canonicalUrl: "https://source.example/story",
  author: "Author",
  title: "Verified change",
  body: "Evidence",
  description: null,
  publishedAt: "2026-08-25T10:00:00.000Z",
  discoveredAt: "2026-08-25T12:00:00.000Z",
  media: [],
  transcript: null,
  comments: [],
  evidence: [{ route: "fixture:rss", retrievedAt: "2026-08-25T12:00:00.000Z" }],
  completeness: {
    title: "available",
    body: "available",
    description: "unavailable",
    transcript: "unsupported",
    comments: "unsupported",
    media: "unavailable",
  },
} satisfies SourceItem;

const opportunity: Omit<RankedOpportunity, "id"> = {
  canonicalKey: "verified-change",
  title: "Explain the verified change",
  angle: "practical_implication",
  angleDescription: "Explain the practical impact of the verified change.",
  materialDevelopment: null,
  urgency: "Now",
  explanation: "It matters",
  sourceItemIds: [sourceItem.id],
  sourceUrls: [sourceItem.canonicalUrl],
  experimentalEvidence: false,
  confidence: 0.9,
  scores: {
    brandRelevance: 1,
    audienceUsefulness: 1,
    timeliness: 1,
    novelty: 1,
    evidenceStrength: 1,
    evidenceDiversity: 1,
    specificity: 1,
    originalPerspective: 1,
    packApplicability: 1,
    speculationRisk: 0,
  },
};

describe("Content Scout model adapters", () => {
  it("retries capacity while ranking Content Opportunities", async () => {
    let attempts = 0;
    const ranker = modelOpportunityRanker(() => async () => {
      attempts += 1;
      if (attempts === 1) throw capacityFailure();
      return { opportunities: [opportunity] };
    });

    const ranked = await ranker.rank({
      brandProfile: profile,
      items: [sourceItem],
      storyGroups: [{ canonicalKey: "verified-change", sourceItemIds: [sourceItem.id] }],
      limit: 5,
    });

    expect(ranked).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("retries capacity while generating a Content Draft", async () => {
    let attempts = 0;
    const generator = modelDraftGenerator(() => async () => {
      attempts += 1;
      if (attempts === 1) throw capacityFailure();
      return { copy: "Copy-ready draft.", productionNotes: [], reviewNotes: [] };
    });
    const brief = {
      id: "brief-1",
      runId: "run_20260825-120000_aaaaaaaa",
      contentPackId: "pack-1",
      createdAt: "2026-08-25T12:00:00.000Z",
      opportunity: { ...opportunity, id: "opportunity-1" },
      sourceItems: [sourceItem],
      claims: [],
      brandProfileRevisionId: profile.id,
      brandProfileMarkdown: profile.markdown,
    } satisfies OpportunityBrief;

    await expect(
      generator.generate({
        idempotencyKey: "draft-1",
        brief,
        target: CONTENT_SCOUT_DRAFT_TARGETS_V1[0],
      }),
    ).resolves.toMatchObject({ copy: "Copy-ready draft." });
    expect(attempts).toBe(2);
  });
});
