import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config";
import {
  NotionCalendar,
  NotionCalendarPublisher,
  NotionConnection,
  type NotionApi,
} from "../../../apps/server/src/modules/content-scout/notion";
import type { ContentDraft, OpportunityBrief } from "@chief-of-staff-demo/shared";
import { CONTENT_SCOUT_DRAFT_TARGETS_V1 } from "@chief-of-staff-demo/shared";

function setup() {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-notion-"));
  const configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  const pages = new Map<string, { id: string; url: string }>();
  const createdDatabases: { parentPageId: string; properties: Record<string, unknown> }[] = [];
  const createdPages: { properties: Record<string, unknown>; markdown: string }[] = [];
  let schema: Record<string, { type: string }> = {
    Name: { type: "title" },
    Status: { type: "status" },
    Platform: { type: "select" },
    Format: { type: "select" },
    "Scheduled date": { type: "date" },
    "Content Pack ID": { type: "rich_text" },
    Opportunity: { type: "rich_text" },
    "Source URLs": { type: "rich_text" },
    "Brand Profile revision": { type: "rich_text" },
    "Local Run ID": { type: "rich_text" },
  };
  const api: NotionApi = {
    async getSelf() {
      return { id: "bot-1", name: "Content Scout" };
    },
    async createDatabase(input) {
      createdDatabases.push(input);
      return {
        id: "database-1",
        dataSourceId: "data-source-1",
        url: "https://notion.example/database-1",
      };
    },
    async retrieveDataSource() {
      return { properties: schema };
    },
    async queryByTitle({ title }) {
      return pages.get(title) ?? null;
    },
    async createPage(input) {
      createdPages.push(input);
      const titleProperty = Object.values(input.properties).find(
        (property) => typeof property === "object" && property !== null && "title" in property,
      ) as { title: { text: { content: string } }[] };
      const title = titleProperty.title[0].text.content;
      const page = {
        id: `page-${pages.size + 1}`,
        url: `https://notion.example/${pages.size + 1}`,
      };
      pages.set(title, page);
      return page;
    },
  };
  const connection = new NotionConnection(
    configStore,
    (token) => ({
      ...api,
      async getSelf() {
        if (token === "bad-token") throw new Error("unauthorized");
        return await api.getSelf();
      },
    }),
    () => new Date("2026-08-25T12:00:00.000Z"),
  );
  return {
    configStore,
    connection,
    pages,
    createdDatabases,
    createdPages,
    setSchema: (next: typeof schema) => {
      schema = next;
    },
  };
}

describe("per-user Notion connection", () => {
  it("verifies a person's internal-integration token before replacing the stored token", async () => {
    const { connection, configStore } = setup();
    await expect(connection.connect("secret-good-token")).resolves.toEqual({
      state: "connected",
      tokenHint: "…oken",
      lastVerifiedAt: "2026-08-25T12:00:00.000Z",
    });
    await expect(connection.connect("bad-token")).rejects.toThrow("unauthorized");
    expect(configStore.get().notion.token).toBe("secret-good-token");
    expect(connection.disconnect()).toEqual({
      state: "unconfigured",
      tokenHint: "",
      lastVerifiedAt: null,
    });
  });

  it("creates the standard schema or validates an existing mapping without mutating it", async () => {
    const { connection, configStore, createdDatabases, setSchema } = setup();
    await connection.connect("secret-good-token");
    const calendar = new NotionCalendar(connection, configStore);
    await calendar.createStandard("parent-page-1");
    expect(createdDatabases[0]?.parentPageId).toBe("parent-page-1");
    expect(Object.keys(createdDatabases[0].properties)).toEqual([
      "Name",
      "Status",
      "Platform",
      "Format",
      "Scheduled date",
      "Content Pack ID",
      "Opportunity",
      "Source URLs",
      "Created",
      "Published URL",
      "Brand Profile revision",
      "Local Run ID",
    ]);

    setSchema({
      Title: { type: "title" },
      Workflow: { type: "select" },
      Network: { type: "select" },
      Shape: { type: "select" },
      Date: { type: "date" },
    });
    await calendar.mapExisting({
      databaseId: "existing-db",
      dataSourceId: "existing-source",
      databaseUrl: "https://notion.example/existing",
      mapping: {
        name: "Title",
        status: "Workflow",
        platform: "Network",
        format: "Shape",
        scheduledDate: "Date",
      },
    });
    expect(configStore.get().modules["content-scout"].notion.databaseId).toBe("existing-db");
    await expect(
      calendar.mapExisting({
        databaseId: "bad-db",
        dataSourceId: "bad-source",
        databaseUrl: "https://notion.example/bad",
        mapping: {
          name: "Network",
          status: "Workflow",
          platform: "Network",
          format: "Shape",
          scheduledDate: "Date",
        },
      }),
    ).rejects.toThrow("Network must be a title");
    expect(configStore.get().modules["content-scout"].notion.databaseId).toBe("existing-db");
  });
});

describe("one-way Notion calendar publication", () => {
  it("puts clean copy first, maps only existing optional properties, and finds the same page by stable title", async () => {
    const { connection, configStore, createdPages } = setup();
    await connection.connect("secret-good-token");
    await new NotionCalendar(connection, configStore).createStandard("parent-page-1");
    const publisher = new NotionCalendarPublisher(connection, configStore);
    const target = CONTENT_SCOUT_DRAFT_TARGETS_V1[0];
    const draft: ContentDraft = {
      id: "draft-1",
      contentPackId: "pack-1",
      target,
      createdAt: "2026-08-25T12:00:00.000Z",
      copy: "Copy-ready content only.",
      productionNotes: ["Use a clear opening visual."],
      reviewNotes: [
        { claim: "Verified claim", kind: "fact", sourceUrls: ["https://source.example"] },
      ],
    };
    const brief = {
      id: "brief-1",
      runId: "run_20260825-120000_aaaaaaaa",
      contentPackId: "pack-1",
      createdAt: "2026-08-25T12:00:00.000Z",
      opportunity: {
        id: "opportunity-1",
        canonicalKey: "key",
        title: "Opportunity title",
        angle: "practical_implication",
        angleDescription: "Explain the practical impact.",
        materialDevelopment: null,
        urgency: "Now",
        explanation: "Why it matters",
        sourceItemIds: [],
        sourceUrls: ["https://source.example"],
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
      },
      sourceItems: [],
      supportingSourceItemCount: 0,
      claims: [],
      brandProfileRevisionId: "brand-1",
      brandProfileMarkdown: "# Brand",
    } satisfies OpportunityBrief;
    expect(await publisher.findDraftPage("stable-key", draft)).toBeNull();
    const created = await publisher.createDraftPage({ idempotencyKey: "stable-key", draft, brief });
    expect(createdPages[0]?.markdown.startsWith("Copy-ready content only.")).toBe(true);
    expect(createdPages[0]?.markdown).toContain("## Evidence and review notes");
    await expect(publisher.findDraftPage("stable-key", draft)).resolves.toEqual(created);
  });
});
