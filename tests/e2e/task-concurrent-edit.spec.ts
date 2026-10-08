import { expect, test } from "./fixture";

for (const moveGroup of [false, true]) {
  test(`a stale Task form preserves work and recovers (group move: ${moveGroup})`, async ({
    page,
    context,
    request,
  }) => {
    const response = await request.post("/api/tasks", { data: { title: "Concurrent edit probe" } });
    expect(response.status()).toBe(201);
    const task = await response.json();
    const row = page.locator(`#task-${task.id}`);
    await page.goto("/tasks");
    await row.getByRole("button", { name: "Edit details", exact: true }).click();
    await row.getByLabel("Notes", { exact: true }).fill("First editor's unsaved notes");

    const second = await context.newPage();
    await second.goto("/tasks");
    const secondRow = second.locator(`#task-${task.id}`);
    await secondRow.getByRole("button", { name: "Edit details", exact: true }).click();
    await secondRow.getByLabel("Title", { exact: true }).fill("Second editor's accepted title");
    if (moveGroup) await secondRow.getByLabel("Due date", { exact: true }).fill("2027-01-15");
    await secondRow.getByRole("button", { name: "Save details", exact: true }).click();
    await expect(secondRow.getByRole("heading")).toHaveText("Second editor's accepted title");

    // Refresh proves that the form guards its opening snapshot, not the latest polled version.
    await page.getByRole("button", { name: "Refresh Tasks", exact: true }).click();
    await expect(row.getByRole("heading")).toHaveText("Second editor's accepted title");
    await expect(row.getByLabel("Title", { exact: true })).toHaveValue("Concurrent edit probe");
    await row.getByRole("button", { name: "Save details", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("changed since you read it");
    await expect(row.getByLabel("Notes", { exact: true })).toHaveValue(
      "First editor's unsaved notes",
    );
    expect((await (await request.get(`/api/tasks/${task.id}`)).json()).title).toBe(
      "Second editor's accepted title",
    );

    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.getByRole("button", { name: "Edit details", exact: true }).click();
    await expect(row.getByLabel("Title", { exact: true })).toHaveValue(
      "Second editor's accepted title",
    );
    await row.getByLabel("Notes", { exact: true }).fill("Reviewed notes after recovery");
    await row.getByRole("button", { name: "Save details", exact: true }).click();
    await expect(row.getByText("Reviewed notes after recovery", { exact: true })).toBeVisible();
    await second.close();
  });
}
