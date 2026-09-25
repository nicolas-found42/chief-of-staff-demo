import { expect, test } from "./fixture";
import AxeBuilder from "@axe-core/playwright";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

test("Drive folder is the only Intake; Runs list and Drive settings are visible", async ({
  page,
}) => {
  await page.goto("/runs");
  // Upload dropzone is gone — Drive folder is the sole Intake
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "All runs" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcript intake" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Choose folder/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
});

test("settings round-trips with status-only installation credentials", async ({ page }) => {
  await page.goto("/settings");
  // Exact: "Provider API key" and the "Extraction provider" group also
  // contain the substring "Provider".
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("mock");

  // Installation credentials are status-only in the Workspace UI.
  await expect(page.getByRole("heading", { name: "Installation credentials" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Installation credentials" })
      .locator('input[type="password"]'),
  ).toHaveCount(0);

  const manage = page.getByText("Manage provider", { exact: true });
  if (await manage.isVisible()) await manage.click();
  await page.getByText("Advanced: choose models per task", { exact: true }).click();
  await page.getByLabel("Research evaluation judge", { exact: true }).fill("independent-judge");
  await page
    .getByLabel("Person evidence extraction and identity", { exact: true })
    .fill("research-extractor");
  await page.getByLabel("Task list name").fill("E2E Followups");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".banner-ok")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Research evaluation judge", { exact: true })).toHaveValue(
    "independent-judge",
  );
  await expect(
    page.getByLabel("Person evidence extraction and identity", { exact: true }),
  ).toHaveValue("research-extractor");

  await page.reload();
  await expect(page.getByLabel("Task list name")).toHaveValue("E2E Followups");
  await expect(page.getByRole("group", { name: "Google", exact: true })).toContainText(
    "Not configured",
  );
});

test("provider choices include local Ollama and test-only mock", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("heading", { name: "Connections" }).waitFor();
  const manage = page.getByText("Manage provider", { exact: true });
  if (await manage.isVisible()) {
    await manage.click();
  }
  const provider = page.getByLabel("Provider", { exact: true });
  /* This hermetic server admits mock; Ollama needs no installation key. */
  await expect(provider.getByRole("option", { name: /^mock/ })).toHaveCount(1);
  await expect(provider.getByRole("option", { name: /Ollama/ })).toHaveCount(1);
  await provider.selectOption("ollama");
  await expect(provider).toHaveValue("ollama");
  await expect(page.getByLabel("Ollama base URL")).toBeVisible();
  /* Leave the shared Workspace's form state as it was found. */
  await provider.selectOption("mock");
  await expect(provider).toHaveValue("mock");
});

test("installation setup stays operator-owned and gives an actionable guide", async ({ page }) => {
  await page.goto("/settings");
  const credentials = page.getByRole("region", { name: "Installation credentials" });
  await expect(credentials).toContainText("./scripts/setup-wizard.sh");
  await expect(credentials.getByRole("link", { name: "Open Guided Setup" })).toHaveAttribute(
    "href",
    "/onboarding?goal=meetings",
  );
  await expect(credentials.locator('input[type="password"]')).toHaveCount(0);
});

test("missing installation client explains the operator step before owner consent", async ({
  page,
}) => {
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.installation.googleClient.state = "missing";
    await route.fulfill({ response, json: payload });
  });
  await page.goto("/settings");
  const google = page.getByRole("group", { name: "Google", exact: true });
  await expect(google).toContainText("installation Google OAuth client is not configured");
  await expect(google.getByRole("link", { name: "Open Guided Setup" })).toHaveAttribute(
    "href",
    "/onboarding?goal=meetings",
  );
  await expect(google.getByRole("button", { name: "Sign in with Google" })).toHaveCount(0);
});

test("the Shell says Google is not set up on every page, and not on Settings", async ({ page }) => {
  // The banner used to belong to the runs page, so it reached the one Module
  // that happened to own `/` and nowhere else. Scoped to the Shell's own live
  // region, because the Settings card renders warnings of its own.
  const shellBanner = page.locator('main > [role="status"] .banner-warn');

  for (const path of ["/", "/runs", "/content-scout"]) {
    await page.goto(path);
    // Shell vocabulary: Tasks and Gmail are Google surfaces, where the old
    // string named Transcript's own pipeline stages.
    await expect(shellBanner, `banner on ${path}`).toContainText(
      "Google is not set up. Gmail and Google Tasks need a connection; local Tasks remain available.",
    );
    // The footer is the other piece of Shell chrome on every page, and it has
    // to name the one shipped exception to draft-only (ADR-0034) or it tells
    // the person something untrue about a Module they can turn on.
    await expect(page.locator(".app-footer"), `footer on ${path}`).toContainText(
      "mail is never sent — except Meeting Briefs, which go only to your connected account",
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
  await expect(page).toHaveURL(/\/onboarding\?goal=meetings$/);
  await expect(page.getByRole("heading", { name: /Meeting setup/i }).first()).toBeVisible();
});

test("primary actions are reachable and operable by keyboard", async ({ page }) => {
  await page.goto("/runs");

  // Drive is the only Intake — no upload button, but the page still has a heading and a way to check
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "All runs" })).toBeVisible();
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };
  await page.goto(`/runs/${runId}`);
  await expect(page.locator("h1.run-title")).toBeVisible();
  // Each route carries its own title, suffixed with the Shell's name — not with
  // the name of a Module, which is what this used to say.
  await expect(page).toHaveTitle(/· Chief of Staff$/);

  // Runs are reachable from the list without a pointer.
  await page.goto("/runs");
  // The seeded Run is the keyboard subject: its fixture writes
  // transcript.txt, so Files exists to exercise once the disclosure opens.
  const runLink = page.locator(`.run-link[href="/runs/${runId}"]`);
  await expect(runLink).toBeVisible();
  await runLink.press("Enter");
  await page.waitForURL(/\/runs\/run_/, { timeout: 15_000 });

  // The capped-height log can be scrolled from the keyboard, and the Run's
  // files stay plain links under "Files" — native links, so keyboard users
  // reach and open them like every other control. The transcript-module
  // pre-block they replaced is retired (issue #142).
  await expect(page.locator(".events-log")).toHaveAttribute("tabindex", "0");
  await page.locator("details summary").click();
  const fileLink = page.locator(".run-files a").first();
  await expect(fileLink).toBeVisible();
  await fileLink.focus();
  await expect(fileLink).toBeFocused();
});

test("the page never scrolls sideways at a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ["/", "/runs", "/settings"]) {
    await page.goto(path);
    const overflows = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth > root.clientWidth + 1;
    });
    expect(overflows, `${path} scrolls horizontally at 320px`).toBe(false);
  }
  await page.goto("/content-scout");
  await page.getByRole("button", { name: "Settings & Health" }).click();
  const contentScoutOverflows = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth + 1;
  });
  expect(contentScoutOverflows, "Content Scout Settings scrolls horizontally at 320px").toBe(false);
});

test("Content Scout Settings exposes safe cleanup and non-color runtime health", async ({
  page,
}) => {
  await page.goto("/content-scout");
  await page.getByRole("button", { name: "Settings & Health" }).click();

  await expect(page.getByRole("heading", { name: "Storage & retention" })).toBeVisible();
  await expect(page.getByText("Durable records", { exact: true })).toBeVisible();
  await expect(page.getByText("Retained evidence transcripts", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "External runtimes" })).toBeVisible();
  await expect(page.getByText(/browser\.chromium: Available/)).toBeVisible();
  await expect(page.getByText(/python\.pyktok: Unsupported/)).toBeVisible();

  const preview = page.getByRole("button", { name: "Preview temporary cleanup" });
  await preview.focus();
  await preview.press("Enter");
  await expect(page.getByText("Temporary-data cleanup preview is ready.")).toBeVisible();
  await expect(page.getByText("Nothing is eligible for temporary-data cleanup.")).toBeVisible();
  await expect(preview).toBeFocused();
  await expect(page.getByRole("button", { name: /Delete .*expired temporary/ })).toHaveCount(0);
});

test("the front door is Home, and the Shell's runs list lives at /runs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
  // Titled after the Shell with no suffix, so opening the most-visited route
  // never re-titles the tab (WCAG 2.4.2 is satisfied by the app's own name).
  await expect(page).toHaveTitle("Chief of Staff");

  // Home loads provider + runs async (shows Loading… first). Wait for the
  // sentence that only exists after both resolve.
  await expect(page.locator(".home-sentence")).toBeVisible();

  // A status surface, not a Module's page in different chrome: Intake and the
  // runs table stay with the pages that own them.
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByTestId("runs-table")).toHaveCount(0);

  // No assertion that "Recent activity" is absent: ADR-0014 revised ADR-0010 and
  // gives Home exactly that feed, so its presence is the contract, not a leak.
  // Whether it renders depends on whether finished Runs exist, which the shared
  // hermetic server makes order-dependent — so the front-door contract pinned
  // here is the absence of Module-owned Intake and tables, which is invariant.

  // Ticket 12 honesty rule: with Google disconnected the Runs page stays
  // silent about watching — no liveness line, no stale promise.
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All runs");
  await expect(page.getByTestId("intake-liveness")).toHaveCount(0);

  // One card per product area, from the same explicit list the header nav
  // renders (productAreas.ts; ADR-0043), so the two cannot disagree about
  // what exists. Counted by role rather than by the layout's class names,
  // which are the bento's business and not a contract.
  await page.goto("/");
  await expect(page.locator(".home-sentence")).toBeVisible();
  /* The product tiles, not every h3 in main: the Home work card carries its
     own group headings at the same level (issue #192). */
  const tiles = page.locator("main#main .module-grid").getByRole("heading", { level: 3 });
  await expect(tiles).toHaveCount(5);
  await expect(tiles.filter({ hasText: "Content Engine" })).not.toContainText("Planned");
  await expect(tiles.filter({ hasText: "Content Research" })).not.toContainText("Planned");
  await expect(tiles.filter({ hasText: "Person Profiles" })).not.toContainText("Planned");
  await expect(tiles.filter({ hasText: "Meeting Wizard" })).not.toContainText("Planned");
  await expect(tiles.filter({ hasText: "Tasks" })).not.toContainText("Planned");

  /* The card links bind to the product grid, not all of main: a finished
     scheduled Run can land a feed link naming the same area ("Content
     Research daily"), and a main-scoped role query cannot tell them apart. */
  const areaTiles = page.locator(".module-grid");
  for (const [label, path] of [
    ["Content Engine", "/content-scout"],
    ["Content Research", "/content-research"],
    ["Person Profiles", "/people"],
    ["Meeting Wizard", "/meetings"],
    ["Tasks", "/tasks"],
  ] as const) {
    await expect(areaTiles.getByRole("link", { name: label })).toHaveAttribute("href", path);
  }

  // The header nav carries exactly the five product areas (spec: Navigation
  // and onboarding #1; ADR-0043, ADR-0052) — explicit, never derived from the
  // Module registry — so there is no Modules bar to enumerate.
  const productsNav = page.locator('.app-header nav[aria-label="Products"]');
  await expect(productsNav.getByRole("link")).toHaveCount(5);
  await expect(page.locator('.app-header nav[aria-label="Modules"]')).toHaveCount(0);
  for (const [label, path] of [
    ["Content Engine", "/content-scout"],
    ["Content Research", "/content-research"],
    ["Person Profiles", "/people"],
    ["Meeting Wizard", "/meetings"],
    ["Tasks", "/tasks"],
  ] as const) {
    await expect(productsNav.getByRole("link", { name: label })).toHaveAttribute("href", path);
  }

  await areaTiles.getByRole("link", { name: "Content Engine" }).click();
  await expect(page).toHaveURL(/\/content-scout$/);
  // Dropzone is gone — Drive folder is the Intake. And a Module's page is not
  // a Runs surface any more: with Transcript → Tasks retired (#142) the
  // Shell's cross-Module list at /runs is the only Runs list there is, so
  // nothing here renders a table of its own Runs.
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByTestId("runs-table")).toHaveCount(0);
  await page.getByRole("link", { name: "Found42 — Chief of Staff" }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
});

test("the Shell lists every Module's runs, and a Module's page lists only its own", async ({
  page,
}) => {
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);

  // The cross-Module list is a Shell page, reached by route rather than by tab:
  // a Runs tab would be the bar's first entry that is not a Module (ADR-0014).
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "All runs" })).toBeVisible();
  await expect(page.getByTestId("runs-table")).toBeVisible();
  await expect(page.locator(".runs-table thead")).toContainText("Module");
  // An Intake's name is a Module's private vocabulary, so it is not a column here.
  await expect(page.locator(".runs-table thead")).not.toContainText("Source");
  await expect(page.getByRole("navigation", { name: "Products" })).not.toContainText("runs");

  /* Transcript → Tasks was the last Module with a Runs page of its own, and
     it is retired (issue #142). The cross-Module list is now the only Runs
     list there is, so what remains to assert is that it is complete and
     Module-attributed rather than that it differs from a per-Module one. */

  // A Run's detail page is the Shell's half — the stage timeline, events and
  // files — with a Module's own view only when its Module contributes one.
  // The seed-fixture Module contributes none, and Transcript → Tasks (whose
  // ResultView drew the receipt) is retired (#142): "What happened" and the
  // timeline are the tail every Run carries.
  await page.locator(".run-link").first().click();
  await page.waitForURL(/\/runs\/run_/);
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(page.locator(".timeline-row").first()).toBeVisible();
});

test("partial Content Scout diagnostics stay visible and accessible", async ({ page }) => {
  const profile = await page.request.post("/api/content-scout/brand-profile", {
    data: {
      markdown: "# Brand Profile\n\n## Positioning\nPractical, evidence-led guidance.\n",
      websiteUrl: "https://company.example",
    },
  });
  expect(profile.ok()).toBe(true);
  for (const source of [
    {
      adapterId: "rss",
      label: "Available feed",
      url: "https://available.example/feed.xml",
    },
    {
      adapterId: "instagram",
      label: "Experimental public account",
      url: "https://instagram.example/public-account",
    },
  ]) {
    const response = await page.request.post("/api/content-scout/sources", { data: source });
    expect(response.ok()).toBe(true);
  }
  const started = await page.request.post("/api/content-scout/run");
  expect(started.ok()).toBe(true);
  const { runId } = (await started.json()) as { runId: string };
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/runs/${runId}`);
      return ((await response.json()) as { status: string }).status;
    })
    .toBe("blocked");

  await page.goto("/content-scout");
  const warning = page.locator(".banner-warn", { hasText: "Collection is degraded" });
  await expect(warning).toContainText("instagram response shape change");
  expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);

  await warning.getByRole("link", { name: "Open diagnostics" }).click();
  await expect(page.getByRole("heading", { name: "Content Scout receipt" })).toBeVisible();
  const table = page.getByRole("table", { name: "Source Adapter summary" });
  await expect(table.getByRole("columnheader", { name: "Error classifications" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Last successful request" })).toBeVisible();
  const attempts = page.getByText("instagram Source Adapter attempt receipts", { exact: true });
  await attempts.click();
  await expect(page.getByText("embedded_public_data", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/^expected_public_evidence_missing \(cause 1, sha256:/),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);
});

test.describe("fresh Content Engine setup", () => {
  test.use({ freshWorkspace: true });
  test("Content Engine empty state links each setup prerequisite and names truthful status", async ({
    page,
  }) => {
    await page.goto("/content-scout");
    await expect(page).toHaveTitle(/^Content Engine ·/);
    const rows = page.locator(".setup-check-list > li");
    await expect(rows).toHaveCount(3);
    await expect(rows).toContainText([
      "Configure model access",
      "Create Brand Voice",
      "Add a source to monitor",
    ]);
    await expect(rows).toContainText(["Working", "To do", "To do"]);
    await expect(rows.nth(0)).toContainText("provider key is configured");

    await rows
      .nth(1)
      .getByRole("button", { name: /Create Brand Voice/i })
      .click();
    await expect(page.getByRole("heading", { name: "Brand Profile" })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: /Content/ })
        .getByRole("button", { name: "Brand Profile" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("navigation", { name: /Content/ })
      .getByRole("button", { name: "Shortlist" })
      .click();
    await rows
      .nth(2)
      .getByRole("button", { name: /Add a source to monitor/i })
      .click();
    await expect(page.getByRole("heading", { name: "Approved Source Targets" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: /Content/ }).getByRole("button", { name: "Sources" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

test("Content Research explains source boundaries and accepts YouTube handles", async ({
  page,
}) => {
  await page.goto("/content-research");
  await expect(page.getByText(/Person Profile.*identity signal/i).first()).toBeVisible();
  await expect(page.getByText(/LinkedIn.*not watched/i).first()).toBeVisible();
  const youtube = page.getByLabel("YouTube channel");
  await expect(youtube).toHaveAttribute("aria-describedby", /youtube-help/);
  await expect(page.getByText(/channel URL.*@handle/i).first()).toBeVisible();
  await expect(page.getByText(/Hacker News.*profile/i).first()).toBeVisible();
});

test("Content Scout goes from bounded Brand Profile scan to a started Content Project", async ({
  page,
}) => {
  await page.request.post("/api/test/owner-identity", {
    data: { email: "owner-onboarding@example.com" },
  });
  const peopleResponse = await page.request.get("/api/people");
  const people = (await peopleResponse.json()) as { id: string; emails: string[] }[];
  let owner = people.find((profile) => profile.emails.includes("owner-onboarding@example.com"));
  if (!owner) {
    const created = await page.request.post("/api/people", {
      data: { fullName: "Workspace Owner", primaryEmail: "owner-onboarding@example.com" },
    });
    expect(created.ok()).toBe(true);
    owner = (await created.json()) as { id: string; emails: string[] };
  }
  const confirmation = await page.request.post("/api/onboarding/owner/confirm", {
    data: { profileId: owner.id },
  });
  expect(confirmation.ok()).toBe(true);
  await page.goto("/content-scout");
  await expect(page.getByRole("heading", { level: 1, name: "Content Engine" })).toBeVisible();

  await page.getByRole("button", { name: "Brand Profile" }).click();
  await page.getByLabel("Company website URL").fill("https://company.example");
  await page.getByRole("button", { name: "Scan website" }).click();
  await expect(page.getByRole("heading", { name: "Review website evidence" })).toBeVisible();
  await expect(
    page.getByText("Depth 1 · https://company.example/blog", { exact: false }),
  ).toContainText("Default transient");
  await page.getByRole("button", { name: /^Accept \d+ selected sections?/ }).click();
  await expect(page.getByText(/^Current revision brand_/)).toBeVisible();

  // The scan Run's detail page renders its receipt: a brand-profile-scan
  // result carries evidence counts, not the discovery adapter table, and
  // rendering it through the discovery shape once blanked the whole app.
  await page.goto("/runs");
  await page
    .getByRole("link", { name: /Content Scout Brand Profile proposal/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Content Scout receipt" })).toBeVisible();
  await expect(page.getByText(/pages crawled/)).toContainText("included in the evidence");
  await page.goto("/content-scout");
  await page.getByRole("button", { name: "Sources" }).click();
  await page.getByLabel("Source Adapter").selectOption("rss");
  await page.getByLabel("Name").fill("Example Research");
  await page.getByLabel("Recurring public URL").fill("https://example.com/research.xml");
  await page.getByRole("button", { name: "Approve source" }).click();
  await expect(page.getByRole("cell", { name: "Example Research", exact: false })).toBeVisible();

  /* The Run this journey creates is asserted by id: earlier journeys leave
     content-scout state behind, so global shortlist/run patterns do not hold. */
  const scoutStarted = await page.request.post("/api/content-scout/run");
  expect(scoutStarted.ok()).toBe(true);
  const { runId } = (await scoutStarted.json()) as { runId: string };
  await expect
    .poll(async () => {
      const state = (await (await page.request.get("/api/content-scout")).json()) as {
        shortlist: { runId: string; opportunities: { state: string }[] } | null;
      };
      return (
        state.shortlist?.runId === runId &&
        state.shortlist.opportunities.some((opportunity) => opportunity.state === "ready")
      );
    })
    .toBe(true);
  /* Shortlist is the default view on /content-scout. */
  await page.goto("/content-scout");
  await expect(page.getByText("Explain what the verified change means in practice")).toBeVisible();
  await page.getByRole("checkbox", { name: /Explain what the verified change/ }).check();
  /* Selecting an Opportunity starts one governed Content Project — with the
     Project's own required inputs, and nothing generated at selection time. */
  await page.getByRole("combobox", { name: "Objective" }).selectOption("educate");
  await page.getByLabel("Intended audience").fill("Operations leads");
  await page.getByRole("checkbox", { name: "linkedin standard post" }).check();
  await page
    .getByRole("combobox", { name: "Research mode" })
    .selectOption("existing-workspace-evidence");
  await page.getByRole("button", { name: "Start Project" }).click();
  await expect(
    page.getByText("The selected Opportunities started their Content Projects."),
  ).toBeVisible();
  const projectCard = page.getByRole("heading", { name: "Projects started" });
  await expect(projectCard).toBeVisible();
  const projectBadge = page.locator("code", { hasText: /^project_/ });
  await expect(projectBadge).toBeVisible();
  const projectId = await projectBadge.textContent();
  expect(projectId).toMatch(/^project_/);

  /* Contract, asserted on this journey's own Run by id: the selection started
     exactly one governed Content Project carrying the Opportunity, and the Run
     holds no pack or Notion residue. The Run itself ends done when no Ready
     opportunity remains and blocked otherwise — either is contract-true. */
  const detail = (await await page.request.get(`/api/runs/${runId}`).then((r) => r.json())) as {
    status: string;
    result: {
      projects: { opportunityId: string; projectId: string; created: boolean }[];
    } | null;
    files: string[];
  };
  expect(["done", "blocked"]).toContain(detail.status);
  expect(detail.result?.projects).toEqual([
    { opportunityId: expect.any(String), projectId, created: true },
  ]);
  expect(detail.files.filter((file) => /notion|^draft-/i.test(file))).toEqual([]);
});

test("Content Research presents YouTube Trends, and the trends page refuses a bad paste while you are looking at it", async ({
  page,
}) => {
  // The journey starts where the product puts it: under Content Research.
  await page.goto("/content-research");
  await page.getByRole("link", { name: "YouTube Trends" }).click();
  await expect(page).toHaveURL(/\/content-research\/trends$/);
  await expect(page.getByRole("heading", { level: 1, name: "YouTube Trends" })).toBeVisible();
  // Before there is any data the tab says what will happen, rather than showing
  // an empty screen with no explanation.
  const empty = page.locator(".card", { hasText: "No channels yet" });
  await expect(empty).toContainText("checked against YouTube straight away");

  // The legacy custom-URL form is refused with the forms that work — Google
  // publishes no route from it to a channel id, and the search fallback would
  // make the Module fragile in a way invisible until it tracked the wrong
  // channel.
  await page.getByLabel("Channel URL").fill("https://www.youtube.com/c/Found42");
  await page.getByRole("button", { name: "Add channel" }).click();
  const refusal = page.locator(".field-error");
  await expect(refusal).toContainText("youtube.com/@name");
  await expect(refusal).toContainText("youtube.com/channel/UC");

  // A well-formed address gets as far as Google, which this workspace has not
  // connected — and the refusal is the connection's own wording, the same
  // sentence a Run shows for the same state.
  await page.getByLabel("Channel URL").fill("https://www.youtube.com/@found42");
  await page.getByRole("button", { name: "Add channel" }).click();
  await expect(refusal).toContainText(/not set up/i);

  // And a manual run with nothing to measure says so rather than recording an
  // empty day.
  await page.getByRole("button", { name: "Record today" }).click();
  await expect(page.locator(".banner-error")).toContainText("Add a channel first");

  // The spreadsheet is created from the Module's own settings surface, not by
  // the first Run: a link buried in a Run record scrolls out of Home's feed.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "YouTube Trends" })).toBeVisible();
  const create = page.getByRole("button", { name: "Create the spreadsheet" });
  await expect(create).toBeVisible();
  await create.click();
  await expect(page.locator("section:has(#section-youtube) .field-error")).toContainText(
    /not set up/i,
  );
});

test("Home enumerates what needs doing, and the rail itemises it", async ({ page }) => {
  // Guarantees one failed Run whatever ran before this: the ordinary-failure
  // fixture creates a Run that fails at extract with the genuine-failure
  // wording, and carries no connection flag — it is not an expiry story.
  const seed = await page.request.post("/api/test/seed?scenario=ordinary-failure");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };
  await page.goto(`/runs/${runId}`);
  await expect(page.locator(".run-meta .status-badge.status-failed")).toHaveText("Failed", {
    timeout: 15_000,
  });
  await expect(page.locator(".run-meta")).toContainText("Failed during");
  await expect(page.locator(".run-meta")).not.toContainText("Stopped during");
  // The fixture carries no connection flag, so the banner is the
  // genuine-failure kind and the way out is Retry, not Reconnect: retryable
  // (failed at extract, never convert) and showRetry (nothing reconnectable
  // to wait for) are both true here. Reconnect belongs to connection-flagged
  // failures, covered by the sign-in refusal and the meeting journeys.
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.locator(".timeline-row .status-failed")).toHaveText("Failed");
  await page.goto("/");
  // One clause per rail condition, in the rail's order, with the true total of
  // failures rather than the number of rows shown. No "Nothing needs you." —
  // there plainly is.
  await expect(page.locator(".home-sentence")).toHaveText(
    /^\d+ runs? failed, and the extraction provider is a stand-in\.$/,
  );

  // The rail is labelled for heading navigation even though the label is not
  // drawn: a sighted reader takes it from the sentence above.
  await expect(page.getByRole("heading", { level: 2, name: "Needs your attention" })).toHaveCount(
    1,
  );

  // The provider row carries the consequence and the way out, which is what the
  // sentence deliberately leaves out — and it claims nothing about what
  // extraction would have produced, since that is a Module's stage.
  const mockRow = page.locator(".home-rail-row", { hasText: "mock provider" });
  await expect(mockRow).toContainText(
    "Runs are using the mock provider, so nothing real is extracted",
  );
  await expect(mockRow.getByRole("link", { name: "Choose a provider" })).toHaveAttribute(
    "href",
    "/onboarding?goal=meetings",
  );

  // This workspace was never configured; that is not the expected weekly
  // expiry, so its Run retains the genuine-failure treatment and opens the
  // diagnostic instead of offering the expiry-specific reconnect action.
  const failedRow = page.locator(".home-rail-row", {
    has: page.locator(`a[href="/runs/${runId}"]`),
  });
  await expect(failedRow).toContainText("failed");
  await expect(failedRow.getByRole("link", { name: "Open" })).toHaveAttribute(
    "href",
    `/runs/${runId}`,
  );
});

test("conversion failures show separate person guidance and shape-only diagnostics", async ({
  page,
}) => {
  const seed = await page.request.post("/api/test/seed?scenario=conversion-failure");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };

  await page.goto(`/runs/${runId}`);
  await expect(page.locator(".banner-error")).toContainText(
    "This file is corrupt or does not match its format. Replace or repair the file.",
  );
  await page.getByText("Technical details", { exact: true }).click();
  const events = page.locator(".events-log");
  await expect(events).toContainText('"classification":"invalid_file"');
  await expect(events).toContainText('"format":"json"');
  await expect(events).toContainText('"step":"parse_json"');
  await expect(events).toContainText('"bytes":28');
  await expect(page.locator("body")).not.toContainText("PRIVATE TRANSCRIPT MARKER");
});

test("Home reflows to one column, and a connected workspace says whose it is", async ({ page }) => {
  // The connection this workspace does not have, answered at the API rather
  // than stored: the tests above and below expect a workspace with no Google
  // credentials, and a stub leaves it that way.
  await page.route("**/api/google/status", async (route) => {
    await route.fulfill({
      json: {
        state: "connected",
        email: "owner@example.com",
        redirectUri: "http://127.0.0.1:4319/api/google/callback",
        scopes: [],
        lastConnectedAt: new Date().toISOString(),
        expiresAbout: null,
      },
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  // Identity only, and only when connected — the expiry warning is the Shell
  // banner's job (ADR-0011). How it is drawn is design judgement; that it is
  // said is the contract.
  await expect(page.getByText("Google connected as owner@example.com")).toBeVisible();

  // Two columns where they fit, one where they do not. Asserted as tracks
  // rather than pixels: what reflow owes the reader is a single column, not a
  // particular width (WCAG 1.4.10). The 320px test above already covers the
  // other half — that nothing clips or scrolls sideways once it collapses.
  const tracks = () =>
    page
      .locator(".home-grid")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(await tracks()).toBe(2);
  await page.setViewportSize({ width: 800, height: 900 });
  expect(await tracks()).toBe(1);

  // And it collapses attention-first. In one column the page is read top to
  // bottom, so the rail above the tiles is the difference between meeting what
  // needs you and scrolling past four Modules to find it.
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  await page.goto("/");
  const rail = await page.locator(".home-rail-card").boundingBox();
  const tiles = await page.locator(".module-grid").boundingBox();
  expect(rail, "attention rail").not.toBeNull();
  expect(tiles, "module tiles").not.toBeNull();
  expect(rail!.y).toBeLessThan(tiles!.y);
});

/* Last of all, because it empties the Workspace: the danger zone's repeatable
   generated-data clear (issue #144), the successor to the one-time migration
   gate. Everything above seeded state this deletes, so it runs after them and
   puts the Workspace back to empty rather than to demo data. */
test("the danger zone clears all generated data behind a typed phrase", async ({ page }) => {
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };

  await page.goto("/runs");
  await expect(page.locator(`a[href="/runs/${runId}"]`)).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Danger zone" })).toBeVisible();
  const card = page.getByRole("group", { name: "Clear all generated data" });
  await card.getByText("Show what this deletes, and run it").click();
  // The disclosure names what would go, counted from the live Workspace.
  await expect(card.getByText(/currently \d+ records/)).toBeVisible();

  // The phrase gates the button: a mistyped phrase leaves it disabled.
  await page.getByLabel(/Type .* to confirm/).fill("clear all data");
  await expect(page.getByRole("button", { name: "Delete all generated data" })).toBeDisabled();

  await page.getByLabel(/Type .* to confirm/).fill("CLEAR ALL DATA");
  await page.getByRole("button", { name: "Delete all generated data" }).click();

  await expect(page.getByText("Directories removed")).toBeVisible();
  await page.goto("/runs");
  await expect(page.getByText("No runs yet")).toBeVisible();
});
