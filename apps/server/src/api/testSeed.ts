import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type {
  DraftGenerator,
  BrandProfileCrawler,
  BrandProfileProposer,
  NotionPublisher,
  OpportunityRanker,
  SourceAdapter,
} from "../modules/content-scout/ports.js";
import type { RunSourceSpec } from "../modules/transcript/module.js";

export interface TestSeedContext {
  startRun: (spec: RunSourceSpec) => Promise<string>;
}

/**
 * Hermetic e2e seam: create a Drive-type Run from the sample transcript
 * without needing a real Drive folder. Not part of the user-facing API and
 * never registered unless the explicit test flag is set, so an unset variable
 * cannot expose it (no NODE_ENV string compare).
 */
export async function registerTestSeed(app: FastifyInstance, ctx: TestSeedContext): Promise<void> {
  app.post("/api/test/seed", async (_request, reply) => {
    try {
      let bytes: Buffer | null = null;
      const candidates = [
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../tests/fixtures/transcripts/sample-transcript.md",
        ),
        join(process.cwd(), "tests/fixtures/transcripts/sample-transcript.md"),
      ];
      for (const cand of candidates) {
        try {
          bytes = await readFile(cand);
          break;
        } catch {
          /* This candidate is not there; try the next. */
        }
      }
      if (!bytes) {
        bytes = Buffer.from("# Weekly Product Sync\n\nAlice: hello\nBob: hi\n");
      }
      const runId = await ctx.startRun({
        intake: "drive",
        fileName: "sample-transcript.md",
        bytes,
      });
      reply.code(201);
      return { runId };
    } catch (error) {
      reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  });
}

/** Fixed ports for the browser suite; production never selects these dependencies. */
export function contentScoutTestPorts(now: () => Date): {
  adapters: SourceAdapter[];
  ranker: OpportunityRanker;
  draftGenerator: DraftGenerator;
  notionPublisher: NotionPublisher;
  brandProfileCrawler: BrandProfileCrawler;
  brandProfileProposer: BrandProfileProposer;
} {
  const adapter: SourceAdapter = {
    id: "rss",
    state: "available",
    version: "e2e-fixture-1",
    supports: (target) => target.adapterId === "rss",
    async collect({ target }) {
      const at = now().toISOString();
      return {
        kind: "completed",
        outcome: "items_found",
        checkpoint: "e2e-checkpoint-1",
        items: [
          {
            id: "rss:e2e-public-change",
            externalId: "e2e-public-change",
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://example.com/research/public-change",
            author: "Example Research",
            title: "A verified public change with practical consequences",
            body: "The checked-in public-source fixture describes a verified change and concrete consequences.",
            description: null,
            publishedAt: at,
            discoveredAt: at,
            media: [],
            transcript: null,
            comments: [],
            evidence: [{ route: "fixture:content-scout-rss", retrievedAt: at }],
            completeness: {
              title: "available",
              body: "available",
              description: "unavailable",
              transcript: "unsupported",
              comments: "unsupported",
            },
          },
        ],
        diagnostic: {
          classification: "items_found",
          route: "fixture:content-scout-rss",
          status: 200,
          contentType: "application/rss+xml",
          parserStage: "rss",
          responseHash: "e2e-public-change-v1",
          adapterVersion: "e2e-fixture-1",
          startedAt: at,
          finishedAt: at,
          retries: 0,
          affectedCapabilities: [],
          causeChain: [],
        },
      };
    },
  };
  const ranker: OpportunityRanker = {
    async rank({ items }) {
      return [
        {
          id: "e2e-opportunity-1",
          canonicalKey: "e2e-public-change-practical-impact",
          title: "Explain what the verified change means in practice",
          angle: "practical_implication",
          urgency: "Useful while the public change is new.",
          explanation: "The evidence is specific and matches the accepted educational positioning.",
          sourceItemIds: items.map((item) => item.id),
          sourceUrls: items.map((item) => item.canonicalUrl),
          experimentalEvidence: false,
          confidence: 0.94,
          scores: {
            brandRelevance: 0.95,
            audienceUsefulness: 0.94,
            timeliness: 0.9,
            novelty: 0.82,
            evidenceStrength: 0.92,
            evidenceDiversity: 0.4,
            specificity: 0.9,
            originalPerspective: 0.84,
            packApplicability: 0.96,
            speculationRisk: 0.05,
          },
        },
      ];
    },
  };
  const draftGenerator: DraftGenerator = {
    async generate({ brief, target }) {
      return {
        copy: `${target.channel} ${target.format}\n\n${brief.opportunity.title}\n\nEvidence-led draft for ${target.id}.`,
        productionNotes: [target.productionNotes],
        reviewNotes: [
          {
            claim: "A public source describes the verified change.",
            kind: "fact",
            sourceUrls: brief.opportunity.sourceUrls,
          },
        ],
      };
    },
  };
  const pages = new Map<string, { id: string; url: string }>();
  const notionPublisher: NotionPublisher = {
    async findDraftPage(key) {
      return pages.get(key) ?? null;
    },
    async createDraftPage({ idempotencyKey }) {
      const page = {
        id: `e2e-notion-page-${pages.size + 1}`,
        url: `https://www.notion.so/e2e-content-draft-${pages.size + 1}`,
      };
      pages.set(idempotencyKey, page);
      return page;
    },
  };
  const brandProfileCrawler: BrandProfileCrawler = {
    async crawl({ websiteUrl }) {
      return [
        {
          url: websiteUrl,
          title: "Example Company",
          depth: 0,
          included: true,
          exclusionReason: null,
          text: "Example Company helps small teams explain complex public changes with practical educational guidance.",
        },
        {
          url: `${websiteUrl.replace(/\/$/, "")}/about`,
          title: "About",
          depth: 1,
          included: true,
          exclusionReason: null,
          text: "Customers value specific, evidence-led explanations and a direct, useful voice.",
        },
        {
          url: `${websiteUrl.replace(/\/$/, "")}/blog`,
          title: "Blog",
          depth: 1,
          included: false,
          exclusionReason: "Default transient or operational-page exclusion",
          text: "",
        },
      ];
    },
  };
  const brandProfileProposer: BrandProfileProposer = {
    async propose() {
      return `# Brand Profile\n\n## Summary\nExample Company turns complex changes into practical guidance.\n\n## Products\nEducational guidance.\n\n## Customers\nSmall teams.\n\n## Customer problems\nUnderstanding change.\n\n## Positioning\nEvidence-led and practical.\n\n## Differentiators\nSpecific explanations.\n\n## Proof\nPublic company website.\n\n## Competitors\nNot established.\n\n## Voice\nDirect and useful.\n\n## Vocabulary\nPractical, evidence-led.\n\n## Prohibited claims\nDo not invent outcomes.\n\n## Content themes\nPublic changes and implications.\n\n## Avoided subjects\nUnverified rumors.\n\n## Geographic or regulatory constraints\nNot established.\n`;
    },
  };
  return {
    adapters: [adapter],
    ranker,
    draftGenerator,
    notionPublisher,
    brandProfileCrawler,
    brandProfileProposer,
  };
}
