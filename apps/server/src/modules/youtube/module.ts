import type {
  YoutubeChannel,
  YoutubeChannelCounts,
  YoutubeRunResult,
  YoutubeVideoCount,
} from "@chief-of-staff-demo/shared";
import {
  StageFailure,
  type RetryPlan,
  type RunContext,
  type ShellModule,
} from "../../engine/module.js";
import type { GoogleConnectionState } from "@chief-of-staff-demo/shared";
import { googleFailureHint, googleSurfaceHint } from "../../google/connection.js";
import type { RunOutcome } from "../../runs.js";
import { STATISTICS_CHUNK, chunk, type YouTubeClient } from "./client.js";
import { localDay } from "./day.js";

export const YOUTUBE_MODULE_ID = "youtube-trends";
export const YOUTUBE_MODULE_VERSION = 1;

/** The Module's Intake name, recorded on every Run it starts. */
export const YOUTUBE_INTAKE = "daily";

/** A YouTube client, or the connection state that says why there is none. */
export type ClientAccess =
  | { ok: true; client: YouTubeClient }
  | { ok: false; state: GoogleConnectionState };

export interface YoutubeDeps {
  /** Never touches the network: the same cheap check the outputs surface makes. */
  getClient: () => ClientAccess;
  /** What an error a YouTube call threw proves about the connection. */
  observe: (error: unknown) => GoogleConnectionState | null;
  /** The channels as stored — resolved when they were added, never re-resolved. */
  getChannels: () => YoutubeChannel[];
  /** The derived trend is cached; the day's counts are the only thing that changes it. */
  invalidateTrend: () => void;
}

/** A fresh Run measures today; a retry re-runs from the Stage that failed. */
export type YoutubeInput = { kind: "measure" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One line for the Runs list. What was measured, in the units a person thinks
 * in — and the videos YouTube would not answer for, because three deleted
 * videos should not read as a broken automation.
 */
export function youtubeSummary(channels: number, videos: number, failed: number): string {
  const parts = [
    channels === 1 ? "1 channel" : `${channels} channels`,
    videos === 1 ? "1 video" : `${videos} videos`,
  ];
  if (failed > 0) {
    parts.push(failed === 1 ? "1 unavailable" : `${failed} unavailable`);
  }
  return parts.join(", ");
}

/**
 * YouTube Trends: two Stages it names and orders itself. `enumerate` pages each
 * channel's uploads playlist into a set of video ids; `fetch` reads statistics
 * in chunks and ends by writing the day's counts as the Run's own file.
 *
 * A failed video does not fail the Run — it is named in the result and the Run
 * finishes. A failure that prevents the call being made at all does, because
 * "nothing was measured" must never look like "nothing changed".
 */
export function youtubeTrendsModule(deps: YoutubeDeps): ShellModule<YoutubeInput> {
  /** Whatever a YouTube call threw, worded for the person who has to fix it. */
  const failed = (ctx: RunContext, error: unknown): StageFailure => {
    const state = deps.observe(error);
    if (state) {
      ctx.event("google_unavailable", { state, error: errorMessage(error) });
      return new StageFailure(`google_${state}`, googleFailureHint(state), {
        connectionCaused: true,
      });
    }
    /* A missing scope, a disabled API or an exhausted quota: Google's own 403
       names the cause precisely, and the setup check's classifier already turns
       it into the console step that fixes it. */
    return new StageFailure(errorMessage(error), googleSurfaceHint("youtube", error));
  };

  const client = (ctx: RunContext): YouTubeClient => {
    const access = deps.getClient();
    if (!access.ok) {
      ctx.event("google_unavailable", { state: access.state });
      throw new StageFailure(`google_${access.state}`, googleFailureHint(access.state), {
        connectionCaused: true,
      });
    }
    return access.client;
  };

  return {
    id: YOUTUBE_MODULE_ID,
    version: YOUTUBE_MODULE_VERSION,

    failureHint(stage: string): string {
      return stage === "enumerate"
        ? "The channel's videos could not be listed. Retry, or check the events below."
        : "The view counts could not be read. Retry, or check the events below.";
    },

    planRetry(meta): RetryPlan<YoutubeInput> | null {
      if (meta.status !== "failed" || !meta.failedStage) {
        return null;
      }
      /* Retried in place and always from the top: the video ids `enumerate`
         found live in memory, not on disk, and re-finding them costs one quota
         unit per fifty videos. Nothing anywhere has to define "the latest Run
         for a day", because there is only ever one. */
      return {
        fromStage: "enumerate",
        input: { kind: "measure" },
        resetAttempts: true,
        discard: ["result.json"],
      };
    },

    async run(ctx): Promise<RunOutcome> {
      const channels = deps.getChannels();
      /* The day this Run measures, stamped on the Run by the Intake that
         created it. One decision recorded once: deriving it here from the clock
         would let a Run created a second either side of midnight disagree with
         the date the Intake remembered, and put two Runs on one day. A Run made
         without one falls back to the day it was created. */
      const day = ctx.meta().externalId ?? localDay(new Date(ctx.meta().createdAt));

      const enumerated = await ctx.stage("enumerate", async () => {
        const found = new Map<string, string[]>();
        for (const channel of channels) {
          let ids: string[];
          try {
            ids = await client(ctx).listUploads(channel.uploadsPlaylistId);
          } catch (error) {
            throw error instanceof StageFailure ? error : failed(ctx, error);
          }
          ctx.event("channel_enumerated", {
            channelId: channel.id,
            title: channel.title,
            videos: ids.length,
          });
          found.set(channel.id, ids);
        }
        return found;
      });

      return await ctx.stage("fetch", async () => {
        const counted: YoutubeChannelCounts[] = [];
        for (const channel of channels) {
          const ids = enumerated.get(channel.id) ?? [];
          const videos: YoutubeVideoCount[] = [];
          const failedIds: string[] = [];
          for (const batch of chunk(ids, STATISTICS_CHUNK)) {
            try {
              const answer = await client(ctx).videoStatistics(batch);
              videos.push(...answer.videos);
              failedIds.push(...answer.failedIds);
            } catch (error) {
              throw error instanceof StageFailure ? error : failed(ctx, error);
            }
          }
          if (failedIds.length > 0) {
            /* Named, not hidden, and not a failure: a deleted or private video
               is a fact about that video. */
            ctx.event("videos_unavailable", { channelId: channel.id, ids: failedIds });
          }
          ctx.event("channel_counted", {
            channelId: channel.id,
            title: channel.title,
            videos: videos.length,
            views: videos.reduce((total, video) => total + video.viewCount, 0),
          });
          counted.push({
            channelId: channel.id,
            handle: channel.handle,
            title: channel.title,
            videos,
            failedIds,
          });
        }

        /* The day's counts, written before anything downstream can fail. This
           is what makes a later Stage's retry safe: it resumes against counts
           already fetched and records no second snapshot. */
        const result: YoutubeRunResult = {
          version: 1,
          day,
          measuredAt: new Date().toISOString(),
          channels: counted,
        };
        ctx.writeFile("result.json", JSON.stringify(result, null, 2) + "\n");
        deps.invalidateTrend();

        const videos = counted.reduce((total, entry) => total + entry.videos.length, 0);
        const unavailable = counted.reduce((total, entry) => total + entry.failedIds.length, 0);
        return {
          status: "done",
          summary: youtubeSummary(counted.length, videos, unavailable),
          detail: { day, channels: counted.length, videos, unavailable },
        };
      });
    },
  };
}
