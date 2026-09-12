import { confirmMeetingOwner } from "./meeting-owner-fixture";
import { test, expect } from "./fixture";

// Each acceptance case uses a fresh, fully composed application.
test.use({ freshWorkspace: true });

test("recent results and contextual review survive a failed Brief and a later failed Debrief", async ({
  page,
  request,
}) => {
  const seeded = await request.post("/api/test/meetings/overview-fixture");
  expect(seeded.ok()).toBe(true);
  const fixture = (await seeded.json()) as {
    todayId: string;
    briefRunId: string;
    recent: { id: string; runId: string; transcriptId: string }[];
  };
  await page.goto("/meetings");
  const today = page.getByRole("region", { name: "Today", exact: true });
  const recent = page.getByRole("region", { name: "Recent meetings", exact: true });
  await expect(today.getByRole("link", { name: "Today's planning", exact: true })).toBeVisible();
  await expect(today).toContainText("Brief failed");
  await expect(today).not.toContainText("47");
  await expect(recent.getByRole("link", { name: "Debrief ready", exact: true })).toHaveCount(5);
  await expect(page.getByText("Awaiting approval (47)", { exact: true })).toBeVisible();
  await page.route(`**/api/runs/${fixture.briefRunId}/retry`, (route) =>
    route.fulfill({ status: 503, json: { error: "retry unavailable" } }),
  );
  await today.getByRole("button", { name: "Retry brief", exact: true }).click();
  await expect(today.getByRole("status")).toContainText("Brief retry failed");
  await expect(recent.getByRole("link", { name: "Debrief ready", exact: true })).toHaveCount(5);
  const latest = fixture.recent[4];
  expect(
    (
      await request.post("/api/test/meetings/failed-debrief", {
        data: { transcriptId: latest.transcriptId },
      })
    ).ok(),
  ).toBe(true);
  await expect(recent).toContainText("Latest attempt failed");
  const latestRow = recent.getByRole("listitem").filter({ hasText: "September 5 planning" });
  await latestRow.getByRole("link", { name: "Debrief ready", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/meetings/${latest.id}\\?tab=debrief`));
  await expect(page.getByText("We agreed on the September 5 plan.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Action Items", exact: true })).toBeVisible();
  await page.goto("/meetings");
  await page
    .getByRole("listitem")
    .filter({ hasText: "September 5 planning · 11 pending" })
    .getByRole("link", { name: "Review on source Meeting" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/meetings/${latest.id}\\?tab=debrief#action-items`));
  await expect(page.getByText(/From Sep 5, 2026/).first()).toBeVisible();
  await expect(page.getByText(/Proposed due Sep 6, 2026 — in the past/).first()).toBeVisible();
  const proposal = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Follow up tomorrow 5-0", exact: true }) });
  await expect(proposal).toContainText("Unassigned");
  await proposal.getByText("Original evidence", { exact: true }).click();
  await expect(proposal).toContainText("Stored excerpt and timestamp unavailable");
  await proposal.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.goto("/meetings");
  await expect(page.getByText("Awaiting approval (46)", { exact: true })).toBeVisible();
  await page
    .getByRole("listitem")
    .filter({ hasText: "September 5 planning · 10 pending" })
    .getByRole("link", { name: "Review on source Meeting" })
    .click();
  await page.getByText("Reviewed Action Items (1)", { exact: true }).click();
  await page.getByRole("button", { name: "Restore to pending", exact: true }).click();
  await page.goto("/meetings");
  await expect(page.getByText("Awaiting approval (47)", { exact: true })).toBeVisible();
  await page.goto(`/tasks?meetingId=${fixture.recent[3].id}#action-items`);
  await page.getByRole("link", { name: "Review on source Meeting", exact: true }).click();
  const withEvidence = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Follow up tomorrow 4-1", exact: true }) });
  await withEvidence.getByText("Original evidence", { exact: true }).click();
  await expect(withEvidence.getByRole("blockquote")).toHaveText("Bob: I will follow up tomorrow.");
  await expect(withEvidence).toContainText("00:15");
  const messages = await (await request.get("/api/test/meeting-brief/fake-gmail/messages")).json();
  expect(messages.messages).toHaveLength(0);
});

test("complete Meeting Debrief exposes outcomes before supporting detail", async ({
  page,
  request,
}) => {
  expect((await request.post("/api/test/meetings/overview-fixture")).ok()).toBe(true);
  await page.goto("/meetings");
  await page
    .getByRole("region", { name: "Recent meetings", exact: true })
    .getByRole("link", { name: "September 5 planning", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open questions", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Coaching advice", exact: true }),
  ).not.toBeVisible();
  await page.getByText("Meeting effectiveness and coaching", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Coaching advice", exact: true })).toBeVisible();
});

test("Meeting inline review uses canonical Tasks and bounds pending proposals", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  await page.goto("/meetings");
  await page
    .getByRole("region", { name: "Recent meetings", exact: true })
    .getByRole("link", { name: "September 5 planning", exact: true })
    .click();
  const actions = page.getByRole("region", { name: "Action Items", exact: true });
  await expect(actions.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(5);
  await actions.getByRole("button", { name: "Show all 11 pending Action Items" }).click();
  const proposal = actions
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Follow up tomorrow 5-0", exact: true }) });
  await proposal.getByRole("button", { name: "Create completed Task", exact: true }).click();
  await expect(
    proposal.getByText("Task Destination: Local only · Inbox", { exact: true }),
  ).toBeVisible();
  await expect(proposal.getByLabel("Notes", { exact: true })).not.toBeVisible();
  await proposal.getByText("More options", { exact: true }).click();
  await expect(proposal.getByLabel("Notes", { exact: true })).toBeVisible();
  await proposal.getByLabel("Title", { exact: true }).fill("Reviewed completed follow-up");
  await proposal
    .locator("form")
    .getByRole("button", { name: "Create completed Task", exact: true })
    .click();
  await expect(actions.getByRole("status")).toContainText(
    "Created completed Task: Reviewed completed follow-up",
  );
  const tasks: { tasks: { title: string }[] } = await (
    await request.get("/api/tasks?status=completed")
  ).json();
  expect(
    tasks.tasks.some((task: { title: string }) => task.title === "Reviewed completed follow-up"),
  ).toBe(true);
  const dismiss = actions.getByRole("button", { name: "Dismiss", exact: true }).first();
  await dismiss.click();
  await actions.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(actions.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(10);
});

test("Meeting header is compact and supporting disclosures survive reload", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/meetings");
  await page
    .getByRole("region", { name: "Recent meetings", exact: true })
    .getByRole("link", { name: "September 5 planning", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeInViewport();
  const supporting = page.getByText("Meeting effectiveness and coaching", { exact: true });
  await supporting.click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Coaching advice", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("email preparation is optional and attendee edits survive panel steps", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  await page.goto("/meetings");
  await page
    .getByRole("region", { name: "Recent meetings", exact: true })
    .getByRole("link", { name: "September 5 planning", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Attendees and recipients", exact: true }),
  ).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "Create email draft", exact: true });
  await trigger.click();
  await expect(
    page.getByRole("heading", { name: "Attendees and recipients", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add attendee", exact: true }).click();
  await page.getByLabel("Attendee name 1").fill("Alice");
  await page.getByLabel("Attendee email 1").fill("alice@example.com");
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByLabel("Attendee email 1")).toHaveValue("alice@example.com");
  await page.getByRole("button", { name: "Preview and create", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Preview and create", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Attendee email 1")).toHaveValue("alice@example.com");
  const { promise: holdConfirmation, resolve: releaseConfirmation } = Promise.withResolvers<void>();
  await page.route("**/api/meeting-debrief/*/roster", async (route) => {
    const response = await route.fetch();
    await holdConfirmation;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Confirm attendees", exact: true }).click();
  await expect(page.getByLabel("Attendee email 1")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add attendee", exact: true })).toBeDisabled();
  releaseConfirmation();
  await expect(page.getByLabel("Attendee email 1")).toBeEnabled();
  await expect(page.getByLabel("Attendee email 1")).toHaveValue("alice@example.com");
  await page.unroute("**/api/meeting-debrief/*/roster");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
});

test("field regeneration explains durable Action Item review and retains readable content", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  await page.goto("/meetings");
  await page
    .getByRole("region", { name: "Recent meetings", exact: true })
    .getByRole("link", { name: "September 5 planning", exact: true })
    .click();
  const actions = page.getByRole("region", { name: "Action Items", exact: true });
  await actions.getByRole("button", { name: "Dismiss", exact: true }).first().click();
  await page.getByRole("button", { name: "Regenerate Action Items", exact: true }).click();
  await expect(
    page.getByText(
      "New proposals may be added. Existing Tasks and canonical review decisions survive.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm regeneration", exact: true }).click();
  await expect(page.getByText("We agreed on the September 5 plan.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Action Items updated" })).toBeVisible();
  await expect(actions).toContainText("10 pending · 1 reviewed");
});

test("current specialist Debrief link resolves to its owning Meeting", async ({
  page,
  request,
}) => {
  const fixture = await (await request.post("/api/test/meetings/overview-fixture")).json();
  const latest = fixture.recent[4];
  await page.goto(`/meeting-debrief/${latest.runId}`);
  await expect(page).toHaveURL(new RegExp(`/meetings/${latest.id}\\?tab=debrief`));
  await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
});

test("weekly work keeps accepted Task previews and complete Meeting approval navigation", async ({
  page,
  request,
}) => {
  await request.post("/api/test/meetings/overview-fixture");
  /* Due dates relative to the real clock: the server groups Tasks against
     today, so a fixed date silently crosses from due into overdue. */
  const dueDateFromToday = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const overdueDate = dueDateFromToday(-4);
  const dueDate = dueDateFromToday(1);
  for (let n = 0; n < 7; n++) {
    expect(
      (
        await request.post("/api/tasks", {
          data: { title: `Weekly overdue ${n}`, dueDate: overdueDate },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.post("/api/tasks", {
          data: { title: `Weekly due ${n}`, dueDate },
        })
      ).ok(),
    ).toBe(true);
  }
  await page.goto("/meetings/weekly");
  const overdue = page.getByRole("region", { name: "Overdue Tasks", exact: true });
  await expect(overdue.getByRole("listitem")).toHaveCount(5);
  await expect(page.getByText("Workspace-wide work", { exact: true })).toBeVisible();
  const pending = page.getByRole("region", { name: "Action Items awaiting review", exact: true });
  await expect(pending).toContainText("Awaiting approval (47)");
  await expect(pending.getByRole("listitem")).toHaveCount(5);
  await expect(pending.getByRole("button", { name: "Create Task", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "View all 7 overdue Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Weekly overdue 6", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Weekly due 0", exact: true })).toHaveCount(0);
});

test("returning to History restores filters and reading position", async ({ page, request }) => {
  await request.post("/api/test/meetings/history-fixture");
  await page.goto("/meetings/history?search=History&from=2020-01-01");
  const link = page.getByRole("link", { name: "History session 20", exact: true });
  await link.scrollIntoViewIfNeeded();
  const position = await page.evaluate(() => window.scrollY);
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: "History session 20" })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Search meetings")).toHaveValue("History");
  await expect(link).toBeInViewport();
  await expect
    .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - position))
    .toBeLessThan(60);
});

test("regeneration marks new proposals and retains omitted canonical decisions", async ({
  page,
  request,
}) => {
  const fixture = await (await request.post("/api/test/meetings/overview-fixture")).json();
  const latest = fixture.recent[4];
  const detail = await (await request.get(`/api/meeting-debrief/${latest.runId}`)).json();
  await page.goto("/meetings");
  await page
    .getByRole("region", { name: "Recent meetings", exact: true })
    .getByRole("link", { name: "September 5 planning", exact: true })
    .click();
  const actions = page.getByRole("region", { name: "Action Items", exact: true });
  await actions.getByRole("button", { name: "Dismiss", exact: true }).first().click();
  expect(
    (
      await request.post("/api/test/meeting-debrief/extraction", {
        data: {
          transcriptId: latest.transcriptId,
          extraction: {
            ...detail.extraction,
            actionItems: [
              detail.extraction.actionItems[0],
              { ...detail.extraction.actionItems[1], title: "Changed wording commitment" },
              {
                title: "New follow-up commitment",
                owner: null,
                ownerProfileId: null,
                ownerMentionId: null,
                dueDate: null,
              },
            ],
          },
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole("button", { name: "Regenerate Action Items", exact: true }).click();
  await page.getByRole("button", { name: "Confirm regeneration", exact: true }).click();
  await expect(actions.getByRole("status").filter({ hasText: "2 new Action Items" })).toBeVisible();
  await actions
    .getByRole("button", { name: "Show all 12 pending Action Items", exact: true })
    .click();
  await expect(
    actions.getByRole("heading", { name: "Follow up tomorrow 5-10", exact: true }),
  ).toBeVisible();
  await expect(actions.getByLabel("New proposal")).toHaveCount(2);
  await expect(actions).toContainText("12 pending · 1 reviewed");
});

test("earlier Debrief links retain their exact version and current links resolve", async ({
  page,
  request,
}) => {
  const fixture = await (await request.post("/api/test/meetings/overview-fixture")).json();
  const latest = fixture.recent[4];
  const original = await (await request.get(`/api/meeting-debrief/${latest.runId}`)).json();
  await request.post("/api/test/meeting-debrief/extraction", {
    data: {
      transcriptId: latest.transcriptId,
      extraction: { ...original.extraction, summary: "Revised September 5 summary." },
    },
  });
  await confirmMeetingOwner(request);
  await request.post(`/api/meeting-debrief/${latest.runId}/roster`, {
    data: { entries: [{ email: "owner@example.com" }] },
  });
  const preview = await (
    await request.post(`/api/meeting-debrief/${latest.runId}/preview`, {
      data: { selectedIds: [] },
    })
  ).json();
  expect(
    (
      await request.post(`/api/meeting-debrief/${latest.runId}/approve`, {
        data: { revision: preview.revision, selectedIds: [] },
      })
    ).ok(),
  ).toBe(true);
  await expect
    .poll(async () =>
      Boolean(
        (await (await request.get(`/api/meeting-debrief/${latest.runId}`)).json()).review?.draft,
      ),
    )
    .toBe(true);
  const next = await (await request.post(`/api/meeting-debrief/${latest.runId}/redo`)).json();
  await expect
    .poll(
      async () =>
        (
          (await (await request.get(`/api/meeting-debrief/${next.runId}`)).json()) as {
            status: string;
          }
        ).status,
    )
    .toBe("done");
  await page.goto(`/meeting-debrief/${latest.runId}`);
  await expect(
    page.getByText("Earlier version · this link retains the original Debrief.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("We agreed on the September 5 plan.", { exact: true })).toBeVisible();
  await expect(page.getByText("Revised September 5 summary.", { exact: true })).toHaveCount(0);
  const actions = page.getByRole("region", { name: "Action Items", exact: true });
  await expect(actions).toContainText("Original extracted proposals");
  await expect(actions.getByRole("button", { name: "Create Task", exact: true })).toHaveCount(0);
  await expect(actions.getByRole("link", { name: "Review on source Meeting" })).toBeVisible();

  await page.goto(`/meeting-debrief/${next.runId}`);
  await expect(page).toHaveURL(new RegExp(`/meetings/${latest.id}\\?tab=debrief`));
  await expect(page.getByText("Revised September 5 summary.", { exact: true })).toBeVisible();
});

test("counted jumps reveal complete decisions and Action Items with keyboard focus", async ({
  page,
  request,
}) => {
  const fixture = await (await request.post("/api/test/meetings/overview-fixture")).json();
  await page.goto(`/meetings/${fixture.recent[4].id}?tab=debrief`);
  await page.getByRole("link", { name: "Decisions (8)", exact: true }).click();
  await expect(page.getByRole("region", { name: "Decisions", exact: true })).toContainText(
    "Proceed with plan 5, decision 8.",
  );
  await page.getByRole("link", { name: "Action Items (11)", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Follow up tomorrow 5-10", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Follow up tomorrow 5-10", exact: true }),
  ).toBeVisible();
});

test("email selection uses original proposal after editing its canonical Task", async ({
  page,
  request,
}) => {
  const fixture = await (await request.post("/api/test/meetings/overview-fixture")).json();
  await page.goto(`/meetings/${fixture.recent[4].id}?tab=debrief`);
  const actions = page.getByRole("region", { name: "Action Items", exact: true });
  await actions.getByRole("button", { name: "Create Task", exact: true }).first().click();
  await actions.getByLabel("Title", { exact: true }).fill("Later tracking title");
  await actions.locator("form").getByRole("button", { name: "Create Task", exact: true }).click();
  await expect(actions).toContainText("10 pending · 1 reviewed");
  await page.getByRole("button", { name: "Create email draft", exact: true }).click();
  await page.getByRole("button", { name: "Preview and create", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Follow up tomorrow 5-0", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Update preview", exact: true }).click();
  await expect(page.getByLabel("Email body preview")).toContainText("Follow up tomorrow 5-0");
  await expect(page.getByLabel("Email body preview")).not.toContainText("Later tracking title");
});
