import { expect, test } from "@playwright/test";

test("Drive folder is the only Intake; Runs list and Drive settings are visible", async ({ page }) => {
  await page.goto("/transcript");
  // Upload dropzone is gone — Drive folder is the sole Intake
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcript → Tasks" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Choose folder/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
});

test("settings round-trips with redacted secrets", async ({ page }) => {
  await page.goto("/settings");
  // Exact: "Provider API key" and the "Extraction provider" group also
  // contain the substring "Provider".
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("mock");

  // Secrets are never echoed back: every password input is empty.
  const secretValues = await page.locator('input[type="password"]').evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value)
  );
  expect(secretValues.length).toBeGreaterThan(0);
  expect(secretValues.every((value) => value === "")).toBe(true);

  await page.getByLabel("Task list name").fill("E2E Followups");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".banner-ok")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Task list name")).toHaveValue("E2E Followups");
  await expect(page.getByText("Not connected", { exact: false })).toBeVisible();
});

test("an unconfigured workspace gets the setup wizard, not two bare fields", async ({ page }) => {
  await page.goto("/settings");

  // Seven steps, in the order the console forces them (ADR-0013 froze the
  // sequence), rendered as a wizard: progress visible, exactly one step open.
  const steps = page.locator(".setup-steps > li");
  const toggle = (index: number) => steps.nth(index).locator("button.wizard-step-toggle");
  await expect(steps).toHaveCount(7);
  await expect(page.locator(".wizard-progress")).toHaveText("Step 1 of 7");
  await expect(toggle(0)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Create a project", exact: true })).toBeVisible();

  // Moving on collapses the walked-past step to a ✓ line and opens one more.
  await toggle(1).click();
  await expect(page.locator(".wizard-progress")).toHaveText("Step 2 of 7");
  await expect(toggle(0)).toHaveAttribute("aria-expanded", "false");
  await expect(steps.nth(0)).toHaveClass(/done/);
  await expect(page.getByRole("link", { name: "Enable the Tasks API", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create a project", exact: true })).toHaveCount(0);

  // The scopes step carries its three exact values, each offered to copy so
  // none has to be typed out.
  await toggle(4).click();
  await expect(page.locator(".setup-copy > code")).toHaveText([
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/drive",
  ]);
  await expect(page.locator(".copy-button")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Copy https://www.googleapis.com/auth/tasks", exact: true })
  ).toBeVisible();

  // The redirect URI is built from the port the server is actually on. This
  // suite runs on 4319, so a value hardcoded to 4317 — as the UI used to carry —
  // fails here.
  await toggle(5).click();
  await expect(page.locator(".setup-copy > code")).toHaveText([
    "http://localhost:4319/api/google/callback",
  ]);
  await expect(page.getByRole("button", { name: "Copy Redirect URI", exact: true })).toBeVisible();

  // The credential step is the last, and its sign-in button is Google-branded.
  await toggle(6).click();
  await expect(page.getByRole("button", { name: /Save and sign in with Google/ })).toBeVisible();
});

test("signing in without a client id reports Google's refusal in the page", async ({ page }) => {
  await page.goto("/settings");

  // Credential fields live in the last wizard step (ADR-0013); open it first
  // (steps are collapsed by default, only step 0 open). The previous layout
  // kept them always visible, so the test failed when they moved.
  const steps = page.locator(".setup-steps > li");
  const last = steps.last().locator("button.wizard-step-toggle");
  await last.click();
  // Pressing sign-in with nothing filled in saves an empty client and asks the
  // server for a consent URL, which it refuses. That refusal has to land as
  // readable text, not a console error (WCAG 3.3.1).
  const signIn = page.getByRole("button", { name: /Save and sign in with Google/ });
  await signIn.focus();
  await signIn.click();
  // The wording is the connection's own (googleFailureHint), so the refusal the
  // user reads here is the same sentence a Run shows when it fails for this state.
  await expect(page.locator(".banner-error")).toContainText(/not set up/i);
  await expect(page.locator(".banner-error")).toContainText(/Settings/);
  // The control the user pressed keeps focus rather than dropping it (WCAG 2.4.3).
  await expect(signIn).toBeFocused();
});

test("the Shell says Google is not set up on every page, and not on Settings", async ({ page }) => {
  // The banner used to belong to the runs page, so it reached the one Module
  // that happened to own `/` and nowhere else. Scoped to the Shell's own live
  // region, because the Settings card renders warnings of its own.
  const shellBanner = page.locator('main > [role="status"] .banner-warn');

  for (const path of ["/", "/transcript", "/hot-take"]) {
    await page.goto(path);
    // Shell vocabulary: Tasks and Gmail are Google surfaces, where the old
    // string named Transcript's own pipeline stages.
    await expect(shellBanner, `banner on ${path}`).toContainText(
      "Google is not set up, so nothing can be created in Tasks or Gmail."
    );
  }

  // Absent on Settings, where it would sit directly above a card that says the
  // same thing in detail. The region itself stays mounted — a live region that
  // unmounts re-announces itself on the next navigation.
  await page.goto("/settings");
  await expect(shellBanner).toHaveCount(0);
  await expect(page.locator('main > [role="status"]')).toHaveCount(1);

  // And it routes to the place that fixes it.
  await page.goto("/");
  await shellBanner.getByRole("link", { name: "Set up Google" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator(".setup-steps")).toBeVisible();
});

test("primary actions are reachable and operable by keyboard", async ({ page }) => {
  await page.goto("/transcript");

  // Drive is the only Intake — no upload button, but the page still has a heading and a way to check
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };
  await page.goto(`/runs/${runId}`);
  await expect(page.locator("h1.run-title")).toBeVisible();
  // Each route carries its own title, suffixed with the Shell's name — not with
  // the name of a Module, which is what this used to say.
  await expect(page).toHaveTitle(/· Chief of Staff$/);

  // Runs are reachable from the list without a pointer.
  await page.goto("/transcript");
  const runLink = page.locator(".run-link").first();
  await expect(runLink).toBeVisible();
  await runLink.press("Enter");
  await page.waitForURL(/\/runs\/run_/, { timeout: 15_000 });

  // The capped-height log and transcript can be scrolled from the keyboard.
  await expect(page.locator(".events-log")).toHaveAttribute("tabindex", "0");
  await page.locator("details summary").click();
  await expect(page.locator(".artifact-pre")).toHaveAttribute("tabindex", "0");
});

test("the page never scrolls sideways at a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ["/", "/transcript", "/settings"]) {
    await page.goto(path);
    const overflows = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth > root.clientWidth + 1;
    });
    expect(overflows, `${path} scrolls horizontally at 320px`).toBe(false);
  }
});

test("the front door is Home, and Transcript keeps the runs list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
  // Titled after the Shell with no suffix, so opening the most-visited route
  // never re-titles the tab (WCAG 2.4.2 is satisfied by the app's own name).
  await expect(page).toHaveTitle("Chief of Staff");

  // Home loads provider + runs async (shows Loading… first). Wait for the
  // sentence that only exists after both resolve.
  await expect(page.locator(".home-sentence")).toBeVisible();

  // A status surface, not Transcript with different chrome: Intake and the runs
  // table stay with the Module that owns them.
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByTestId("runs-table")).toHaveCount(0);

  // Every Run this workspace can produce fails at outputs (mock provider, no
  // Google), so nothing has ever finished and the activity feed is omitted
  // entirely rather than rendering zeroes (ADR-0014).
  await expect(page.getByRole("heading", { name: "Recent activity" })).toHaveCount(0);

  // Ticket 12 honesty rule: with Google disconnected the Runs page stays
  // silent about watching — no liveness line, no stale promise.
  await page.goto("/transcript");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Runs");
  await expect(page.getByTestId("intake-liveness")).toHaveCount(0);

  // One card per Module, from the same list the tab bar renders, so the two
  // cannot disagree about what exists.
  await page.goto("/");
  await expect(page.locator(".home-sentence")).toBeVisible();
  const cards = page.locator(".module-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "Hot Take" })).toContainText("Planned");
 
  // Into the Module, and back out by the wordmark.
  await cards.first().getByRole("link").click();
  await expect(page).toHaveURL(/\/transcript$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Runs");
  // Dropzone is gone — Drive folder is the Intake; Runs list stays
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByTestId("runs-table")).toBeVisible();
  await page.getByRole("link", { name: "Found42 — Chief of Staff" }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
});

test("Home enumerates what needs doing, and the rail itemises it", async ({ page }) => {
  // Guarantees one failed Run whatever ran before this: the mock provider
  // answers instantly and the Run then fails at outputs, because this workspace
  // has no Google connection.
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };
  await page.goto(`/runs/${runId}`);
  await expect(page.locator(".run-meta .status-badge.status-attention")).toHaveText("Needs attention", { timeout: 15_000 });
  await page.goto("/");
  // One clause per rail condition, in the rail's order, with the true total of
  // failures rather than the number of rows shown. No "Nothing needs you." —
  // there plainly is.
  await expect(page.locator(".home-sentence")).toHaveText(
    /^\d+ runs? failed, and the extraction provider is a stand-in\.$/
  );

  // The rail is labelled for heading navigation even though the label is not
  // drawn: a sighted reader takes it from the sentence above.
  await expect(page.getByRole("heading", { level: 2, name: "Needs your attention" })).toHaveCount(1);

  // The provider row carries the consequence and the way out, which is what the
  // sentence deliberately leaves out — and it claims nothing about what
  // extraction would have produced, since that is a Module's stage.
  const mockRow = page.locator(".home-rail li", { hasText: "mock provider" });
  await expect(mockRow).toContainText(
    "Runs are using the mock provider, so nothing real is extracted"
  );
  await expect(mockRow.getByRole("link", { name: "Choose a provider" })).toBeVisible();

  // The connection is not a row on its own: the Shell banner above says it on
  // every page. But a run the connection broke names Google in its fix.

  // The seeded Run fails because Google was never connected (D6): the row
  // names the reconnect fix and routes to where it lives, instead of pointing
  // at the run as a generic failure.
  const failedRow = page.locator(".home-rail li").first();
  await expect(failedRow).toContainText("could not finish because Google needs reconnecting");
  await expect(failedRow.getByRole("link", { name: "Reconnect" })).toBeVisible();
  await failedRow.getByRole("link", { name: "Reconnect" }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

/* Last in the file, and it puts the workspace back: it is the only test here
   that stores Google credentials, and everything above expects a workspace with
   none. */
test("credentials saved but no successful sign-in keeps the steps on the page", async ({ page }) => {
  // Where a beginner lands when the first sign-in fails — a wrong redirect URI,
  // an API left disabled, or closing the consent screen. The connection reads
  // `disconnected`, exactly like a deliberate sign-out, and this used to
  // collapse every instruction behind a "Change the OAuth client" summary at
  // precisely the moment they were needed.
  await page.request.put("/api/config", {
    data: {
      google: {
        clientId: "000000000000-onboarding.apps.googleusercontent.com",
        clientSecret: "not-a-real-secret",
      },
    },
  });

  try {
    await page.goto("/settings");

    await expect(page.locator(".setup-steps > li")).toHaveCount(7);
    // Open on the page, not behind a Manage summary (D11), and not collapsed
    // into a wizard someone must first discover (D12).
    await expect(page.locator(".wizard")).toBeVisible();
    // And it says why the steps are still here, rather than only "Not connected".
    await expect(page.locator(".banner-warn")).toContainText(/no sign-in has succeeded yet/i);
    // Credential fields are in the last wizard step, collapsed by default
    const credSteps = page.locator(".setup-steps > li");
    await credSteps.last().locator("button.wizard-step-toggle").click();
    // The credentials already stored are the ones in the field, so the person can
    // see and correct the value that failed.
    await expect(page.getByLabel("OAuth client ID")).toHaveValue(
      "000000000000-onboarding.apps.googleusercontent.com"
    );
  } finally {
    await page.request.put("/api/config", {
      data: { google: { clientId: "", clientSecret: "" } },
    });
  }
});

test("choosing a work account drops the test-user step", async ({ page }) => {
  await page.goto("/settings");

  // A Workspace account can set the consent screen to Internal, which needs no
  // test users at all — and skipping test users on External is the one mistake
  // with no recovery on Google's own page (Error 403: access_denied). So the
  // step list differs, and the choice is made before the steps rather than
  // explained inside them.
  await expect(page.locator(".setup-steps > li")).toHaveCount(7);
  const steps = page.locator(".setup-steps > li");
  await expect(steps.nth(3).locator("button.wizard-step-toggle")).toContainText("test user");
  await steps.nth(3).locator("button.wizard-step-toggle").click();
  await expect(page.getByRole("link", { name: "Open Audience", exact: true })).toBeVisible();

  await page.getByRole("radio", { name: /work account/ }).check();

  await expect(page.locator(".setup-steps > li")).toHaveCount(6);
  await expect(page.getByRole("link", { name: "Open Audience", exact: true })).toHaveCount(0);
  // And the step that remains tells them which radio to pick in the console.
  // The open index survives the switch, so progress renumbers against the
  // shorter list. "Internal" lives in step 3's body (Google Auth Platform)
  // which is collapsed as done — open it to read the body, or check the
  // audience hint that is always visible.
  await expect(page.getByText("Internal")).toBeVisible();
  await expect(page.locator(".wizard-progress")).toHaveText("Step 4 of 6");
  await page.getByRole("radio", { name: /personal account/ }).check();
  await expect(page.locator(".setup-steps > li")).toHaveCount(7);
  await expect(page.locator(".wizard-progress")).toHaveText("Step 4 of 7");
});
