import { createServer } from "node:http";
import type { Task } from "@chief-of-staff-demo/shared";
import { expect, test } from "./fixture";

test("another local website cannot submit a bodyless Task action", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const created = await request.post("/api/tasks", { data: { title: "Keep this Task open" } });
  expect(created.status()).toBe(201);
  const task: Task = await created.json();
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><body><h1>Unrelated local website</h1>
      <form method="POST" enctype="text/plain" action="${baseURL}/api/tasks/${task.id}/complete">
        <button>Submit the cross-origin probe</button>
      </form></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No probe server port");
    await page.goto(`http://127.0.0.1:${address.port}`);
    const response = page.waitForResponse(`${baseURL}/api/tasks/${task.id}/complete`);
    await page.getByRole("button", { name: "Submit the cross-origin probe" }).click();
    expect((await response).status()).toBe(403);
    await expect(page.getByText(/untrusted-origin/)).toBeVisible();
    expect(await (await request.get(`/api/tasks/${task.id}`)).json()).toEqual(task);
    await page.screenshot({ path: testInfo.outputPath("cross-origin-refused.png") });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("an uninitiated Google callback gives a reconnect path", async ({ page }) => {
  await page.goto("/api/google/callback?code=unsolicited-code");
  await expect(page).toHaveURL(/\/settings\?google=state_mismatch$/);
  await expect(page.getByRole("alert").filter({ hasText: "Google sign-in" })).toContainText(
    "Connect Google again",
  );
});
