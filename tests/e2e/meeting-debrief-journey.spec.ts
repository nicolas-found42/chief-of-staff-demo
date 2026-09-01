import { expect, test, type APIRequestContext } from "@playwright/test";

const LINKED_RUN_FILE = "Linked sync - 2026-08-17T13-00-00.000Z.md";

function transcriptRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "drive_journey_link_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "journey-link",
      fileName: LINKED_RUN_FILE,
      sourceUrl: null,
      checksum: "journey-checksum-1",
      observedRevision: 1,
      modifiedAt: "2026-08-17T13:05:00.000Z",
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: [
      "Alice: We decided to ship the billing fix on Friday.",
      "Alice: I will own the billing fix follow-up.",
      "Bob: Is the rollout on track?",
    ].join("\n"),
    meetingDate: "2026-08-17",
    occurrence: { occurrenceKey: "evt1::2026-08-17T13:00:00Z", calendarEventId: "evt1" },
    speakers: ["Alice", "Bob"],
    speakerIdentityMappings: [],
    roster: [
      { displayName: "Alice", email: "alice@example.com" },
      { displayName: "Bob", email: "bob@example.com" },
    ],
    ...overrides,
  };
}

function mention(id: string, surfaceText: string, transcriptId: string): Record<string, unknown> {
  return {
    id,
    kind: "person",
    surfaceText,
    normalizedForms: [surfaceText.toLowerCase()],
    emails: [],
    profileUrls: [],
    verifiedHandles: {},
    externalContactIds: [],
    speakerCalendarEmail: null,
    titles: [],
    roles: [],
    aliases: [],
    relationshipAssertions: [],
    rosterContext: [],
    organizationContext: null,
    attendeeStatus: "speaker",
    confidence: "high",
    provenance: {
      transcriptId,
      spanStart: 0,
      spanEnd: surfaceText.length,
      quote: surfaceText,
      timestamp: null,
      speakerLabel: null,
      meetingDate: null,
    },
    minedAt: "2026-08-31T12:00:00.000Z",
    algorithmVersion: 1,
  };
}

function identityState(transcriptId: string, profileId: string): Record<string, unknown> {
  return {
    mentions: [mention("m_alice", "Alice", transcriptId), mention("m_bob", "Bob", transcriptId)],
    decisions: [
      {
        id: `d_${transcriptId}_alice`,
        mentionId: "m_alice",
        transcriptId,
        action: "confirm",
        outcome: "linked",
        profileId,
        profileRevision: 1,
        decidedBy: "owner",
        decidedAt: "2026-08-31T12:00:00.000Z",
        note: null,
        mappingAuthority: null,
      },
    ],
    organizations: [],
  };
}

async function seed(
  request: APIRequestContext,
  payload: Record<string, unknown>,
): Promise<{ runId: string }> {
  const response = await request.post("/api/test/meeting-debrief/seed", { data: payload });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { runId: string };
}

async function waitForDone(request: APIRequestContext, runId: string): Promise<void> {
  await expect
    .poll(async () => {
      const detail = (await (
        await request.get(`/api/meeting-debrief/${encodeURIComponent(runId)}`)
      ).json()) as { status: string };
      return detail.status;
    })
    .toBe("done");
}

test("meeting debrief hermetic journey — seed → list → detail → unlinked → idempotent → no outward writes", async ({
  page,
  request,
}) => {
  // 1. A Calendar-linked transcript with identity review state is mined.
  const linkedTranscript = transcriptRecord();
  const seeded = await seed(request, {
    transcript: linkedTranscript,
    identity: identityState("drive_journey_link_r1", "profile_alice"),
  });
  await waitForDone(request, seeded.runId);

  // 2. The Debrief list shows the row with prefill and readiness.
  await page.goto("/meeting-debrief");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Debrief" })).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(LINKED_RUN_FILE) });
  await expect(row).toBeVisible();
  await expect(row.getByText("Linked", { exact: true })).toBeVisible();
  await expect(row.getByText("Roster prefilled from Calendar")).toBeVisible();
  await expect(row.getByText(/1 resolved/)).toBeVisible();
  await expect(row.getByText("Ready for review")).toBeVisible();

  // 3. The detail journey shows extraction, roster, identity, and readiness.
  await page.getByRole("link", { name: LINKED_RUN_FILE }).click();
  await expect(page).toHaveURL(new RegExp(`/meeting-debrief/${seeded.runId}$`));
  await expect(page.getByRole("heading", { name: LINKED_RUN_FILE })).toBeVisible();
  await expect(
    page.getByText("Retrospective of " + LINKED_RUN_FILE, { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("We decided to ship the billing fix on Friday").first(),
  ).toBeVisible();
  await expect(page.getByText("billing fix follow-up")).toBeVisible();
  await expect(page.getByText("(confirmed Profile)").first()).toBeVisible();
  await expect(page.getByText(/due 2026-08-17/)).toBeVisible();
  await expect(page.getByText("Is the rollout on track?")).toBeVisible();
  await expect(page.getByText("Effectiveness evidence")).toBeVisible();
  await expect(page.getByText("Coaching advice")).toBeVisible();
  await expect(
    page.getByText("Calendar-linked: occurrence evt1::2026-08-17T13:00:00Z"),
  ).toBeVisible();
  await expect(page.getByText("Roster prefilled from the Calendar association.")).toBeVisible();
  await expect(page.getByText("Alice — confirmed Profile")).toBeVisible();
  await expect(page.getByText("Bob — awaiting review")).toBeVisible();

  // 4. An unlinked transcript visibly requires manual roster confirmation.
  const unlinked = await seed(request, {
    transcript: transcriptRecord({
      id: "drive_journey_unlink_r1",
      source: {
        sourceSystem: "drive",
        externalFileId: "journey-unlink",
        fileName: "Unlinked notes - 2026-08-18T09-00-00.000Z.md",
        sourceUrl: null,
        checksum: "journey-checksum-2",
        observedRevision: 1,
        modifiedAt: null,
      },
      normalizedText: "Carol: We agreed to revisit the pricing page next week.",
      meetingDate: "2026-08-18",
      occurrence: null,
      speakers: ["Carol"],
      roster: [],
    }),
    identity: identityState("drive_journey_unlink_r1", "profile_alice"),
  });
  await waitForDone(request, unlinked.runId);

  await page.goto("/meeting-debrief");
  const unlinkedRow = page.getByRole("row", { name: /Unlinked notes/ });
  await expect(unlinkedRow).toBeVisible();
  await expect(unlinkedRow.getByText("Not linked", { exact: true })).toBeVisible();
  await expect(unlinkedRow.getByText("Roster confirmation required")).toBeVisible();
  await expect(unlinkedRow.getByText("Waiting for roster confirmation")).toBeVisible();

  // 5. Re-mining the same transcripts never duplicates Debrief Runs.
  const reseeded = await seed(request, {
    transcript: linkedTranscript,
    identity: identityState("drive_journey_link_r1", "profile_alice"),
  });
  expect(reseeded.runId).toBe(seeded.runId);
  const index = (await (await request.get("/api/meeting-debrief/index")).json()) as {
    entries: Array<{ transcriptId: string }>;
  };
  expect(index.entries).toHaveLength(2);

  // 6. Nothing was written outward: no draft/Task events, no outward artifact.
  for (const runId of [seeded.runId, unlinked.runId]) {
    const run = (await (await request.get(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
      events: Array<{ type: string }>;
      files: string[];
    };
    expect(run.events.filter((event) => /draft|task|gmail|send/i.test(event.type))).toEqual([]);
    expect(run.files).toEqual(["result.json"]);
    const raw = await (
      await request.get(`/api/runs/${encodeURIComponent(runId)}/artifacts/result.json`)
    ).text();
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      "debrief",
      "extractedAt",
      "transcriptId",
      "version",
    ]);
  }
});
