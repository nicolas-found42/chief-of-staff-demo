import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeShell, type Shell } from "../../../apps/server/src/composition/shell";
import { TaskCutover } from "../../../apps/server/src/tasks/cutover";

/**
 * Installation credential custody (#480), exercised through the composed public
 * HTTP surface over a real temporary Workspace. Process environment is the
 * installation boundary; Workspace configuration is the owner boundary.
 */

const CREDENTIAL_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
] as const;

let priorEnvironment: Record<string, string | undefined> = {};
let shell: Shell | null = null;
let workspaceDir = "";

function clearCredentialEnvironment(): void {
  for (const name of CREDENTIAL_ENV) delete process.env[name];
}

beforeEach(() => {
  priorEnvironment = Object.fromEntries(CREDENTIAL_ENV.map((name) => [name, process.env[name]]));
  clearCredentialEnvironment();
  workspaceDir = mkdtempSync(join(tmpdir(), "installation-credentials-http-"));
});

afterEach(async () => {
  if (shell) {
    shell.stop();
    await shell.app.close();
    shell = null;
  }
  for (const name of CREDENTIAL_ENV) {
    const value = priorEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

async function compose(): Promise<Shell> {
  shell = await composeShell({ workspaceDir, port: 4999 });
  return shell;
}

function workspaceConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function getConfig(app: Shell["app"]): Promise<Record<string, unknown>> {
  const response = await app.inject({ method: "GET", url: "/api/config" });
  expect(response.statusCode).toBe(200);
  return response.json<Record<string, unknown>>();
}

describe("installation credentials over public config HTTP", () => {
  it("reports every missing installation credential without storing legacy fields in a fresh Workspace", async () => {
    const app = await compose();

    const body = await getConfig(app.app);
    const installation = await app.app.inject({
      method: "GET",
      url: "/api/config.installation",
    });
    expect(installation.statusCode).toBe(200);
    expect(body.installation).toEqual(installation.json());

    expect(body.installation).toEqual({
      googleClient: { state: "missing" },
      providerKeys: {
        openrouter: { state: "missing" },
        openai: { state: "missing" },
        anthropic: { state: "missing" },
        gemini: { state: "missing" },
      },
      ollama: { state: "not-required" },
    });
    expect(body.config).not.toHaveProperty("apiKey");
    expect(body.config).not.toHaveProperty("google.clientId");
    expect(body.config).not.toHaveProperty("google.clientSecret");

    const persisted = workspaceConfig();
    expect(persisted).not.toHaveProperty("apiKey");
    expect(persisted).not.toHaveProperty("google.clientId");
    expect(persisted).not.toHaveProperty("google.clientSecret");
  });

  it("refuses legacy credentials at startup without changing them before explicit migration", async () => {
    expect(new TaskCutover({ workspaceDir }).initializePristine()).toBe(true);
    const legacy = {
      provider: "openrouter",
      model: "inception/mercury-2.5",
      apiKey: "legacy-provider-key-must-remain-until-migration",
      google: {
        clientId: "legacy-client-id-must-remain.apps.googleusercontent.com",
        clientSecret: "legacy-client-secret-must-remain",
        refreshToken: "workspace-refresh-token",
        lastConnectedAt: null,
        hasExpiredBefore: false,
      },
    };
    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify(legacy), "utf8");

    let startupError: unknown = null;
    try {
      await compose();
    } catch (error) {
      startupError = error;
    }
    expect(startupError).toBeInstanceOf(Error);

    expect(workspaceConfig()).toMatchObject({
      apiKey: legacy.apiKey,
      google: {
        clientId: legacy.google.clientId,
        clientSecret: legacy.google.clientSecret,
        refreshToken: legacy.google.refreshToken,
      },
    });
  });

  it("reports the Google pair and provider keys as status only, never values or fragments", async () => {
    const secrets = {
      GOOGLE_CLIENT_ID: "installation-client-id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "installation-client-secret-7f3a",
      OPENROUTER_API_KEY: "installation-openrouter-key-91bc",
      OPENAI_API_KEY: "installation-openai-key-22de",
      ANTHROPIC_API_KEY: "installation-anthropic-key-a840",
      GEMINI_API_KEY: "installation-gemini-key-115c",
    };
    Object.assign(process.env, secrets);
    const app = await compose();

    const body = await getConfig(app.app);

    expect(body.installation).toEqual({
      googleClient: { state: "configured" },
      providerKeys: {
        openrouter: { state: "configured" },
        openai: { state: "configured" },
        anthropic: { state: "configured" },
        gemini: { state: "configured" },
      },
      ollama: { state: "not-required" },
    });
    for (const secret of Object.values(secrets)) {
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(workspaceConfig())).not.toContain(secret);
    }
    expect(JSON.stringify(body)).not.toMatch(/7f3a|91bc|22de|a840|115c/);
  });

  it("treats an incomplete Google client pair as missing", async () => {
    process.env.GOOGLE_CLIENT_ID =
      "only-half-of-the-installation-client.apps.googleusercontent.com";
    const app = await compose();

    const body = await getConfig(app.app);

    expect(body.installation).toMatchObject({ googleClient: { state: "missing" } });
    expect(JSON.stringify(body)).not.toContain(
      "only-half-of-the-installation-client.apps.googleusercontent.com",
    );
  });

  it("treats a provider key as missing when its process value is empty", async () => {
    process.env.OPENROUTER_API_KEY = "";
    const app = await compose();

    const body = await getConfig(app.app);

    expect(body.installation).toMatchObject({
      providerKeys: { openrouter: { state: "missing" } },
    });
  });

  it("rejects secret-bearing Workspace config updates and leaves no secret on disk", async () => {
    const app = await compose();
    const offered = {
      apiKey: "workspace-provider-key-must-not-persist",
      google: {
        clientId: "workspace-google-id-must-not-persist.apps.googleusercontent.com",
        clientSecret: "workspace-google-secret-must-not-persist",
      },
    };

    const response = await app.app.inject({
      method: "PUT",
      url: "/api/config",
      payload: offered,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(offered.apiKey);
    expect(response.body).not.toContain(offered.google.clientId);
    expect(response.body).not.toContain(offered.google.clientSecret);
    const bytes = readFileSync(join(workspaceDir, "config.json"), "utf8");
    expect(bytes).not.toContain(offered.apiKey);
    expect(bytes).not.toContain(offered.google.clientId);
    expect(bytes).not.toContain(offered.google.clientSecret);
  });

  it("allows only installed cloud providers and Ollama as Workspace provider choices", async () => {
    process.env.OPENROUTER_API_KEY = "installed-openrouter-key";
    const app = await compose();

    const missing = await app.app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { provider: "openai", model: "gpt-5.2" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<Record<string, unknown>>().error).toBeTypeOf("string");

    const installed = await app.app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { provider: "openrouter", model: "inception/mercury-2.5" },
    });
    expect(installed.statusCode).toBe(200);

    const local = await app.app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { provider: "ollama", model: "nemotron" },
    });
    expect(local.statusCode).toBe(200);

    const body = await getConfig(app.app);
    expect(body.config).toMatchObject({ provider: "ollama", model: "nemotron" });
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(true);
  });
});
