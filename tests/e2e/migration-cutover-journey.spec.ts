import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * The one-time Workspace migration at the browser level (issue #144, spec
 * § Migration and Cutover and its cutover acceptance criteria): the gate
 * holds every normal API surface, the Shell renders the gate instead of the
 * product navs, the preview is content-free, cancelling is a client no-op
 * that the Workspace survives byte-for-byte across a full gated boot, the
 * typed phrase performs the in-process cutover, onboarding receives the
 * user with the seven exact steps, and Home is the product's front door
 * again once onboarding is under way.
 *
 * Two hermetic servers are in play:
 * - The shared browser-suite server (playwright.config webServer, port 4319)
 *   boots post-cutover; this journey arms its gate through
 *   /api/test/migration/arm, drives the whole confirm path, and disarms
 *   through /api/test/migration/disarm — in the test AND unconditionally in
 *   afterAll, so a mid-journey failure can never leave the shared server
 *   holding the gate for the rest of the serial suite.
 * - A second instance (port 4410) boots a pre-cutover Workspace with NO
 *   migration marker, spawned from e2e/start-server.mjs with
 *   MIGRATION_TEST_WORKSPACE_DIR. On it, the Cancel proof spans the gated
 *   boot itself: a sha256 snapshot taken before the process exists must
 *   still deep-equal a snapshot taken after the boot, the status and
 *   inventory reads, and the Cancel — byte-for-byte, exactly as the gate
 *   page's own copy promises.
 *
 * The banner-disappearance half of the Home banner contract is not driven
 * here: completing every onboarding step needs a real connected Google
 * grant (provider-enablement reads google.state === "connected"), and no
 * hermetic seam can produce one — the same limit that keeps the connected
 * banner states unit-tested in tests/src/unit/connection-notice.test.ts.
 * The journey asserts the banner present while onboarding is incomplete;
 * "complete" (every step's done read from the real stores) is the status
 * aggregator's contract, covered in tests/src/api/migration-routes.test.ts.
 */

/* The exact phrase the reset demands. Kept as a literal mirror of
   MIGRATION_CONFIRMATION_PHRASE (apps/server/src/migration/workspace.ts): the
   suite imports no app module, so the constant's stability is asserted by the
   journey's own success — a renamed phrase fails the confirm step loudly. */
const PHRASE = "RESET WORKSPACE";
const OWNER_EMAIL = "migration-owner@example.com";

/* The seven exact step ids in their fixed order (spec: Migration and Cutover). */
const ONBOARDING_STEP_IDS = [
  "provider-enablement",
  "owner-profile",
  "brand-voice",
  "internal-domains",
  "transcript-folder",
  "sheets-destinations",
  "workflow-bundles",
] as const;

const SHARED_ORIGIN = "http://127.0.0.1:4319";
const SECOND_PORT = 4410;
const SECOND_ORIGIN = `http://127.0.0.1:${SECOND_PORT}`;

const FOUR_AREAS = [
  ["Content Engine", "/content-scout"],
  ["Content Research", "/content-research"],
  ["Person Profiles", "/people"],
  ["Meeting Wizard", "/meetings"],
] as const;

let secondServer: ChildProcess | null = null;
let secondWorkspace: string | null = null;

/** Recursive relative-path + sha256 lines, sorted — the Workspace's bytes, content-free to this suite. */
function snapshotWorkspace(dir: string): string[] {
  const lines: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(child);
      } else {
        const hash = createHash("sha256")
          .update(readFileSync(join(dir, child)))
          .digest("hex");
        lines.push(`${hash} ${child}`);
      }
    }
  };
  walk("");
  return lines.sort();
}

/** A pre-cutover Workspace: hermetic defaults plus product state in every directory category. */
function buildPreCutoverWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "runs", "run_legacy"), { recursive: true });
  mkdirSync(join(dir, "person-profiles", "person_legacy"), { recursive: true });
  mkdirSync(join(dir, "content-scout"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      provider: "mock",
      model: "",
      apiKey: "",
      tasklistName: "Legacy Meeting Followups",
      google: {
        clientId: "legacy-client-id.apps.googleusercontent.com",
        clientSecret: "legacy-client-secret",
        refreshToken: "legacy-refresh-token",
        lastConnectedAt: "2026-08-01T00:00:00.000Z",
        hasExpiredBefore: true,
      },
      drive: {
        enabled: true,
        folderId: "legacy-folder-id",
        folderName: "Transcripts",
        pollIntervalMinutes: 2,
      },
      ollama: { baseUrl: "http://127.0.0.1:11434" },
      modules: {
        "content-scout": {
          dailyTime: "08:00",
          weeklyDiscoveryDay: 1,
          weeklyDiscoveryTime: "09:00",
        },
        "youtube-trends": {
          channels: [
            {
              id: "UClegacy0000000000000000",
              handle: "@legacy",
              title: "Legacy Channel",
              uploadsPlaylistId: "UUlegacy0000000000000000",
              addedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          spreadsheetId: "legacy-sheet",
          spreadsheetUrl: "",
        },
      },
    }),
  );
  writeFileSync(join(dir, "runs", "run_legacy", "transcript.txt"), "legacy transcript body");
  writeFileSync(join(dir, "person-profiles", "person_legacy", "current.json"), "{}");
  writeFileSync(join(dir, "content-scout", "state.json"), "{}");
  writeFileSync(join(dir, "mock-result.json"), "{}");
}

/** Waits for a spawned server's health endpoint, failing with the last error if it never answers. */
async function waitForHealth(url: string, deadlineMs = 20_000): Promise<void> {
  const started = Date.now();
  let last: unknown = null;
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = new Error(`health answered ${res.status}`);
    } catch (err) {
      last = err;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await promise;
  }
  throw new Error(`server at ${url} never became healthy: ${String(last)}`);
}

/** Restores the shared hermetic server after the journey, whatever happened to it. Idempotent. */
async function disarmSharedServer(): Promise<void> {
  const res = await fetch(`${SHARED_ORIGIN}/api/test/migration/disarm`, { method: "POST" });
  const body = (await res.json()) as { state?: string };
  expect(res.ok, `disarm failed: ${res.status} ${JSON.stringify(body)}`).toBe(true);
  expect(body.state).toBe("completed");
}

test.afterAll(async () => {
  if (secondServer) {
    secondServer.kill("SIGTERM");
    secondServer = null;
  }
  if (secondWorkspace) {
    rmSync(secondWorkspace, { recursive: true, force: true });
    secondWorkspace = null;
  }
  // The gate arm/disarm seam is exempt from the 503 preHandler exactly for
  // this call, so an armed mid-journey failure cannot poison the serial suite.
  await disarmSharedServer();
});

test("migration cutover journey — gate holds, Cancel touches nothing, the phrase cutover lands on onboarding, and Home is live again", async ({
  page,
}) => {
  // Seed one known Run while ungated, so the gate's inventory has real content
  // to prove it never excerpts: the preview reports counts, never content.
  const seed = await page.request.post("/api/test/seed");
  expect(seed.ok(), `seed failed: ${seed.status()} ${await seed.text()}`).toBe(true);

  // AC 1: arming clears the completed marker and activates the hold.
  const arm = await page.request.post("/api/test/migration/arm");
  expect(arm.ok(), `arm failed: ${arm.status()} ${await arm.text()}`).toBe(true);
  expect(await arm.json()).toEqual({ state: "required" });

  // AC 2: while the gate holds, every normal /api route refuses 503.
  const runsRefused = await page.request.get("/api/runs");
  expect(runsRefused.status()).toBe(503);
  expect(await runsRefused.json()).toEqual({ error: "migration-required" });

  // AC 3: the Shell's landmarks hold, but no product navigation is offered.
  await page.goto("/");
  await expect(page.locator(".app-shell .skip-link")).toBeAttached();
  await expect(page.locator("main.app-main")).toBeAttached();
  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace migration" }),
    "the gate page is what '/' renders while gated",
  ).toBeVisible();
  for (const label of ["Products", "Modules", "Settings"]) {
    await expect(
      page.locator(`nav[aria-label="${label}"]`),
      `no ${label} nav is offered while gated`,
    ).toHaveCount(0);
  }

  // The inventory is content-free: every category renders its name and count,
  // and the seeded Run's file name — content — appears nowhere on the page.
  const inventoryResponse = await page.request.get("/api/migration/inventory");
  expect(inventoryResponse.ok(), `inventory failed: ${inventoryResponse.status()}`).toBe(true);
  const inventory = (await inventoryResponse.json()) as {
    outcome: string;
    categories?: { name: string; classification: string; count: number }[];
  };
  expect(inventory.outcome).toBe("inventory");
  const runsCategory = inventory.categories?.find(
    (category) => category.name === "runs-and-artifacts",
  );
  expect(runsCategory, "the preview must inventory the Runs category").toBeDefined();
  expect(runsCategory?.count ?? 0).toBeGreaterThan(0);
  await expect(
    page.locator("main#main"),
    `the gate page must show the ${runsCategory?.name} count the preview named`,
  ).toContainText(`${runsCategory?.name} — ${runsCategory?.count}`);
  await expect(page.locator("main#main")).not.toContainText("sample-transcript.md");

  // A direct load of a product route still renders the gate: the boot gate is
  // the Shell's, not a redirect — no route escapes it client-side.
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "Workspace migration" })).toBeVisible();

  // AC 5 (first half): cancelling is a client-only action. Watch every
  // response for the receipt endpoint while navigating away.
  const confirmRequests: string[] = [];
  const watchConfirm = (response: { url(): string }): void => {
    if (response.url().includes("/api/migration/confirm")) confirmRequests.push(response.url());
  };
  page.on("response", watchConfirm);
  await page.getByRole("button", { name: "Cancel and keep this Workspace" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Workspace migration" })).toBeVisible();
  expect(confirmRequests, "Cancel must send no confirm request").toEqual([]);
  page.off("response", watchConfirm);

  // AC 5 (second half): a wrong phrase is refused inline, announced, focused,
  // and leaves the gate standing with nothing changed.
  const phraseField = page.getByLabel(`Type ${PHRASE} to confirm`);
  await phraseField.fill("DELETE PROFILE");
  await page.getByRole("button", { name: "Confirm and reset" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("confirmation-mismatch");
  await expect(alert).toBeFocused();
  await expect(page.getByRole("button", { name: "Confirm and reset" })).toBeVisible();

  // The exact phrase performs the in-process cutover: receipt shown
  // content-free, then the Shell hands the user to onboarding.
  await phraseField.fill(PHRASE);
  await page.getByRole("button", { name: "Confirm and reset" }).click();
  await expect(page.getByRole("heading", { name: "Migration complete" })).toBeVisible();
  await expect(page.locator(".receipt-grid")).toContainText("Credentials preserved");
  await expect(page.locator(".receipt-grid")).toContainText("Files removed");
  await expect(page).toHaveURL(/\/onboarding$/, { timeout: 5_000 });
  await expect(
    page.getByRole("heading", { level: 1, name: "Set up your workspace" }),
  ).toBeVisible();

  // AC 7: onboarding lists the seven exact step ids in order, read from the
  // status aggregator — and the clean Workspace is not usable yet.
  const status = await page.request.get("/api/migration/status");
  expect(status.ok(), `status failed: ${status.status()}`).toBe(true);
  const statusBody = (await status.json()) as {
    state: string;
    onboarding: { complete: boolean; steps: { id: string }[] };
  };
  expect(statusBody.state).toBe("completed");
  expect(statusBody.onboarding.steps.map((step) => step.id)).toEqual(ONBOARDING_STEP_IDS);
  /* The ids and their order are pinned above from the status aggregator; the
     rows render the human labels, so the DOM check mirrors them in the same
     fixed order (apps/server/src/api/onboarding.ts). */
  const ONBOARDING_STEP_LABELS = [
    "Enable providers",
    "Confirm the owner Profile",
    "Create Brand Voice",
    "Select Internal Domains",
    "Choose the Transcripts folder",
    "Configure clean Sheets destinations",
    "Configure workflow bundles",
  ] as const;
  const stepRows = page.locator(".setup-check-list li");
  await expect(stepRows).toHaveCount(7);
  for (const [index, label] of ONBOARDING_STEP_LABELS.entries()) {
    await expect(
      stepRows.nth(index),
      `onboarding step ${index} must render ${ONBOARDING_STEP_IDS[index]} as "${label}" in order`,
    ).toContainText(label);
  }
  await expect(
    stepRows.filter({ hasText: "To do" }).first(),
    "at least one step is still to do",
  ).toBeVisible();

  // Complete the owner-profile step through the same real flow
  // content-project-journey.spec.ts uses (identity seam → Profile → confirm),
  // and watch it flip on the polling page without a reload.
  await page.request.post("/api/test/owner-identity", { data: { email: OWNER_EMAIL } });
  const peopleResponse = await page.request.get("/api/people");
  const people = (await peopleResponse.json()) as { id: string; emails: string[] }[];
  let owner = people.find((profile) => profile.emails.includes(OWNER_EMAIL));
  if (!owner) {
    const created = await page.request.post("/api/people", {
      data: { fullName: "Migration Workspace Owner", primaryEmail: OWNER_EMAIL },
    });
    expect(created.ok()).toBe(true);
    owner = (await created.json()) as { id: string; emails: string[] };
  }
  const confirmation = await page.request.post("/api/onboarding/owner/confirm", {
    data: { profileId: owner.id },
  });
  expect(confirmation.ok(), `owner confirm failed: ${confirmation.status()}`).toBe(true);
  const ownerRow = page.locator(".setup-check-list li", { hasText: "Confirm the owner Profile" });
  await expect(ownerRow).toContainText("Done", { timeout: 15_000 });

  // Home while onboarding is still incomplete: the Finish setup banner is the
  // one persistent surface for it. (Full completion — and the banner's
  // disappearance — needs a real connected Google grant; see the docblock.)
  await page.getByRole("link", { name: "Found42 — Chief of Staff" }).click();
  await expect(page).toHaveURL(/\/$/);
  const setupBanner = page.locator(".banner[role='status']");
  await expect(setupBanner).toContainText("Workspace setup is not finished.");
  await expect(setupBanner.getByRole("link", { name: "Finish setup" })).toHaveAttribute(
    "href",
    "/onboarding",
  );

  // AC 8: the product is live again the moment the cutover completed.
  const productsNav = page.locator('nav[aria-label="Products"]');
  for (const [name, href] of FOUR_AREAS) {
    await expect(
      productsNav.getByRole("link", { name }),
      `${name} must be a nav area again`,
    ).toHaveAttribute("href", href);
  }
  const runsLive = await page.request.get("/api/runs");
  expect(runsLive.status()).toBe(200);

  // Restore the hermetic post-cutover state for the rest of the serial suite.
  const disarm = await page.request.post("/api/test/migration/disarm");
  expect(disarm.ok(), `disarm failed: ${disarm.status()}`).toBe(true);
  expect(await disarm.json()).toEqual({ state: "completed" });

  // AC 9 (compatibility endpoints): the retired API namespaces answer the
  // framework's plain 404 — JSON, no redirect, no compat shim.
  for (const endpoint of ["/api/drive/sync", "/api/idea-engine/runs"]) {
    const response = await page.request.get(endpoint);
    expect(response.status(), `${endpoint} must be gone`).toBe(404);
    expect(response.headers()["location"], `${endpoint} must not redirect`).toBeUndefined();
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = (await response.json()) as { error?: unknown };
    expect(typeof body.error, `${endpoint} must be the not-found JSON`).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
  }
});

test("a gated boot leaves the pre-cutover Workspace byte-for-byte unchanged through the Cancel", async ({
  page,
}) => {
  // A second hermetic instance on its own port, over a pre-cutover Workspace
  // with no migration marker. The snapshot is taken BEFORE the process exists,
  // so the proof spans the gated boot itself — not just the armed hold on the
  // already-running shared server.
  secondWorkspace = join(tmpdir(), `tf-migration-gated-${process.pid}`);
  buildPreCutoverWorkspace(secondWorkspace);
  const before = snapshotWorkspace(secondWorkspace);

  const startServerPath = fileURLToPath(new URL("./start-server.mjs", import.meta.url));
  const repoRoot = resolve(dirname(startServerPath), "../..");
  secondServer = spawn(process.execPath, [startServerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(SECOND_PORT),
      MIGRATION_TEST_WORKSPACE_DIR: secondWorkspace,
      /* The environment the app actually ships in: docker-compose declares this,
         and the Shell seeds relay.json from it on a Workspace that has no
         address stored. Without it here the byte-for-byte proof below ran under
         an environment no deployment uses, and missed a gated boot writing to
         the Workspace it was holding. */
      RELAY_BASE_URL: "http://relay:4318",
    },
    stdio: "ignore",
  });
  await waitForHealth(`${SECOND_ORIGIN}/api/health`);

  // The gated boot wrote nothing.
  expect(
    snapshotWorkspace(secondWorkspace),
    "a gated boot must leave the pre-cutover Workspace byte-for-byte unchanged",
  ).toEqual(before);

  // The gate holds this instance's API too.
  const status = await page.request.get(`${SECOND_ORIGIN}/api/migration/status`);
  expect((await status.json()) as { state: string }).toMatchObject({ state: "required" });
  const runsRefused = await page.request.get(`${SECOND_ORIGIN}/api/runs`);
  expect(runsRefused.status()).toBe(503);

  // Drive the gate page on this instance and Cancel: the no-request contract,
  // with the Workspace snapshot still deep-equal to the pre-boot bytes.
  await page.goto(`${SECOND_ORIGIN}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Workspace migration" })).toBeVisible();
  await expect(page.locator("main#main")).toContainText("runs-and-artifacts");
  const confirmRequests: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/migration/confirm")) confirmRequests.push(response.url());
  });
  await page.getByRole("button", { name: "Cancel and keep this Workspace" }).click();
  await expect(page).toHaveURL(new RegExp(`:${SECOND_PORT}/$`));
  expect(confirmRequests, "Cancel must send no confirm request").toEqual([]);
  expect(
    snapshotWorkspace(secondWorkspace),
    "boot + status + inventory + Cancel must leave the Workspace byte-for-byte unchanged",
  ).toEqual(before);
});
