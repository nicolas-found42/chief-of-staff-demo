import { expect, test } from "./fixture";

const MEETING_STEPS = [
  ["Configure the model extraction provider", "/settings#api-key", "api-key"],
  ["Connect Google", "/settings#group-google", "group-google"],
  ["Choose the transcript Drive folder", "/settings#drive-folder", "drive-folder"],
  ["Enable Drive polling", "/settings#drive-polling", "drive-polling"],
  [
    "Allow the app to read and process the selected folder",
    "/settings#transcript-consent",
    "transcript-consent",
  ],
] as const;

test.use({ freshWorkspace: true });

test("Meeting setup exposes five independent steps and each lands on its named control", async ({
  page,
}) => {
  await page.goto("/onboarding?goal=meetings");

  await expect(page.getByRole("heading", { level: 1, name: "Meeting setup" })).toBeVisible();
  const required = page.getByRole("region", { name: "Required for your first Meeting Debrief" });
  await expect(required.getByRole("link")).toHaveCount(MEETING_STEPS.length);
  await expect(required).not.toContainText(
    /Brand Voice|Internal Domains|Sheets|workflow bundles|Owner Profile/i,
  );
  await expect(page.getByRole("region", { name: "Other product setup" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/upload/i);

  for (const [label, href, targetId] of MEETING_STEPS) {
    await page.goto("/onboarding?goal=meetings");
    await required.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${href.replace("#", "\\#")}$`));
    await expect(page.locator(`#${targetId}`)).toBeFocused();
  }
});

test("unrelated product setup does not make Home sound unusable after Meetings are ready", async ({
  page,
}) => {
  await page.route("**/api/migration/status**", async (route) => {
    await route.fulfill({
      json: {
        state: "completed",
        origin: "pristine",
        onboarding: {
          goal: "meetings",
          complete: true,
          steps: MEETING_STEPS.map(([label, href]) => ({ id: href, label, done: true, href })),
          otherSetup: {
            complete: false,
            steps: [
              {
                id: "brand-voice",
                label: "Create Brand Voice",
                done: false,
                href: "/content-scout",
              },
            ],
          },
        },
      },
    });
  });

  await page.goto("/onboarding?goal=meetings");
  await expect(page.getByText("Meeting setup complete")).toBeVisible();
  await expect(page.getByText(/Other product setup is optional/)).toBeVisible();

  await page.goto("/");
  await expect(page.getByText(/workspace setup is not finished|workspace.*unusable/i)).toHaveCount(
    0,
  );
  await expect(page.getByText("Other product setup is optional.")).toBeVisible();
});
