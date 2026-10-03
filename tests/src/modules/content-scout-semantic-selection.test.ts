import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import { openRuns } from "../../../apps/server/src/runs";
import type { OpportunityRanker } from "../../../apps/server/src/modules/content-scout/ports";
import type { SourceAdapter } from "../../../apps/server/src/source-adapters/source-adapter";
import type {
  EnrichmentSelectionAudit,
  SelectionJudgment,
} from "../../../apps/server/src/modules/content-scout/selection-model";
import type { RankedOpportunity, SourceItem } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-25T12:00:00.000Z");

const SUBSTANTIVE = {
  id: "yt:substantive",
  title: "A detailed interoperability walkthrough with practical steps",
  body: "This video explains the rule, the deadline, and concrete implementation steps that teams can follow. It is long enough to support transcript work.",
};

/* Long enough that the deterministic selector would enrich it: the semantic
   promotion veto has to be what keeps it out. */
const PITCH = {
  id: "yt:pitch",
  title: "Join the operations automation community",
  body: "Are you ready to future-proof your career? Join thousands of operations professionals in the fastest-growing automation community. Our free weekly newsletter delivers curated insights, exclusive webinars, and a supportive network of peers. Sign up today and never miss an issue.",
};

function fixtureItem(seed: { id: string; title: string; body: string }): SourceItem {
  return {
    id: seed.id,
    externalId: seed.id.replace("yt:", ""),
    targetId: "target-1",
    adapterId: "youtube",
    canonicalUrl: `https://youtube.com/watch?v=${seed.id.replace("yt:", "")}`,
    author: "Channel A",
    title: seed.title,
    body: seed.body,
    description: null,
    publishedAt: "2026-08-25T10:00:00.000Z",
    discoveredAt: NOW.toISOString(),
    media: [{ type: "video", url: `https://youtube.com/watch?v=${seed.id.replace("yt:", "")}` }],
    transcript: null,
    comments: [],
    evidence: [{ route: "fixture:youtube", retrievedAt: NOW.toISOString() }],
    completeness: {
      title: "available",
      body: "available",
      description: "unavailable",
      transcript: "unavailable",
      comments: "unavailable",
      media: "available",
    },
  };
}

function selectionAdapter(items: SourceItem[], enrichLog: string[]): SourceAdapter {
  return {
    id: "youtube",
    state: "available",
    version: "fixture-1",
    supports: (target) => target.adapterId === "youtube",
    async collect({ target }) {
      return {
        kind: "completed" as const,
        outcome: "items_found" as const,
        checkpoint: "yt-checkpoint",
        items: items.map((item) => ({ ...item, targetId: target.id })),
        diagnostic: {
          classification: "items_found" as const,
          route: "fixture:youtube",
          status: 200,
          contentType: "application/json",
          parserStage: "youtube" as const,
          responseHash: "yt-response",
          adapterVersion: "fixture-1",
          startedAt: NOW.toISOString(),
          finishedAt: NOW.toISOString(),
          retries: 0,
          affectedCapabilities: [],
          causeChain: [],
        },
      };
    },
    async enrich(enriched) {
      for (const item of enriched) enrichLog.push(item.id);
      return enriched.map((item) => ({
        ...item,
        transcript: "Detailed transcript text.",
        completeness: { ...item.completeness, transcript: "available" as const },
      }));
    },
  };
}

function perItemRanker(received: string[]): OpportunityRanker {
  return {
    async rank({ items }) {
      received.push(...items.map((item) => item.id));
      return items.map((item): RankedOpportunity => ({
        id: `opportunity-${item.id}`,
        canonicalKey: item.id,
        title: item.title ?? "Untitled",
        angle: "practical_implication",
        angleDescription: "Explain the practical impact.",
        materialDevelopment: null,
        urgency: "Now.",
        explanation: "Matches brand.",
        sourceItemIds: [item.id],
        sourceUrls: [item.canonicalUrl],
        experimentalEvidence: false,
        confidence: 0.9,
        scores: {
          brandRelevance: 0.9,
          audienceUsefulness: 0.8,
          timeliness: 0.9,
          novelty: 0.7,
          evidenceStrength: 0.9,
          evidenceDiversity: 0.5,
          specificity: 0.8,
          originalPerspective: 0.7,
          packApplicability: 0.8,
          speculationRisk: 0.1,
        },
      }));
    },
  };
}

async function runIntake(input: {
  items: SourceItem[];
  judgments: Record<string, SelectionJudgment | null>;
}): Promise<{
  host: ContentScoutHost;
  runId: string;
  runs: ReturnType<typeof openRuns>;
  enrichLog: string[];
  ranked: string[];
  revisionId: string;
}> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-semantic-selection-"));
  const runs = openRuns(workspaceDir);
  const enrichLog: string[] = [];
  const ranked: string[] = [];
  const host = new ContentScoutHost({
    runs,
    workspaceDir,
    now: () => NOW,
    adapters: [selectionAdapter(input.items, enrichLog)],
    ranker: perItemRanker(ranked),
    selectionJudger: async ({ item }) => input.judgments[item.id] ?? null,
    log: () => undefined,
  });
  const revision = host.acceptBrandProfile({
    markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
    sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
  });
  host.addSourceTarget({
    adapterId: "youtube",
    label: "Fixture channel",
    url: "https://youtube.com/channel/fixture",
  });
  const runId = await host.scoutNow();
  await host.idle();
  return { host, runId, runs, enrichLog, ranked, revisionId: revision.id };
}

type RunHandle = NonNullable<ReturnType<ReturnType<typeof openRuns>["open"]>>;

function auditOf(run: RunHandle): EnrichmentSelectionAudit[] {
  return JSON.parse(run.readArtifact("enrichment-selection.json")!) as EnrichmentSelectionAudit[];
}

describe("Semantic enrichment selection (#503)", () => {
  it("judges each eligible item, enriches only the selected, and records the audit", async () => {
    const substantive = fixtureItem(SUBSTANTIVE);
    const pitch = fixtureItem(PITCH);
    const { runId, runs, enrichLog, ranked, revisionId } = await runIntake({
      items: [substantive, pitch],
      judgments: {
        "yt:substantive": { fit: 0.9, substance: 0.9, promotion: 0.05 },
        "yt:pitch": { fit: 0.85, substance: 0.2, promotion: 0.9 },
      },
    });

    expect(runs.detail(runId)!.status).toBe("blocked");
    expect(enrichLog).toEqual(["yt:substantive"]);

    const run = runs.open(runId)!;
    const audit = auditOf(run);
    expect(audit).toHaveLength(2);
    const byId = new Map(audit.map((record) => [record.sourceItemId, record]));
    expect(byId.get("yt:substantive")).toMatchObject({
      branch: "semantic",
      selected: true,
      reason: "semantic_judgment",
      questionRevision: 1,
      brandProfileRevisionId: revisionId,
      budgeted: true,
    });
    expect(byId.get("yt:pitch")).toMatchObject({
      branch: "semantic",
      selected: false,
      reason: "semantic_judgment",
    });
    expect(byId.get("yt:pitch")?.judgments).toEqual({ fit: 0.85, substance: 0.2, promotion: 0.9 });

    /* A skipped item keeps its place in ranking: only enrichment is withheld. */
    expect(ranked).toEqual(["yt:substantive", "yt:pitch"]);
    const promising = JSON.parse(run.readArtifact("promising-items.json")!) as { id: string }[];
    expect(promising.map((item) => item.id)).toEqual(["yt:substantive"]);
    const discarded = JSON.parse(run.readArtifact("discarded-items.json")!) as { id: string }[];
    expect(discarded.map((item) => item.id)).toEqual(["yt:pitch"]);
  });

  it("falls back to the deterministic selector on judger failure and records the reason", async () => {
    const substantive = fixtureItem(SUBSTANTIVE);
    const pitch = fixtureItem(PITCH);
    const { runId, runs, enrichLog } = await runIntake({
      items: [substantive, pitch],
      judgments: { "yt:substantive": null, "yt:pitch": null },
    });

    /* Both items clear the deterministic rules, so failure preserves the old
       behavior exactly while the Run stays usable. */
    expect(enrichLog).toEqual(["yt:substantive", "yt:pitch"]);
    const audit = auditOf(runs.open(runId)!);
    for (const record of audit) {
      expect(record).toMatchObject({
        branch: "fallback",
        selected: true,
        reason: "judger_failure",
        judgments: null,
      });
    }
  });

  it("sends borderline judgments to the deterministic fallback per item", async () => {
    const substantive = fixtureItem(SUBSTANTIVE);
    const pitch = fixtureItem(PITCH);
    const { runId, runs, enrichLog } = await runIntake({
      items: [substantive, pitch],
      judgments: {
        /* Exactly at the frozen cut: inside the borderline band. */
        "yt:substantive": { fit: 0.7, substance: 0.9, promotion: 0.05 },
        /* Strongly off-topic: decided semantically, not borderline. */
        "yt:pitch": { fit: 0.1, substance: 0.9, promotion: 0.05 },
      },
    });

    expect(enrichLog).toEqual(["yt:substantive"]);
    const audit = auditOf(runs.open(runId)!);
    const byId = new Map(audit.map((record) => [record.sourceItemId, record]));
    expect(byId.get("yt:substantive")).toMatchObject({
      branch: "fallback",
      reason: "borderline_judgment",
      selected: true,
    });
    expect(byId.get("yt:pitch")).toMatchObject({
      branch: "semantic",
      selected: false,
      reason: "semantic_judgment",
    });
  });

  it("stops semantic judgments at the per-Run budget and marks the remainder", async () => {
    const items = Array.from({ length: 61 }, (_, index) =>
      fixtureItem({
        id: `yt:bulk-${index}`,
        title: `Bulk fixture item ${index}`,
        body: "A fixture body with more than thirty words so the deterministic selector independently enriches it: this sentence padding exists to clear the word floor, the character floor, and the evidence floor without any semantic judgment helping the decision along.",
      }),
    );
    let calls = 0;
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-semantic-budget-"));
    const runs = openRuns(workspaceDir);
    const enrichLog: string[] = [];
    const ranked: string[] = [];
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [selectionAdapter(items, enrichLog)],
      ranker: perItemRanker(ranked),
      selectionJudger: async () => {
        calls += 1;
        return { fit: 0.9, substance: 0.9, promotion: 0.05 };
      },
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "youtube",
      label: "Fixture channel",
      url: "https://youtube.com/channel/fixture",
    });
    const runId = await host.scoutNow();
    await host.idle();

    expect(calls).toBe(60);
    const audit = auditOf(runs.open(runId)!);
    expect(audit).toHaveLength(61);
    const overBudget = audit.filter((record) => record.reason === "budget_exhausted");
    expect(overBudget).toHaveLength(1);
    expect(overBudget[0].budgeted).toBe(false);
    /* The over-budget item still took the deterministic path and stayed in ranking. */
    expect(overBudget[0].selected).toBe(true);
    expect(ranked).toHaveLength(61);
  });

  it("writes no audit artifact when no semantic judger is configured", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-semantic-absent-"));
    const runs = openRuns(workspaceDir);
    const enrichLog: string[] = [];
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [selectionAdapter([fixtureItem(SUBSTANTIVE)], enrichLog)],
      ranker: perItemRanker([]),
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "youtube",
      label: "Fixture channel",
      url: "https://youtube.com/channel/fixture",
    });
    const runId = await host.scoutNow();
    await host.idle();

    expect(enrichLog).toEqual(["yt:substantive"]);
    expect(runs.open(runId)!.readArtifact("enrichment-selection.json")).toBeNull();
  });
});
