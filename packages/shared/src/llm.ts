import type { ProviderId } from "./schemas.js";

/** One model call's absolute ceiling — the backstop above the token idle ceiling. */
export const MODEL_REQUEST_TIMEOUT_MS = 120_000;

/**
 * How long one streaming model call may go without a token — measured from the
 * call's start until its first token, then from the last token it produced. The
 * absolute `MODEL_REQUEST_TIMEOUT_MS` ceiling stays above it as a backstop: a
 * stream that keeps dripping tokens is still bounded, while a hung one ends in
 * thirty seconds instead of two minutes.
 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 30_000;

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
