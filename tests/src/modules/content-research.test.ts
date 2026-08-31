import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { ContentResearchHost } from "../../../apps/server/src/modules/content-research/host";
import { ContentResearchStore } from "../../../apps/server/src/modules/content-research/store";
import {
  CONTENT_RESEARCH_BACKFILL_INTAKE,
  CONTENT_RESEARCH_DISCOVERY_INTAKE,
  CONTENT_RESEARCH_INTAKE,
  contentResearchBackfillModule,
  contentResearchModule,
  peopleDiscoveryModule,
} from "../../../apps/server/src/modules/content-research/module";
import { CONTENT_RESEARCH_MODULE_ID } from "@chief-of-staff-demo/shared";
import type { RecoveryState } from "../../../apps/server/src/engine/module";
import type { RunMeta } from "@chief-of-staff-demo/shared";
import type { PeopleDiscoverer } from "../../../apps/server/src/modules/content-research/ports";
import {
  feedsDeclaredIn,
  type FeedDiscoverer,
} from "../../../apps/server/src/source-adapters/feeds";
import { openRuns } from "../../../apps/server/src/runs";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../../apps/server/src/source-adapters/source-adapter";
import type { SourceItem } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-30T08:00:00.000Z");

/* A clock the test moves, so 48h checkpoints and backfill windows are deterministic. */
let current = new Date(NOW);
const now = (): Date => new Date(current);

function makeItem(input: {
  url: string;
  title: string;
  adapterId: string;
  publishedAt?: string;
  counts?: { views?: number; hnPoints?: number; redditScore?: number };
}): SourceItem {
  return {
    id: `item_${input.url}`,
    externalId: input.url,
    targetId: "fixture-target",
    adapterId: input.adapterId,
    canonicalUrl: input.url,
    author: "Fixture Author",
    title: input.title,
    body: `Body of ${input.title}`,
    description: null,
    publishedAt: input.publishedAt ?? "2026-08-29T10:00:00.000Z",
    discoveredAt: now().toISOString(),
    media: [],
    transcript: null,
    comments: [],
    evidence: [{ route: `fixture:${input.adapterId}`, retrievedAt: now().toISOString() }],
    completeness: {
      title: "available",
      body: "available",
      description: "unavailable",
      transcript: "unavailable",
      comments: "unavailable",
      media: "unavailable",
    },
    /* Engagement rides the shared SourceItem contract, exactly as the RSS,
       YouTube, Reddit and HN adapters report it — an item without counts is a
       platform that publishes none. */
    ...(input.counts ? { engagement: input.counts } : {}),
  };
}

type RecordedCall = {
  targetId: string;
  since: string;
  until: string;
  checkpoint: string | null;
  conditional: { etag: string | null; lastModified: string | null } | null;
};

function makeAdapter(input: {
  id: string;
  itemsFor: (personId: string) => SourceItem[];
  backfillWindowsDays?: readonly (7 | 30 | 90)[];
  failWith?: SourceCollectionResult;
}): SourceAdapter & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    id: input.id,
    state: "available",
    version: "fixture-1",
    ...(input.backfillWindowsDays ? { backfillWindowsDays: input.backfillWindowsDays } : {}),
    calls,
    supports: (target) => target.adapterId === input.id,
    async collect({ target, since, until, checkpoint, conditional }) {
      calls.push({
        targetId: target.id,
        since,
        until,
        checkpoint: checkpoint ?? null,
        conditional: conditional ?? null,
      });
      if (input.failWith) return input.failWith;
      const personId = target.id.split("__")[0] ?? "";
      const items = input.itemsFor(personId);
      return {
        kind: "completed",
        outcome: items.length > 0 ? "items_found" : "legitimate_empty",
        checkpoint: until,
        conditional: { etag: `W/"${input.id}-etag"`, lastModified: null },
        items,
        diagnostic: {
          classification: items.length > 0 ? "items_found" : "legitimate_empty",
          route: `fixture:${input.id}`,
          status: 200,
          contentType: "application/json",
          parserStage: "adapter_boundary",
          responseHash: "fixture-hash",
          adapterVersion: "fixture-1",
          startedAt: now().toISOString(),
          finishedAt: now().toISOString(),
          retries: 0,
          affectedCapabilities: [],
          causeChain: [],
        },
      };
    },
  };
}

function rateLimitedResult(): SourceCollectionResult {
  return {
    kind: "failed",
    outcome: "rate_limit",
    items: [],
    checkpoint: null,
    diagnostic: {
      classification: "rate_limit",
      route: "fixture:reddit",
      status: 429,
      contentType: null,
      parserStage: "fetch",
      responseHash: "",
      adapterVersion: "fixture-1",
      startedAt: now().toISOString(),
      finishedAt: now().toISOString(),
      retries: 0,
      affectedCapabilities: [],
      causeChain: ["HTTP 429"],
    },
  };
}

function makeHookExtractor() {
  const calls: { personName: string; titles: (string | null)[] }[] = [];
  return {
    calls,
    async extract(input: { personName: string; items: { title: string | null }[] }) {
      calls.push({ personName: input.personName, titles: input.items.map((i) => i.title) });
      return { hook: `why ${input.personName} landed`, evidenceQuote: "a verbatim line" };
    },
  };
}

/**
 * A Sheet that actually remembers what was written, because the ledger upsert is
 * a read-then-write: a retry has to see the rows the first attempt left behind
 * before we can claim it creates only what is missing.
 */
function makeSheets() {
  const appended: (string | number)[][][] = [];
  const updated: { rowNumber: number; values: (string | number)[] }[] = [];
  const tabs: string[] = [];
  const rows = new Map<string, (string | number)[][]>();
  let created = 0;
  return {
    appended,
    updated,
    tabs,
    rowsIn: (tab: string) => rows.get(tab) ?? [],
    createdCount: () => created,
    factory: () => ({
      ok: true as const,
      client: {
        createSpreadsheet: async () => {
          created += 1;
          return { id: `sheet-${created}`, url: `https://sheets.example/sheet-${created}` };
        },
        ensureTab: async (_id: string, title: string, header: string[]) => {
          tabs.push(title);
          if (!rows.has(title)) rows.set(title, [header]);
        },
        readRows: async (_id: string, tab: string) => rows.get(tab) ?? null,
        appendRows: async (_id: string, tab: string, newRows: (string | number)[][]) => {
          appended.push(newRows);
          rows.set(tab, [...(rows.get(tab) ?? []), ...newRows]);
        },
        updateRow: async (
          _id: string,
          tab: string,
          rowNumber: number,
          values: (string | number)[],
        ) => {
          updated.push({ rowNumber, values });
          const existing = [...(rows.get(tab) ?? [])];
          existing[rowNumber - 1] = values;
          rows.set(tab, existing);
        },
        isMissing: () => false,
      },
      spreadsheet: null,
    }),
  };
}

function makeGmail(options: { failFirst?: number } = {}) {
  const drafts: { to: string; subject: string; body: string }[] = [];
  let attempts = 0;
  return {
    drafts,
    factory: () => ({
      ok: true as const,
      client: {
        createDraft: async (draft: { to: string; subject: string; body: string }) => {
          attempts += 1;
          if (options.failFirst !== undefined && attempts <= options.failFirst) {
            throw new Error("gmail temporarily unavailable");
          }
          drafts.push(draft);
          return `draft-${attempts}`;
        },
      },
    }),
  };
}

interface HarnessOptions {
  adapters: (SourceAdapter & { calls?: RecordedCall[] })[];
  hookExtractor?: ReturnType<typeof makeHookExtractor>;
  discoverer?: PeopleDiscoverer;
  sheets?: ReturnType<typeof makeSheets>;
  gmail?: ReturnType<typeof makeGmail>;
  discoverFeeds?: FeedDiscoverer;
  searchPublic?: (query: string) => Promise<{ title: string; url: string; snippet: string }[]>;
}

function makeHarness(options: HarnessOptions) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-research-"));
  const runs = openRuns(workspaceDir);
  const hookExtractor = options.hookExtractor ?? makeHookExtractor();
  const sheets = options.sheets ?? makeSheets();
  const gmail = options.gmail ?? makeGmail();
  const host = new ContentResearchHost({
    runs,
    workspaceDir,
    adapters: options.adapters,
    hookExtractor,
    ...(options.discoverer ? { discoverer: options.discoverer } : {}),
    discoverFeeds: options.discoverFeeds ?? (async () => []),
    searchPublic: options.searchPublic ?? (async () => []),
    sheetsFactory: sheets.factory,
    gmailFactory: gmail.factory,
    getOwnerEmail: () => "owner@example.com",
    now,
    log: () => {},
    sleep: () => Promise.resolve(),
  });
  return { workspaceDir, runs, host, hookExtractor, sheets, gmail };
}

interface RunResultShape {
  reports: {
    personId: string;
    personName: string;
    items: {
      canonicalUrl: string;
      platform: string;
      resonanceScore: number;
      resonanceBasis: string;
      weightedCount: number;
    }[];
  }[];
  adapters: { adapterId: string; outcome: string; errorClassifications: string[] }[];
  ledgerRows: { personId: string; canonicalUrl: string; platform: string }[];
}

function readResult(runs: ReturnType<typeof openRuns>, runId: string): RunResultShape {
  return JSON.parse(runs.open(runId)?.readArtifact("result.json") ?? "{}") as RunResultShape;
}

describe("Content Research", () => {
  it("daily run: per-person reports, global dedup with per-person attribution, ledger rows, owner draft", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const hn = makeAdapter({ id: "hn", itemsFor: () => [], backfillWindowsDays: [7, 30, 90] });
    const { workspaceDir, runs, host, gmail } = makeHarness({ adapters: [rss, hn] });

    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    const ava = host.addPerson({
      name: "Ava",
      handleHints: { blogRssHints: ["https://ava.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://example.com/co-authored",
        title: "Co-authored post",
        adapterId: "rss",
        counts: { views: 50 },
      }),
    ]);
    perPerson.set(ava.id, [
      makeItem({
        url: "https://example.com/co-authored",
        title: "Co-authored post",
        adapterId: "rss",
        counts: { views: 90 },
      }),
      makeItem({
        url: "https://ava.example/own",
        title: "Ava alone",
        adapterId: "rss",
        counts: { views: 5 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    expect(runs.open(runId)?.read().status).toBe("done");
    const result = readResult(runs, runId);
    expect(result.reports).toHaveLength(2);
    const benReport = result.reports.find((r) => r.personId === ben.id);
    const avaReport = result.reports.find((r) => r.personId === ava.id);
    // The co-authored URL is attributed to both people…
    expect(benReport?.items.map((i) => i.canonicalUrl)).toContain(
      "https://example.com/co-authored",
    );
    expect(avaReport?.items.map((i) => i.canonicalUrl)).toContain(
      "https://example.com/co-authored",
    );
    // …but stored once globally.
    expect(readdirSync(join(workspaceDir, "content-research", "items"))).toHaveLength(2);

    // The ledger keeps one row per (person, canonicalUrl) — both rows for the shared post.
    const coAuthoredRows = result.ledgerRows.filter(
      (r) => r.canonicalUrl === "https://example.com/co-authored",
    );
    expect(coAuthoredRows.map((r) => r.personId).sort()).toEqual([ava.id, ben.id].sort());
    // One owner-only draft digest was created.
    expect(gmail.drafts).toHaveLength(1);
    expect(gmail.drafts[0]?.to).toBe("owner@example.com");
  });

  it("daily run: the next Run asks conditionally with what the last one was told", async () => {
    /* Source Targets are re-derived from a Person's hints every Run, so the
       validators have to be remembered against the URL or every fetch is
       unconditional (spec #116 story 8). */
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host } = makeHarness({ adapters: [rss] });
    host.addPerson({
      name: "Ada",
      handleHints: { blogRssHints: ["https://ada.example/feed"] },
    });

    await host.researchNow();
    await host.idle();
    const first = rss.calls.find((c) => c.targetId.endsWith("__0"));
    expect(first?.conditional).toBeNull();
    expect(first?.checkpoint).toBeNull();

    rss.calls.length = 0;
    await host.researchNow();
    await host.idle();
    const second = rss.calls.find((c) => c.targetId.endsWith("__0"));
    expect(second?.conditional).toEqual({ etag: 'W/"rss-etag"', lastModified: null });
    expect(second?.checkpoint).not.toBeNull();
  });

  it("daily run: a URL reaching two people by different adapters keeps each person's own platform", async () => {
    /* Dedup is global on canonicalUrl, so the shared post is stored once — but
       Ben found it on his feed and Ava on her channel, and labelling Ava's copy
       "rss" because Ben was seen first would misreport where it resonated. */
    const shared = {
      url: "https://example.com/shared",
      title: "Shared post",
      counts: { views: 100 },
    };
    const rss = makeAdapter({
      id: "rss",
      itemsFor: (pid) => (pid === benId ? [makeItem({ ...shared, adapterId: "rss" })] : []),
    });
    const youtube = makeAdapter({
      id: "youtube",
      itemsFor: (pid) => (pid === avaId ? [makeItem({ ...shared, adapterId: "youtube" })] : []),
    });
    const { runs, host } = makeHarness({ adapters: [rss, youtube] });

    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    const ava = host.addPerson({
      name: "Ava",
      handleHints: { blogRssHints: [], youtubeChannelId: "UC_ava" },
    });
    const benId = ben.id;
    const avaId = ava.id;

    const runId = await host.researchNow();
    await host.idle();

    const result = readResult(runs, runId);
    const platformFor = (personId: string) =>
      result.reports
        .find((r) => r.personId === personId)
        ?.items.find((i) => i.canonicalUrl === shared.url)?.platform;

    expect(platformFor(benId)).toBe("rss");
    expect(platformFor(avaId)).toBe("youtube");
  });

  it("daily run: hook extraction is one call per person and never sees the other person's items", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const hooks = makeHookExtractor();
    const { runs, host, hookExtractor } = makeHarness({ adapters: [rss], hookExtractor: hooks });

    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    const ava = host.addPerson({
      name: "Ava",
      handleHints: { blogRssHints: ["https://ava.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({ url: "https://ben.example/post", title: "Ben's post", adapterId: "rss" }),
    ]);
    perPerson.set(ava.id, [
      makeItem({ url: "https://ava.example/post", title: "Ava's post", adapterId: "rss" }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    expect(runs.open(runId)?.read().status).toBe("done");
    expect(hookExtractor.calls).toHaveLength(2);
    expect(hookExtractor.calls.find((c) => c.personName === "Ben")?.titles).toEqual(["Ben's post"]);
    expect(hookExtractor.calls.find((c) => c.personName === "Ava")?.titles).toEqual(["Ava's post"]);
  });

  it("48h overlap checkpoint advances: the second daily run looks back from the checkpoint, not another 7 days", async () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { runs, host } = makeHarness({ adapters: [rss] });
    host.addPerson({ name: "Ben", handleHints: { blogRssHints: ["https://ben.example/feed"] } });

    const first = await host.researchNow();
    await host.idle();
    expect(runs.open(first)?.read().status).toBe("done");
    // The first run scans the prior 7 days.
    expect(rss.calls[0]?.since).toBe(
      new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(host.getDailyCheckpoint()).toBe(NOW.toISOString());

    current = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const second = await host.researchNow();
    await host.idle();
    expect(runs.open(second)?.read().status).toBe("done");
    // The second run: checkpoint minus the 48h overlap.
    expect(rss.calls.at(-1)?.since).toBe(
      new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("backfill: an unsupported window fails explicitly; a supported window passes a genuine historical since", async () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [], backfillWindowsDays: [7] });
    const { runs, host } = makeHarness({ adapters: [rss] });
    host.addPerson({ name: "Ben", handleHints: { blogRssHints: ["https://ben.example/feed"] } });

    const refused = await host.backfillNow(30);
    await host.idle();
    expect(runs.open(refused)?.read().status).toBe("failed");
    expect(runs.open(refused)?.read().failureHint).toContain("backfill");

    const ok = await host.backfillNow(7);
    await host.idle();
    expect(runs.open(ok)?.read().status).toBe("done");
    expect(rss.calls.at(-1)?.since).toBe(
      new Date(current.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("one adapter rate-limited: the Run still completes and the other platform's evidence survives", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const sick = makeAdapter({ id: "reddit", itemsFor: () => [], failWith: rateLimitedResult() });
    const { runs, host } = makeHarness({ adapters: [rss, sick] });
    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({ url: "https://ben.example/post", title: "Ben's post", adapterId: "rss" }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    expect(runs.open(runId)?.read().status).toBe("done");
    const result = readResult(runs, runId);
    expect(result.reports[0]?.items.map((i) => i.canonicalUrl)).toEqual([
      "https://ben.example/post",
    ]);
    const reddit = result.adapters.find((a) => a.adapterId === "reddit");
    expect(reddit?.outcome).toBe("rate_limit");
    expect(reddit?.errorClassifications).toContain("rate_limit");
  });

  it("velocity: with a 90-day baseline the score is a z-score against the person, not the raw count", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { workspaceDir, runs, host } = makeHarness({ adapters: [rss] });
    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/spike",
        title: "Ben's spike",
        adapterId: "rss",
        counts: { views: 105 },
      }),
    ]);
    // The person's 90-day baseline: quiet days around 100 views.
    new ContentResearchStore(workspaceDir, now).recordBaseline(ben.id, [100, 102]);

    const runId = await host.researchNow();
    await host.idle();

    const result = readResult(runs, runId);
    const scored = result.reports[0]?.items[0];
    expect(scored).toBeDefined();
    expect(scored.weightedCount).toBe(105);
    // mean 101, sample stdDev sqrt(2): a spike above the person, not a big raw number.
    expect(scored.resonanceScore).toBeCloseTo((105 - 101) / Math.SQRT2, 5);
  });

  it("resonance ranking orders each person's report by score", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host } = makeHarness({ adapters: [rss] });
    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/low",
        title: "Low",
        adapterId: "rss",
        counts: { views: 3 },
      }),
      makeItem({
        url: "https://ben.example/high",
        title: "High",
        adapterId: "rss",
        counts: { views: 300 },
      }),
      makeItem({
        url: "https://ben.example/mid",
        title: "Mid",
        adapterId: "rss",
        counts: { views: 30 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    const result = readResult(runs, runId);
    const scores = result.reports[0]?.items.map((i) => i.resonanceScore) ?? [];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(result.reports[0]?.items[0]?.canonicalUrl).toBe("https://ben.example/high");
  });

  it("local report survives a Google partial failure; the retry creates only what is missing", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const sheets = makeSheets();
    const gmail = makeGmail({ failFirst: 1 });
    const { runs, host } = makeHarness({ adapters: [rss], sheets, gmail });
    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/post",
        title: "Ben's post",
        adapterId: "rss",
        counts: { views: 10 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    // The first attempt failed at Gmail — but the local report is already readable.
    expect(runs.open(runId)?.read().status).toBe("failed");
    const partial = readResult(runs, runId);
    expect(partial.reports).toHaveLength(1);
    expect(partial.ledgerRows).toHaveLength(1);

    await host.retryRun(runId);
    await host.idle();

    expect(runs.open(runId)?.read().status).toBe("done");
    // The Sheet rows went up exactly once across both attempts; the draft only on the retry.
    expect(sheets.appended).toHaveLength(1);
    expect(gmail.drafts).toHaveLength(1);
    expect(gmail.drafts[0]?.to).toBe("owner@example.com");
  });

  it("a Home notification fires when at least one person has new resonance", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host } = makeHarness({ adapters: [rss] });
    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/post",
        title: "Ben's post",
        adapterId: "rss",
        counts: { views: 10 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    const events = runs.detail(runId)?.events ?? [];
    const notification = events.find((e) => e.type === "home_notification");
    expect(String(notification?.detail?.message)).toContain("Ben");
  });

  it("people discovery: public search for co-mentions reaches the proposer, and a sick search still runs", async () => {
    /* Story 21 sources candidates from co-mentions found by public search, not
       from what the model happens to recall. */
    const queries: string[] = [];
    let seen: { title: string; url: string; snippet: string }[] = [];
    const discoverer: PeopleDiscoverer = {
      discover: async (input) => {
        seen = input.searchResults;
        return [];
      },
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host } = makeHarness({
      adapters: [rss],
      discoverer,
      searchPublic: async (query) => {
        queries.push(query);
        return [{ title: "Ada and Grace", url: "https://example.com/a", snippet: "co-mention" }];
      },
    });
    host.addPerson({ name: "Ada", handleHints: { blogRssHints: [] } });

    await host.discoverNow();
    await host.idle();

    expect(queries.some((q) => q.includes("Ada"))).toBe(true);
    expect(seen.map((r) => r.url)).toEqual(["https://example.com/a"]);

    // A search route that throws narrows the evidence rather than failing the Run.
    const sick = makeHarness({
      adapters: [makeAdapter({ id: "rss", itemsFor: () => [] })],
      discoverer,
      searchPublic: async () => {
        throw new Error("search unavailable");
      },
    });
    sick.host.addPerson({ name: "Ada", handleHints: { blogRssHints: [] } });
    const sickRunId = await sick.host.discoverNow();
    await sick.host.idle();
    expect(sick.runs.open(sickRunId)?.read().status).toBe("done");
  });

  it("people discovery: proposes, approves into a watched person, dismisses against re-suggestion, restores", async () => {
    const discoverer: PeopleDiscoverer = {
      discover: async (input) => {
        expect(input.approvedPeople.map((p) => p.name)).toContain("Ben");
        return [
          {
            name: "Grace Hopper",
            reason: "co-mentioned by Ben",
            supportingUrls: ["https://ben.example/post"],
            relationshipToBrand: "admired systems pioneer",
            source: "co-mention",
          },
        ];
      },
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { runs, host } = makeHarness({ adapters: [rss], discoverer });
    host.addPerson({ name: "Ben", handleHints: { blogRssHints: ["https://ben.example/feed"] } });

    const runId = await host.discoverNow();
    await host.idle();
    expect(runs.open(runId)?.read().status).toBe("done");

    const suggestions = host.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.state).toBe("pending");
    expect(suggestions[0]?.relationshipToBrand).toBe("admired systems pioneer");

    // Approve: the suggestion becomes a watched Named Person in one click.
    host.decideSuggestion(suggestions[0].id, "approved", null);
    expect(host.listPeople().map((p) => p.name)).toContain("Grace Hopper");

    // A second discovery run does not re-suggest someone already watched.
    const second = await host.discoverNow();
    await host.idle();
    expect(runs.open(second)?.read().status).toBe("done");
    expect(host.listSuggestions()).toHaveLength(1);
  });

  it("people discovery: a dismissed suggestion blocks re-suggestion while dismissed and restores afterwards", async () => {
    const name = { value: "Radia Perlman" };
    const discoverer: PeopleDiscoverer = {
      discover: async () => [
        {
          name: name.value,
          reason: "cited in collected items",
          supportingUrls: ["https://example.com/radia"],
          relationshipToBrand: "related pioneer",
          source: "co-mention",
        },
      ],
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host } = makeHarness({ adapters: [rss], discoverer });
    host.addPerson({ name: "Ben", handleHints: { blogRssHints: ["https://ben.example/feed"] } });

    await host.discoverNow();
    await host.idle();
    const pending = host.listSuggestions().find((s) => s.name === "Radia Perlman");
    expect(pending?.state).toBe("pending");
    host.decideSuggestion(pending!.id, "dismissed", "not relevant");

    // Re-proposed while dismissed: not saved again.
    await host.discoverNow();
    await host.idle();
    const afterDismiss = host.listSuggestions().filter((s) => s.name === "Radia Perlman");
    expect(afterDismiss).toHaveLength(1);
    expect(afterDismiss[0]?.state).toBe("dismissed");

    // Restoring makes the person eligible again.
    host.restoreSuggestion(afterDismiss[0].id);
    expect(host.listSuggestions().find((s) => s.name === "Radia Perlman")?.state).toBe("pending");
  });

  it("the cross-Run index groups reports by person, newest report first", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { host } = makeHarness({ adapters: [rss] });
    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/post",
        title: "Ben's post",
        adapterId: "rss",
        counts: { views: 10 },
      }),
    ]);

    await host.researchNow();
    await host.idle();
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
    await host.researchNow();
    await host.idle();

    const index = host.getIndex();
    expect(index.byPerson).toHaveLength(1);
    expect(index.byPerson[0]?.personName).toBe("Ben");
    expect(index.byPerson[0]?.reports).toHaveLength(2);
    expect(
      index.byPerson[0]?.reports[0].generatedAt >= index.byPerson[0].reports[1].generatedAt,
    ).toBe(true);
    expect(index.runs).toHaveLength(2);
  });

  it("target derivation watches a person by name on Reddit, HN, and Google News without any URL being pasted", async () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const reddit = makeAdapter({ id: "reddit", itemsFor: () => [] });
    const hn = makeAdapter({ id: "hn", itemsFor: () => [], backfillWindowsDays: [7, 30, 90] });
    const news = makeAdapter({ id: "news", itemsFor: () => [] });
    const { host } = makeHarness({ adapters: [rss, reddit, hn, news] });
    const ava = host.addPerson({ name: "Ava", handleHints: { blogRssHints: [] } });

    await host.researchNow();
    await host.idle();

    expect(reddit.calls.some((c) => c.targetId.startsWith(ava.id))).toBe(true);
    expect(hn.calls.some((c) => c.targetId.startsWith(ava.id))).toBe(true);
    expect(news.calls.some((c) => c.targetId.startsWith(ava.id))).toBe(true);
    // No RSS target exists without a hint — and none is invented.
    expect(rss.calls.filter((c) => c.targetId.startsWith(ava.id))).toHaveLength(0);
  });

  it("feed discovery reads the feeds a site declares about itself and ignores anything else", () => {
    const html = `
      <html><head>
        <link rel="alternate" type="application/rss+xml" title="Ben's blog" href="/feed.xml">
        <link rel="alternate" type="application/atom+xml" href="https://cdn.example/atom">
        <link rel="alternate" type="text/html" href="/amp">
        <link rel="stylesheet" type="application/rss+xml" href="/not-a-feed">
        <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      </head></html>`;
    expect(feedsDeclaredIn(html, "https://ben.example/")).toEqual([
      { url: "https://ben.example/feed.xml", title: "Ben's blog" },
      { url: "https://cdn.example/atom", title: null },
    ]);
  });

  it("adding a person resolves the feeds their site declares, and the daily run then collects them", async () => {
    const asked: string[] = [];
    const discoverFeeds: FeedDiscoverer = async (site) => {
      asked.push(site);
      return site === "https://ben.example/"
        ? [{ url: "https://ben.example/feed.xml", title: "Ben's blog" }]
        : [];
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host } = makeHarness({ adapters: [rss], discoverFeeds });

    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/some/post"] },
    });
    const resolved = await host.resolveSourceTargets(ben.id);

    expect(asked).toEqual(["https://ben.example/"]);
    expect(resolved.discoveredSourceTargets).toEqual([
      {
        adapterId: "rss",
        url: "https://ben.example/feed.xml",
        label: "Ben's blog",
      },
    ]);

    await host.researchNow();
    await host.idle();
    expect(rss.calls.some((call) => call.targetId.startsWith(ben.id))).toBe(true);
  });

  it("a site that cannot be reached leaves the person watched, without inventing a feed", async () => {
    const discoverFeeds: FeedDiscoverer = async () => {
      throw new Error("ENOTFOUND");
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host } = makeHarness({ adapters: [rss], discoverFeeds });
    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/"] },
    });

    const resolved = await host.resolveSourceTargets(ben.id);
    expect(resolved.discoveredSourceTargets).toEqual([]);
    expect(host.listPeople().map((p) => p.name)).toEqual(["Ben"]);
  });

  it("approving a suggestion watches the person's supporting sites and resolves their feeds in one step", async () => {
    const discoverFeeds: FeedDiscoverer = async (site) =>
      site === "https://grace.example/" ? [{ url: "https://grace.example/rss", title: null }] : [];
    const discoverer: PeopleDiscoverer = {
      discover: async () => [
        {
          name: "Grace Hopper",
          reason: "co-mentioned by Ben",
          supportingUrls: ["https://grace.example/posts/compilers"],
          relationshipToBrand: "admired systems pioneer",
          source: "co-mention",
        },
      ],
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host } = makeHarness({ adapters: [rss], discoverer, discoverFeeds });
    host.addPerson({ name: "Ben", handleHints: { blogRssHints: [] } });

    await host.discoverNow();
    await host.idle();
    const suggestion = host.listSuggestions()[0];
    host.decideSuggestion(suggestion.id, "approved", null);

    const grace = host.listPeople().find((p) => p.name === "Grace Hopper")!;
    // The supporting URL's site is watched straight away…
    expect(grace.discoveredSourceTargets).toEqual([
      { adapterId: "website", url: "https://grace.example/", label: "Grace Hopper website" },
    ]);
    // …and resolving adds the feed that site declares.
    const resolved = await host.resolveSourceTargets(grace.id);
    expect(resolved.discoveredSourceTargets.map((t) => `${t.adapterId} ${t.url}`)).toEqual([
      "website https://grace.example/",
      "rss https://grace.example/rss",
    ]);
  });

  it("counts a platform reports drive the ranking, and a platform reporting none does not outrank them", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const youtube = makeAdapter({ id: "youtube", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host } = makeHarness({ adapters: [rss, youtube] });
    const ben = host.addPerson({
      name: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"], youtubeChannelId: "UCben" },
    });
    perPerson.set(ben.id, [
      // An RSS post: Substack publishes no engagement counts at all.
      makeItem({ url: "https://ben.example/post", title: "Quiet post", adapterId: "rss" }),
      // A video YouTube reports real numbers for.
      makeItem({
        url: "https://www.youtube.com/watch?v=abc",
        title: "Busy video",
        adapterId: "youtube",
        counts: { views: 4000 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    const items = readResult(runs, runId).reports[0]?.items ?? [];
    expect(items[0]?.canonicalUrl).toBe("https://www.youtube.com/watch?v=abc");
    expect(items[0]?.weightedCount).toBe(4000);
    // The post with no reported counts scores zero rather than a made-up number.
    expect(items.find((i) => i.canonicalUrl === "https://ben.example/post")?.weightedCount).toBe(0);
  });
});

describe("Content Research recovery ownership", () => {
  /* The daily, backfill and discovery Runners share one Module id, so the
     Runner's module-scoped recovery scan hands the daily Module every Content
     Research Run. Adopting another Intake's Run re-collected every adapter
     under it and published a second time. planRecovery reads only the durable
     record, so the Module's collaborators are never reached. */
  const module = contentResearchModule(fromPartial({}));

  const runAwaitingRecovery = (intake: string) =>
    fromPartial<RecoveryState>({
      module: CONTENT_RESEARCH_MODULE_ID,
      intake,
      status: "running",
      files: [],
    });

  const failedRun = (intake: string) =>
    fromPartial<RunMeta>({
      module: CONTENT_RESEARCH_MODULE_ID,
      intake,
      status: "failed",
      failedStage: "collect",
      externalId: "backfill:90",
    });

  it("retries its own daily Run but never another Intake's Run", () => {
    /* retryRun asks each Runner in turn, so a Module that answers for an
       Intake it does not own re-runs a backfill as a daily Run — advancing the
       daily checkpoint and the 90-day baseline off a 90-day window. */
    expect(module.planRetry(failedRun(CONTENT_RESEARCH_INTAKE))).toMatchObject({
      fromStage: "collect",
    });
    expect(module.planRetry(failedRun(CONTENT_RESEARCH_DISCOVERY_INTAKE))).toBe(null);
    expect(module.planRetry(failedRun(CONTENT_RESEARCH_BACKFILL_INTAKE))).toBe(null);
  });

  it("each Intake's Module answers only for its own failed Runs", () => {
    const backfill = contentResearchBackfillModule(fromPartial({}));
    const discovery = peopleDiscoveryModule(fromPartial({}));

    expect(backfill.planRetry(failedRun(CONTENT_RESEARCH_BACKFILL_INTAKE))).toBeTruthy();
    expect(backfill.planRetry(failedRun(CONTENT_RESEARCH_INTAKE))).toBe(null);
    expect(backfill.planRetry(failedRun(CONTENT_RESEARCH_DISCOVERY_INTAKE))).toBe(null);

    expect(discovery.planRetry(failedRun(CONTENT_RESEARCH_DISCOVERY_INTAKE))).toBeTruthy();
    expect(discovery.planRetry(failedRun(CONTENT_RESEARCH_INTAKE))).toBe(null);
    expect(discovery.planRetry(failedRun(CONTENT_RESEARCH_BACKFILL_INTAKE))).toBe(null);
  });

  it("recovers its own daily Run but never another Intake's Run", () => {
    expect(module.planRecovery?.(runAwaitingRecovery(CONTENT_RESEARCH_INTAKE))).toMatchObject({
      fromStage: "collect",
    });
    expect(module.planRecovery?.(runAwaitingRecovery(CONTENT_RESEARCH_DISCOVERY_INTAKE))).toBe(
      null,
    );
    expect(module.planRecovery?.(runAwaitingRecovery(CONTENT_RESEARCH_BACKFILL_INTAKE))).toBe(null);
  });
});
