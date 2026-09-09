import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixture";

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

async function waitForStatus(
  request: APIRequestContext,
  runId: string,
  status: "blocked" | "done" | "skipped",
): Promise<void> {
  await expect
    .poll(async () => {
      const detail = (await (
        await request.get(`/api/meeting-debrief/${encodeURIComponent(runId)}`)
      ).json()) as { status: string };
      return detail.status;
    })
    .toBe(status);
}

const REVIEW_WAIT_MS = 31 * 24 * 60 * 60 * 1000;

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
  await waitForStatus(request, seeded.runId, "done");

  // 2. The Debrief list shows the row with prefill and readiness.
  await page.goto("/meeting-debrief");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Debrief" })).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(LINKED_RUN_FILE) });
  await expect(row).toBeVisible();
  await expect(row.getByText("Linked", { exact: true })).toBeVisible();
  await expect(row.getByText("Roster prefilled from Calendar")).toBeVisible();
  await expect(row.getByText(/1 resolved/)).toBeVisible();
  await expect(row.getByText(/^Ready/)).toBeVisible();

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
  await expect(page.getByText("billing fix follow-up").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Roster confirmation", exact: true })).toHaveCount(
    0,
  );

  await expect(page.getByText(/Proposed due Aug 17, 2026/)).toBeVisible();
  await expect(page.getByText("Is the rollout on track?")).toBeVisible();
  await page.getByText("Meeting effectiveness and coaching", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Effectiveness evidence" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Coaching advice" })).toBeVisible();
  await page.getByRole("button", { name: "Create email draft", exact: true }).click();
  await expect(page.getByLabel("Attendee email 1")).toHaveValue("alice@example.com");
  await page.getByRole("button", { name: "Preview and create", exact: true }).click();
  await expect(
    page.getByText("Confirm attendees in the previous step.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("Transcript and identity details", { exact: true }).click();
  await expect(page.getByText("Alice — Profile")).toBeVisible();
  /* Unresolved mentions are grouped by name and counted, not listed once per
     span with an "awaiting review" suffix nothing could ever act on. */
  await expect(page.getByText("Bob", { exact: true })).toBeVisible();

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
  await waitForStatus(request, unlinked.runId, "done");

  await page.goto("/meeting-debrief");
  const unlinkedRow = page.getByRole("row", { name: /Unlinked notes/ });
  await expect(unlinkedRow).toBeVisible();
  await expect(unlinkedRow.getByText("Not linked", { exact: true })).toBeVisible();
  await expect(unlinkedRow.getByText("Roster confirmation required")).toBeVisible();
  await expect(unlinkedRow.getByText(/^Ready/)).toBeVisible();

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
    expect(run.files.sort()).toEqual(["result.json", "review.json"]);
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

const OWNER_EMAIL = "owner@example.com";

/**
 * Establishes the review journey's owner precondition idempotently and
 * verifies it took: the journey never assumes what earlier specs on the
 * shared hermetic server did to the onboarding state.
 */
async function confirmOwner(request: APIRequestContext): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const identity = await request.post("/api/test/owner-identity", {
      data: { email: OWNER_EMAIL },
    });
    expect(identity.ok()).toBe(true);
    const created = await request.post("/api/people", {
      data: { fullName: "Workspace Owner", primaryEmail: OWNER_EMAIL },
    });
    let profileId: string;
    if (created.ok()) {
      profileId = ((await created.json()) as { id: string }).id;
    } else {
      // The owner Profile may already exist from a previous journey pass.
      const existing = (await (
        await request.get("/api/people?query=" + encodeURIComponent(OWNER_EMAIL))
      ).json()) as Array<{ id: string }>;
      const holder = existing[0];
      expect(holder).toBeTruthy();
      profileId = holder.id;
    }
    const confirmed = await request.post("/api/onboarding/owner/confirm", {
      data: { profileId },
    });
    if (!confirmed.ok()) continue;
    const status = (await (await request.get("/api/onboarding/owner")).json()) as {
      confirmed: { confirmedForGoogleEmail: string } | null;
    };
    if (status.confirmed?.confirmedForGoogleEmail === OWNER_EMAIL) return;
  }
  throw new Error("Owner identity could not be confirmed for the review journey");
}

test("meeting debrief review journey — regenerate, roster, recipients, approval lock, redo", async ({
  page,
  request,
}) => {
  await confirmOwner(request);

  // A transcript id unique to this journey: seeding must never re-resolve to
  // a Run another journey on the shared server already created.
  const transcript = transcriptRecord({
    id: "drive_journey_review_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "journey-review",
      fileName: "Review sync - 2026-08-17T13-00-00.000Z.md",
      sourceUrl: null,
      checksum: "journey-checksum-review",
      observedRevision: 1,
      modifiedAt: "2026-08-17T13:05:00.000Z",
    },
    normalizedText: [
      "Alice: We decided to ship the billing fix on Friday.",
      "Bob: I will own the billing fix follow-up.",
      "Bob: Is the rollout on track?",
      "Alice: I will send you the summary, Carol.",
    ].join("\n"),
  });
  const seeded = await seed(request, {
    transcript,
    identity: identityState("drive_journey_link_r1", "profile_alice"),
    profiles: [{ fullName: "Carol", email: "carol@example.com" }],
  });
  await waitForStatus(request, seeded.runId, "done");

  await page.goto(`/meeting-debrief/${encodeURIComponent(seeded.runId)}`);
  await expect(page.getByText(/Debrief ready/).first()).toBeVisible();
  await page.getByRole("button", { name: "Regenerate Summary", exact: true }).click();
  await page.getByRole("button", { name: "Confirm regeneration", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Summary updated" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Create email draft", exact: true }).click();
  await page.getByRole("button", { name: "Add attendee", exact: true }).click();
  await page.getByLabel("Attendee name 3").fill("Owner");
  await page.getByLabel("Attendee email 3").fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Confirm attendees", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Attendees confirmed" })).toBeVisible();
  await page.getByLabel("Find a Person Profile").fill("Carol");
  await page.getByRole("button", { name: "Search profiles", exact: true }).click();
  await page.getByRole("button", { name: "Add recipient", exact: true }).click();
  await page.getByRole("button", { name: "Preview and create", exact: true }).click();
  await page.getByRole("button", { name: "Update preview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Email body", exact: true })).toBeVisible();
  await expect(page.getByText("carol@example.com", { exact: false }).last()).toBeVisible();
  const previewBody = await page.getByLabel("Email body preview").innerText();
  expect((await request.post("/api/test/meeting-debrief/fail-next-draft")).ok()).toBe(true);
  await page.getByRole("button", { name: "Create draft in Gmail", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry draft creation", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Email body preview")).toHaveText(previewBody);
  await page.getByRole("button", { name: "Retry draft creation", exact: true }).click();
  await waitForStatus(request, seeded.runId, "done");
  await expect
    .poll(async () => {
      const detail = (await (
        await request.get(`/api/meeting-debrief/${encodeURIComponent(seeded.runId)}`)
      ).json()) as { review: { state: string } | null };
      return detail.review?.state;
    })
    .toBe("published");
  await expect(page.getByRole("link", { name: "Open draft in Gmail", exact: true })).toBeVisible();
  const drafts: { drafts: { body: string }[] } = await (
    await request.get("/api/test/meeting-debrief/drafts")
  ).json();
  expect(drafts.drafts.at(-1)?.body).toBe(previewBody);
  /* A draft, never a sent message. The Gmail link itself needs a real draft
     receipt, which this hermetic server has no outward surface to create —
     the module test at that seam is where the link is proven. */
  await expect(page.getByText(/Nothing has been sent/).first()).toBeVisible();
  const approvedDetail = (await (
    await request.get(`/api/meeting-debrief/${encodeURIComponent(seeded.runId)}`)
  ).json()) as {
    status: string;
    review: { state: string; automaticRecipients: Array<{ email: string }> };
  };
  expect(approvedDetail.status).toBe("done");
  expect(approvedDetail.review.state).toBe("published");
  expect(approvedDetail.review.automaticRecipients.map((r) => r.email)).toEqual([
    "alice@example.com",
    "bob@example.com",
  ]);
  const lockedTry = await request.post(
    `/api/meeting-debrief/${encodeURIComponent(seeded.runId)}/regenerate`,
    { data: { field: "summary" } },
  );
  expect(lockedTry.status()).toBe(409);

  // 7. Redo after approval: a distinct Run with a duplicate-output warning.
  //    The redo Run is identified through the API — the one Run of this
  //    transcript that is not the approved original — never by diffing the
  //    whole index, which other journeys' Runs also populate.
  await page.getByRole("button", { name: "Start a new Debrief", exact: true }).click();
  let redoRunId: string | null = null;
  await expect
    .poll(async () => {
      const index = (await (await request.get("/api/meeting-debrief/index")).json()) as {
        entries: Array<{ runId: string; transcriptId: string }>;
      };
      const candidates = index.entries.filter(
        (entry) => entry.transcriptId === transcript.id && entry.runId !== seeded.runId,
      );
      redoRunId = candidates[0]?.runId ?? null;
      return redoRunId;
    })
    .toBeTruthy();
  // The detail surface renders once; wait for the redo Run to hold its
  // review record — and the verified warning — before reading it on the page.
  await waitForStatus(request, redoRunId!, "done");
  await expect
    .poll(async () => {
      const detail = (await (
        await request.get(`/api/meeting-debrief/${encodeURIComponent(redoRunId!)}`)
      ).json()) as {
        review: { state: string; duplicateWarning: { approvedRunId: string } | null } | null;
      };
      return detail.review?.duplicateWarning?.approvedRunId ?? null;
    })
    .toBe(seeded.runId);
  await expect(page).toHaveURL(new RegExp(`/meeting-debrief/${encodeURIComponent(redoRunId!)}$`));
  await page.getByRole("button", { name: "Create email draft", exact: true }).click();
  await expect(page.getByText(/Duplicate output warning/)).toBeVisible();
  await expect(page.getByText(new RegExp(seeded.runId))).toBeVisible();
  const redoRun = (await (
    await request.get(`/api/runs/${encodeURIComponent(redoRunId!)}`)
  ).json()) as { events: Array<{ type: string }> };
  expect(redoRun.events.some((event) => event.type === "debrief_redo")).toBe(true);
});

test("meeting debrief journey — a Debrief never expires, and publishing stays gated", async ({
  page,
  request,
}) => {
  const unlinked = await seed(request, {
    transcript: transcriptRecord({
      id: "drive_journey_expiry_r1",
      source: {
        sourceSystem: "drive",
        externalFileId: "journey-expiry",
        fileName: "Expiry notes - 2026-07-01T09-00-00.000Z.md",
        sourceUrl: null,
        checksum: "journey-checksum-3",
        observedRevision: 1,
        modifiedAt: null,
      },
      normalizedText: "Carol: We agreed to revisit the pricing page next week.",
      meetingDate: "2026-07-01",
      occurrence: null,
      speakers: ["Carol"],
      roster: [],
    }),
  });
  await waitForStatus(request, unlinked.runId, "done");

  // Confirming a typed roster with no verified Profile shows the blocker
  // the approval gate refuses on.
  await page.goto(`/meeting-debrief/${encodeURIComponent(unlinked.runId)}`);
  await page.getByRole("button", { name: "Create email draft", exact: true }).click();
  await page.getByRole("button", { name: "Add attendee", exact: true }).click();
  await page.getByLabel("Attendee name 1").fill("Dana");
  await page.getByLabel("Attendee email 1").fill("dana@example.com");
  await page.getByRole("button", { name: "Confirm attendees", exact: true }).click();
  await page.getByRole("button", { name: "Preview and create", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Verify the attendee's Person Profile email", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  /* Time passing takes nothing away. A Debrief used to skip itself after
     thirty unreviewed days, which meant work the owner had not got to was
     deleted on a timer; nothing waits for review now, so nothing expires. */
  const advanced = await request.post("/api/test/meeting-debrief/advance", {
    data: { ms: REVIEW_WAIT_MS },
  });
  expect(advanced.ok()).toBe(true);
  await waitForStatus(request, unlinked.runId, "done");

  await page.goto("/meeting-debrief");
  const row = page.getByRole("row", { name: /Expiry notes/ });
  await expect(row.getByText(/^Ready/)).toBeVisible();

  await page.getByRole("link", { name: /Expiry notes/ }).click();
  await expect(page.getByText(/Debrief ready/).first()).toBeVisible();
  /* Still there, in full: nothing was taken away by the clock. */
  await expect(
    page.getByText("We agreed to revisit the pricing page", { exact: false }).first(),
  ).toBeVisible();

  // Complete and readable, and still outward-silent until it is published.
  const run = (await (
    await request.get(`/api/runs/${encodeURIComponent(unlinked.runId)}`)
  ).json()) as { events: Array<{ type: string }>; files: string[] };
  expect(run.events.filter((event) => /draft|task|gmail|send/i.test(event.type))).toEqual([]);
  expect(run.files.sort()).toEqual(["result.json", "review.json"]);
});
