import type { APIRequestContext } from "@playwright/test";
import { expect } from "./fixture";

/** Configure the owner through public onboarding, with a synthetic Google identity. */
export async function confirmMeetingOwner(request: APIRequestContext): Promise<void> {
  const email = "owner@example.com";
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await request.post("/api/test/owner-identity", { data: { email } })).ok()).toBe(true);
    const created = await request.post("/api/people", {
      data: { fullName: "Workspace Owner", primaryEmail: email },
    });
    const profile = created.ok()
      ? ((await created.json()) as { id: string })
      : (
          (await (await request.get(`/api/people?query=${encodeURIComponent(email)}`)).json()) as {
            id: string;
          }[]
        )[0];
    const response = await request.post("/api/onboarding/owner/confirm", {
      data: { profileId: profile.id },
    });
    if (response.ok()) return;
  }
  throw new Error("Could not confirm the synthetic workspace owner");
}
