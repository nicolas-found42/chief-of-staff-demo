import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@chief-of-staff-demo/shared";
import { registerApi } from "../../../apps/server/src/api/router";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { PersonProfileResolver } from "../../../apps/server/src/person-profile/resolver";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store.js";
import { WorkspaceMeetingJoin } from "../../../apps/server/src/meetings/join.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { ConfigStore } from "../../../apps/server/src/config";
import { openGoogleConnection } from "../../../apps/server/src/google/connection";
import { GOOGLE_SCOPES } from "../../../apps/server/src/google/oauth";
import { openRuns } from "../../../apps/server/src/runs";

let app: FastifyInstance;
let configStore: ConfigStore;
let probe: () => Promise<{ email: string | null }>;
let mintAccessToken: () => Promise<{ token: string; expiresAt: string | null }>;
let exchangeCode: (
  config: AppConfig,
  port: number,
  code: string,
) => Promise<{ refreshToken: string; grantedScopes: string[] }>;

const originalGoogleEnvironment = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
};

function setGoogleCredentials(clientId: string, clientSecret: string): void {
  process.env.GOOGLE_CLIENT_ID = clientId;
  process.env.GOOGLE_CLIENT_SECRET = clientSecret;
}

function restoreGoogleEnvironment(): void {
  for (const [name, value] of Object.entries(originalGoogleEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-google-callback-"));
  setGoogleCredentials("id.apps", "secret");
  configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  configStore.setGoogleRefreshToken("stored-refresh");
  probe = async () => ({ email: "nicolas@found42.com" });
  mintAccessToken = async () => ({ token: "picker-token", expiresAt: null });
  exchangeCode = async (_config, _port, code) => ({
    refreshToken: `refresh-${code}`,
    grantedScopes: [...GOOGLE_SCOPES],
  });

  const google = openGoogleConnection(configStore, 4317, {
    probe: () => probe(),
    mintAccessToken: () => mintAccessToken(),
    exchangeCode: (config, port, code) => exchangeCode(config, port, code),
  });

  app = fastify({ logger: false });
  const peopleStore = new PersonProfileStore(workspaceDir);
  const peopleProfiles = new WorkspacePersonProfiles({
    store: peopleStore,
    lifecycle: [],
  });
  const ownerOnboarding = new OwnerOnboarding({ people: peopleProfiles, workspaceDir });
  const meetings = new WorkspaceMeetings(workspaceDir);
  await registerApi(app, {
    runs: openRuns(workspaceDir),
    port: 4317,
    configStore,
    modules: [],
    google,
    people: peopleProfiles,
    peopleResolver: new PersonProfileResolver({ store: peopleStore, sources: [] }),
    meetings,
    meetingJoin: new WorkspaceMeetingJoin({
      meetings,
      listTranscripts: () => [],
      attachMeeting: async () => undefined,
    }),
    onboarding: ownerOnboarding,
    /* No Content Engine or Tasks route is exercised here, so the interfaces
       behind them are never reached. */
    contentProjects: fromPartial({}),
    tasks: fromPartial({}),
    actionItems: fromPartial({}),
    taskLinking: fromPartial({}),
    asanaLinking: fromPartial({}),
    /* No mock is admitted here: these tests exercise the Google surface under
       the production posture (issue #198). */
    mockProviderAvailable: false,
    onConfigChanged: () => {},
  });
  await app.ready();
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  restoreGoogleEnvironment();
});

describe("GET /api/google/picker-token", () => {
  it("returns a freshly minted token only for a connected Google connection", async () => {
    const response = await app.inject({ method: "GET", url: "/api/google/picker-token" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ token: "picker-token", expiresAt: null });
  });

  it("names the connection state when no token can be minted", async () => {
    probe = async () => {
      throw Object.assign(new Error("invalid_grant"), {
        response: { data: { error: "invalid_grant" } },
      });
    };

    const response = await app.inject({ method: "GET", url: "/api/google/picker-token" });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/expired/i);
  });

  it("surfaces a minting failure as a gateway error", async () => {
    mintAccessToken = async () => {
      throw new Error("token endpoint unavailable");
    };

    const response = await app.inject({ method: "GET", url: "/api/google/picker-token" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "token endpoint unavailable" });
  });
});

describe("GET /api/google/callback", () => {
  async function callbackUrl(code: string): Promise<string> {
    const connect = await app.inject("/api/google/connect");
    const state = new URL(connect.json<{ authUrl: string }>().authUrl).searchParams.get("state");
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    return `/api/google/callback?code=${code}&state=${state}`;
  }

  it.each(["", "&state=forged"])(
    "refuses an unsolicited callback %s before exchanging any code",
    async (suffix) => {
      const exchange = vi.fn(exchangeCode);
      exchangeCode = exchange;
      const response = await app.inject(`/api/google/callback?code=unsolicited${suffix}`);
      expect(response.headers.location).toBe("/settings?google=state_mismatch");
      expect(exchange).not.toHaveBeenCalled();
      expect(configStore.get().google.refreshToken).toBe("stored-refresh");
    },
  );

  it("consumes state once and refuses replay without overwriting the grant", async () => {
    const url = await callbackUrl("accepted");
    expect((await app.inject(url)).headers.location).toBe("/settings?google=connected");
    expect((await app.inject(url)).headers.location).toBe("/settings?google=state_mismatch");
    expect(configStore.get().google.refreshToken).toBe("refresh-accepted");
  });

  it("keeps the legitimate pending attempt after a mismatched state", async () => {
    const url = await callbackUrl("legitimate");
    expect(
      (await app.inject("/api/google/callback?code=forged&state=wrong")).headers.location,
    ).toBe("/settings?google=state_mismatch");
    expect(configStore.get().google.refreshToken).toBe("stored-refresh");
    expect((await app.inject(url)).headers.location).toBe("/settings?google=connected");
  });

  it("invalidates an older attempt when sign-in starts again or disconnects", async () => {
    const old = await callbackUrl("old");
    const current = await callbackUrl("current");
    expect((await app.inject(old)).headers.location).toBe("/settings?google=state_mismatch");
    await app.inject({ method: "POST", url: "/api/google/disconnect" });
    expect((await app.inject(current)).headers.location).toBe("/settings?google=state_mismatch");
    expect(configStore.get().google.refreshToken).toBeNull();
  });

  it("expires an abandoned sign-in and preserves the existing connection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const url = await callbackUrl("expired");
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect((await app.inject(url)).headers.location).toBe("/settings?google=state_mismatch");
    expect(configStore.get().google.refreshToken).toBe("stored-refresh");
  });

  it.each(["disconnect", "new-sign-in"])(
    "does not commit an in-flight exchange after %s",
    async (action) => {
      let finish: () => void = () => {};
      let started: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      exchangeCode = async () => {
        started();
        await pending;
        return { refreshToken: "obsolete-grant", grantedScopes: [...GOOGLE_SCOPES] };
      };
      const oldUrl = await callbackUrl("old-in-flight");
      const callback = app.inject(oldUrl);
      // Begin the exchange, then interrupt it from another browser action.
      const completion = callback.then((response) => response);
      await entered;
      let currentUrl: string | undefined;
      if (action === "disconnect")
        await app.inject({ method: "POST", url: "/api/google/disconnect" });
      else currentUrl = await callbackUrl("new-attempt");
      finish();
      expect((await completion).headers.location).toBe("/settings?google=state_mismatch");
      expect(configStore.get().google.refreshToken).toBe(
        action === "disconnect" ? null : "stored-refresh",
      );
      if (currentUrl) {
        exchangeCode = async () => ({
          refreshToken: "current-grant",
          grantedScopes: [...GOOGLE_SCOPES],
        });
        expect((await app.inject(currentUrl)).headers.location).toBe("/settings?google=connected");
        expect(configStore.get().google.refreshToken).toBe("current-grant");
      }
    },
  );
  it.each([
    ["/api/google/callback?error=access_denied", "/settings?google=access_denied"],
    ["/api/google/callback?error=server_error", "/settings?google=error"],
    ["/api/google/callback", "/settings?google=error"],
  ])("redirects a refused or incomplete callback", async (url, location) => {
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(location);
  });

  it("stores a successful grant before returning to Settings", async () => {
    configStore.setGoogleRefreshToken(null);

    const response = await app.inject({
      method: "GET",
      url: await callbackUrl("grant-code"),
    });

    expect(response.headers.location).toBe("/settings?google=connected");
    const status = await app.inject({ method: "GET", url: "/api/google/status" });
    expect(status.json().state).toBe("connected");
  });

  it("names every permission Google omitted from the grant", async () => {
    exchangeCode = async () => ({
      refreshToken: "partial-refresh",
      grantedScopes: [
        "https://www.googleapis.com/auth/tasks",
        "https://www.googleapis.com/auth/youtube.readonly",
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: await callbackUrl("partial-grant"),
    });

    expect(response.headers.location).toBe(
      "/settings?google=scope_missing&missing=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.compose%2Chttps%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly%2Chttps%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send%2Chttps%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly%2Chttps%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive",
    );
  });

  it("names a registered redirect URI mismatch", async () => {
    exchangeCode = async () => {
      throw Object.assign(new Error("redirect_uri_mismatch"), {
        response: { data: { error: "redirect_uri_mismatch" } },
      });
    };

    const response = await app.inject({
      method: "GET",
      url: await callbackUrl("mismatch"),
    });

    expect(response.headers.location).toBe("/settings?google=redirect_uri_mismatch");
  });

  it("returns an unclassified exchange failure to Settings", async () => {
    exchangeCode = async () => {
      throw new Error("exchange failed");
    };

    const response = await app.inject({
      method: "GET",
      url: await callbackUrl("generic"),
    });

    expect(response.headers.location).toBe("/settings?google=error");
  });
});
