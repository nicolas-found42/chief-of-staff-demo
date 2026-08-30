import type { ContentResearchHost } from "./host.js";

/**
 * The V1 watchlist (spec #116): the candidates verified by primary fetch on
 * the V1 surfaces during the grill. Verified feeds and channels carry explicit
 * discovered targets; the remaining platforms watch the person by name
 * (Reddit / Hacker News / Google News search) — the derivation in targets.ts.
 * Pieter Levels' YouTube presence is guest appearances, not an owned channel,
 * so no YouTube target is invented for him.
 */
export function seedContentResearchV1(host: ContentResearchHost): void {
  if (host.listAllPeople().length > 0) return;
  host.addPerson({
    name: "Lenny Rachitsky",
    handleHints: { blogRssHints: ["https://www.lennysnewsletter.com/feed"] },
    discoveredSourceTargets: [
      {
        adapterId: "rss",
        url: "https://www.lennysnewsletter.com/feed",
        label: "Lenny's Newsletter (Substack)",
      },
      {
        adapterId: "youtube",
        url: "https://www.youtube.com/@LennysPodcast",
        label: "Lenny's Podcast",
      },
    ],
  });
  host.addPerson({
    name: "Pieter Levels",
    handleHints: { blogRssHints: ["https://levels.io/rss"] },
    discoveredSourceTargets: [
      { adapterId: "rss", url: "https://levels.io/rss", label: "@levelsio blog" },
    ],
  });
}
