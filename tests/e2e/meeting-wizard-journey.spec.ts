import { expect, test } from "./fixture";

/**
 * Meeting Wizard journey (issues #136, #151): the home reads the Meeting store
 * and lists today's Meetings in start order, each linking to its own page; a
 * day with no meetings says so; the Brief journey keeps Prepare now; the
 * legacy product route and adapter surface answer not-found.
 */

/** Today's local date at a fixed hour, so the fixtures land on the home's day. */
function atTodayLocal(hour: number): string {
  const at = new Date();
  at.setHours(hour, 0, 0, 0);
  return at.toISOString();
}

const NOW_BEFORE_DUE = atTodayLocal(9);

function fixtureEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startAt = (overrides.startAt as string | undefined) ?? atTodayLocal(11);
  return {
    calendarId: "primary",
    eventId: "evt_wizard_1",
    occurrenceId: startAt,
    version: "v1",
    summary: "Internal planning",
    description: "Q4 planning",
    startAt,
    endAt: new Date(Date.parse(startAt) + 60 * 60 * 1000).toISOString(),
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

test("meeting wizard home — a day with no meetings says so", async ({ page }) => {
  // Fresh hermetic workspace: no Meeting recorded carries today's date.
  await page.goto("/meetings");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Wizard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today's meetings" })).toBeVisible();
  await expect(page.getByText("No meetings today.")).toBeVisible();
});

test("meeting wizard journey — home lists today's Meetings from the store, Brief journey, legacy surface gone", async ({
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

  // Two meetings today at different hours, both Eligible.
  const internalEvent = fixtureEvent({
    summary: "Internal planning",
    startAt: atTodayLocal(11),
  });
  const externalEvent = fixtureEvent({
    eventId: "evt_wizard_2",
    summary: "External kickoff",
    startAt: atTodayLocal(15),
    attendees: [
      { email: "owner@example.com", responseStatus: "accepted", organizer: true },
      { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
    ],
  });
  for (const event of [internalEvent, externalEvent]) {
    expect((await request.post("/api/test/meeting-brief/schedule", { data: { event } })).ok()).toBe(
      true,
    );
  }
  // The intake pass records each occurrence as a Meeting (ADR-0050).
  expect((await request.post("/api/meeting-brief/reconcile")).ok()).toBe(true);

  const meetingsRes = await request.get("/api/meetings/list");
  expect(meetingsRes.ok()).toBe(true);
  const store = (await meetingsRes.json()) as { meetings: { id: string; title: string }[] };
  const internal = store.meetings.find((m) => m.title === "Internal planning");
  const external = store.meetings.find((m) => m.title === "External kickoff");
  if (!internal || !external) throw new Error("Meeting store did not record both meetings");

  // The home lists both in start order and links each to its page; the
  // brief-record projection it replaced is gone.
  await page.goto("/meetings");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Wizard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today's meetings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Upcoming eligible meetings" })).toHaveCount(0);
  const cards = page.locator("li.card");
  await expect(cards.filter({ hasText: "Internal planning" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "External kickoff" })).toHaveCount(1);

  await expect(
    cards.filter({ hasText: "Internal planning" }).getByRole("link", { name: "Internal planning" }),
  ).toHaveAttribute("href", `/meetings/${internal.id}`);
  await expect(
    cards.filter({ hasText: "External kickoff" }).getByRole("link", { name: "External kickoff" }),
  ).toHaveAttribute("href", `/meetings/${external.id}`);

  // Following a home link reaches that Meeting's page.
  await cards
    .filter({ hasText: "Internal planning" })
    .getByRole("link", { name: "Internal planning" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Internal planning" })).toBeVisible();

  // Prepare now lives on the Brief journey; the internal meeting delivers.
  await page.goto("/meetings/brief");
  const internalCard = page.locator("li.card").filter({ hasText: "Internal planning" }).first();
  await internalCard.getByRole("button", { name: "Prepare now" }).click();
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/meeting-brief/index");
        const data = (await res.json()) as {
          briefs: { occurrenceKey: string; delivery: { status: string } | null }[];
        };
        const brief = data.briefs.find((b) => b.occurrenceKey.startsWith("evt_wizard_1"));
        return brief?.delivery?.status ?? "none";
      },
      { timeout: 15_000 },
    )
    .toBe("sent");

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
  expect(idxAfter.upcoming.some((u) => u.occurrenceKey.startsWith("evt_wizard_2"))).toBe(true);

  // The legacy product route answers not-found; the legacy adapter API is gone.
  await page.goto("/meeting-brief");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  const legacyStatus = await request.get("/api/meeting-brief/guest-profile/status");
  expect(legacyStatus.status()).toBe(404);
});
