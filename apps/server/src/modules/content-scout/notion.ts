import { createHash } from "node:crypto";
import { Client } from "@notionhq/client";
import type { AppConfig, ContentDraft, OpportunityBrief } from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../../config.js";
import type { NotionPublisher } from "./ports.js";

interface NotionPageRef {
  id: string;
  url: string;
}

export interface NotionApi {
  getSelf(): Promise<{ id: string; name: string | null }>;
  createDatabase(input: {
    parentPageId: string;
    title: string;
    properties: Record<string, unknown>;
  }): Promise<{ id: string; url: string; dataSourceId: string }>;
  retrieveDataSource(id: string): Promise<{ properties: Record<string, { type: string }> }>;
  queryByTitle(input: {
    dataSourceId: string;
    property: string;
    title: string;
  }): Promise<NotionPageRef | null>;
  createPage(input: {
    dataSourceId: string;
    properties: Record<string, unknown>;
    markdown: string;
  }): Promise<NotionPageRef>;
}

export type NotionApiFactory = (token: string) => NotionApi;

function notionApi(token: string): NotionApi {
  const client = new Client({ auth: token });
  return {
    async getSelf() {
      const self = await client.users.me({});
      return { id: self.id, name: "name" in self ? (self.name ?? null) : null };
    },
    async createDatabase(input) {
      const response = await client.databases.create({
        parent: { type: "page_id", page_id: input.parentPageId },
        title: [{ type: "text", text: { content: input.title } }],
        initial_data_source: {
          properties: input.properties as Parameters<
            typeof client.databases.create
          >[0]["initial_data_source"] extends { properties?: infer P }
            ? P
            : never,
        },
      });
      if (!("url" in response) || !("data_sources" in response) || !response.data_sources[0]) {
        throw new Error("Notion created a database without returning its data source.");
      }
      return { id: response.id, url: response.url, dataSourceId: response.data_sources[0].id };
    },
    async retrieveDataSource(id) {
      const response = await client.dataSources.retrieve({ data_source_id: id });
      if (!("properties" in response)) {
        throw new Error("Notion did not return the data source schema.");
      }
      return {
        properties: Object.fromEntries(
          Object.entries(response.properties).map(([name, property]) => [
            name,
            { type: property.type },
          ]),
        ),
      };
    },
    async queryByTitle(input) {
      const response = await client.dataSources.query({
        data_source_id: input.dataSourceId,
        filter: { property: input.property, title: { equals: input.title } },
        page_size: 1,
      });
      const found = response.results[0];
      return found && found.object === "page" && "url" in found
        ? { id: found.id, url: found.url }
        : null;
    },
    async createPage(input) {
      const response = await client.pages.create({
        parent: { type: "data_source_id", data_source_id: input.dataSourceId },
        properties: input.properties as NonNullable<
          Parameters<typeof client.pages.create>[0]["properties"]
        >,
        markdown: input.markdown,
      });
      if (!("url" in response)) {
        throw new Error("Notion created a partial page with no URL.");
      }
      return { id: response.id, url: response.url };
    },
  };
}

export type NotionConnectionStatus =
  | { state: "unconfigured"; tokenHint: ""; lastVerifiedAt: null }
  | { state: "connected"; tokenHint: string; lastVerifiedAt: string }
  | { state: "unverified"; tokenHint: string; lastVerifiedAt: null };

export class NotionConnection {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly buildApi: NotionApiFactory = notionApi,
    private readonly now: () => Date = () => new Date(),
  ) {}

  status(): NotionConnectionStatus {
    const notion = this.configStore.get().notion;
    if (!notion.token) return { state: "unconfigured", tokenHint: "", lastVerifiedAt: null };
    const tokenHint = `…${notion.token.slice(-4)}`;
    return notion.lastVerifiedAt
      ? { state: "connected", tokenHint, lastVerifiedAt: notion.lastVerifiedAt }
      : { state: "unverified", tokenHint, lastVerifiedAt: null };
  }

  async connect(token: string): Promise<NotionConnectionStatus> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("A Notion internal-integration token is required.");
    await this.buildApi(trimmed).getSelf();
    this.configStore.setNotionToken(trimmed, this.now().toISOString());
    return this.status();
  }

  disconnect(): NotionConnectionStatus {
    this.configStore.setNotionToken("", null);
    return this.status();
  }

  api(): NotionApi {
    const token = this.configStore.get().notion.token;
    if (!token) throw new Error("Connect your Notion integration first.");
    return this.buildApi(token);
  }
}

const STANDARD_PROPERTIES: Record<string, unknown> = {
  Name: { title: {} },
  Status: { status: {} },
  Platform: { select: {} },
  Format: { select: {} },
  "Scheduled date": { date: {} },
  "Content Pack ID": { rich_text: {} },
  Opportunity: { rich_text: {} },
  "Source URLs": { rich_text: {} },
  Created: { created_time: {} },
  "Published URL": { url: {} },
  "Brand Profile revision": { rich_text: {} },
  "Local Run ID": { rich_text: {} },
};

type ContentScoutConfig = AppConfig["modules"]["content-scout"];

export class NotionCalendar {
  constructor(
    private readonly connection: NotionConnection,
    private readonly configStore: ConfigStore,
  ) {}

  async createStandard(parentPageId: string): Promise<ContentScoutConfig["notion"]> {
    const created = await this.connection.api().createDatabase({
      parentPageId,
      title: "Content Scout Calendar",
      properties: STANDARD_PROPERTIES,
    });
    const next = {
      databaseId: created.id,
      dataSourceId: created.dataSourceId,
      databaseUrl: created.url,
      mapping: {
        name: "Name",
        status: "Status",
        platform: "Platform",
        format: "Format",
        scheduledDate: "Scheduled date",
      },
    };
    this.save(next);
    return next;
  }

  async mapExisting(input: {
    databaseId: string;
    dataSourceId: string;
    databaseUrl: string;
    mapping: ContentScoutConfig["notion"]["mapping"];
  }): Promise<ContentScoutConfig["notion"]> {
    const schema = await this.connection.api().retrieveDataSource(input.dataSourceId);
    const expected: [keyof typeof input.mapping, string[]][] = [
      ["name", ["title"]],
      ["status", ["status", "select"]],
      ["platform", ["select"]],
      ["format", ["select"]],
      ["scheduledDate", ["date"]],
    ];
    for (const [key, allowed] of expected) {
      const mapped = input.mapping[key];
      const actual = schema.properties[mapped]?.type;
      if (!actual || !allowed.includes(actual)) {
        throw new Error(`${mapped} must be a ${allowed.join(" or ")} Notion property.`);
      }
    }
    this.save(input);
    return input;
  }

  private save(notion: ContentScoutConfig["notion"]): void {
    const current = this.configStore.get().modules[CONTENT_SCOUT_MODULE_ID];
    this.configStore.setModuleConfig(CONTENT_SCOUT_MODULE_ID, { ...current, notion });
  }
}

const CONTENT_SCOUT_MODULE_ID = "content-scout" as const;

function richText(content: string) {
  return [{ type: "text" as const, text: { content: content.slice(0, 2_000) } }];
}

function stablePageTitle(key: string, draft?: ContentDraft): string {
  const receipt = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const label = draft ? `${draft.target.channel} — ${draft.target.format}` : "Content Draft";
  return `${label} [${receipt}]`;
}

export class NotionCalendarPublisher implements NotionPublisher {
  private schema: Record<string, { type: string }> | null = null;

  constructor(
    private readonly connection: NotionConnection,
    private readonly configStore: ConfigStore,
  ) {}

  async findDraftPage(key: string, draft?: ContentDraft): Promise<NotionPageRef | null> {
    const config = this.calendar();
    return await this.connection.api().queryByTitle({
      dataSourceId: config.dataSourceId,
      property: config.mapping.name,
      title: stablePageTitle(key, draft),
    });
  }

  async createDraftPage(input: {
    idempotencyKey: string;
    draft: ContentDraft;
    brief: OpportunityBrief;
  }): Promise<NotionPageRef> {
    const config = this.calendar();
    this.schema ??= (
      await this.connection.api().retrieveDataSource(config.dataSourceId)
    ).properties;
    const statusType = this.schema[config.mapping.status]?.type;
    const properties: Record<string, unknown> = {
      [config.mapping.name]: {
        title: richText(stablePageTitle(input.idempotencyKey, input.draft)),
      },
      [config.mapping.status]:
        statusType === "select" ? { select: { name: "Draft" } } : { status: { name: "Draft" } },
      [config.mapping.platform]: { select: { name: input.draft.target.channel } },
      [config.mapping.format]: { select: { name: input.draft.target.format } },
      [config.mapping.scheduledDate]: { date: null },
    };
    const optional: [string, unknown][] = [
      ["Content Pack ID", { rich_text: richText(input.draft.contentPackId) }],
      ["Opportunity", { rich_text: richText(input.brief.opportunity.title) }],
      ["Source URLs", { rich_text: richText(input.brief.opportunity.sourceUrls.join("\n")) }],
      ["Brand Profile revision", { rich_text: richText(input.brief.brandProfileRevisionId) }],
      ["Local Run ID", { rich_text: richText(input.brief.runId) }],
    ];
    for (const [name, value] of optional) {
      if (this.schema[name]) properties[name] = value;
    }
    return await this.connection.api().createPage({
      dataSourceId: config.dataSourceId,
      properties,
      markdown: this.markdown(input.draft, input.brief, input.idempotencyKey),
    });
  }

  private calendar(): ContentScoutConfig["notion"] {
    const config = this.configStore.get().modules[CONTENT_SCOUT_MODULE_ID].notion;
    if (!config.dataSourceId) throw new Error("Choose or create a Notion content calendar first.");
    return config;
  }

  private markdown(draft: ContentDraft, brief: OpportunityBrief, key: string): string {
    const production = draft.productionNotes.length
      ? draft.productionNotes.map((note) => `- ${note}`).join("\n")
      : "- None";
    const evidence = draft.reviewNotes.length
      ? draft.reviewNotes
          .map((note) => `- **${note.kind}:** ${note.claim} — ${note.sourceUrls.join(", ")}`)
          .join("\n")
      : brief.claims.map((claim) => `- ${claim.claim} — ${claim.sourceUrls.join(", ")}`).join("\n");
    return `${draft.copy}\n\n## Production notes\n\n${production}\n\n## Opportunity Brief\n\n${brief.opportunity.title}\n\n${brief.opportunity.explanation}\n\n## Evidence and review notes\n\n${evidence}\n\n## Local identities\n\n- Content Pack: ${draft.contentPackId}\n- Draft: ${draft.id}\n- Run: ${brief.runId}\n- Brand Profile revision: ${brief.brandProfileRevisionId}\n- Idempotency key: ${key}\n`;
  }
}
