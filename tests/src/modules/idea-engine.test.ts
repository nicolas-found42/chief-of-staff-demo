import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CompleteJson } from "../../../apps/server/src/llm/providers";
import {
  IDEA_ENGINE_MODULE_ID,
  IDEA_ENGINE_MODULE_VERSION,
  IDEA_CONTENT_TYPES,
  IDEA_FORMAT_VALUES,
  IDEA_VALIDATOR_RETRIES,
  type IdeaEngineRunResult,
} from "@chief-of-staff-demo/shared";
import { ModelBoundaryError } from "../../../apps/server/src/llm/failure";
import type { ModelBoundaryDiagnostic } from "@chief-of-staff-demo/shared";
import { Runner } from "../../../apps/server/src/engine/runner";
import {
  ideaEngineModule,
  type IdeaEngineInput,
  type SheetsAccess,
  type GmailAccess,
  type SheetsClient,
  type GmailClient,
} from "../../../apps/server/src/modules/idea-engine/module";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import type { GoogleConnectionState } from "@chief-of-staff-demo/shared";

/**
 * Idea Engine driven by its own `run` over a temporary Workspace, with fakes only at edges the app doesn't own.
 */

const TRANSCRIPT = `Richard: I think the future of AI is vertical agents, not horizontal platforms.
Richard: We should write a short hook for TikTok about the 0-30s rule.
Dana: That sounds good, but I think we need more.
Richard: Here is a thesis for an article: the meeting is the new API.`;

function makeIdea(_contentType: string, title: string, description = "desc") {
  return {
    Title: title,
    Description: description,
    "Target Audience": "founders",
    CTA: "Read more",
    Format: IDEA_FORMAT_VALUES[0] as string,
    "Custom Prompt": `Expand ${title}`,
    evidence: { at: "00:01", quote: title },
    confidence: 0.95,
  };
}

// Fake Sheets
interface FakeSheets extends SheetsClient {
  appended: Array<{ tab: string; rows: (string | number)[][] }>;
  tabs: string[];
  header: string[] | null;
  throws: unknown;
  ensureCalls: number;
  appendCalls: number;
}
function fakeSheets(): FakeSheets {
  const s: FakeSheets = {
    appended: [],
    tabs: [],
    header: null,
    throws: null,
    ensureCalls: 0,
    appendCalls: 0,
    async ensureTab(_spreadsheetId: string, title: string, header: string[]) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      if (s.throws) throw s.throws instanceof Error ? s.throws : new Error(String(s.throws));
      s.ensureCalls += 1;
      if (!s.tabs.includes(title)) {
        s.tabs.push(title);
        s.header = header;
      }
    },
    async appendRows(_spreadsheetId: string, tab: string, rows: (string | number)[][]) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      if (s.throws) throw s.throws instanceof Error ? s.throws : new Error(String(s.throws));
      s.appendCalls += 1;
      s.appended.push({ tab, rows });
    },
    isMissing: (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      return /notFound|404|Requested entity was not found/i.test(msg);
    },
  };
  // Support migration variant
  (s as unknown as Record<string, unknown>).ensureTabWithMigration = s.ensureTab.bind(s);
  return s;
}

interface FakeGmail extends GmailClient {
  drafts: Array<{ to: string; subject: string; body: string }>;
  throws: unknown;
}
function fakeGmail(): FakeGmail {
  const g: FakeGmail = {
    drafts: [],
    throws: null,
    async createDraft(draft) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      if (g.throws) throw g.throws instanceof Error ? g.throws : new Error(String(g.throws));
      g.drafts.push(draft);
      return `draft-${g.drafts.length}`;
    },
  };
  return g;
}

function scriptedProvider(script: Record<string, unknown[]>): CompleteJson {
  const calls = new Map<string, number>();
  return async ({ system, user: _user }) => {
    // Detect contentType from system prompt: contains `ContentType: "X"` or `for type "X"`
    const m = system.match(/for type "([^"]+)"/) ?? _user.match(/ContentType: ([^\n]+)/);
    const ct = m?.[1]?.trim() ?? "unknown";
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const arr = script[ct] ?? script["*"] ?? [];
    const idx = calls.get(ct) ?? 0;
    calls.set(ct, idx + 1);
    if (idx >= arr.length) throw new Error(`no scripted response for ${ct} call ${idx}`);
    const val = arr[idx];
    if (val instanceof Error) throw val;
    return val;
  };
}

/** A failure as the LLM seam reports it: a classification, not a sentence. */
function seamFailure(
  fields: Partial<ModelBoundaryDiagnostic> & Pick<ModelBoundaryDiagnostic, "classification">,
): ModelBoundaryError {
  return new ModelBoundaryError({
    provider: "openrouter",
    model: "test-model",
    upstreamServer: null,
    upstreamCode: null,
    binding: "forced_tool_call",
    status: null,
    finishReason: null,
    bodyBytes: 42,
    topLevelKeys: ["error"],
    populatedFields: [],
    emptyFields: [],
    timeoutMs: null,
    ...fields,
  });
}

function rateLimited(): ModelBoundaryError {
  return seamFailure({ classification: "http_error", status: 429 });
}

let workspaceDir: string;
let runs: Runs;
let sheets: FakeSheets;
let gmail: FakeGmail;
let sheetsAccess: () => SheetsAccess;
let gmailAccess: () => GmailAccess;
let providerScript: Record<string, unknown[]>;
let completeJson: CompleteJson;

function getCompleteJson(): CompleteJson {
  return completeJson;
}

function runner(): Runner<IdeaEngineInput> {
  return new Runner({
    runs,
    module: ideaEngineModule({
      getConfig: () =>
        ({
          provider: "mock",
          model: "test-model",
          apiKey: "",
          tasklistName: "Meeting Followups",
          google: {
            clientId: "",
            clientSecret: "",
            refreshToken: null,
            lastConnectedAt: null,
            hasExpiredBefore: false,
          },
          drive: {
            enabled: true,
            folderId: "folder-1",
            folderName: "Transcripts",
            pollIntervalMinutes: 2,
          },
          ollama: { baseUrl: "http://127.0.0.1:11434" },
          modules: {
            "youtube-trends": { channels: [], spreadsheetId: "", spreadsheetUrl: "" },
            "idea-engine": {
              spreadsheetId: "sheet-123",
              spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123",
              prompts: {},
            },
          },
        }) as unknown as import("@chief-of-staff-demo/shared").AppConfig,
      getCompleteJson,
      getLlmInfo: () => ({ provider: "mock", model: "test-model" }),
      getSheets: sheetsAccess,
      getGmail: gmailAccess,
      observe: (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        if (/invalid_grant|expired/i.test(msg)) return "expired";
        if (/notFound|404/i.test(msg) && msg.includes("spreadsheet")) return null;
        return null;
      },
      invalidateIndex: () => {},
    }),
  });
}

async function runFresh(
  fileName = "meeting-2026-08-24T10-00-00.000Z.md",
  text = TRANSCRIPT,
): Promise<string> {
  const engine = runner();
  const id = await engine.startRun(
    {
      intake: "drive",
      fileName,
      sourceUrl: "https://drive.google.com/file/d/abc/view",
      externalId: "drive-abc",
    },
    {
      kind: "fresh",
      fileName,
      text,
      sourceUrl: "https://drive.google.com/file/d/abc/view",
      externalId: "drive-abc",
    },
  );
  await engine.idle();
  return id;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "idea-"));
  runs = openRuns(workspaceDir);
  sheets = fakeSheets();
  gmail = fakeGmail();
  sheetsAccess = () => ({
    ok: true,
    client: sheets,
    spreadsheet: { id: "sheet-123", url: "https://docs.google.com/spreadsheets/d/sheet-123" },
  });
  gmailAccess = () => ({ ok: true, client: gmail });
  providerScript = {};
  // Default: each content type returns one idea
  for (const ct of IDEA_CONTENT_TYPES) {
    providerScript[ct] = [[makeIdea(ct, `Title ${ct}`)]];
  }
  completeJson = scriptedProvider(providerScript);
});

describe("Idea Engine Module", () => {
  it("golden transcript → done with ideas, batched Sheets and digest draft", async () => {
    const id = await runFresh();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    expect(detail.summary).toContain("12 ideas");
    const result = detail.result as IdeaEngineRunResult;
    expect(result.ideas).toHaveLength(12);
    expect(result.perTypeReasons).toEqual({});
    expect(result.reason).toBeNull();
    // One batched append, not 12 calls
    expect(sheets.appended).toHaveLength(1);
    expect(sheets.appended[0].tab).toBe("All RA Content Ideas");
    expect(sheets.appended[0].rows).toHaveLength(12);
    // ContentType column present (header migration)
    expect(sheets.header?.includes("ContentType")).toBe(true);
    // One draft digest with sheet link and bullets grouped by type
    expect(gmail.drafts).toHaveLength(1);
    expect(gmail.drafts[0].subject).toContain("Ideas processed");
    expect(gmail.drafts[0].body).toContain("Title video");
    expect(gmail.drafts[0].body).toContain("https://docs.google.com/spreadsheets/d/sheet-123");
    expect(detail.events.some((e) => e.type === "rows_appended")).toBe(true);
    expect(detail.events.some((e) => e.type === "gmail_draft_created")).toBe(true);
  });

  it("recovers an orphaned Run at its first unfinished content type", async () => {
    const completedTypes = IDEA_CONTENT_TYPES.slice(0, 4);
    const orphan = runs.create({
      module: IDEA_ENGINE_MODULE_ID,
      moduleVersion: IDEA_ENGINE_MODULE_VERSION,
      intake: "drive",
      fileName: "chosen-transcript.md",
      sourceUrl: "https://drive.google.com/file/d/chosen/view",
      externalId: "chosen-transcript",
    });
    orphan.writeArtifact("transcript.txt", TRANSCRIPT);
    orphan.writeArtifact("context.json", '{"attendees":[]}\n');
    completedTypes.forEach((contentType, index) => {
      orphan.writeArtifact(
        `idea-progress-${String(index).padStart(2, "0")}.json`,
        JSON.stringify({
          ideas: [
            {
              ...makeIdea(contentType, `Saved ${contentType}`),
              ContentType: contentType,
            },
          ],
          reason: null,
          hashes: [],
        }),
      );
    });
    orphan.started(IDEA_CONTENT_TYPES[4]);
    const afterRestart = runner();

    expect(await afterRestart.recoverRuns()).toBe(1);
    await afterRestart.idle();

    const detail = runs.detail(orphan.id)!;
    expect(detail.status).toBe("done");
    expect((detail.result as IdeaEngineRunResult).ideas).toHaveLength(12);
    expect(detail.events.find((event) => event.type === "run_recovered")?.detail).toEqual({
      fromStage: IDEA_CONTENT_TYPES[4],
      previousStatus: "running",
    });
    const recoveredAt = detail.events.findIndex((event) => event.type === "run_recovered");
    expect(
      detail.events
        .slice(recoveredAt + 1)
        .filter((event) => event.type === "stage_started")
        .map((event) => event.detail?.stage),
    ).not.toEqual(expect.arrayContaining(completedTypes));
  });

  it("recovers publication from the durable result without duplicating Content Ideas", async () => {
    const completedId = await runFresh();
    const result = runs.open(completedId)!.readArtifact("result.json")!;
    const orphan = runs.create({
      module: IDEA_ENGINE_MODULE_ID,
      moduleVersion: IDEA_ENGINE_MODULE_VERSION,
      intake: "drive",
      fileName: "chosen-transcript.md",
      sourceUrl: "https://drive.google.com/file/d/chosen/view",
      externalId: "chosen-transcript",
    });
    orphan.writeArtifact("transcript.txt", TRANSCRIPT);
    orphan.writeArtifact("context.json", '{"attendees":[]}\n');
    orphan.writeArtifact("result.json", result);
    orphan.started("publish");
    sheets.appended = [];
    gmail.drafts = [];
    const afterRestart = runner();

    expect(await afterRestart.recoverRuns()).toBe(1);
    await afterRestart.idle();

    const detail = runs.detail(orphan.id)!;
    expect(detail.status).toBe("done");
    expect((detail.result as IdeaEngineRunResult).ideas).toHaveLength(12);
    expect(sheets.appended[0]?.rows).toHaveLength(12);
    expect(detail.events.filter((event) => event.type === "run_recovered").at(-1)?.detail).toEqual({
      fromStage: "publish",
      previousStatus: "running",
    });
  });

  it("recovers the draft Stage without publishing the durable result again", async () => {
    const id = await runFresh();
    sheets.appended = [];
    gmail.drafts = [];
    runs.open(id)!.started("draft");
    const afterRestart = runner();

    expect(await afterRestart.recoverRuns()).toBe(1);
    await afterRestart.idle();

    expect(runs.detail(id)?.status).toBe("done");
    expect(sheets.appended).toHaveLength(0);
    expect(gmail.drafts).toHaveLength(1);
    expect(
      runs
        .detail(id)
        ?.events.filter((event) => event.type === "run_recovered")
        .at(-1)?.detail,
    ).toEqual({ fromStage: "draft", previousStatus: "running" });
  });

  it("recovers at draft when publication finished before the restart", async () => {
    const completedId = await runFresh();
    const result = runs.open(completedId)!.readArtifact("result.json")!;
    const orphan = runs.create({
      module: IDEA_ENGINE_MODULE_ID,
      moduleVersion: IDEA_ENGINE_MODULE_VERSION,
      intake: "drive",
      fileName: "chosen-transcript.md",
      sourceUrl: "https://drive.google.com/file/d/chosen/view",
      externalId: "chosen-transcript",
    });
    orphan.writeArtifact("transcript.txt", TRANSCRIPT);
    orphan.writeArtifact("context.json", '{"attendees":[]}\n');
    orphan.writeArtifact("result.json", result);
    orphan.started("publish");
    orphan.appendEvent("rows_appended", { tab: "All RA Content Ideas", rows: 12 });
    sheets.appended = [];
    gmail.drafts = [];
    const afterRestart = runner();

    expect(await afterRestart.recoverRuns()).toBe(1);
    await afterRestart.idle();

    expect(runs.detail(orphan.id)?.status).toBe("done");
    expect(sheets.appended).toHaveLength(0);
    expect(gmail.drafts).toHaveLength(1);
    expect(
      runs.detail(orphan.id)?.events.find((event) => event.type === "run_recovered")?.detail,
    ).toEqual({ fromStage: "draft", previousStatus: "running" });
  });

  it("skipped for unsupported file type (not a transcript)", async () => {
    const engine = runner();
    const id = await engine.startRun(
      { intake: "drive", fileName: "image.png", sourceUrl: null, externalId: "drive-png" },
      { kind: "fresh", fileName: "image.png", sourceUrl: null, externalId: "drive-png" },
    );
    await engine.idle();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("skipped");
    expect(detail.skipReason).toContain("unsupported");
    expect(sheets.appended).toHaveLength(0);
    expect(gmail.drafts).toHaveLength(0);
  });

  it("fails a corrupt supported file with the shared shape-only conversion diagnostic", async () => {
    const privateText = '{"PRIVATE TRANSCRIPT MARKER"';
    const engine = runner();
    const id = await engine.startRun(
      {
        intake: "drive",
        fileName: "meeting.json",
        sourceUrl: null,
        externalId: "drive-json",
      },
      {
        kind: "fresh",
        fileName: "meeting.json",
        bytes: Buffer.from(privateText),
        sourceUrl: null,
        externalId: "drive-json",
      },
    );
    await engine.idle();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("convert");
    expect(detail.failureHint).toBe(
      "This file is corrupt or does not match its format. Replace or repair the file.",
    );
    expect(detail.events.find((event) => event.type === "stage_failed")?.detail).toMatchObject({
      error: "invalid_file",
      diagnostic: {
        classification: "invalid_file",
        format: "json",
        bytes: Buffer.byteLength(privateText),
        step: "parse_json",
      },
    });
    expect(JSON.stringify(detail)).not.toContain("PRIVATE TRANSCRIPT MARKER");
  });

  it("zero ideas for all types → completed with reason, not skipped", async () => {
    for (const ct of IDEA_CONTENT_TYPES) providerScript[ct] = [[]];
    completeJson = scriptedProvider(providerScript);
    const id = await runFresh();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    expect(detail.summary).toBe(
      "0 ideas — no hook / no arc — from meeting-2026-08-24T10-00-00.000Z.md",
    );
    const result = detail.result as IdeaEngineRunResult;
    expect(result.ideas).toHaveLength(0);
    expect(result.reason).toContain("0 ideas");
    expect(Object.keys(result.perTypeReasons).length).toBe(12);
    expect(sheets.appended).toHaveLength(0); // no rows
    // Still a draft for visibility
    expect(gmail.drafts).toHaveLength(1);
    expect(detail.events.some((e) => e.type === "per_type_reason")).toBe(true);
  });

  it("intra-type dedupe: duplicate Title+Description within same type writes once", async () => {
    const dup = makeIdea("video", "Dup Title", "Dup Desc");
    providerScript["video"] = [[dup, dup]]; // same title+desc twice
    completeJson = scriptedProvider(providerScript);
    const id = await runFresh();
    const result = runs.detail(id)!.result as IdeaEngineRunResult;
    const videoIdeas = result.ideas.filter((i) => i.ContentType === "video");
    expect(videoIdeas).toHaveLength(1);
    // But distinct types may keep same title
    providerScript["article"] = [[makeIdea("article", "Dup Title", "Dup Desc")]];
    providerScript["video"] = [[dup, dup]];
    completeJson = scriptedProvider(providerScript);
    workspaceDir = mkdtempSync(join(tmpdir(), "idea-"));
    runs = openRuns(workspaceDir);
    sheets = fakeSheets();
    gmail = fakeGmail();
    const id2 = await runFresh("meeting2.md", TRANSCRIPT);
    const result2 = runs.detail(id2)!.result as IdeaEngineRunResult;
    expect(result2.ideas.filter((i) => i.Title === "Dup Title")).toHaveLength(2); // one per type
    expect(runs.detail(id2)!.events.some((e) => e.type === "dedupe_skip")).toBe(true);
  });

  it("validator retry on Format enum drift then succeeds", async () => {
    const bad = { ...makeIdea("video", "Bad Format"), Format: "bad_format" as unknown as string };
    providerScript["video"] = [[[bad]], [[makeIdea("video", "Good Title")]]];
    // Need to shape provider to return array per call: our script expects per contentType array of responses where each response is array of ideas
    // For video, first call returns bad, second returns good
    // Our earlier default for other types remains single idea
    completeJson = async ({ system, user: _user2 }: { system: string; user: string }) => {
      void _user2;
      const ctMatch = system.match(/for type "([^"]+)"/);
      const ct = ctMatch?.[1] ?? "video";
      if (ct === "video") {
        const count = (completeJson as unknown as { _vCount?: number })._vCount ?? 0;
        (completeJson as unknown as { _vCount: number })._vCount = count + 1;
        if (count === 0) return [bad];
        return [makeIdea("video", "Good Title")];
      }
      return [makeIdea(ct, `Title ${ct}`)];
    };
    const id = await runFresh();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    const videoIdeas = (detail.result as IdeaEngineRunResult).ideas.filter(
      (i) => i.ContentType === "video",
    );
    expect(videoIdeas[0].Title).toBe("Good Title");
    expect(detail.events.filter((e) => e.type === "extract_error").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  /**
   * The retry decision is the Module's, and it is made from the classified
   * model-boundary failure. A rate limit is retried past the validator cap
   * because backing off is the whole point; nothing else is.
   */
  it("retries past the validator cap when the model boundary classified a rate limit", async () => {
    providerScript["video"] = [
      rateLimited(),
      rateLimited(),
      rateLimited(),
      [makeIdea("video", "After the wait")],
    ];
    completeJson = scriptedProvider(providerScript);
    const id = await runFresh();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    const videoIdeas = (detail.result as IdeaEngineRunResult).ideas.filter(
      (i) => i.ContentType === "video",
    );
    expect(videoIdeas[0].Title).toBe("After the wait");
  });

  /* The same words in an unclassified error buy nothing: one sentence cannot
     serve both a person reading a Run and the code deciding whether to retry. */
  it("does not treat an unclassified error as a rate limit because its message says so", async () => {
    providerScript["video"] = Array.from(
      { length: 5 },
      () => new Error("429 rate limit exceeded, quota reached"),
    );
    completeJson = scriptedProvider(providerScript);
    const id = await runFresh();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("failed");
    expect(detail.events.filter((e) => e.type === "extract_error")).toHaveLength(
      IDEA_VALIDATOR_RETRIES,
    );
  });

  /**
   * The validator retry exists for this Module's own parse rejecting a reply. A
   * model-boundary failure is not that, and must not be answered by nudging the
   * model about its Format enum — the message naming the `response_format`
   * binding is not evidence about the reply's fields.
   */
  it("does not answer a model-boundary failure with the Format validator nudge", async () => {
    const prompts: string[] = [];
    const scripted = scriptedProvider({
      ...providerScript,
      video: Array.from({ length: 5 }, () =>
        seamFailure({ classification: "http_error", binding: "response_format", status: 500 }),
      ),
    });
    completeJson = async (request) => {
      prompts.push(request.user);
      return scripted(request);
    };
    const id = await runFresh();
    expect(runs.detail(id)!.status).toBe("failed");
    expect(prompts.some((prompt) => prompt.includes("Validator:"))).toBe(false);
  });

  it("single-attendee short-circuit: still extracts without speaker filter", async () => {
    const singleTranscript = "Hello everyone, I have an idea for a LinkedIn post about AI agents.";
    for (const ct of IDEA_CONTENT_TYPES) providerScript[ct] = [[makeIdea(ct, `Single ${ct}`)]];
    completeJson = scriptedProvider(providerScript);
    const engine = runner();
    const id = await engine.startRun(
      { intake: "drive", fileName: "solo.md", sourceUrl: null, externalId: "drive-solo" },
      {
        kind: "fresh",
        fileName: "solo.md",
        text: singleTranscript,
        sourceUrl: null,
        externalId: "drive-solo",
        context: { meetingDate: null, attendees: [{ name: "Richard", email: null }] },
      },
    );
    await engine.idle();
    expect(runs.detail(id)!.status).toBe("done");
    expect((runs.detail(id)!.result as IdeaEngineRunResult).ideas).toHaveLength(12);
  });

  it("expired vs disconnected: expired throws connectionCaused, disconnected fails with hint", async () => {
    // expired via Sheets throws invalid_grant
    sheets.throws = Object.assign(new Error("invalid_grant"), {
      response: { data: { error: "invalid_grant" } },
    });
    // Sheets access ok but append will fail with expired
    const id = await runFresh();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("publish");
    expect(detail.connectionCaused).toBe(true);
    expect(detail.failureHint).toContain("Reconnect");
  });

  it("disconnected gmail fails draft stage with hint", async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "idea-"));
    runs = openRuns(workspaceDir);
    sheets = fakeSheets();
    gmail = fakeGmail();
    gmailAccess = () => ({ ok: false, state: "disconnected" as GoogleConnectionState });
    sheetsAccess = () => ({
      ok: true,
      client: sheets,
      spreadsheet: { id: "sheet-123", url: "https://docs.google.com/spreadsheets/d/sheet-123" },
    });
    // need fresh provider
    for (const ct of IDEA_CONTENT_TYPES) providerScript[ct] = [[makeIdea(ct, `Title ${ct}`)]];
    completeJson = scriptedProvider(providerScript);
    const engine2 = runner();
    const id2 = await engine2.startRun(
      { intake: "drive", fileName: "meeting2.md", sourceUrl: null, externalId: "drive-2" },
      {
        kind: "fresh",
        fileName: "meeting2.md",
        text: TRANSCRIPT,
        sourceUrl: null,
        externalId: "drive-2",
      },
    );
    await engine2.idle();
    const detail2 = runs.detail(id2)!;
    // draft stage should fail with disconnected
    expect(detail2.status).toBe("failed");
    expect(detail2.failedStage).toBe("draft");
    expect(detail2.connectionCaused).toBe(true);
  });
});
