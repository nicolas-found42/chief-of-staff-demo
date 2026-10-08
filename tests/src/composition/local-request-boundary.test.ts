import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "@chief-of-staff-demo/shared";
import { composeShell, type Shell } from "../../../apps/server/src/composition/shell";

let shell: Shell;
let directory: string;
const port = 4997;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cos-request-boundary-"));
  shell = await composeShell({ workspaceDir: directory, port });
});

afterEach(async () => {
  shell.stop();
  await shell.app.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the composed local server request boundary", () => {
  it.each([
    "https://attacker.invalid",
    "http://localhost:4996",
    "http://127.0.0.1:4996",
    "null",
    "http://localhost:4997.attacker.invalid",
  ])("refuses %s before a bodyless action can mutate work", async (origin) => {
    const created = await shell.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Keep this Task open" },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json<Task>();
    const refused = await shell.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/complete`,
      headers: { origin },
    });
    expect(refused.statusCode).toBe(403);
    expect((await shell.app.inject(`/api/tasks/${task.id}`)).json()).toEqual(task);
  });

  it.each([
    "attacker.invalid:4997",
    "localhost.attacker.invalid",
    "127.0.0.1.attacker.invalid",
    "attacker@localhost:4997",
  ])("refuses an untrusted Host %s even without Origin", async (host) => {
    const response = await shell.app.inject({ url: "/api/config", headers: { host } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "untrusted-host" });
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "preserves app requests on %s and native clients without Origin",
    async (host) => {
      const headers = { host: `${host}:${port}`, origin: `http://${host}:${port}` };
      const response = await shell.app.inject({
        method: "POST",
        url: "/api/tasks",
        headers,
        payload: { title: "Local capture" },
      });
      expect(response.statusCode).toBe(201);
      expect((await shell.app.inject({ url: "/api/tasks", headers })).json().tasks).toHaveLength(1);
      expect(
        (
          await shell.app.inject({ url: "/api/health", headers: { host: `${host}:${port}` } })
        ).json(),
      ).toEqual({ ok: true });
    },
  );

  it.each(["cross-site", "same-site"])(
    "refuses %s API fetches even when Origin is absent",
    async (site) => {
      const response = await shell.app.inject({
        url: "/api/config",
        headers: { "sec-fetch-site": site, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" },
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it.each(["/%61pi/tasks", "/a%70i/config"])(
    "checks the matched API route for encoded path %s",
    async (url) => {
      const response = await shell.app.inject({
        url,
        headers: { "sec-fetch-site": "cross-site" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "untrusted-origin" });
    },
  );

  it("preserves Google's top-level callback but refuses a cross-site callback fetch", async () => {
    const headers = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    const callback = await shell.app.inject({
      url: "/api/google/callback?error=access_denied",
      headers,
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/settings?google=access_denied");
    expect(
      (
        await shell.app.inject({
          url: "/api/google/callback?error=access_denied",
          headers: { ...headers, "sec-fetch-mode": "cors" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await shell.app.inject({ url: "/tasks", headers })).statusCode).toBe(200);
  });
});
