import { defineTelemetrySchema } from "@earendil-works/pi-telemetry";

/**
 * Span vocabulary for the Chief of Staff service. Required hierarchy:
 *
 * chief_of_staff.run
 * ├── chief_of_staff.step
 * │   └── chief_of_staff.ai_invocation   (pi AI/agent span)
 * ├── chief_of_staff.iteration
 * │   ├── chief_of_staff.step
 * │   └── chief_of_staff.filesystem_commit
 * └── chief_of_staff.notification
 *
 * Allowed attributes: run id, step id, invocation id, task type, task index,
 * provider, model id, retry count, duration, token counts, artifact type,
 * byte count, status. Names, email addresses, subjects, transcript content,
 * prompts, completions, tool arguments, file contents, headers, secrets, and
 * absolute paths are never recorded.
 */
export const TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    "chief_of_staff.run": {
      description: "One workflow run from transcript claim to completion.",
      parents: { kind: "root_or_external" },
      status: { default: "ok", errorWhen: "The run fails or is cancelled" },
      startAttributes: {
        "chief_of_staff.run_id": {
          type: "string",
          required: true,
          description: "Identifier of the run.",
        },
        "chief_of_staff.mode": {
          type: "string",
          required: true,
          description: "LLM mode: live, record, or replay.",
        },
        "chief_of_staff.model_id": {
          type: "string",
          required: false,
          description: "Configured OpenRouter model id.",
        },
        "chief_of_staff.provider": {
          type: "string",
          required: false,
          description: "LLM provider id.",
        },
      },
      endAttributes: {
        "chief_of_staff.status": {
          type: "string",
          description: "Terminal run status.",
        },
        "chief_of_staff.duration_ms": {
          type: "number",
          description: "Run duration in milliseconds.",
        },
        "chief_of_staff.discarded_tasks": {
          type: "number",
          description: "Count of extracted tasks discarded because they were assigned to someone else.",
        },
        "chief_of_staff.accepted_tasks": {
          type: "number",
          description: "Count of accepted tasks.",
        },
      },
    },
    "chief_of_staff.step": {
      description: "One workflow step invocation.",
      parents: {
        kind: "spans",
        spans: ["chief_of_staff.run", "chief_of_staff.iteration"],
      },
      status: { default: "ok", errorWhen: "The step fails or is cancelled" },
      startAttributes: {
        "chief_of_staff.run_id": {
          type: "string",
          required: true,
          description: "Identifier of the run.",
        },
        "chief_of_staff.step_id": {
          type: "string",
          required: true,
          description: "Workflow step id.",
        },
        "chief_of_staff.invocation_id": {
          type: "string",
          required: true,
          description: "Invocation identifier.",
        },
        "chief_of_staff.task_index": {
          type: "number",
          required: false,
          description: "Iterator task index, absent for non-loop steps.",
        },
        "chief_of_staff.task_type": {
          type: "string",
          required: false,
          description: "Task type, absent for non-loop steps.",
        },
        "chief_of_staff.retry_count": {
          type: "number",
          required: false,
          description: "Number of prior attempts for this invocation.",
        },
        "chief_of_staff.provider": {
          type: "string",
          required: false,
          description: "LLM provider id for AI steps.",
        },
        "chief_of_staff.model_id": {
          type: "string",
          required: false,
          description: "LLM model id for AI steps.",
        },
      },
      endAttributes: {
        "chief_of_staff.status": {
          type: "string",
          description: "Step terminal status.",
        },
        "chief_of_staff.duration_ms": {
          type: "number",
          description: "Step duration in milliseconds.",
        },
        "chief_of_staff.input_tokens": {
          type: "number",
          description: "Prompt token count when reported.",
        },
        "chief_of_staff.output_tokens": {
          type: "number",
          description: "Completion token count when reported.",
        },
        "chief_of_staff.total_tokens": {
          type: "number",
          description: "Total token count when reported.",
        },
      },
    },
    "chief_of_staff.ai_invocation": {
      description: "One pi agent invocation inside an AI step.",
      parents: { kind: "spans", spans: ["chief_of_staff.step"] },
      status: {
        default: "ok",
        errorWhen: "The model call fails, is retried to exhaustion, or is aborted",
      },
      startAttributes: {
        "chief_of_staff.run_id": {
          type: "string",
          required: true,
          description: "Identifier of the run.",
        },
        "chief_of_staff.step_id": {
          type: "string",
          required: true,
          description: "AI step id.",
        },
        "chief_of_staff.invocation_id": {
          type: "string",
          required: true,
          description: "Invocation identifier.",
        },
        "chief_of_staff.task_index": {
          type: "number",
          required: false,
          description: "Iterator task index, absent for the extraction step.",
        },
        "chief_of_staff.provider": {
          type: "string",
          required: true,
          description: "LLM provider id.",
        },
        "chief_of_staff.model_id": {
          type: "string",
          required: true,
          description: "LLM model id.",
        },
        "chief_of_staff.retry_count": {
          type: "number",
          required: true,
          description: "Zero-based attempt counter for this invocation.",
        },
      },
      endAttributes: {
        "chief_of_staff.status": {
          type: "string",
          description: "Invocation terminal status.",
        },
        "chief_of_staff.duration_ms": {
          type: "number",
          description: "Invocation duration in milliseconds.",
        },
        "chief_of_staff.input_tokens": {
          type: "number",
          description: "Prompt token count when reported.",
        },
        "chief_of_staff.output_tokens": {
          type: "number",
          description: "Completion token count when reported.",
        },
        "chief_of_staff.total_tokens": {
          type: "number",
          description: "Total token count when reported.",
        },
        "chief_of_staff.cost_total": {
          type: "number",
          description: "Estimated cost when reported.",
        },
      },
    },
    "chief_of_staff.iteration": {
      description: "One iterator iteration covering a single task branch.",
      parents: { kind: "spans", spans: ["chief_of_staff.run"] },
      status: { default: "ok", errorWhen: "The iteration fails or is cancelled" },
      startAttributes: {
        "chief_of_staff.run_id": {
          type: "string",
          required: true,
          description: "Identifier of the run.",
        },
        "chief_of_staff.task_index": {
          type: "number",
          required: true,
          description: "Stable task index within the iterator.",
        },
        "chief_of_staff.task_type": {
          type: "string",
          required: true,
          description: "Task type routed by the paths step.",
        },
      },
      endAttributes: {
        "chief_of_staff.status": {
          type: "string",
          description: "Iteration terminal status.",
        },
        "chief_of_staff.duration_ms": {
          type: "number",
          description: "Iteration duration in milliseconds.",
        },
      },
    },
    "chief_of_staff.filesystem_commit": {
      description: "One atomic artifact commit by a filesystem adapter.",
      parents: {
        kind: "spans",
        spans: ["chief_of_staff.iteration", "chief_of_staff.step"],
      },
      status: { default: "ok", errorWhen: "The atomic commit fails" },
      startAttributes: {
        "chief_of_staff.run_id": {
          type: "string",
          required: true,
          description: "Identifier of the run.",
        },
        "chief_of_staff.step_id": {
          type: "string",
          required: true,
          description: "Step performing the commit.",
        },
        "chief_of_staff.invocation_id": {
          type: "string",
          required: true,
          description: "Invocation identifier.",
        },
        "chief_of_staff.artifact_type": {
          type: "string",
          required: true,
          description: "Artifact type being committed.",
        },
        "chief_of_staff.byte_count": {
          type: "number",
          required: true,
          description: "Size of the committed artifact in bytes.",
        },
      },
      endAttributes: {
        "chief_of_staff.status": {
          type: "string",
          description: "Commit terminal status.",
        },
        "chief_of_staff.duration_ms": {
          type: "number",
          description: "Commit duration in milliseconds.",
        },
      },
    },
    "chief_of_staff.notification": {
      description: "Write of the completion notification after all iterations settle.",
      parents: { kind: "spans", spans: ["chief_of_staff.run"] },
      status: { default: "ok", errorWhen: "The notification write fails" },
      startAttributes: {
        "chief_of_staff.run_id": {
          type: "string",
          required: true,
          description: "Identifier of the run.",
        },
      },
      endAttributes: {
        "chief_of_staff.status": {
          type: "string",
          description: "Notification write status.",
        },
        "chief_of_staff.duration_ms": {
          type: "number",
          description: "Notification write duration in milliseconds.",
        },
        "chief_of_staff.byte_count": {
          type: "number",
          description: "Notification file size in bytes.",
        },
      },
    },
  },
});
