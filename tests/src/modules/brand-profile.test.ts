import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceBrandProfileStore } from "../../../apps/server/src/brand-profile/store.js";

describe("Workspace Brand Profile", () => {
  it("reads an accepted revision without constructing a Content Scout store", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "workspace-brand-profile-"));
    const now = () => new Date("2026-08-31T12:00:00.000Z");
    const store = new WorkspaceBrandProfileStore(workspaceDir, now);

    const accepted = store.accept({
      markdown: "# Brand Profile\n\n## Voice\nDirect and practical.",
      sourceScan: {
        websiteUrl: "https://example.com/",
        includedUrls: ["https://example.com/"],
        excludedUrls: [],
      },
      note: "Approved by the workspace owner",
    });

    expect(new WorkspaceBrandProfileStore(workspaceDir).current()).toEqual(accepted);
    expect(new WorkspaceBrandProfileStore(workspaceDir).get(accepted.id)).toEqual(accepted);
  });
});
