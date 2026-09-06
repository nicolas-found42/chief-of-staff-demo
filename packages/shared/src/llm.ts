import { z } from "zod";
import { ProviderIdSchema, type ProviderId } from "./schemas.js";

/**
 * One model call's absolute ceiling — the backstop above the two stream
 * ceilings below.
 *
 * Since #232 this bounds only a call that is actively generating: a connection
 * that goes quiet is caught at 30 seconds and one that stays open without
 * producing an answer at 90, both far below this. So the number's only job is
 * to fit real work, and the measured work does not fit in two minutes — one
 * person-extraction answer is around 4,000 output tokens, and the configured
 * model was measured between 24 and 75 tokens per second depending on the
 * route it landed on.
 */
export const MODEL_REQUEST_TIMEOUT_MS = 300_000;

/**
 * How long one streaming model call may go without a token — measured from the
 * call's start until its first token, then from the last token it produced. The
 * absolute `MODEL_REQUEST_TIMEOUT_MS` ceiling stays above it as a backstop: a
 * stream that keeps dripping tokens is still bounded, while a hung one ends in
 * thirty seconds instead of two minutes.
 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * How long an upstream may stay connected without producing any answer.
 *
 * Distinct from the idle ceiling above, which asks whether the connection is
 * alive at all. Some upstreams buffer a whole tool call and send nothing but
 * SSE keepalives while they generate — measured at 57 to 73 seconds before an
 * 18,797-character answer arrived in a single delta (#232). Treating that as a
 * dead connection aborted work the model was completing, so silence with
 * traffic gets its own, longer bound, still under the absolute ceiling so a
 * provider that keeps the line warm and never answers is named as such rather
 * than reported as a slow generation.
 */
export const MODEL_STREAM_SILENT_TIMEOUT_MS = 90_000;

/**
 * How a model is bound to the caller's Result Shape. Ordered most deterministic
 * first: `response_format` has the provider constrain decoding to the JSON
 * Schema, `forced_tool_call` constrains the arguments of a call the model is
 * required to make, and `prompt_only` merely asks. One Shell seam serves every
 * Module and every provider, so the binding follows what a model declares
 * support for, never which provider happens to front it (ADR-0029).
 */
export const RESULT_SHAPE_BINDINGS = [
  "response_format",
  "forced_tool_call",
  "prompt_only",
] as const;
export type ResultShapeBinding = (typeof RESULT_SHAPE_BINDINGS)[number];

/**
 * Why a call across the Shell's one LLM seam failed, as a stable code rather
 * than a sentence. Callers decide retryability and wording from the code; the
 * message exists for a person reading a Run and is never matched against.
 */
export const MODEL_BOUNDARY_CLASSIFICATIONS = [
  /** The request never reached the provider — DNS, refused connection, TLS. */
  "transport_failure",
  /** The seam's own request ceiling fired while the call was in flight. */
  "request_timeout",
  /** The streamed answer began repeating one short unit instead of finishing. */
  "repetition_loop",
  /** The provider answered with a status outside 2xx. */
  "http_error",
  /** A 2xx answer with no body at all. */
  "empty_body",
  /** A 2xx answer whose body is not JSON. */
  "unparseable_body",
  /** A 2xx answer carrying a failure the provider or its upstream named. */
  "upstream_error",
  /** A parsed answer with nothing in the field the Result Shape Binding uses. */
  "unusable_shape",
  /** The binding's field held text, and that text is not JSON. */
  "answer_not_json",
] as const;
export type ModelBoundaryClassification = (typeof MODEL_BOUNDARY_CLASSIFICATIONS)[number];

/**
 * The facts about one failed model call, recorded as shape only — codes, keys,
 * types, sizes, flags. Transcripts are private and Source Items are untrusted
 * third-party evidence, so no field here may hold payload text; the Source
 * Adapter diagnostics are the precedent (ADR-0028) and the quality bar.
 */
export interface ModelBoundaryDiagnostic {
  classification: ModelBoundaryClassification;
  /** Which provider the Shell called, and the model id it asked for. */
  provider: ProviderId;
  model: string;
  /** The server behind the provider, where the provider named one. */
  upstreamServer: string | null;
  /** The numeric code the provider or its upstream gave, where it gave one. */
  upstreamCode: number | null;
  /** Which binding built the request whose answer failed. */
  binding: ResultShapeBinding;
  /** The HTTP status, or `null` when no response arrived. */
  status: number | null;
  /** Why the model stopped, as the provider reported it. */
  finishReason: string | null;
  /**
   * The response body's length in bytes, and `0` where no response arrived at
   * all — `status` is `null` in that case, so the two are distinguishable.
   */
  bodyBytes: number;
  /** The body's own top-level keys, in the order they arrived. */
  topLevelKeys: string[];
  /** Fields of the answer container that held something. */
  populatedFields: string[];
  /** Fields of the answer container that arrived null, empty or absent. */
  emptyFields: string[];
  /** The ceiling that fired, for `request_timeout`; `null` otherwise. */
  timeoutMs: number | null;
}

/** Bounded wire contract for durable, shape-only model failures. */
export const ModelBoundaryDiagnosticSchema: z.ZodType<ModelBoundaryDiagnostic> = z.object({
  classification: z.enum(MODEL_BOUNDARY_CLASSIFICATIONS),
  provider: ProviderIdSchema,
  model: z.string().max(200),
  upstreamServer: z.string().max(200).nullable(),
  upstreamCode: z.number().int().safe().nullable(),
  binding: z.enum(RESULT_SHAPE_BINDINGS),
  status: z.number().int().min(100).max(599).nullable(),
  finishReason: z.string().max(200).nullable(),
  bodyBytes: z.number().int().nonnegative().safe(),
  topLevelKeys: z.array(z.string().max(200)).max(64),
  populatedFields: z.array(z.string().max(200)).max(64),
  emptyFields: z.array(z.string().max(200)).max(64),
  timeoutMs: z.number().int().nonnegative().safe().nullable(),
});

/** Shape-only observation of one completion wire attempt, including recovered failures. */
export const ModelAttemptEventSchema = z.object({
  attempt: z.number().int().positive().safe(),
  binding: z.enum(RESULT_SHAPE_BINDINGS),
  outcome: z.enum(["retrying", "succeeded", "failed"]),
  diagnostic: ModelBoundaryDiagnosticSchema.nullable(),
  /** 500 for the one same-binding retry; 0 for binding recovery or final outcomes. */
  delayMs: z.number().int().nonnegative().max(500),
  stoppedReason: z.string().max(1000).nullable(),
});
export type ModelAttemptEvent = z.infer<typeof ModelAttemptEventSchema>;

/** One field that did not conform to a Module's declared Result Shape. */
export interface ResultShapeIssue {
  field: string;
  expectedType: string;
  actualType: string;
}

/** Shape-only facts from a Module validating a model reply. */
export interface ResultShapeDiagnostic {
  expectedShape: string;
  topLevelKeys: string[];
  issues: ResultShapeIssue[];
}
