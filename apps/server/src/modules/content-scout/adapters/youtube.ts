import { createHash } from "node:crypto";
import { google } from "googleapis";
import type { AdapterDiagnostic, SourceComment, SourceItem } from "@chief-of-staff-demo/shared";
import type { GoogleConnectionState } from "@chief-of-staff-demo/shared";
import type { GoogleAuth } from "../../../google/oauth.js";
import { parseChannelUrl, type ChannelRef } from "../../youtube/channels.js";
import type { SourceAdapter, SourceCollectionResult } from "../ports.js";

interface YouTubeSourceVideo {
  id: string;
  title: string;
  description: string | null;
  channelTitle: string | null;
  publishedAt: string;
}

export interface YouTubeSourceClient {
  resolveChannel(ref: ChannelRef): Promise<{ id: string; uploadsPlaylistId: string } | null>;
  listUploads(playlistId: string, publishedAfter: string): Promise<YouTubeSourceVideo[]>;
  listComments(videoId: string, limit: number): Promise<SourceComment[]>;
}

export type YouTubeSourceAccess =
  { ok: true; client: YouTubeSourceClient } | { ok: false; state: GoogleConnectionState };

export function youtubeSourceClient(auth: GoogleAuth): YouTubeSourceClient {
  const api = google.youtube({ version: "v3", auth });
  return {
    async resolveChannel(ref) {
      const lookup =
        ref.kind === "handle"
          ? { forHandle: ref.value }
          : ref.kind === "id"
            ? { id: [ref.value] }
            : { forUsername: ref.value };
      const response = await api.channels.list({
        part: ["contentDetails"],
        maxResults: 1,
        ...lookup,
      });
      const channel = response.data.items?.[0];
      const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads;
      return channel?.id && uploadsPlaylistId ? { id: channel.id, uploadsPlaylistId } : null;
    },

    async listUploads(playlistId, publishedAfter) {
      const videos: YouTubeSourceVideo[] = [];
      let pageToken: string | undefined;
      let reachedOld = false;
      do {
        const response = await api.playlistItems.list({
          part: ["snippet", "contentDetails"],
          playlistId,
          maxResults: 50,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const item of response.data.items ?? []) {
          const id = item.contentDetails?.videoId;
          const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
          if (!id || !publishedAt) continue;
          if (Date.parse(publishedAt) < Date.parse(publishedAfter)) {
            reachedOld = true;
            continue;
          }
          videos.push({
            id,
            title: item.snippet?.title ?? id,
            description: item.snippet?.description ?? null,
            channelTitle:
              item.snippet?.videoOwnerChannelTitle ?? item.snippet?.channelTitle ?? null,
            publishedAt: new Date(publishedAt).toISOString(),
          });
        }
        pageToken = reachedOld ? undefined : (response.data.nextPageToken ?? undefined);
      } while (pageToken);
      return videos;
    },

    async listComments(videoId, limit) {
      const response = await api.commentThreads.list({
        part: ["snippet"],
        videoId,
        maxResults: Math.min(limit, 50),
        order: "relevance",
        textFormat: "plainText",
      });
      return (response.data.items ?? []).flatMap((thread): SourceComment[] => {
        const comment = thread.snippet?.topLevelComment;
        const snippet = comment?.snippet;
        if (!comment?.id || !snippet?.textDisplay) return [];
        return [
          {
            author: snippet.authorDisplayName ?? null,
            publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt).toISOString() : null,
            url: `https://www.youtube.com/watch?v=${videoId}&lc=${comment.id}`,
            text: snippet.textDisplay,
            engagement: snippet.likeCount ?? null,
          },
        ];
      });
    },
  };
}

export class YouTubeSourceAdapter implements SourceAdapter {
  readonly id = "youtube";
  readonly state = "available" as const;
  readonly version = "youtube-data-api-v3";

  constructor(
    private readonly getAccess: () => YouTubeSourceAccess,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: Parameters<SourceAdapter["collect"]>[0]): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    const access = this.getAccess();
    if (!access.ok) {
      return this.failure(
        "blocked_access",
        request.target.url,
        startedAt,
        ["youtube"],
        [`Google connection is ${access.state}.`],
      );
    }
    let ref: ChannelRef;
    try {
      ref = parseChannelUrl(request.target.url);
    } catch (error) {
      return this.failure(
        "unsupported_capability",
        request.target.url,
        startedAt,
        ["source_target"],
        [error instanceof Error ? error.message : String(error)],
      );
    }
    try {
      const channel = await access.client.resolveChannel(ref);
      if (!channel) {
        return this.failure(
          "response_shape_change",
          request.target.url,
          startedAt,
          ["channel"],
          ["YouTube returned no uploads playlist for the public channel."],
        );
      }
      const videos = await access.client.listUploads(channel.uploadsPlaylistId, request.since);
      const items: SourceItem[] = videos.map((video) => ({
        id: `${request.target.id}:${video.id}`,
        externalId: video.id,
        targetId: request.target.id,
        adapterId: this.id,
        canonicalUrl: `https://www.youtube.com/watch?v=${video.id}`,
        author: video.channelTitle,
        title: video.title,
        body: video.description,
        description: video.description,
        publishedAt: video.publishedAt,
        discoveredAt: this.now().toISOString(),
        media: [{ type: "video", url: `https://www.youtube.com/watch?v=${video.id}` }],
        transcript: null,
        comments: [],
        evidence: [
          { route: "youtube.data.playlistItems.list", retrievedAt: this.now().toISOString() },
        ],
        completeness: {
          title: "available",
          body: video.description ? "available" : "unavailable",
          description: video.description ? "available" : "unavailable",
          transcript: "unavailable",
          comments: "unavailable",
        },
      }));
      const hash = createHash("sha256")
        .update(videos.map((video) => video.id).join("\n"))
        .digest("hex");
      const outcome =
        items.length > 0
          ? "items_found"
          : request.checkpoint
            ? "no_new_material"
            : "legitimate_empty";
      return {
        kind: "completed",
        outcome,
        items,
        checkpoint: hash,
        diagnostic: this.diagnostic(outcome, request.target.url, startedAt, [], []),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        (error as { code?: number; response?: { status?: number } }).code ??
        (error as { response?: { status?: number } }).response?.status;
      const outcome =
        status === 429
          ? "rate_limit"
          : status === 401 || status === 403
            ? "blocked_access"
            : "internal_failure";
      return this.failure(outcome, request.target.url, startedAt, ["items"], [message]);
    }
  }

  async enrich(items: SourceItem[]): Promise<SourceItem[]> {
    const access = this.getAccess();
    if (!access.ok) {
      return items.map((item) => ({
        ...item,
        completeness: { ...item.completeness, comments: "failed" },
      }));
    }
    return await Promise.all(
      items.map(async (item) => {
        try {
          const comments = await access.client.listComments(item.externalId, 50);
          return {
            ...item,
            comments,
            completeness: {
              ...item.completeness,
              comments: "available" as const,
            },
          };
        } catch {
          return {
            ...item,
            completeness: { ...item.completeness, comments: "failed" as const },
          };
        }
      }),
    );
  }

  private failure(
    outcome: Extract<SourceCollectionResult, { kind: "failed" }>["outcome"],
    route: string,
    startedAt: string,
    affectedCapabilities: AdapterDiagnostic["affectedCapabilities"],
    causeChain: string[],
  ): SourceCollectionResult {
    return {
      kind: "failed",
      outcome,
      items: [],
      checkpoint: null,
      diagnostic: this.diagnostic(outcome, route, startedAt, affectedCapabilities, causeChain),
    };
  }

  private diagnostic(
    classification: AdapterDiagnostic["classification"],
    route: string,
    startedAt: string,
    affectedCapabilities: AdapterDiagnostic["affectedCapabilities"],
    causeChain: string[],
  ): AdapterDiagnostic {
    return {
      classification,
      route,
      status: null,
      contentType: "application/json",
      parserStage: "youtube_data_api",
      responseHash: "",
      adapterVersion: this.version,
      startedAt,
      finishedAt: this.now().toISOString(),
      retries: 0,
      affectedCapabilities,
      causeChain,
    };
  }
}
