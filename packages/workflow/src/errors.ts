/** Error codes from the specification's error model plus engine-internal codes. */
export type WorkflowErrorCode =
  | "WORKFLOW_DEFINITION_CHANGED"
  | "INVALID_CONFIGURATION"
  | "SOURCE_UNSUPPORTED"
  | "SOURCE_TOO_LARGE"
  | "UNRESOLVED_REFERENCE"
  | "INVALID_STRUCTURED_OUTPUT"
  | "OPENROUTER_AUTH"
  | "OPENROUTER_RATE_LIMIT"
  | "OPENROUTER_MODEL_UNAVAILABLE"
  | "FILESYSTEM_WRITE"
  | "IDEMPOTENCY_CONFLICT"
  | "RUN_CANCELLED"
  | "REPLAY_FIXTURE_MISSING"
  | "INVALID_REPLAY_FIXTURE"
  | "RATE_LIMITED"
  | "ARTIFACT_NOT_FOUND"
  | "UNKNOWN_STEP";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly retryable: boolean;
  readonly causeError: unknown;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "WorkflowError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.causeError = opts.cause;
  }
}

export function toWorkflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowError("FILESYSTEM_WRITE", message, {
    retryable: true,
    cause: error,
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("aborted"))
  );
}
