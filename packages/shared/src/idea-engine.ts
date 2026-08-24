import { z } from "zod";

/** The Module's stable identity. */
export const IDEA_ENGINE_MODULE_ID = "idea-engine";
export const IDEA_ENGINE_MODULE_VERSION = 1;

/** 12 prompt types — Relay's `content_types` verbatim. */
export const IDEA_CONTENT_TYPES = [
  "Live_thread",
  "Vertical_short",
  "X/Twitter",
  "LinkedIn_Carousel",
  "video",
  "blog_post",
  "article",
  "how_to_guide",
  "case_study_article",
  "LinkedIn_post_image",
  "LinkedIn_post_video",
  "email",
] as const;
export type IdeaContentType = (typeof IDEA_CONTENT_TYPES)[number];

export const IDEA_FORMAT_VALUES = ["articles", "blog_posts", "videos", "how_to_guides"] as const;
export type IdeaFormat = (typeof IDEA_FORMAT_VALUES)[number];
export const IdeaFormatSchema = z.enum(IDEA_FORMAT_VALUES);

/** The four Sheet values; `Format` is the only enum the validator enforces. */
export const IdeaSheetFormatSchema = z.enum(IDEA_FORMAT_VALUES);

/** One idea as the LLM returns it, before internal enrichment. */
export const IdeaEngineIdeaWireSchema = z.strictObject({
  Title: z.string().min(1),
  Description: z.string().min(1),
  "Target Audience": z.string(),
  CTA: z.string(),
  Format: IdeaFormatSchema,
  "Custom Prompt": z.string(),
  evidence: z.strictObject({
    at: z.string(),
    quote: z.string(),
  }),
  confidence: z.number().min(0).max(1),
});

export type IdeaEngineIdeaWire = z.infer<typeof IdeaEngineIdeaWireSchema>;

/** One idea as persisted in the Run result (internal fields kept, Sheet copy is flat). */
export const IdeaEngineIdeaSchema = IdeaEngineIdeaWireSchema.extend({
  ContentType: z.enum(IDEA_CONTENT_TYPES),
});
export type IdeaEngineIdea = z.infer<typeof IdeaEngineIdeaSchema>;

/** The flat row written to Sheets — no internal evidence/confidence. */
export interface IdeaSheetRow {
  Title: string;
  Description: string;
  "Target Audience": string;
  CTA: string;
  Format: IdeaFormat;
  ContentType: IdeaContentType;
  "Custom Prompt": string;
  "Transcript Name": string;
  "Transcript URL": string | null;
  "Idea processing timestamp": string;
  Status: string;
}

/** `result.json` for one Idea Engine Run. */
export interface IdeaEngineRunResult {
  version: 1;
  sourceId: string;
  sourceFileName: string;
  sourceUrl: string | null;
  ideas: IdeaEngineIdea[];
  perTypeReasons: Partial<Record<IdeaContentType, string>>;
  reason: string | null;
  /** Persisted intra-type dedupe hashes for audit, per content type. */
  hashes?: Partial<Record<IdeaContentType, string[]>>;
  /** When the Run ran. */
  processedAt: string;
}

/**
 * GET /api/idea-engine/ideas — the Cross-Run index (ADR-0005).
 * Derived by scanning Run results, never a second copy.
 */
export interface IdeaEngineIndex {
  /** One entry per Run, newest first. */
  runs: Array<{
    runId: string;
    createdAt: string;
    fileName?: string | undefined;
    sourceUrl: string | null;
    externalId: string | null;
    ideas: IdeaEngineIdea[];
    summary: string | null;
  }>;
  /** Distinct ideas across all Runs, filterable by ContentType. */
  ideas: IdeaEngineIdea[];
}

/** Header for the single tab `All RA Content Ideas`. ContentType beside Format. */
export const IDEA_SHEET_TAB = "All RA Content Ideas";
export const IDEA_SHEET_HEADER = [
  "Title",
  "Description",
  "Target Audience",
  "CTA",
  "Format",
  "ContentType",
  "Custom Prompt",
  "Status",
  "Transcript Name",
  "Transcript in Google Drive",
  "Idea processing timestamp",
];

/** Batch size for the 12 Stages. */
export const IDEA_BATCH_SIZE = 4;
export const IDEA_STAGE_TIMEOUT_MS = 60_000;
export const IDEA_VALIDATOR_RETRIES = 3;

/** Default prompts versioned with the Module (12 distinct). */
export const IDEA_DEFAULT_PROMPTS: Record<IdeaContentType, string> = {
  Live_thread: "Extract Live_thread ideas: long-form live discussion hooks, threaded narrative arc, real-time audience interaction. Focus on statements by the workspace owner that could seed a live audio/threaded conversation.",
  Vertical_short: "Extract Vertical_short ideas: 0-30s hook, on-screen text, punchline, vertical video for Shorts/TikTok/Reels. Focus on owner's one-line hooks and visual moments.",
  "X/Twitter": "Extract X/Twitter ideas: concise, timely, opinionated takes suited to a single X post or short thread. Focus on owner's positions.",
  LinkedIn_Carousel: "Extract LinkedIn_Carousel ideas: swipeable carousel narrative, each slide a point, suited to LinkedIn document post. Focus on owner's frameworks or lists.",
  video: "Extract video ideas: long-form YouTube video story arc, hook, visual proof, chapters. Focus on owner's deep stories.",
  blog_post: "Extract blog_post ideas: blog headline, thesis, proof points, SEO-friendly outline. Focus on owner's written insights.",
  article: "Extract article ideas: headline, thesis, proof, long-form editorial arc for publication. Focus on owner's positions with evidence.",
  how_to_guide: "Extract how_to_guide ideas: step-by-step instructional promise, prerequisites, steps, outcomes. Focus on owner's playbooks.",
  case_study_article: "Extract case_study_article ideas: client context, challenge, approach, outcome, proof. Focus on owner's delivered work.",
  LinkedIn_post_image: "Extract LinkedIn_post_image ideas: single image post hook, insight, visual cue. Focus on owner's sharable moments.",
  LinkedIn_post_video: "Extract LinkedIn_post_video ideas: talking-head video hook, script beats, CTA for LinkedIn video. Focus on owner's camera-ready statements.",
  email: "Extract email ideas: subject, audience, narrative, CTA for newsletter/sales email. Focus on owner's offers or narratives.",
};
