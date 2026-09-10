import { test, expect } from "@playwright/test";
import fastify from "fastify";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceBackup } from "../../apps/server/src/backup/workspace";
import { TaskStore } from "../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../apps/server/src/tasks/action-items";
import { registerTasksApi } from "../../apps/server/src/api/tasks";

test("the Tasks page reads two isolated restores with owner edits, completion and Trash intact", async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), "backup-browser-"));
  const workspace = join(root, "source");
  const source = new TaskStore(workspace);
  const tasks = new WorkspaceTasks({ store: source });
  const accepted = tasks.create({ title: "Original task" });
  tasks.update(accepted.id, { title: "Owner-edited completed task" });
  tasks.complete(accepted.id);
  const trashed = tasks.create({ title: "Retained in Trash" });
  tasks.trash(trashed.id);
  const expected = source.readTasks();
  const backup = new WorkspaceBackup(workspace, async () => {});
  const web = fileURLToPath(new URL("../../apps/web/dist/", import.meta.url));
  try {
    await backup.capture(join(root, "backup"));
    for (const name of ["first", "second"]) {
      const restored = join(root, name);
      await backup.restore(join(root, "backup"), restored);
      const store = new TaskStore(restored);
      const app = fastify();
      // Compose only local read paths: no intake, provider, delivery or sync exists.
      app.addHook("onRequest", async (request, reply) => {
        if (request.method !== "GET") return reply.code(405).send({ error: "offline-read-only" });
      });
      registerTasksApi(app, {
        tasks: new WorkspaceTasks({ store }),
        actionItems: new WorkspaceActionItems({ store }),
      });
      app.get("/api/people", async () => []);
      app.get("/tasks", async (_, reply) =>
        reply.type("text/html").send(readFileSync(join(web, "index.html"))),
      );
      app.get<{ Params: { file: string } }>("/assets/:file", async (request, reply) => {
        const file = basename(request.params.file);
        return reply
          .type(file.endsWith(".css") ? "text/css" : "text/javascript")
          .send(readFileSync(join(web, "assets", file)));
      });
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const externalRequests: string[] = [];
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === origin) await route.continue();
        else {
          externalRequests.push(route.request().url());
          await route.abort();
        }
      });
      try {
        await page.goto(`${origin}/tasks`);
        await expect(
          page.getByRole("heading", { name: "Owner-edited completed task", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Retained in Trash", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("In Trash · was open · restoring returns it exactly as it was."),
        ).toBeVisible();
        expect(store.readTasks()).toEqual(expected);
        expect(externalRequests).toEqual([]);
      } finally {
        await page.unrouteAll();
        await app.close();
      }
    }
    expect(source.readTasks()).toEqual(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
