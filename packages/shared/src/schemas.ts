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
    /* When a sign-in last succeeded. Null means one never has, which is what
       keeps the setup steps on screen for someone whose first attempt failed. */
    lastConnectedAt: z.string().nullable().default(null),
    /* Whether Google has ever refused this grant. The seven-day expiry belongs
       to a consent screen whose publishing status is Testing; an Internal app
       has no publishing status and never expires. This app cannot read its own
       publishing status with the scopes it holds, so it does not guess — it
       predicts an expiry only once it has seen one. */
    hasExpiredBefore: z.boolean().default(false),
  }),
  drive: z.strictObject({
    enabled: z.boolean().default(false),
    folderId: z.string().default(""),
    folderName: z.string().default(""),
    pollIntervalMinutes: z.number().int().positive().default(2),
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
  drive: z
    .strictObject({
      enabled: z.boolean().optional(),
      folderId: z.string().optional(),
      folderName: z.string().optional(),
      pollIntervalMinutes: z.number().int().positive().optional(),
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
  };
  drive: {
    enabled: boolean;
    folderId: string;
    folderName: string;
    pollIntervalMinutes: number;
  };
  /** Not a secret: a local endpoint address, returned verbatim. */
  ollama: {
    baseUrl: string;
  };
}

// ---------------------------------------------------------------------------
// Google connection
// ---------------------------------------------------------------------------

/**
 * Where the Google connection stands. Four states rather than one boolean,
 * because a stored refresh token that Google has stopped honouring is not an
 * error case here — it is the documented weekly end state of every OAuth client
 * whose consent screen is External and whose publishing status is Testing, and
 * a personal Google account leaves no other option. Reporting that as
 * "connected" sends the next Run to a failure the Shell could have named.
 */
export const GOOGLE_CONNECTION_STATES = [
  /** No OAuth client credentials stored yet: the setup steps have not been done. */
  "unconfigured",
  /** Credentials stored, nobody signed in yet. */
  "disconnected",
  /** Google answered a token refresh; Tasks and drafts will be written. */
  "connected",
  /** Credentials stored and a token held, but Google rejected it — sign in again. */
  "expired",
] as const;
export type GoogleConnectionState = (typeof GOOGLE_CONNECTION_STATES)[number];

/** GET /api/google/status response. */
export interface GoogleStatus {
  state: GoogleConnectionState;
  /** The signed-in account, when Google told us who it is. */
  email: string | null;
  /**
   * The exact redirect URI to register, derived from the port the server is
   * actually listening on. Served rather than written into the UI so the two
   * cannot drift when PORT changes.
   */
  redirectUri: string;
  /** The scopes to add to the consent screen, in the order they are requested. */
  scopes: string[];
  /**
   * When the last sign-in succeeded, or null if one never has. This is what
   * separates "set up, merely signed out" from "half-configured, never worked"
   * without a fifth state: the console steps stay on screen until it is set.
   */
  lastConnectedAt: string | null;
  /**
   * When Google will probably stop accepting the sign-in. An estimate, never a
   * promise — Google does not report a refresh token's lifetime, and a password
   * change or a revoke ends the grant immediately.
   *
   * Null until Google has actually refused this grant once. The seven-day limit
   * applies to a consent screen in Testing; an Internal app has none, and
   * predicting one there would warn every week about an event that never
   * arrives. The prediction is earned by observation, not assumed.
   */
  expiresAbout: string | null;
}

/**
 * How long Google leaves a refresh token alive while a consent screen's
 * publishing status is Testing. Google's documented behaviour, not a value it
 * returns, so everything derived from it is an estimate.
 */
export const GOOGLE_TESTING_TOKEN_DAYS = 7;

/**
 * POST /api/google/check response: what Google itself said about each surface
 * the app needs. Answers "did I finish the console steps?" by asking Google
 * rather than by describing the console — the console is the part that goes
 * stale, and a 403 from Google names the missing piece exactly.
 */
export interface SetupCheck {
  state: GoogleConnectionState;
  /**
   * One line per surface checked, in the order the setup steps introduce them.
   * Empty when the connection state made a call impossible at all.
   */
  items: { label: string; ok: boolean; detail: string }[];
}

/** GET /api/google/picker-token response: short-lived token for the Picker. */
export interface PickerTokenResponse {
  token: string;
  expiresAt: string | null;
}

/** GET /api/intake/drive response: what the Drive Intake remembers (D14).
 *  Served from config and the state file; it never asks Google anything. */
export interface DriveIntakeStatus {
  enabled: boolean;
  configured: boolean;
  folderName: string;
  pollIntervalMinutes: number;
  /** Null until the first poll of this process completes — after a restart
   *  there is no last-checked time to claim. */
  lastPollAt: string | null;
  lastPollOutcome: "ok" | "failed" | null;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const RUN_STATUSES = ["pending", "running", "done", "skipped", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_SOURCES = ["drive"] as const;
export type RunSourceType = (typeof RUN_SOURCES)[number];
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
  /** Workflow-named stage, e.g. "convert" | "extract" | "outputs" for the transcript workflow. */
  failedStage: string | null;
  skipReason: string | null;
  failureHint: string | null;
  /** True when the Google connection caused the failure (D6). Legacy metas
   *  predate the marker; absent reads as an ordinary failure. */
  connectionCaused?: boolean;
}

export const RUN_EVENT_TYPES = [
  "created",
  "stage_started",
  "stage_failed",
  "extract_attempt",
  "extract_error",
  "extract_ok",
  "classify_skipped",
  "google_task_created",
  "google_task_error",
  "gmail_draft_created",
  "gmail_draft_error",
  "google_unavailable",
  "run_done",
  "run_failed",
  "run_reopened",
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
  /** Why the Run was skipped; null unless status is "skipped". */
  skipReason: string | null;
  /** Task count from result.json; null before a result exists. */
  taskCount: number | null;
  /** Present only when the Google connection caused a failure (D6). */
  connectionCaused?: boolean;
}

export interface RunDetail extends RunSummary {
  attempts: number;
  /** Workflow-named stage, e.g. "convert" | "extract" | "outputs" for the transcript workflow. */
  failedStage: string | null;
  skipReason: string | null;
  failureHint: string | null;
  result: ExtractionResult | null;
  events: RunEvent[];
  transcript: string;
}
