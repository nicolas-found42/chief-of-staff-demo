import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import type { ChannelRef } from "../../../apps/server/src/source-adapters/youtube-channels";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import { openRuns } from "../../../apps/server/src/runs";
import { ContentResearchHost } from "../../../apps/server/src/modules/content-research/host";
import { ConfigStore } from "../../../apps/server/src/config";
import { ModelBoundaryError } from "../../../apps/server/src/llm/failure";
import {
  YouTubeSourceAdapter,
  type YouTubeSourceClient,
} from "../../../apps/server/src/source-adapters/youtube";
import type { OpportunityRanker } from "../../../apps/server/src/modules/content-scout/ports";
import type { SourceAdapter } from "../../../apps/server/src/source-adapters/source-adapter";
import type { PersonProfileProjection } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const ranker: OpportunityRanker = { rank: async () => [] };

const originalOpenRouterEnvironment = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "";
});

afterEach(() => {
  if (originalOpenRouterEnvironment === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterEnvironment;
});

function availableAdapter(id: string, state: SourceAdapter["state"] = "available"): SourceAdapter {
  return {
    id,
    state,
    version: "fixture-1",
    supports: (target) => target.adapterId === id,
    async collect() {
      throw new Error("Collection is not expected by the setup projection test.");
    },
  };
}

function rejectedKeyDiagnostic(status: number, upstreamCode: number | null = null) {
  return new ModelBoundaryError({
    classification: "http_error",
    provider: "openrouter",
    model: "test-model",
    upstreamServer: "OpenRouter",
    upstreamCode,
    binding: "response_format",
    status,
    finishReason: null,
    bodyBytes: 128,
    topLevelKeys: ["error"],
    populatedFields: ["error"],
    emptyFields: [],
    timeoutMs: null,
    usage: null,
  });
}

describe("Content Engine setup and Brand Profile scan contracts", () => {
  it("publishes setup status from authoritative provider, Brand Voice, and Source Adapter state", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "content-engine-setup-"));
    const runs = openRuns(workspaceDir);
    const configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      configStore,
      adapters: [availableAdapter("rss")],
      ranker,
      log: () => undefined,
    });
    const app = Fastify();
    host.routes(app);

    const empty = (await app.inject({ method: "GET", url: "/api/content-scout" })).json<{
      setup: {
        providerConfigured: boolean;
        brandVoiceAccepted: boolean;
        sourceTargetCollectable: boolean;
        scoutReady: boolean;
        nextAction: { label: string; href: string };
      };
    }>();

    expect(empty.setup).toEqual({
      providerConfigured: false,
      brandVoiceAccepted: false,
      sourceTargetCollectable: false,
      scoutReady: false,
      nextAction: { label: "Open Guided Setup", href: "/onboarding?goal=meetings" },
    });

    process.env.OPENROUTER_API_KEY = "stored-not-validated";
    configStore.update({ provider: "openrouter" });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Voice\nDirect\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const archived = host.addSourceTarget({
      adapterId: "rss",
      label: "Archived feed",
      url: "https://company.example/feed.xml",
    });
    host.setSourceTargetState(archived.id, "archived");

    const partial = (await app.inject({ method: "GET", url: "/api/content-scout" })).json<{
      setup: {
        providerConfigured: boolean;
        brandVoiceAccepted: boolean;
        sourceTargetCollectable: boolean;
        scoutReady: boolean;
      };
    }>();
    expect(partial.setup).toMatchObject({
      providerConfigured: true,
      brandVoiceAccepted: true,
      sourceTargetCollectable: false,
      scoutReady: false,
    });

    const proposalOnlyWorkspace = mkdtempSync(join(tmpdir(), "content-engine-proposal-only-"));
    const proposalOnlyConfig = new ConfigStore(join(proposalOnlyWorkspace, "config.json"));
    proposalOnlyConfig.load();
    process.env.OPENROUTER_API_KEY = "stored-not-validated";
    proposalOnlyConfig.update({ provider: "openrouter" });
    const proposalOnlyHost = new ContentScoutHost({
      runs: openRuns(proposalOnlyWorkspace),
      workspaceDir: proposalOnlyWorkspace,
      configStore: proposalOnlyConfig,
      adapters: [availableAdapter("rss")],
      ranker,
      brandProfileCrawler: {
        async crawl(input) {
          return [
            {
              url: input.websiteUrl,
              title: "Company",
              depth: 0,
              included: true,
              exclusionReason: null,
              text: "Public company evidence.",
            },
          ];
        },
      },
      brandProfileProposer: {
        async propose() {
          return "# Brand Profile\n\n## Voice\nDirect\n";
        },
      },
      log: () => undefined,
    });
    await proposalOnlyHost.scanBrandProfile("https://company.example");
    await proposalOnlyHost.idle();
    const proposalOnlyApp = Fastify();
    proposalOnlyHost.routes(proposalOnlyApp);
    expect(
      (await proposalOnlyApp.inject({ method: "GET", url: "/api/content-scout" })).json<{
        setup: { brandVoiceAccepted: boolean; scoutReady: boolean };
      }>().setup,
    ).toMatchObject({ brandVoiceAccepted: false, scoutReady: false });
    await proposalOnlyApp.close();

    host.addSourceTarget({
      adapterId: "rss",
      label: "Active feed",
      url: "https://company.example/active.xml",
    });
    const complete = (await app.inject({ method: "GET", url: "/api/content-scout" })).json<{
      setup: { sourceTargetCollectable: boolean; scoutReady: boolean };
    }>();
    expect(complete.setup).toMatchObject({ sourceTargetCollectable: true, scoutReady: true });

    const experimentalWorkspace = mkdtempSync(join(tmpdir(), "content-engine-experimental-"));
    const experimental = availableAdapter("experimental-source", "experimental");
    const experimentalHost = new ContentScoutHost({
      runs: openRuns(experimentalWorkspace),
      workspaceDir: experimentalWorkspace,
      configStore,
      adapters: [experimental],
      ranker,
      log: () => undefined,
    });
    experimentalHost.addSourceTarget({
      adapterId: experimental.id,
      label: "Experimental only",
      url: "https://company.example/experimental",
    });
    const experimentalApp = Fastify();
    experimentalHost.routes(experimentalApp);
    expect(
      (await experimentalApp.inject({ method: "GET", url: "/api/content-scout" })).json<{
        setup: { sourceTargetCollectable: boolean; scoutReady: boolean };
      }>().setup,
    ).toMatchObject({ sourceTargetCollectable: false, scoutReady: false });
    await experimentalApp.close();

    const ollamaStore = new ConfigStore(join(workspaceDir, "ollama-config.json"));
    ollamaStore.load();
    ollamaStore.update({ provider: "ollama" });
    const ollamaHost = new ContentScoutHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      configStore: ollamaStore,
      adapters: [availableAdapter("rss")],
      ranker,
      log: () => undefined,
    });
    const ollamaApp = Fastify();
    ollamaHost.routes(ollamaApp);
    expect(
      (await ollamaApp.inject({ method: "GET", url: "/api/content-scout" })).json<{
        setup: { providerConfigured: boolean };
      }>().setup.providerConfigured,
    ).toBe(true);
    await ollamaApp.close();

    await app.close();
  });

  it("normalizes a bare Brand Profile domain to HTTPS before the public crawl", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "content-engine-domain-"));
    const runs = openRuns(workspaceDir);
    const crawled: string[] = [];
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      adapters: [availableAdapter("rss")],
      ranker,
      brandProfileCrawler: {
        async crawl(input) {
          crawled.push(input.websiteUrl);
          return [
            {
              url: input.websiteUrl,
              title: "Company",
              depth: 0,
              included: true,
              exclusionReason: null,
              text: "Public company evidence.",
            },
          ];
        },
      },
      brandProfileProposer: { propose: async () => "# Brand Profile\n\n## Voice\nDirect\n" },
      log: () => undefined,
    });
    const app = Fastify();
    app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      reply.code(error.statusCode ?? 500).send({ error: error.message });
    });
    host.routes(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/content-scout/brand-profile/scan",
      payload: { websiteUrl: "company.example" },
    });
    await host.idle();

    expect(response.statusCode).toBe(200);
    expect(crawled).toEqual(["https://company.example/"]);
    await app.close();
  });

  it("keeps credentialed and local Brand Profile hosts refused after bare-domain normalization", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "content-engine-domain-security-"));
    const runs = openRuns(workspaceDir);
    let crawls = 0;
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      adapters: [availableAdapter("rss")],
      ranker,
      brandProfileCrawler: {
        async crawl(input) {
          crawls += 1;
          return [
            {
              url: input.websiteUrl,
              title: "Company",
              depth: 0,
              included: true,
              exclusionReason: null,
              text: "Public company evidence.",
            },
          ];
        },
      },
      brandProfileProposer: { propose: async () => "# Brand Profile\n\n## Voice\nDirect\n" },
      log: () => undefined,
    });
    const app = Fastify();
    app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      reply.code(error.statusCode ?? 500).send({ error: error.message });
    });
    host.routes(app);

    for (const websiteUrl of [
      "ftp://company.example",
      "https://user:password@company.example",
      "http://localhost",
      "not a domain",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/content-scout/brand-profile/scan",
        payload: { websiteUrl },
      });
      expect(response.statusCode, websiteUrl).toBeGreaterThanOrEqual(400);
    }
    expect(crawls).toBe(0);
    expect(runs.list({ module: "content-scout" }).runs).toEqual([]);
    await app.close();
  });

  it("refuses a credential-less Brand Profile scan before creating a Run, crawling, or calling the provider", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "content-engine-no-key-"));
    const runs = openRuns(workspaceDir);
    const configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    let crawls = 0;
    let proposals = 0;
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      configStore,
      adapters: [availableAdapter("rss")],
      ranker,
      brandProfileCrawler: {
        async crawl(input) {
          crawls += 1;
          return [
            {
              url: input.websiteUrl,
              title: "Company",
              depth: 0,
              included: true,
              exclusionReason: null,
              text: "Public company evidence.",
            },
          ];
        },
      },
      brandProfileProposer: {
        async propose() {
          proposals += 1;
          return "# Brand Profile\n\n## Voice\nDirect\n";
        },
      },
      log: () => undefined,
    });
    const app = Fastify();
    app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      reply.code(error.statusCode ?? 500).send({ error: error.message });
    });
    host.routes(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/content-scout/brand-profile/scan",
      payload: { websiteUrl: "https://company.example" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "brand-profile-scan-disabled",
      readiness: {
        state: "setup-required",
        reason: "provider-not-configured",
        nextAction: {
          label: "Open Guided Setup",
          href: "/onboarding?goal=meetings",
        },
      },
    });
    expect(runs.list({ module: "content-scout" }).runs).toEqual([]);
    expect({ crawls, proposals }).toEqual({ crawls: 0, proposals: 0 });
    await app.close();
  });

  it.each([
    { label: "status", status: 401, upstreamCode: null },
    {
      label: "upstreamCode",
      status: 200,
      upstreamCode: 403,
    },
  ])(
    "names the rejected configured key from sanitized $label facts",
    async ({ status, upstreamCode }) => {
      const workspaceDir = mkdtempSync(join(tmpdir(), "content-engine-bad-key-"));
      const runs = openRuns(workspaceDir);
      const configStore = new ConfigStore(join(workspaceDir, "config.json"));
      configStore.load();
      process.env.OPENROUTER_API_KEY = "PRIVATE_REJECTED_KEY";
      configStore.update({ provider: "openrouter" });
      let proposals = 0;
      const host = new ContentScoutHost({
        runs,
        workspaceDir,
        configStore,
        adapters: [availableAdapter("rss")],
        ranker,
        brandProfileCrawler: {
          async crawl(input) {
            return [
              {
                url: input.websiteUrl,
                title: "Company",
                depth: 0,
                included: true,
                exclusionReason: null,
                text: "Public company evidence.",
              },
            ];
          },
        },
        brandProfileProposer: {
          async propose() {
            proposals += 1;
            throw rejectedKeyDiagnostic(status, upstreamCode);
          },
        },
        log: () => undefined,
      });

      const runId = await host.scanBrandProfile("https://company.example");
      await host.idle();
      const detail = runs.detail(runId)!;

      expect(detail).toMatchObject({ status: "failed", failedStage: "propose" });
      expect(detail.failureHint).toMatch(/configured .*API key.*Settings/i);
      expect(detail.failureHint).not.toMatch(/bounded Brand Profile scan failed/i);
      expect(proposals).toBe(1);
      const persisted = JSON.stringify(detail);
      expect(persisted).toContain("modelBoundary");
      expect(persisted).not.toContain("PRIVATE_REJECTED_KEY");
    },
  );
});

describe("Content Research setup action contracts", () => {
  it("refuses each blocked HTTP action before Run creation", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "content-research-http-setup-"));
    const runs = openRuns(workspaceDir);
    const host = new ContentResearchHost({
      runs,
      workspaceDir,
      adapters: [],
      profileProjection: () =>
        fromPartial<PersonProfileProjection>({
          purpose: "public-safe",
          profileId: "maya",
          profileRevision: 1,
          fullName: "Maya Chen",
        }),
      hookExtractor: { extract: async () => ({ hook: "unused", evidenceQuote: "unused" }) },
      discoverer: { discover: async () => [] },
      searchPublic: async () => [],
      readiness: (kind) => `${kind} setup is incomplete.`,
      log: () => undefined,
    });
    const app = Fastify();
    app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      reply.code(error.statusCode ?? 500).send({ error: error.message });
    });
    host.routes(app);

    for (const [url, payload] of [
      ["/api/content-research/run", undefined],
      ["/api/content-research/backfill", { windowDays: 30 }],
      ["/api/content-research/discover", undefined],
    ] as const) {
      const response = await app.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
      expect(response.statusCode).toBe(409);
    }
    expect(runs.list({ module: "content-research" }).runs).toEqual([]);
    await app.close();
  });

  it("feeds Content Research YouTube handles and URLs through the established adapter contract", async () => {
    const references: ChannelRef[] = [];
    const client: YouTubeSourceClient = {
      async resolveChannel(ref) {
        references.push(ref);
        return { id: "UC_found42", uploadsPlaylistId: "UU_found42" };
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const collect = (url: string) =>
      adapter.collect({
        target: {
          id: `target-${url}`,
          adapterId: "youtube",
          label: "Maya YouTube",
          url,
          state: "active",
          createdAt: NOW.toISOString(),
          archivedAt: null,
          checkpoint: null,
          lastSuccessfulAt: null,
          conditional: null,
        },
        since: "2026-09-17T12:00:00.000Z",
        until: NOW.toISOString(),
        checkpoint: null,
      });

    const [handle, url, id] = await Promise.all([
      collect("https://www.youtube.com/@found42"),
      collect("https://www.youtube.com/@found42/videos"),
      collect("https://www.youtube.com/channel/UC_found42"),
    ]);
    expect([handle.kind, url.kind, id.kind]).toEqual(["completed", "completed", "completed"]);
    expect(references).toEqual(
      expect.arrayContaining([
        { kind: "handle", value: "@found42" },
        { kind: "id", value: "UC_found42" },
      ]),
    );
  });
});
