import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixture";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/**
 * The Tasks browser journey (issues #173, #174, #177): capture a Task with a
 * title alone, complete and reopen it, edit its full details, organize Task
 * Lists, and read the pending Action Items a Meeting Debrief proposed without
 * any of them looking like accepted work.
 *
 * Nothing here is connected to a provider. The hermetic Workspace has no
 * Google account, which is the point: the whole area has to work anyway.
 */
async function scanForViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, results.violations.map((v) => v.id).join(", ")).toEqual([]);
}

test("tasks journey — nav → quick add → complete → reopen → edit → lists", async ({ page }) => {
  // 1. Tasks is a top-level product area reachable from explicit navigation.
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Tasks" })
    .click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeFocused();
  await expect(page.getByText("No open Tasks. Quick Add above captures one.")).toBeVisible();

  // 2. Quick Add takes a title and nothing else — reached from the keyboard,
  //    submitted from the keyboard, and it hands focus back for the next one.
  await page.getByLabel("Task title").click();
  await page.keyboard.type("Send the billing follow-up");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { level: 3, name: "Send the billing follow-up" }),
  ).toBeVisible();
  await expect(page.getByLabel("Task title")).toBeFocused();
  await expect(page.getByLabel("Task title")).toHaveValue("");
  // The defaults the Workspace filed it under, stated on the row itself.
  await expect(page.getByText("Inbox · no due date · no priority · You")).toBeVisible();

  // 3. Completing moves it out of open work; reopening brings it back.
  await page.getByRole("button", { name: "Complete" }).click();
  await expect(page.getByText("Nothing completed yet.")).toHaveCount(0);
  await expect(page.getByText("No open Tasks. Quick Add above captures one.")).toBeVisible();
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByText("Nothing completed yet.")).toBeVisible();

  // 4. A Task List of the owner's own, then the full detail edit that files
  //    the Task into it without changing what the Task is.
  await page.getByLabel("New Task List").fill("Billing");
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Billing" })).toBeVisible();

  await page.getByRole("button", { name: "Edit details" }).click();
  await page.getByLabel("Notes").fill("Include the Q3 numbers.");
  await page.getByLabel("Due date").fill("2026-09-11");
  await page.getByLabel("Priority").selectOption("high");
  await page.getByLabel("Task List", { exact: true }).selectOption({ label: "Billing" });
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Billing · due 2026-09-11 · high priority · You")).toBeVisible();
  await expect(page.getByText("Include the Q3 numbers.")).toBeVisible();
  // Focus returns to the control that opened the form.
  await expect(page.getByRole("button", { name: "Edit details" })).toBeFocused();

  // 5. A list that still holds a Task is refused rather than emptied.
  await page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 3, name: "Billing" }) })
    .getByRole("button", { name: "Delete list" })
    .click();
  await expect(page.getByRole("alert")).toContainText("still holds 1 Task");

  // 6. Refreshing the route is safe, and the Workspace still holds everything.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "Send the billing follow-up" }),
  ).toBeVisible();
  await expect(page.getByText("No Action Items are waiting.")).toBeVisible();

  await scanForViolations(page);
});

test("tasks journey — a Debrief's Action Items arrive as proposals, not Tasks", async ({
  page,
  request,
}) => {
  const fileName = "Tasks journey - 2026-08-19T13-00-00.000Z.md";
  const seeded = await request.post("/api/test/meeting-debrief/seed", {
    data: {
      transcript: {
        id: "drive_tasks_journey_r1",
        source: {
          sourceSystem: "drive",
          externalFileId: "tasks-journey",
          fileName,
          sourceUrl: null,
          checksum: "tasks-journey-checksum",
          observedRevision: 1,
          modifiedAt: "2026-08-19T13:05:00.000Z",
        },
        ingestedAt: "2026-08-31T12:00:00.000Z",
        extractorVersion: 1,
        normalizedText: [
          "Dana: We decided to move the pricing page review to Thursday.",
          "Dana: I will own the pricing page rewrite.",
        ].join("\n"),
        meetingDate: "2026-08-19",
        occurrence: null,
        speakers: ["Dana"],
        speakerIdentityMappings: [],
        roster: [],
      },
    },
  });
  expect(seeded.ok(), `seed failed: ${seeded.status()}`).toBe(true);
  const { runId } = (await seeded.json()) as { runId: string };

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/meeting-debrief/${encodeURIComponent(runId)}`);
      return ((await detail.json()) as { status: string }).status;
    })
    .toBe("done");

  await page.goto("/tasks");
  await expect(page.getByRole("heading", { level: 2, name: "Action Items" })).toBeVisible();
  const proposal = page
    .getByRole("listitem")
    .filter({ hasText: "own the pricing page rewrite" })
    .first();
  await expect(proposal).toBeVisible();
  await expect(proposal.getByText(/^Proposed ·/)).toBeVisible();
  await expect(proposal.getByRole("link", { name: "Open full Debrief" })).toHaveAttribute(
    "href",
    `/meeting-debrief/${runId}`,
  );

  // A proposal is not accepted work: it carries no Task controls, and the
  // extraction created no Task of its own.
  await expect(proposal.getByRole("button", { name: "Complete" })).toHaveCount(0);
  const tasks = (await (await request.get("/api/tasks")).json()) as {
    tasks: Array<{ title: string }>;
  };
  expect(tasks.tasks.map((task) => task.title)).not.toContain("own the pricing page rewrite");
});
