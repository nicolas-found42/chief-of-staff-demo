import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  ContentScoutHost,
  type ContentScoutHostDeps,
} from "../../../apps/server/src/modules/content-scout/host";
import { ModelBoundaryError } from "../../../apps/server/src/llm/failure";
import { openRuns } from "../../../apps/server/src/runs";

const NOW = new Date("2026-09-23T12:00:00.000Z");

function scanHost(overrides: Partial<ContentScoutHostDeps>) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-brand-scan-readiness-"));
  const runs = openRuns(workspaceDir);
  const crawled: string[] = [];
  const host = new ContentScoutHost({
    runs,
    workspaceDir,
    now: () => NOW,
    adapters: [],
    ranker: { rank: async () => [] },
    brandProfileCrawler: {
      async crawl({ websiteUrl }) {
        crawled.push(websiteUrl);
        return [
          {
            url: websiteUrl,
            title: "Company",
            depth: 0,
            included: true,
            exclusionReason: null,
            text: "Practical educational company facts.",
          },
        ];
      },
    },
    log: () => undefined,
    ...overrides,
  });
  const app = Fastify();
  host.routes(app);
  return { host, runs, app, crawled };
}

describe("Brand Profile scan model readiness (#484)", () => {
  it("refuses a scan before any crawl or Run while the model provider is not set up", async () => {
    const { runs, app, crawled } = scanHost({
      modelReadiness: () => "Add a model provider key in Settings → Extraction provider.",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/content-scout/brand-profile/scan",
      payload: { websiteUrl: "https://company.example" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Add a model provider key in Settings → Extraction provider.",
    });
    expect(crawled).toEqual([]);
    expect(runs.list().runs).toEqual([]);
  });

  it("names the API key when the provider rejects the proposal call", async () => {
    const { host, runs } = scanHost({
      brandProfileProposer: {
        async propose() {
          throw new ModelBoundaryError({
            classification: "http_error",
            provider: "openrouter",
            model: "test-model",
            upstreamServer: null,
            upstreamCode: 401,
            binding: "response_format",
            status: 401,
            finishReason: null,
            bodyBytes: 64,
            topLevelKeys: ["error"],
            populatedFields: [],
            emptyFields: [],
            timeoutMs: null,
            usage: null,
          });
        },
      },
    });

    const runId = await host.scanBrandProfile("https://company.example");
    await host.idle();

    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("propose");
    expect(detail.failureHint).toBe(
      "The model provider rejected the API key. Check it in Settings → Extraction provider. No accepted revision was changed.",
    );
    const failed = detail.events.find((event) => event.type === "stage_failed");
    expect(failed?.detail?.modelBoundary).toMatchObject({ status: 401 });
  });
});
