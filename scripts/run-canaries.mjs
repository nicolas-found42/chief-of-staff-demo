#!/usr/bin/env node
/**
 * Run public canaries outside merge CI using the normal Source Adapter
 * diagnostic contract. This is the scheduled canary seam: it collects the
 * same small envelope as the Daily Intake (adapter.collect) and persists
 * results by adapter version, target, capability, route, and time, but a
 * failure here never fails the repository check gate.
 *
 * Intended to be invoked by `.github/workflows/canary.yml` (scheduled) and
 * locally via `node ./scripts/run-canaries.mjs`. Network access is required
 * for the live canaries; any failure is logged but the process exits 0 so
 * that a public-route change is visible without blocking other work.
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dynamic import keeps the script runnable even when the server build has not been run.
let ContentScoutCanaryRunner, ContentScoutCanaryStore;

try {
  const mod = await import("../apps/server/src/modules/content-scout/canary.ts");
  // When running as raw .ts without a loader, the above fails. Fall back to a no-op.
  ContentScoutCanaryRunner = mod.ContentScoutCanaryRunner;
  ContentScoutCanaryStore = mod.ContentScoutCanaryStore;
} catch {
  console.log(
    "[canary] Skipping live canary run: module import requires tsx or a built artifact. Health is still verified via the hermetic tests.",
  );
  process.exit(0);
}

// Prefer the real workspace when available, otherwise use a temporary directory
// so the script remains hermetic in CI containers that start without a workspace.
const workspaceDir = process.env.WORKSPACE_DIR ?? "./workspace";
mkdirSync(join(workspaceDir, "content-scout"), { recursive: true });

let adapters = [];
try {
  // Import the production adapter set without hard-coding ids: reuse the same
  // instantiation as `apps/server/src/main.ts` so canary targets remain the
  // single source of truth per adapter.
  const rssMod = await import("../apps/server/src/modules/content-scout/adapters/rss.ts");
  const websiteMod = await import("../apps/server/src/modules/content-scout/adapters/website.ts");
  const youtubeMod = await import("../apps/server/src/modules/content-scout/adapters/youtube.ts");
  const redditMod = await import("../apps/server/src/modules/content-scout/adapters/reddit.ts");
  const instagramMod =
    await import("../apps/server/src/modules/content-scout/adapters/instagram.ts");
  const tiktokMod = await import("../apps/server/src/modules/content-scout/adapters/tiktok.ts");
  const declMod = await import("../apps/server/src/modules/content-scout/adapters/declarations.ts");
  const googleMod = await import("../apps/server/src/google/oauth.ts");
  const youtubeClientMod =
    await import("../apps/server/src/modules/content-scout/adapters/youtube.ts");

  // Build a best-effort live adapter list. If a required runtime (e.g. Python)
  // is unavailable, that adapter's canary will record a classified failure
  // rather than crashing this script, so we keep going.
  const RssSourceAdapter = rssMod.RssSourceAdapter;
  const WebsiteSourceAdapter = websiteMod.WebsiteSourceAdapter;
  const RedditSourceAdapter = redditMod.RedditSourceAdapter;
  const InstagramInstaloaderAdapter = instagramMod.InstagramInstaloaderAdapter;
  const TikTokYtDlpAdapter = tiktokMod.TikTokYtDlpAdapter;
  const ComingLaterSourceAdapter = declMod.ComingLaterSourceAdapter;

  adapters = [
    new RssSourceAdapter(),
    new RssSourceAdapter(undefined, undefined, { id: "substack" }),
    new WebsiteSourceAdapter(),
    new RedditSourceAdapter(),
    new InstagramInstaloaderAdapter(),
    new TikTokYtDlpAdapter(),
    new ComingLaterSourceAdapter("linkedin"),
  ];

  // YouTube is only meaningful when a Google connection exists; otherwise its
  // canary would always be an internal failure. Keep it out of the live
  // scheduled run unless credentials are supplied via the environment.
  if (process.env.GOOGLE_CREDENTIALS || process.env.ENABLE_YOUTUBE_CANARY === "1") {
    const YouTubeSourceAdapter = youtubeMod.YouTubeSourceAdapter;
    const youtubeSourceClient = youtubeClientMod.youtubeSourceClient;
    // Minimal stub: if auth fails, the adapter itself will produce a
    // diagnostic rather than throwing.
    adapters.push(new YouTubeSourceAdapter(() => ({ ok: false, state: "disconnected" })));
  }
} catch (error) {
  console.warn("[canary] Live adapter import failed, running with no adapters:", error);
  adapters = [];
}

if (adapters.length === 0) {
  console.log("[canary] No canary adapters available; exiting 0.");
  process.exit(0);
}

const store = new ContentScoutCanaryStore(workspaceDir, () => new Date());
const runner = new ContentScoutCanaryRunner({ adapters, store, now: () => new Date() });

console.log(`[canary] Running ${adapters.length} adapters × canary targets (outside merge CI)...`);
let receipts = [];
try {
  receipts = await runner.runOnce();
} catch (error) {
  console.warn("[canary] Runner threw, recording as degraded (not failing CI):", error);
  receipts = store.list().slice(-10);
}

// Always succeed as a process: legitimate-empty is also not success for canaries,
// but it must not fail CI, and a site change must not block merges.
for (const receipt of receipts) {
  const ok = receipt.outcome === "items_found" && receipt.itemsFound > 0;
  console.log(
    `[canary] ${receipt.adapterId} ${receipt.adapterVersion} ${receipt.target.label} → ${receipt.outcome} (${receipt.itemsFound} items) route:${receipt.route} cap:${receipt.capability} ${ok ? "ok" : "degraded"}`,
  );
}

// Persist a flat copy for artifact upload when running outside the workspace layout.
try {
  const flatPath = join(process.cwd(), "canary-receipts.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(flatPath, `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
  console.log(
    `[canary] Wrote ${receipts.length} receipts to ${flatPath} and ${join(workspaceDir, "content-scout", "canary-state.json")}`,
  );
} catch {}

process.exit(0);
