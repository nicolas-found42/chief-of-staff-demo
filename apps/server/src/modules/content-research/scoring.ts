import type { SourceItem } from "@chief-of-staff-demo/shared";
import {
  CONTENT_RESEARCH_PLATFORM_WEIGHTS,
  type ResonanceCounts,
  type ResonanceScoredItem,
} from "@chief-of-staff-demo/shared";

/**
 * The counts a platform reported for this item. Only what the adapter observed
 * is carried through — an absent count means the platform exposes none, and is
 * never read as a zero the way a missing field silently would be.
 */
function extractCounts(item: SourceItem): ResonanceCounts {
  const counts: ResonanceCounts = {};
  const engagement = item.engagement;
  if (engagement) {
    if (engagement.views !== undefined) counts.views = engagement.views;
    if (engagement.likes !== undefined) counts.likes = engagement.likes;
    if (engagement.votes !== undefined) counts.votes = engagement.votes;
    if (engagement.hnPoints !== undefined) counts.hnPoints = engagement.hnPoints;
    if (engagement.redditScore !== undefined) counts.redditScore = engagement.redditScore;
    if (engagement.reposts !== undefined) counts.reposts = engagement.reposts;
  }
  return counts;
}

function weightedCount(counts: ResonanceCounts): number {
  const views = counts.views ?? 0;
  const votes = counts.votes ?? counts.redditScore ?? counts.likes ?? 0;
  const hnPoints = counts.hnPoints ?? 0;
  const reposts = counts.reposts ?? 0;
  return (
    views * CONTENT_RESEARCH_PLATFORM_WEIGHTS.views +
    votes * CONTENT_RESEARCH_PLATFORM_WEIGHTS.votes +
    hnPoints * CONTENT_RESEARCH_PLATFORM_WEIGHTS.hnPoints +
    reposts * CONTENT_RESEARCH_PLATFORM_WEIGHTS.reposts
  );
}

function platformForAdapter(adapterId: string): string {
  const lower = adapterId.toLowerCase();
  if (lower.includes("youtube") || lower.includes("yt")) return "youtube";
  if (lower.includes("reddit")) return "reddit";
  if (lower.includes("hacker") || lower.includes("hn")) return "hn";
  if (lower.includes("news") || lower.includes("google")) return "news";
  if (lower.includes("rss") || lower.includes("substack") || lower.includes("website"))
    return "rss";
  return adapterId;
}

export function toScoredItem(input: {
  item: SourceItem;
  adapterId: string;
  hook: string | null;
  evidenceQuote?: string | null;
  baseline: { mean: number; stdDev: number; historyLength: number } | null;
}): ResonanceScoredItem {
  const counts = extractCounts(input.item);
  const w = weightedCount(counts);
  const score = (() => {
    if (!input.baseline || input.baseline.historyLength === 0) return w;
    if (input.baseline.stdDev === 0) return w - input.baseline.mean;
    return (w - input.baseline.mean) / input.baseline.stdDev;
  })();
  return {
    canonicalUrl: input.item.canonicalUrl,
    platform: platformForAdapter(input.adapterId),
    title: input.item.title,
    publishedAt: input.item.publishedAt,
    discoveredAt: input.item.discoveredAt,
    counts,
    weightedCount: w,
    resonanceScore: score,
    hook: input.hook,
    evidenceQuote: input.evidenceQuote ?? null,
    evidenceUrl: input.item.evidence[0]?.route ?? input.item.canonicalUrl,
    completeness: {
      title: String(input.item.completeness.title),
      body: String(input.item.completeness.body),
      description: String(input.item.completeness.description),
      transcript: String(input.item.completeness.transcript),
      comments: String(input.item.completeness.comments),
      media: String(input.item.completeness.media),
    },
    sourceItemId: input.item.id,
  };
}
