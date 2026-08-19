import { z } from "zod";

/**
 * Extraction result — mirror of the routine's `routine/outbox-schema.json` v1,
 * with two adaptations for this app:
 *  - `drafts[].body` added: this app composes the draft text itself and creates
 *    the Gmail draft from it.
 *  - `sourceId` / `sourceUrl` generalized: a run id or Fireflies transcript id
 *    and any source URL, instead of Drive file id / url.
 */
export const ExtractionResultSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.string(),
  sourceFileName: z.string(),
  sourceUrl: z.string().nullable(),
  processedAt: z.string(),
  isTranscript: z.boolean(),
  skipReason: z.string().nullable(),
  summary: z.string(),
  tasks: z.array(
    z.strictObject({
      title: z.string().min(1),
      owner: z.string().optional(),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "due must be YYYY-MM-DD")
        .optional(),
      notes: z.string().optional(),
      sourceQuote: z.string().optional(),
    })
  ),
  drafts: z.array(
    z.strictObject({
      /** Empty string when the recipient is unknown. */
      to: z.string().optional(),
      subject: z.string(),
      body: z.string(),
      reason: z.string().optional(),
    })
  ),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type TaskItem = ExtractionResult["tasks"][number];
export type DraftItem = ExtractionResult["drafts"][number];

/**
 * Wire schema handed to LLM providers as the structured-output contract.
 * Identical to `ExtractionResultSchema` except every optional field is
 * required-but-nullable: OpenAI strict json_schema demands that all properties
 * appear in `required`. The pipeline normalizes nulls away and re-validates
 * with `ExtractionResultSchema` before trusting the payload.
 */
export const ExtractionWireSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.string(),
  sourceFileName: z.string(),
  sourceUrl: z.string().nullable(),
  processedAt: z.string(),
  isTranscript: z.boolean(),
  skipReason: z.string().nullable(),
  summary: z.string(),
  tasks: z.array(
    z.strictObject({
      title: z.string(),
      owner: z.string().nullable(),
      due: z.string().nullable(),
      notes: z.string().nullable(),
      sourceQuote: z.string().nullable(),
    })
  ),
  drafts: z.array(
    z.strictObject({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      reason: z.string().nullable(),
    })
  ),
});

/**
 * Convert a provider payload into the canonical shape. Accepts either the
 * wire shape (all fields required, null for absent optionals — what strict
 * structured-output providers emit) or the canonical shape (optional fields
 * omitted, e.g. a hand-edited mock-result.json). Throws when neither
 * validates.
 */
export function normalizeExtractionResult(payload: unknown): ExtractionResult {
  const wire = ExtractionWireSchema.safeParse(payload);
  if (wire.success) {
    return ExtractionResultSchema.parse({
      ...wire.data,
      tasks: wire.data.tasks.map((task) => {
        const out: Record<string, unknown> = { title: task.title };
        for (const key of ["owner", "due", "notes", "sourceQuote"] as const) {
          if (task[key] !== null && task[key] !== undefined) {
            out[key] = task[key];
          }
        }
        return out;
      }),
      drafts: wire.data.drafts.map((draft) => {
        const out: Record<string, unknown> = {
          to: draft.to ?? "",
          subject: draft.subject,
          body: draft.body,
        };
        if (draft.reason !== null && draft.reason !== undefined) {
          out.reason = draft.reason;
        }
        return out;
      }),
    });
  }
  return ExtractionResultSchema.parse(payload);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const PROVIDERS = ["openai", "anthropic", "openrouter", "gemini", "ollama", "mock"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export const ProviderIdSchema = z.enum(PROVIDERS);

/** Default model per provider; free-text editable in Settings. */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.2",
  anthropic: "claude-sonnet-5",
  openrouter: "google/gemini-3.7-flash",
  gemini: "gemini-3.7-flash",
  ollama: "nemotron",
  mock: "",
};

/** Ollama's default listen address. `host.docker.internal` inside a container. */
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export const ConfigSchema = z.strictObject({
  provider: ProviderIdSchema,
  model: z.string(),
  apiKey: z.string(),
  tasklistName: z.string().default("Meeting Followups"),
  google: z.strictObject({
    clientId: z.string(),
    clientSecret: z.string(),
    refreshToken: z.string().nullable(),
  }),
  fireflies: z.strictObject({
    enabled: z.boolean().default(false),
    apiKey: z.string(),
    pollIntervalMinutes: z.number().int().positive().default(5),
  }),
  watch: z.strictObject({
    enabled: z.boolean().default(false),
    folderPath: z.string(),
  }),
  ollama: z.strictObject({
    baseUrl: z.string().default(DEFAULT_OLLAMA_BASE_URL),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** PUT /api/config body. Absent secret fields keep their stored values. */
export const ConfigUpdateSchema = z.strictObject({
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  tasklistName: z.string().optional(),
  google: z
    .strictObject({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
    })
    .optional(),
  fireflies: z
    .strictObject({
      enabled: z.boolean().optional(),
      apiKey: z.string().optional(),
      pollIntervalMinutes: z.number().int().positive().optional(),
    })
    .optional(),
  watch: z
    .strictObject({
      enabled: z.boolean().optional(),
      folderPath: z.string().optional(),
    })
    .optional(),
  ollama: z
    .strictObject({
      baseUrl: z.string().optional(),
    })
    .optional(),
});

export type ConfigUpdate = z.infer<typeof ConfigUpdateSchema>;

export interface SecretHint {
  set: boolean;
  /** Last 4 characters of the stored secret, "" when unset. */
  hint: string;
}

/** GET /api/config response payload: every secret replaced by a hint. */
export interface RedactedConfig {
  provider: ProviderId;
  model: string;
  tasklistName: string;
  apiKey: SecretHint;
  google: {
    clientId: string;
    clientSecret: SecretHint;
    connected: boolean;
  };
  fireflies: {
    enabled: boolean;
    apiKey: SecretHint;
    pollIntervalMinutes: number;
  };
  watch: {
    enabled: boolean;
    folderPath: string;
  };
  /** Not a secret: a local endpoint address, returned verbatim. */
  ollama: {
    baseUrl: string;
  };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  "pending",
  "extracting",
  "creating-outputs",
  "done",
  "skipped",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_SOURCES = ["upload", "fireflies", "watch"] as const;
export type RunSourceType = (typeof RUN_SOURCES)[number];

export type RunFailedStage = "extract" | "outputs";

/** runs/<runId>/meta.json */
export interface RunMeta {
  id: string;
  createdAt: string;
  source: RunSourceType;
  fileName: string;
  sourceUrl: string | null;
  externalId: string | null;
  status: RunStatus;
  attempts: number;
  failedStage: RunFailedStage | null;
  skipReason: string | null;
}

export const RUN_EVENT_TYPES = [
  "created",
  "extract_attempt",
  "extract_error",
  "extract_ok",
  "classify_skipped",
  "google_task_created",
  "google_task_error",
  "gmail_draft_created",
  "gmail_draft_error",
  "google_not_connected",
  "run_done",
  "run_failed",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** One JSON line in runs/<runId>/events.jsonl */
export interface RunEvent {
  at: string;
  type: RunEventType;
  detail?: Record<string, unknown>;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  source: RunSourceType;
  fileName: string;
  sourceUrl: string | null;
  status: RunStatus;
  /** Task count from result.json; null before a result exists. */
  taskCount: number | null;
}

export interface RunDetail extends RunSummary {
  attempts: number;
  failedStage: RunFailedStage | null;
  skipReason: string | null;
  result: ExtractionResult | null;
  events: RunEvent[];
  transcript: string;
}

export interface GoogleStatus {
  connected: boolean;
  email: string | null;
}
