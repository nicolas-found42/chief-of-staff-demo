import { expect, test } from "@playwright/test";

const NOW_BEFORE_DUE = "2026-08-28T10:00:00.000Z";
const START_AT = "2026-08-28T15:00:00.000Z";

/**
 * Meeting Wizard journey (issue #136): the Overview read projection and the
 * sibling Brief journey over internal and external Eligible Meetings, with
 * the legacy product route and adapter surface answering not-found.
 */
function fixtureEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    calendarId: "primary",
    eventId: "evt_wizard_1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Internal planning",
    description: "Q4 planning",
    startAt: START_AT,
    endAt: "2026-08-28T15:30:00.000Z",
    location: "Room A",
    conferenceLink: "https://meet.example.com/abc",
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [
      { email: "owner@example.com", responseStatus: "accepted", organizer: true },
      { email: "bob@internal.example.com", displayName: "Bob", responseStatus: "accepted" },
    ],
    attachments: [],
    ...overrides,
  };
}

test("meeting wizard journey — Overview projects internal + external meetings, Prepare now, Brief journey, legacy surface gone", async ({
  page,
  request,
}) => {
  // Setup: Internal Domains + a clean fake Gmail mailbox.
  await request.post("/api/test/meeting-brief/set-now", { data: { now: NOW_BEFORE_DUE } });
  const cfgRes = await request.put("/api/meeting-brief/config", {
    data: { internalDomains: ["internal.example.com"] },
  });
  expect(cfgRes.ok()).toBe(true);
  await request.post("/api/test/meeting-brief/fake-gmail/clear");

  // One internal meeting and one external meeting, both Eligible.
  const internalEvent = fixtureEvent({ summary: "Internal planning" });
  const externalEvent = fixtureEvent({
    eventId: "evt_wizard_2",
    summary: "External kickoff",
    attendees: [
      { email: "owner@example.com", responseStatus: "accepted", organizer: true },
      { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
    ],
  });
  expect(
    (
      await request.post("/api/test/meeting-brief/schedule", { data: { event: internalEvent } })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.post("/api/test/meeting-brief/schedule", { data: { event: externalEvent } })
    ).ok(),
  ).toBe(true);

  // The Meeting Wizard Overview read projection lists both upcoming meetings.
  const overviewRes = await request.get("/api/meetings/overview");
  expect(overviewRes.ok()).toBe(true);
  const overview = (await overviewRes.json()) as {
    upcoming: { occurrenceKey: string; summary: string }[];
  };
  const internalKey = overview.upcoming.find((u) => u.summary === "Internal planning");
  const externalKey = overview.upcoming.find((u) => u.summary === "External kickoff");
  if (!internalKey || !externalKey)
    throw new Error("Overview did not list both scheduled meetings");

  // Overview surface: both meetings visible, no current briefs yet.
  await page.goto("/meetings");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Wizard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Upcoming eligible meetings" })).toBeVisible();
  await expect(page.getByText("Internal planning")).toBeVisible();
  await expect(page.getByText("External kickoff")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Brief readiness" })).toBeVisible();
  // Back on the Overview: Prepare now on the internal meeting.
  await page.goto("/meetings");
  await expect(page.getByText("Internal planning")).toBeVisible();
  // Prepare now on the internal meeting from the Overview.
  const internalCard = page.locator("li.card").filter({ hasText: "Internal planning" }).first();
  await internalCard.getByRole("button", { name: "Prepare now" }).click();
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/meeting-brief/index");
        const data = (await res.json()) as {
          briefs: { occurrenceKey: string; delivery: { status: string } | null }[];
        };
        const brief = data.briefs.find((b) => b.occurrenceKey === internalKey.occurrenceKey);
        return brief?.delivery?.status ?? "none";
      },
      { timeout: 15_000 },
    )
    .toBe("sent");

  // The Overview shows the prepared internal meeting under Brief readiness.
  await page.goto("/meetings");
  const readiness = page.getByRole("region", { name: "Brief readiness" });
  const internalReady = readiness.locator("li.card").filter({ hasText: "Internal planning" });
  await expect(internalReady.getByText("Sent", { exact: true })).toBeVisible();

  // Brief journey: the per-occurrence route shows the pinned Brief revision.
  await page.goto(`/meetings/brief/${encodeURIComponent(internalKey.occurrenceKey)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Brief" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Revision history" })).toBeVisible();
  await expect(page.getByText(/version v1/).first()).toBeVisible();
  await expect(
    page.getByText("Brief for Internal planning", { exact: true }).first(),
  ).toBeVisible();

  // Owner-only delivery: no external attendee ever receives a Brief.
  const gmail = (await (
    await request.get("/api/test/meeting-brief/fake-gmail/messages")
  ).json()) as { messages: { to: string; subject: string }[] };
  expect(gmail.messages).toHaveLength(1);
  expect(gmail.messages[0].to).toBe("owner@example.com");

  // The external meeting still waits for its scheduled preparation time.
  const idxAfter = (await (await request.get("/api/meeting-brief/index")).json()) as {
    upcoming: { occurrenceKey: string }[];
  };
  expect(idxAfter.upcoming.some((u) => u.occurrenceKey === externalKey.occurrenceKey)).toBe(true);

  // The legacy product route answers not-found; the legacy adapter API is gone.
  await page.goto("/meeting-brief");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  const legacyStatus = await request.get("/api/meeting-brief/guest-profile/status");
  expect(legacyStatus.status()).toBe(404);
});
