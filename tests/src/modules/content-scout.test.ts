import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import type {
  DraftGenerator,
  NotionPublisher,
  OpportunityRanker,
  SourceAdapter,
} from "../../../apps/server/src/modules/content-scout/ports";
import { openRuns } from "../../../apps/server/src/runs";
import { ConfigStore } from "../../../apps/server/src/config";
import { CONTENT_SCOUT_DRAFT_TARGETS_V1 } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-25T12:00:00.000Z");

function rssAdapter(): SourceAdapter {
  return {
    id: "rss",
    state: "available",
    version: "fixture-1",
    supports: (target) => target.adapterId === "rss",
    async collect({ target }) {
      return {
        kind: "completed",
        outcome: "items_found",
        checkpoint: "rss-checkpoint-1",
        items: [
          {
            id: "rss:story-1",
            externalId: "story-1",
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://example.com/story-1",
            author: "Example Research",
            title: "A concrete change worth explaining",
            body: "The public source describes a verified change and its practical impact.",
            description: null,
            publishedAt: "2026-08-25T10:00:00.000Z",
            discoveredAt: NOW.toISOString(),
            media: [],
            transcript: null,
            comments: [],
            evidence: [{ route: "fixture:rss", retrievedAt: NOW.toISOString() }],
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
          route: "fixture:rss",
          status: 200,
          contentType: "application/rss+xml",
          parserStage: "rss",
          responseHash: "rss-response-1",
          adapterVersion: "fixture-1",
          startedAt: NOW.toISOString(),
          finishedAt: NOW.toISOString(),
          retries: 0,
          affectedCapabilities: [],
          causeChain: [],
        },
      };
    },
  };
}

function websiteAdapter(): SourceAdapter {
  return {
    id: "website",
    state: "available",
    version: "fixture-1",
    supports: (target) => target.adapterId === "website",
    async collect() {
      return {
        kind: "failed",
        outcome: "response_shape_change",
        items: [],
        checkpoint: null,
        diagnostic: {
          classification: "response_shape_change",
          route: "fixture:website",
          status: 200,
          contentType: "text/html",
          parserStage: "readability",
          responseHash: "web-response-1",
          adapterVersion: "fixture-1",
          startedAt: NOW.toISOString(),
          finishedAt: NOW.toISOString(),
          retries: 0,
          affectedCapabilities: ["body"],
          causeChain: ["Article body selector no longer matched."],
        },
      };
    },
  };
}

const ranker: OpportunityRanker = {
  async rank({ items, brandProfile }) {
    return [
      {
        id: "opportunity-1",
        canonicalKey: "verified-change-practical-impact",
        title: "Explain what the verified change means in practice",
        angle: "practical_implication",
        urgency: "Useful while the change is new.",
        explanation: "It matches the Brand Profile's educational positioning.",
        sourceItemIds: items.map((item) => item.id),
        sourceUrls: items.map((item) => item.canonicalUrl),
        experimentalEvidence: false,
        confidence: 0.91,
        scores: {
          brandRelevance: brandProfile.markdown.includes("educational") ? 0.95 : 0.5,
          audienceUsefulness: 0.9,
          timeliness: 0.9,
          novelty: 0.8,
          evidenceStrength: 0.9,
          evidenceDiversity: 0.4,
          specificity: 0.9,
          originalPerspective: 0.8,
          packApplicability: 0.9,
          speculationRisk: 0.1,
        },
      },
    ];
  },
};

describe("ContentScoutHost", () => {
  it("persists configured sources, produces a ranked shortlist, and durably blocks the Intake Run", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-scout-"));
    const runs = openRuns(workspaceDir);
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter(), websiteAdapter()],
      ranker,
      log: () => undefined,
    });

    const revision = host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: {
        websiteUrl: "https://company.example",
        includedUrls: ["https://company.example/"],
        excludedUrls: [],
      },
      note: "Initial accepted profile",
    });
    const rss = host.addSourceTarget({
      adapterId: "rss",
      label: "Example Research",
      url: "https://example.com/feed.xml",
    });
    host.addSourceTarget({
      adapterId: "website",
      label: "Example newsroom",
      url: "https://news.example/updates",
    });

    const runId = await host.scoutNow();
    await host.idle();

    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("blocked");
    expect(detail.wait).toMatchObject({
      stage: "selection",
      timeout: { kind: "none" },
    });
    expect(detail.events.map((event) => event.type)).toEqual([
      "created",
      "stage_started",
      "source_adapter_attempted",
      "source_adapter_completed",
      "source_adapter_attempted",
      "source_adapter_failed",
      "stage_started",
      "stage_started",
      "shortlist_ranked",
      "stage_started",
      "run_blocked",
    ]);

    const shortlist = host.activeShortlist();
    expect(shortlist).toMatchObject({
      runId,
      brandProfileRevisionId: revision.id,
      omittedCount: 0,
      opportunities: [
        {
          id: expect.stringMatching(/^opportunity-/),
          state: "ready",
          title: "Explain what the verified change means in practice",
        },
      ],
    });
    expect(host.listSourceTargets().find((target) => target.id === rss.id)?.checkpoint).toBe(
      "rss-checkpoint-1",
    );
    expect(detail.result).toMatchObject({
      adapters: [
        { adapterId: "rss", outcome: "items_found", itemsFound: 1 },
        { adapterId: "website", outcome: "response_shape_change", itemsFound: 0 },
      ],
      shortlist: { opportunityCount: 1 },
      warnings: 1,
    });

    const reconstructed = new ContentScoutHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter(), websiteAdapter()],
      ranker,
      log: () => undefined,
    });
    expect(reconstructed.activeShortlist()).toEqual(shortlist);
  });

  it("collapses missed daily and weekly periods and keeps their schedule receipts independent across DST", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-schedule-"));
    const runs = openRuns(workspaceDir);
    const configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    configStore.setModuleConfig("content-scout", {
      ...configStore.get().modules["content-scout"],
      timeZone: "America/New_York",
      dailyTime: "08:00",
      weeklyDiscoveryDay: 1,
      weeklyDiscoveryTime: "09:00",
    });
    // Tuesday after the 2026 fall-back: today's daily period and this week's
    // missed Monday discovery period are each due exactly once.
    const clock = new Date("2026-11-03T14:00:00.000Z");
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      configStore,
      now: () => clock,
      adapters: [rssAdapter()],
      ranker,
      discoverer: {
        async discover() {
          return [
            {
              adapterId: "website",
              label: "Suggested public source",
              url: "https://suggested.example/updates",
              discoveredBecause: "Fixture relationship",
              evidenceUrls: ["https://example.com/story-1"],
              similarityFactors: ["Educational focus"],
            },
          ];
        },
      },
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "rss",
      label: "Research",
      url: "https://example.com/feed.xml",
    });

    await host.checkSchedules();
    await host.idle();
    await host.checkSchedules();
    await host.idle();

    const scheduled = runs.list({ module: "content-scout" }).runs;
    expect(scheduled).toHaveLength(2);
    expect(scheduled.map((run) => [run.intake, run.status])).toEqual(
      expect.arrayContaining([
        ["source-discovery", "done"],
        ["daily-intake", "blocked"],
      ]),
    );
    expect(host.listSourceSuggestions()).toHaveLength(1);
    expect(host.scheduleState()).toEqual({
      lastSuccessfulIntakePeriod: "2026-11-03",
      lastSuccessfulDiscoveryPeriod: "2026-W45",
    });
  });

  it("runs a bounded Brand Profile scan without mutating the accepted revision", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-brand-scan-"));
    const runs = openRuns(workspaceDir);
    let crawlRequest: unknown;
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter()],
      ranker,
      brandProfileCrawler: {
        async crawl(input) {
          crawlRequest = input;
          return [
            {
              url: input.websiteUrl,
              title: "Company",
              depth: 0,
              included: true,
              exclusionReason: null,
              text: "Practical educational company facts.",
            },
            {
              url: `${input.websiteUrl}/blog`,
              title: "Blog",
              depth: 1,
              included: false,
              exclusionReason: "Default exclusion",
              text: "",
            },
          ];
        },
      },
      brandProfileProposer: {
        async propose() {
          return "# Brand Profile\n\n## Summary\nNew website proposal\n\n## Voice\nDirect\n";
        },
      },
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Summary\nOriginal website value\n\n## Voice\nWarm\n",
      sourceScan: {
        websiteUrl: "https://company.example",
        includedUrls: [],
        excludedUrls: [],
      },
    });
    const current = host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Summary\nMaintained operator value\n\n## Voice\nWarm\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });

    const runId = await host.scanBrandProfile("https://company.example");
    await host.idle();

    expect(crawlRequest).toEqual({
      websiteUrl: "https://company.example",
      maxPages: 25,
      maxDepth: 2,
    });
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    expect(
      detail.events
        .filter((event) => event.type === "stage_started")
        .map((event) => event.detail?.stage),
    ).toEqual(["crawl", "propose"]);
    expect(host.currentBrandProfile()).toEqual(current);
    const proposal = host.brandProfileProposal()!;
    expect(proposal).toMatchObject({
      runId,
      basedOnRevisionId: current.id,
      pages: [{ included: true }, { included: false }],
    });
    expect(proposal.sectionDiffs.find((diff) => diff.section === "Summary")).toMatchObject({
      currentValue: "Maintained operator value",
      proposedValue: "New website proposal",
      status: "conflicting",
    });
  });

  it("freezes one brief, generates all 23 drafts independently at concurrency four, and publishes one page per draft", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-pack-"));
    const runs = openRuns(workspaceDir);
    const requests: Parameters<DraftGenerator["generate"]>[0][] = [];
    let active = 0;
    let maximumActive = 0;
    const generator: DraftGenerator = {
      async generate(input) {
        requests.push(structuredClone(input));
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return {
          copy: `Copy for ${input.target.id}`,
          productionNotes: [`Production notes for ${input.target.channel}`],
          reviewNotes: [
            {
              claim: "The source describes a verified change.",
              kind: "fact",
              sourceUrls: input.brief.opportunity.sourceUrls,
            },
          ],
        };
      },
    };
    const pages = new Map<string, { id: string; url: string }>();
    const notion: NotionPublisher = {
      async findDraftPage(key) {
        return pages.get(key) ?? null;
      },
      async createDraftPage({ idempotencyKey }) {
        const page = {
          id: `page-${pages.size + 1}`,
          url: `https://notion.example/page-${pages.size + 1}`,
        };
        pages.set(idempotencyKey, page);
        return page;
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter()],
      ranker,
      draftGenerator: generator,
      notionPublisher: notion,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: {
        websiteUrl: "https://company.example",
        includedUrls: ["https://company.example/"],
        excludedUrls: [],
      },
    });
    host.addSourceTarget({
      adapterId: "rss",
      label: "Example Research",
      url: "https://example.com/feed.xml",
    });
    const runId = await host.scoutNow();
    await host.idle();

    const opportunityId = host.activeShortlist()!.opportunities[0].id;
    await host.select(runId, [opportunityId]);
    await host.idle();

    expect(runs.detail(runId)!.status).toBe("done");
    expect(requests).toHaveLength(23);
    expect(new Set(requests.map((request) => request.brief.id))).toHaveLength(1);
    expect(requests.map((request) => request.target.id).sort()).toEqual(
      CONTENT_SCOUT_DRAFT_TARGETS_V1.map((target) => target.id).sort(),
    );
    expect(
      requests.every(
        (request) => Object.keys(request).sort().join(",") === "brief,idempotencyKey,target",
      ),
    ).toBe(true);
    expect(maximumActive).toBe(4);
    expect(pages).toHaveLength(23);

    const packs = host.listContentPacks();
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      runId,
      opportunityId,
      status: "complete",
    });
    expect(packs[0]?.draftIds).toHaveLength(23);
    expect(packs[0]?.notionPageKeys).toHaveLength(23);
    expect(runs.detail(runId)!.result).toMatchObject({
      packs: [
        {
          generated: 23,
          published: 23,
          total: 23,
          missingDraftTargets: [],
          missingNotionPages: [],
        },
      ],
    });
  });

  it("retries only missing drafts and repairs an ambiguous Notion timeout without duplicates", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-retry-"));
    const runs = openRuns(workspaceDir);
    const calls = new Map<string, number>();
    const failOnce = new Set(["linkedin-poll", "tiktok-script"]);
    const generator: DraftGenerator = {
      async generate({ target }) {
        const count = (calls.get(target.id) ?? 0) + 1;
        calls.set(target.id, count);
        if (failOnce.has(target.id) && count === 1) {
          throw new Error(`temporary ${target.id} failure`);
        }
        return {
          copy: `Immutable ${target.id} generation ${count}`,
          productionNotes: [],
          reviewNotes: [],
        };
      },
    };
    const pages = new Map<string, { id: string; url: string }>();
    let createCalls = 0;
    let timedOut = false;
    const notion: NotionPublisher = {
      async findDraftPage(key) {
        return pages.get(key) ?? null;
      },
      async createDraftPage({ idempotencyKey }) {
        createCalls += 1;
        const page = { id: `page-${createCalls}`, url: `https://notion.example/${createCalls}` };
        pages.set(idempotencyKey, page);
        if (!timedOut && idempotencyKey.includes("youtube-long-script")) {
          timedOut = true;
          throw new Error("timeout after Notion accepted the page");
        }
        return page;
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter()],
      ranker,
      draftGenerator: generator,
      notionPublisher: notion,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Feed", url: "https://example.com/feed" });
    const runId = await host.scoutNow();
    await host.idle();

    const opportunityId = host.activeShortlist()!.opportunities[0].id;
    await host.select(runId, [opportunityId]);
    await host.idle();
    expect(runs.detail(runId)!.status).toBe("failed");
    expect(runs.detail(runId)!.failedStage).toBe("draft");
    const successfulTarget = "linkedin-standard-post";
    const packId = `${runId}--${opportunityId}`;
    const successfulArtifact = `draft-${packId}-${successfulTarget}.json`;
    const successfulBefore = runs.open(runId)!.readArtifact(successfulArtifact);

    await host.retryRun(runId);
    await host.idle();
    expect(runs.detail(runId)!.status).toBe("failed");
    expect(runs.detail(runId)!.failedStage).toBe("publish");
    expect(calls.get("linkedin-poll")).toBe(2);
    expect(calls.get("tiktok-script")).toBe(2);
    expect(calls.get(successfulTarget)).toBe(1);
    expect(createCalls).toBe(23);
    expect(pages).toHaveLength(23);

    await host.retryRun(runId);
    await host.idle();
    expect(runs.detail(runId)!.status).toBe("done");
    expect(createCalls).toBe(23);
    expect(runs.open(runId)!.readArtifact(successfulArtifact)).toBe(successfulBefore);
    expect(host.listContentPacks()[0]).toMatchObject({
      status: "complete",
      draftIds: expect.arrayContaining([
        `${packId}:linkedin-poll:v1`,
        `${packId}:tiktok-script:v1`,
      ]),
    });
  });

  it("supersedes an older blocked shortlist only after its replacement ranks successfully", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-supersede-"));
    const runs = openRuns(workspaceDir);
    let failRanking = false;
    const switchingRanker: OpportunityRanker = {
      async rank(input) {
        if (failRanking) throw new Error("ranking unavailable");
        return await ranker.rank(input);
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter()],
      ranker: switchingRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\nEducational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Feed", url: "https://example.com/feed" });
    const oldRunId = await host.scoutNow();
    await host.idle();
    expect(runs.detail(oldRunId)!.status).toBe("blocked");

    failRanking = true;
    const failedReplacement = await host.scoutNow();
    await host.idle();
    expect(runs.detail(failedReplacement)!.status).toBe("failed");
    expect(runs.detail(oldRunId)!.status).toBe("blocked");
    expect(host.activeShortlist()?.runId).toBe(oldRunId);

    failRanking = false;
    const successfulReplacement = await host.scoutNow();
    await host.idle();
    expect(runs.detail(successfulReplacement)!.status).toBe("blocked");
    expect(runs.detail(oldRunId)!).toMatchObject({
      status: "skipped",
      skipReason: `Superseded by ${successfulReplacement}.`,
      wait: null,
    });
  });
});
