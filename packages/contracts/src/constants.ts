/** Shared constants for the Chief of Staff local workflow. */
export const SERVICE_VERSION = "1.0.0";
export const PROTOCOL_VERSION = 1;
export const DEFAULT_SERVICE_PORT = 4317;
export const DEFAULT_SERVICE_URL = `http://127.0.0.1:${DEFAULT_SERVICE_PORT}`;

export const STEP_SCHEMA_VERSION = 1;

export const WORKFLOW_SCHEMA_VERSION = 1;
export const WORKFLOW_REVISION = 219;
export const WORKFLOW_DEFINITION_PATH = "reference/workflow-definition.json";
export const WORKFLOW_DEFINITION_HASH_PATH = "reference/workflow-definition.sha256";

export const LLM_MODEL_ID = "nvidia/nemotron-3.5-lightning";
export const LLM_PROVIDER_ID = "openrouter";

export const TRACKING_CSV_HEADER = [
  "row_id",
  "run_id",
  "task_index",
  "task_name",
  "task_type",
  "assigned_to",
  "deadline",
  "source_step",
  "target_uri",
  "status",
  "created_at",
  "source_validation_error",
] as const;

export const TRACKING_SCOPE_VALIDATION_ERROR = "Scope is not set";
export const LOCAL_SCOPE_SUPPLIED_WARNING = "LOCAL_SCOPE_SUPPLIED";

export const EXTRACTION_TOOL_NAME = "submit_tasks";
export const CALENDAR_TOOL_NAME = "find_calendar_events";
