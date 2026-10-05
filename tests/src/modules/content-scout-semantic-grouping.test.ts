import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import { openRuns } from "../../../apps/server/src/runs";
import type { OpportunityRanker } from "../../../apps/server/src/modules/content-scout/ports";
import type { SourceAdapter } from "../../../apps/server/src/source-adapters/source-adapter";
import type { RankedOpportunity, SourceItem } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-25T12:00:00.000Z");

function item(id: string, title: string, url: string, storyKey?: string): SourceItem {
  return {
    id,
    externalId: id,
    targetId: "placeholder",
    adapterId: "rss",
    canonicalUrl: url,
    author: "Author",
    title,
    body: "The published rule gives teams a concrete interoperability deadline and implementation detail.",
    description: null,
    publishedAt: "2026-08-25T10:00:00.000Z",
    discoveredAt: NOW.toISOString(),
    media: [],
    transcript: null,
    comments: [],
    evidence: [{ route: url, retrievedAt: NOW.toISOString() }],
    completeness: {
      title: "available",
      body: "available",
      description: "unavailable",
      transcript: "unsupported",
      comments: "unsupported",
      media: "unavailable",
    },
    ...(storyKey ? { storyKey } : {}),
  };
}

function feedAdapter(items: SourceItem[]): SourceAdapter {
  return {
    id: "rss",
    state: "available",
    version: "fixture-1",
    supports: (target) => target.adapterId === "rss",
    async collect({ target }) {
      return {
        kind: "completed" as const,
        outcome: "items_found" as const,
        checkpoint: "rss-checkpoint",
        items: items.map((entry) => ({ ...entry, targetId: target.id })),
        diagnostic: {
          classification: "items_found" as const,
          route: "fixture:rss",
          status: 200,
          contentType: "application/rss+xml",
          parserStage: "rss_parse" as const,
          responseHash: "rss-hash",
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

function perItemRanker(): OpportunityRanker {
  return {
    async rank({ items }) {
      return items.map((entry): RankedOpportunity => ({
        id: `opportunity-${entry.id}`,
        canonicalKey: entry.id,
        title: entry.title ?? "Untitled",
        angle: "practical_implication",
        angleDescription: "Explain the story.",
        materialDevelopment: null,
        urgency: "Now.",
        explanation: "Matches brand.",
        sourceItemIds: [entry.id],
        sourceUrls: [entry.canonicalUrl],
        experimentalEvidence: false,
        confidence: 0.9,
        scores: {
          brandRelevance: 0.9,
          audienceUsefulness: 0.9,
          timeliness: 0.9,
          novelty: 0.9,
          evidenceStrength: 0.9,
          evidenceDiversity: 0.5,
          specificity: 0.9,
          originalPerspective: 0.7,
          packApplicability: 0.8,
          speculationRisk: 0.1,
        },
      }));
    },
  };
}

const SAME_VERDICT = { same: 0.95, different: 0.03, ambiguous: 0.02 };
const DIFFERENT_VERDICT = { same: 0.05, different: 0.9, ambiguous: 0.05 };

const ATLAS_A = item(
  "rss:atlas-a",
  "Example Labs launches Atlas data platform",
  "https://wire.example/atlas-a",
);
const ATLAS_B = item(
  "rss:atlas-b",
  "Atlas is live: Example Labs opens its data platform",
  "https://wire.example/atlas-b",
);
const BEACON = item(
  "rss:beacon",
  "Example Labs launches Beacon data platform",
  "https://wire.example/beacon",
);

describe("Semantic story grouping (#502)", () => {
  it("groups two reports of one launch and keeps a different launch separate", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-grouping-basic-"));
    const runs = openRuns(workspaceDir);
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [feedAdapter([ATLAS_A, ATLAS_B, BEACON])],
      ranker: perItemRanker(),
      storyPairJudger: async ({ left, right }) =>
        [left.id, right.id].every((id) => id.startsWith("rss:atlas"))
          ? SAME_VERDICT
          : DIFFERENT_VERDICT,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Wire", url: "https://wire.example/feed" });
    const runId = await host.scoutNow();
    await host.idle();

    const groups = JSON.parse(runs.open(runId)!.readArtifact("eligibility.json")!) as {
      storyGroups: { canonicalKey: string; sourceItemIds: string[] }[];
    };
    expect(groups.storyGroups).toHaveLength(2);
    const atlas = groups.storyGroups.find((group) => group.sourceItemIds.includes("rss:atlas-a"))!;
    expect([...atlas.sourceItemIds].sort()).toEqual(["rss:atlas-a", "rss:atlas-b"]);
    expect(
      groups.storyGroups.find((group) => group.sourceItemIds.includes("rss:beacon"))!.sourceItemIds,
    ).toEqual(["rss:beacon"]);

    const audit = JSON.parse(runs.open(runId)!.readArtifact("story-grouping.json")!) as {
      pairsEvaluated: number;
      questionRevision: number;
      pairs: { left: string; right: string; merged: boolean; verdict: { same: number } | null }[];
    };
    expect(audit.pairsEvaluated).toBe(3);
    expect(audit.questionRevision).toBe(2);
    const atlasPair = audit.pairs.find(
      (pair) => pair.left === "rss:atlas-a" && pair.right === "rss:atlas-b",
    )!;
    expect(atlasPair.merged).toBe(true);
    expect(atlasPair.verdict!.same).toBe(0.95);
  });

  it("keeps ambiguous and failed pairs unmerged and the Run usable", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-grouping-failure-"));
    const runs = openRuns(workspaceDir);
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [feedAdapter([ATLAS_A, ATLAS_B])],
      ranker: perItemRanker(),
      storyPairJudger: async () => null,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Wire", url: "https://wire.example/feed" });
    const runId = await host.scoutNow();
    await host.idle();

    expect(runs.detail(runId)!.status).toBe("blocked");
    const groups = JSON.parse(runs.open(runId)!.readArtifact("eligibility.json")!) as {
      storyGroups: { sourceItemIds: string[] }[];
    };
    expect(groups.storyGroups.map((group) => group.sourceItemIds.sort())).toEqual([
      ["rss:atlas-a"],
      ["rss:atlas-b"],
    ]);
    const audit = JSON.parse(runs.open(runId)!.readArtifact("story-grouping.json")!) as {
      judgerFailures: number;
      pairsEvaluated: number;
    };
    expect(audit.judgerFailures).toBe(1);
    expect(audit.pairsEvaluated).toBe(1);
  });

  it("groups by exact adapter storyKey without any semantic call", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-grouping-keyed-"));
    const runs = openRuns(workspaceDir);
    let calls = 0;
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [
        feedAdapter([
          item("rss:keyed-1", "First keyed report", "https://wire.example/keyed-1", "shared-key"),
          item("rss:keyed-2", "Second keyed report", "https://wire.example/keyed-2", "shared-key"),
          item("rss:free", "An unkeyed report", "https://wire.example/free"),
        ]),
      ],
      ranker: perItemRanker(),
      storyPairJudger: async () => {
        calls += 1;
        return SAME_VERDICT;
      },
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Wire", url: "https://wire.example/feed" });
    const runId = await host.scoutNow();
    await host.idle();

    const groups = JSON.parse(runs.open(runId)!.readArtifact("eligibility.json")!) as {
      storyGroups: { sourceItemIds: string[] }[];
    };
    const keyed = groups.storyGroups.find((group) => group.sourceItemIds.includes("rss:keyed-1"))!;
    expect([...keyed.sourceItemIds].sort()).toEqual(["rss:keyed-1", "rss:keyed-2"]);
    /* Only the unkeyed singleton's non-existent pairs: one unkeyed item means
       zero candidate pairs, so the judger is never called. */
    expect(calls).toBe(0);
  });

  it("produces identical group keys regardless of collection order", async () => {
    const collect = async (items: SourceItem[]) => {
      const workspaceDir = mkdtempSync(join(tmpdir(), "cos-grouping-order-"));
      const runs = openRuns(workspaceDir);
      const host = new ContentScoutHost({
        runs,
        workspaceDir,
        now: () => NOW,
        adapters: [feedAdapter(items)],
        ranker: perItemRanker(),
        storyPairJudger: async ({ left, right }) =>
          [left.id, right.id].every((id) => id.startsWith("rss:atlas"))
            ? SAME_VERDICT
            : DIFFERENT_VERDICT,
        log: () => undefined,
      });
      host.acceptBrandProfile({
        markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
        sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
      });
      host.addSourceTarget({ adapterId: "rss", label: "Wire", url: "https://wire.example/feed" });
      const runId = await host.scoutNow();
      await host.idle();
      const groups = JSON.parse(runs.open(runId)!.readArtifact("eligibility.json")!) as {
        storyGroups: { canonicalKey: string; sourceItemIds: string[] }[];
      };
      return groups.storyGroups
        .map((group) => ({
          key: group.canonicalKey,
          members: [...group.sourceItemIds].sort(),
        }))
        .sort((left, right) => left.members.join("|").localeCompare(right.members.join("|")));
    };

    const forward = await collect([ATLAS_A, ATLAS_B, BEACON]);
    const shuffled = await collect([BEACON, ATLAS_B, ATLAS_A]);
    expect(shuffled).toEqual(forward);
  });
});
