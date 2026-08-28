import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "../../../apps/server/src/config";
import { openGoogleConnection } from "../../../apps/server/src/google/connection";
import { createGmailDraft } from "../../../apps/server/src/google/gmail";
import {
  buildGoogleAuth,
  exchangeGoogleCode,
  googleAuthUrl,
  GOOGLE_SCOPES,
  mintAccessToken,
  type GoogleAuth,
} from "../../../apps/server/src/google/oauth";
import { googleOutputs } from "../../../apps/server/src/google/outputs";
import {
  appendRows,
  appendRowsWithUserEntered,
  createSpreadsheet,
  ensureTab,
  ensureTabWithMigration,
} from "../../../apps/server/src/google/sheets";
import { createGoogleTask, findOrCreateTasklist } from "../../../apps/server/src/google/tasks";

const sdk = vi.hoisted(() => {
  const sheets = {
    spreadsheets: {
      create: vi.fn(),
      get: vi.fn(),
      batchUpdate: vi.fn(),
      values: {
        append: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
      },
    },
  };
  const tasks = {
    tasklists: { list: vi.fn(), insert: vi.fn() },
    tasks: { insert: vi.fn() },
  };
  const gmail = {
    users: {
      drafts: { create: vi.fn(), list: vi.fn() },
      threads: { list: vi.fn() },
      messages: { list: vi.fn(), get: vi.fn(), send: vi.fn() },
      getProfile: vi.fn(),
    },
  };
  const drive = { files: { get: vi.fn(), list: vi.fn() } };
  const youtube = { videos: { list: vi.fn() } };
  const calendar = { events: { list: vi.fn() } };
  const credentials: Record<string, unknown> = {};
  const oauthClient = {
    credentials,
    setCredentials: vi.fn((next: Record<string, unknown>) => Object.assign(credentials, next)),
    generateAuthUrl: vi.fn(() => "https://accounts.google.test/authorize"),
    getToken: vi.fn(),
    getAccessToken: vi.fn(),
  };
  const oauthCtor = vi.fn(function OAuth2() {
    return oauthClient;
  });
  return {
    sheets,
    sheetsFactory: vi.fn(() => sheets),
    tasks,
    tasksFactory: vi.fn(() => tasks),
    gmail,
    gmailFactory: vi.fn(() => gmail),
    drive,
    driveFactory: vi.fn(() => drive),
    youtube,
    youtubeFactory: vi.fn(() => youtube),
    calendar,
    calendarFactory: vi.fn(() => calendar),
    credentials,
    oauthClient,
    oauthCtor,
  };
});

vi.mock("googleapis", () => ({
  google: {
    sheets: sdk.sheetsFactory,
    tasks: sdk.tasksFactory,
    gmail: sdk.gmailFactory,
    drive: sdk.driveFactory,
    youtube: sdk.youtubeFactory,
    calendar: sdk.calendarFactory,
    auth: { OAuth2: sdk.oauthCtor },
  },
}));

const auth = {} as GoogleAuth;
const config: AppConfig = {
  provider: "mock",
  model: "mock-model",
  apiKey: "test-key",
  tasklistName: "Meeting Followups",
  google: {
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "secret",
    refreshToken: "refresh-token",
    lastConnectedAt: null,
    hasExpiredBefore: false,
  },
  notion: { token: "", lastVerifiedAt: null },
  drive: { enabled: false, folderId: "", folderName: "", pollIntervalMinutes: 2 },
  ollama: { baseUrl: "http://127.0.0.1:11434" },
  modules: {
    "youtube-trends": { channels: [], spreadsheetId: "", spreadsheetUrl: "" },
    "idea-engine": { spreadsheetId: "", spreadsheetUrl: "", prompts: {} },
    "content-scout": {
      timeZone: "UTC",
      dailyTime: "08:00",
      weeklyDiscoveryDay: 1,
      weeklyDiscoveryTime: "09:00",
      shortlistSize: 5,
      notion: {
        databaseId: "",
        dataSourceId: "",
        databaseUrl: "",
        mapping: {
          name: "Name",
          status: "Status",
          platform: "Platform",
          format: "Format",
          scheduledDate: "Scheduled date",
        },
      },
    },
    "meeting-brief-generator": {
      internalDomains: [],
      guestProfile: {
        endpoint: "",
        apiKey: "",
        lastVerifiedAt: null,
        lastCheckAt: null,
        lastCheckState: null,
        lastCheckDetail: null,
      },
      hubspot: { token: "", lastVerifiedAt: null },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.sheets.spreadsheets.create.mockResolvedValue({
    data: { spreadsheetId: "sheet-1", spreadsheetUrl: "https://docs.google.com/sheet-1" },
  });
  sdk.sheets.spreadsheets.get.mockResolvedValue({ data: { sheets: [] } });
  sdk.sheets.spreadsheets.batchUpdate.mockResolvedValue({ data: {} });
  sdk.sheets.spreadsheets.values.append.mockResolvedValue({ data: {} });
  sdk.sheets.spreadsheets.values.get.mockResolvedValue({ data: { values: [] } });
  sdk.sheets.spreadsheets.values.update.mockResolvedValue({ data: {} });
  sdk.tasks.tasklists.list.mockResolvedValue({ data: { items: [] } });
  sdk.tasks.tasklists.insert.mockResolvedValue({ data: { id: "list-new" } });
  sdk.tasks.tasks.insert.mockResolvedValue({
    data: { id: "task-1", webViewLink: "https://tasks.google.com/task-1" },
  });
  sdk.gmail.users.drafts.create.mockResolvedValue({ data: { id: "draft-1" } });
  sdk.gmail.users.drafts.list.mockResolvedValue({ data: { drafts: [] } });
  sdk.gmail.users.threads.list.mockResolvedValue({ data: { threads: [] } });
  sdk.gmail.users.messages.list.mockResolvedValue({ data: { messages: [] } });
  sdk.gmail.users.getProfile.mockResolvedValue({
    data: { emailAddress: "nicolas@found42.com" },
  });
  sdk.drive.files.get.mockResolvedValue({ data: { id: "folder-1", name: "Transcripts" } });
  sdk.drive.files.list.mockResolvedValue({ data: { files: [] } });
  sdk.youtube.videos.list.mockResolvedValue({ data: { items: [] } });
  for (const key of Object.keys(sdk.credentials)) {
    delete sdk.credentials[key];
  }
  sdk.oauthClient.setCredentials.mockImplementation((next: Record<string, unknown>) =>
    Object.assign(sdk.credentials, next),
  );
  sdk.oauthClient.generateAuthUrl.mockReturnValue("https://accounts.google.test/authorize");
  sdk.oauthClient.getToken.mockResolvedValue({
    tokens: { refresh_token: "new-refresh", scope: GOOGLE_SCOPES.join(" ") },
  });
  sdk.oauthClient.getAccessToken.mockResolvedValue({ token: "access-token" });
});

describe("Sheets Output Adapter", () => {
  it("creates a spreadsheet and returns Google's permanent link", async () => {
    await expect(createSpreadsheet(auth, "Weekly trends")).resolves.toEqual({
      id: "sheet-1",
      url: "https://docs.google.com/sheet-1",
    });
    expect(sdk.sheets.spreadsheets.create).toHaveBeenCalledWith({
      requestBody: { properties: { title: "Weekly trends" } },
      fields: "spreadsheetId,spreadsheetUrl",
    });
  });

  it("uses a stable Sheets URL when Google omits one", async () => {
    sdk.sheets.spreadsheets.create.mockResolvedValueOnce({
      data: { spreadsheetId: "sheet-2" },
    });
    await expect(createSpreadsheet(auth, "Ideas")).resolves.toEqual({
      id: "sheet-2",
      url: "https://docs.google.com/spreadsheets/d/sheet-2",
    });
  });

  it("rejects a spreadsheet response without an id", async () => {
    sdk.sheets.spreadsheets.create.mockResolvedValueOnce({ data: {} });
    await expect(createSpreadsheet(auth, "Ideas")).rejects.toThrow("Google created no spreadsheet");
  });

  it("adds a missing tab and its raw header, escaping apostrophes in the range", async () => {
    await ensureTab(auth, "sheet-1", "Richard's channel", ["Day", "Views"]);

    expect(sdk.sheets.spreadsheets.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: "sheet-1",
      requestBody: {
        requests: [{ addSheet: { properties: { title: "Richard's channel" } } }],
      },
    });
    expect(sdk.sheets.spreadsheets.values.append).toHaveBeenCalledWith({
      spreadsheetId: "sheet-1",
      range: "'Richard''s channel'!A:D",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [["Day", "Views"]] },
    });
  });

  it("leaves an existing tab untouched", async () => {
    sdk.sheets.spreadsheets.get.mockResolvedValueOnce({
      data: { sheets: [{ properties: { title: "Found42" } }] },
    });

    await ensureTab(auth, "sheet-1", "Found42", ["Day", "Views"]);

    expect(sdk.sheets.spreadsheets.batchUpdate).not.toHaveBeenCalled();
    expect(sdk.sheets.spreadsheets.values.append).not.toHaveBeenCalled();
  });

  it("creates a missing Idea Engine tab with user-entered values", async () => {
    await ensureTabWithMigration(auth, "sheet-1", "Ideas", ["Title", "ContentType"]);

    expect(sdk.sheets.spreadsheets.batchUpdate).toHaveBeenCalledOnce();
    expect(sdk.sheets.spreadsheets.values.append).toHaveBeenCalledWith(
      expect.objectContaining({
        range: "'Ideas'!A:K",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["Title", "ContentType"]] },
      }),
    );
  });

  it("migrates a legacy Idea Engine header exactly once", async () => {
    sdk.sheets.spreadsheets.get.mockResolvedValue({
      data: { sheets: [{ properties: { title: "Ideas" } }] },
    });
    sdk.sheets.spreadsheets.values.get.mockResolvedValue({
      data: { values: [["Title", "Format"]] },
    });

    await ensureTabWithMigration(auth, "sheet-1", "Ideas", ["Title", "Format", "ContentType"]);

    expect(sdk.sheets.spreadsheets.values.update).toHaveBeenCalledWith({
      spreadsheetId: "sheet-1",
      range: "'Ideas'!1:1",
      valueInputOption: "RAW",
      requestBody: { values: [["Title", "Format", "ContentType"]] },
    });

    sdk.sheets.spreadsheets.values.get.mockResolvedValue({
      data: { values: [["Title", "Format", "ContentType"]] },
    });
    await ensureTabWithMigration(auth, "sheet-1", "Ideas", ["Title", "Format", "ContentType"]);
    expect(sdk.sheets.spreadsheets.values.update).toHaveBeenCalledOnce();
  });

  it("leaves the header unchanged when its inspection fails", async () => {
    sdk.sheets.spreadsheets.get.mockResolvedValue({
      data: { sheets: [{ properties: { title: "Ideas" } }] },
    });
    sdk.sheets.spreadsheets.values.get.mockRejectedValue(new Error("read denied"));

    await expect(
      ensureTabWithMigration(auth, "sheet-1", "Ideas", ["Title", "ContentType"]),
    ).resolves.toBeUndefined();
    expect(sdk.sheets.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it("does not call Sheets for an empty raw append", async () => {
    await appendRows(auth, "sheet-1", "Found42", []);

    expect(sdk.sheetsFactory).not.toHaveBeenCalled();
  });

  it("does not call Sheets for an empty user-entered append", async () => {
    await appendRowsWithUserEntered(auth, "sheet-1", "Ideas", []);

    expect(sdk.sheetsFactory).not.toHaveBeenCalled();
  });
});

describe("Tasks Output Adapter", () => {
  it("reuses a tasklist with the requested title", async () => {
    sdk.tasks.tasklists.list.mockResolvedValueOnce({
      data: {
        items: [
          { id: "other", title: "Other" },
          { id: "list-1", title: "Followups" },
        ],
      },
    });

    await expect(findOrCreateTasklist(auth, "Followups")).resolves.toBe("list-1");
    expect(sdk.tasks.tasklists.insert).not.toHaveBeenCalled();
  });

  it("creates a missing tasklist", async () => {
    await expect(findOrCreateTasklist(auth, "Followups")).resolves.toBe("list-new");
    expect(sdk.tasks.tasklists.insert).toHaveBeenCalledWith({
      requestBody: { title: "Followups" },
    });
  });

  it("rejects a tasklist response without an id", async () => {
    sdk.tasks.tasklists.insert.mockResolvedValueOnce({ data: {} });
    await expect(findOrCreateTasklist(auth, "No id")).rejects.toThrow(
      'tasklist insert returned no id for "No id"',
    );
  });

  it("creates a dated task with its source notes and returns Google's link", async () => {
    const created = await createGoogleTask(
      auth,
      "list-1",
      { title: "Send update", due: "2026-08-31", owner: "Dana" },
      { sourceFileName: "meeting.md", sourceUrl: "https://drive.google.test/meeting" },
    );

    expect(created).toEqual({
      googleId: "task-1",
      webViewLink: "https://tasks.google.com/task-1",
    });
    expect(sdk.tasks.tasks.insert).toHaveBeenCalledWith({
      tasklist: "list-1",
      requestBody: {
        title: "Send update",
        due: "2026-08-31T00:00:00Z",
        notes: ["Owner: Dana", "Source: meeting.md", "https://drive.google.test/meeting"].join(
          "\n",
        ),
      },
    });
  });

  it("keeps an absent task web link nullable", async () => {
    sdk.tasks.tasks.insert.mockResolvedValueOnce({ data: { id: "task-2" } });
    await expect(
      createGoogleTask(
        auth,
        "list-1",
        { title: "Undated" },
        { sourceFileName: "", sourceUrl: null },
      ),
    ).resolves.toEqual({ googleId: "task-2", webViewLink: null });
  });

  it("rejects a task response without an id", async () => {
    sdk.tasks.tasks.insert.mockResolvedValueOnce({ data: {} });
    await expect(
      createGoogleTask(auth, "list-1", { title: "No id" }, { sourceFileName: "", sourceUrl: null }),
    ).rejects.toThrow('task insert returned no id for "No id"');
  });
});

describe("Gmail Output Adapter", () => {
  it("creates a draft-only MIME message and returns its Google id", async () => {
    await expect(
      createGmailDraft(auth, {
        to: "dana@example.com",
        subject: "Follow up",
        body: "Hello Dana",
      }),
    ).resolves.toBe("draft-1");
    expect(sdk.gmail.users.drafts.create).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { message: { raw: expect.any(String) } },
    });
  });

  it("rejects a draft response without an id", async () => {
    sdk.gmail.users.drafts.create.mockResolvedValueOnce({ data: {} });
    await expect(
      createGmailDraft(auth, { to: "", subject: "No id", body: "Body" }),
    ).rejects.toThrow('draft insert returned no id for "No id"');
  });
});

describe("OAuth adapter", () => {
  it("builds the shared client with the running redirect URI and stored refresh token", () => {
    const built = buildGoogleAuth(config, 5000);

    expect(built).toBe(sdk.oauthClient);
    expect(sdk.oauthCtor).toHaveBeenCalledWith(
      "client.apps.googleusercontent.com",
      "secret",
      "http://localhost:5000/api/google/callback",
    );
    expect(sdk.oauthClient.setCredentials).toHaveBeenCalledWith({
      refresh_token: "refresh-token",
    });
  });

  it("requests offline consent for every required Google surface", () => {
    expect(googleAuthUrl(config, 4317)).toBe("https://accounts.google.test/authorize");
    expect(sdk.oauthClient.generateAuthUrl).toHaveBeenCalledWith({
      access_type: "offline",
      prompt: "consent",
      scope: [...GOOGLE_SCOPES],
    });
  });

  it("exchanges a code for a refresh token and normalized granted scopes", async () => {
    sdk.oauthClient.getToken.mockResolvedValueOnce({
      tokens: { refresh_token: "refresh-2", scope: " scope-a  scope-b " },
    });

    await expect(exchangeGoogleCode(config, 4317, "code-1")).resolves.toEqual({
      refreshToken: "refresh-2",
      grantedScopes: ["scope-a", "scope-b"],
    });
    expect(sdk.oauthClient.getToken).toHaveBeenCalledWith("code-1");
  });

  it("accepts Google's alternate scopes array", async () => {
    sdk.oauthClient.getToken.mockResolvedValueOnce({
      tokens: { refresh_token: "refresh-3", scopes: ["scope-a", "scope-b"] },
    });
    await expect(exchangeGoogleCode(config, 4317, "code-2")).resolves.toEqual({
      refreshToken: "refresh-3",
      grantedScopes: ["scope-a", "scope-b"],
    });
  });

  it("rejects a code exchange without a refresh token", async () => {
    sdk.oauthClient.getToken.mockResolvedValueOnce({ tokens: {} });
    await expect(exchangeGoogleCode(config, 4317, "code-3")).rejects.toThrow(
      "Google did not return a refresh token",
    );
  });

  it("mints an access token with Google's expiry time", async () => {
    sdk.credentials.expiry_date = Date.parse("2026-08-25T12:00:00.000Z");

    await expect(mintAccessToken(config, 4317)).resolves.toEqual({
      token: "access-token",
      expiresAt: "2026-08-25T12:00:00.000Z",
    });
  });

  it("falls back to the client's stored access credential", async () => {
    sdk.credentials.access_token = "credential-token";
    sdk.oauthClient.getAccessToken.mockResolvedValueOnce({});
    await expect(mintAccessToken(config, 4317)).resolves.toEqual({
      token: "credential-token",
      expiresAt: null,
    });
  });

  it("rejects an access-token response without a token", async () => {
    sdk.oauthClient.getAccessToken.mockResolvedValueOnce({});
    await expect(mintAccessToken(config, 4317)).rejects.toThrow(
      "Google did not return an access token",
    );
  });
});

describe("Google Outputs surface", () => {
  it("binds tasklist lookup to the authorized connection", async () => {
    const outputs = googleOutputs(config, 4317);

    await expect(outputs.findOrCreateTasklist("Followups")).resolves.toBe("list-new");
  });

  it("binds task creation to the authorized connection", async () => {
    const outputs = googleOutputs(config, 4317);

    await expect(
      outputs.createTask(
        "list-new",
        { title: "Call Dana" },
        { sourceFileName: "meeting.md", sourceUrl: null },
      ),
    ).resolves.toMatchObject({ googleId: "task-1" });
  });

  it("binds Gmail drafts to the authorized connection", async () => {
    const outputs = googleOutputs(config, 4317);

    await expect(outputs.createDraft({ subject: "Follow up", body: "Hello" })).resolves.toBe(
      "draft-1",
    );
  });
});

describe("Google connection SDK probes", () => {
  function connectionConfig(): ConfigStore {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-google-probes-"));
    const store = new ConfigStore(join(workspaceDir, "config.json"));
    store.load();
    store.update({ google: { clientId: "id.apps", clientSecret: "secret" } });
    store.setGoogleRefreshToken("refresh-token");
    return store;
  }

  it("spends the refresh token and reports the account Google identifies", async () => {
    const google = openGoogleConnection(connectionConfig(), 4317);

    await expect(google.state()).resolves.toMatchObject({
      state: "connected",
      email: "nicolas@found42.com",
    });
    expect(sdk.oauthClient.getAccessToken).toHaveBeenCalledOnce();
    expect(sdk.gmail.users.getProfile).toHaveBeenCalledWith({ userId: "me" });
  });

  it("keeps the connection usable when Gmail cannot provide a display name", async () => {
    sdk.gmail.users.getProfile.mockRejectedValueOnce(new Error("profile unavailable"));
    const google = openGoogleConnection(connectionConfig(), 4317);

    await expect(google.state()).resolves.toMatchObject({ state: "connected", email: null });
  });
  it("checks every required Google surface with read-only calls", async () => {
    const google = openGoogleConnection(connectionConfig(), 4317);

    await expect(google.verifySetup()).resolves.toMatchObject({
      state: "connected",
      items: [
        { label: "Google Tasks", ok: true },
        { label: "Gmail drafts", ok: true },
        { label: "Gmail history", ok: true },
        { label: "Gmail delivery", ok: true },
        { label: "Google Calendar", ok: true },
        { label: "Google Drive", ok: true },
        { label: "YouTube view counts", ok: true },
      ],
    });
    expect(sdk.tasks.tasklists.list).toHaveBeenCalledWith({ maxResults: 1 });
    expect(sdk.gmail.users.drafts.list).toHaveBeenCalledWith({ userId: "me", maxResults: 1 });
    expect(sdk.gmail.users.threads.list).toHaveBeenCalledWith({ userId: "me", maxResults: 1 });
    expect(sdk.gmail.users.messages.list).toHaveBeenCalledWith({
      userId: "me",
      maxResults: 1,
      q: "in:sent",
    });
    expect(sdk.calendar.events.list).toHaveBeenCalledWith({
      calendarId: "primary",
      maxResults: 1,
      singleEvents: true,
    });
    expect(sdk.drive.files.list).toHaveBeenCalledWith({ pageSize: 1, fields: "files(id)" });
    expect(sdk.youtube.videos.list).toHaveBeenCalledWith({
      part: ["id"],
      chart: "mostPopular",
      maxResults: 1,
    });
  });

  it("checks the configured transcript folder rather than an arbitrary Drive page", async () => {
    const store = connectionConfig();
    store.update({ drive: { folderId: "folder-1" } });

    await openGoogleConnection(store, 4317).verifySetup();

    expect(sdk.drive.files.get).toHaveBeenCalledWith({
      fileId: "folder-1",
      fields: "id, name",
      supportsAllDrives: true,
    });
    expect(sdk.drive.files.list).not.toHaveBeenCalled();
  });
});
