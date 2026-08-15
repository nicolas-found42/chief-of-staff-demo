/** Core domain types shared by the UI, service, engine, and tests. */

export interface ProfileConfig {
  name: string;
  title: string;
  company: string;
  writingStyle: string;
  focusAreas: string[];
}

export interface ModelsConfig {
  provider: "openrouter";
  model: string;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
}

export interface AppConfig {
  maxParallelTasks: number;
  watchDebounceMs: number;
  maxTranscriptBytes: number;
  allowedUiOrigins: string[];
}

export type CalendarEventStatus = "busy" | "tentative" | "free";

export interface CalendarEvent {
  id: string;
  start: string;
  end: string;
  summary: string;
  status: CalendarEventStatus;
}

export interface CalendarEvents {
  timezone: string;
  events: CalendarEvent[];
}

export type TaskType = "email" | "business plan" | "other";

export interface EmailDetails {
  Recipient: string;
  Subject: string;
  Body: string;
}

export interface BusinessPlanDetails {
  Title: string;
  Summary: string;
}

export interface ExtractedTask {
  "Task name": string;
  "Task type": TaskType;
  "Assigned to": string;
  Deadline?: string;
  "Email details"?: EmailDetails;
  "Business plan details"?: BusinessPlanDetails;
  "Task description"?: string;
}

export type TaskListId = "email-drafts" | "business-plans" | "my-tasks";

export interface LocalTaskResource {
  schemaVersion: 1;
  id: string;
  list: TaskListId;
  title: string;
  due: string | null;
  notes: string;
  status: "needsAction";
  source: {
    runId: string;
    taskIndex: number;
    stepId: string;
  };
  createdAt: string;
}

export interface EmailDraftFrontMatter {
  schemaVersion: 1;
  id: string;
  to: string[];
  labels: string[];
  subject: string;
  runId: string;
  taskIndex: number;
  createdAt: string;
}

export type StepArtifactStatus = "succeeded" | "failed" | "skipped";

export interface StepWarning {
  code: string;
  message: string;
}

export interface StepError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface StepArtifact<T = unknown> {
  schemaVersion: 1;
  runId: string;
  stepId: string;
  invocationId: string;
  taskIndex: number | null;
  status: StepArtifactStatus;
  startedAt: string;
  finishedAt: string;
  output: T | null;
  warnings: StepWarning[];
  error: StepError | null;
}

export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type LlmMode = "live" | "record" | "replay";

export interface SourceMetadata {
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  timestamps: {
    claimedAt: string;
    birthtimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
  };
}

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number;
}

export interface StepInvocationRecord {
  stepId: string;
  invocationId: string;
  taskIndex: number | null;
  status: StepArtifactStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  retryCount: number;
  warnings: StepWarning[];
  error: StepError | null;
  artifactUri: string;
  usage?: UsageSummary;
}

export interface ManifestTaskSummary {
  index: number;
  name: string;
  type: TaskType;
  branch: string;
  deadline: string | null;
}

export type ArtifactType =
  | "gmail-draft"
  | "plan-document"
  | "task"
  | "notification"
  | "tracking-csv"
  | "step-artifact"
  | "transcript"
  | "llm-request";

export interface ManifestArtifact {
  artifactId: string;
  type: ArtifactType;
  uri: string;
  taskIndex: number | null;
  byteSize: number;
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  status: RunStatus;
  workflow: {
    path: string;
    revision: number;
    sha256: string;
  };
  source: SourceMetadata;
  transcriptSha256: string;
  configSha256: {
    profile: string;
    models: string;
  };
  now: string;
  timezone: string;
  llm: {
    mode: LlmMode;
    model: string;
  };
  tasks: ManifestTaskSummary[];
  steps: StepInvocationRecord[];
  unresolvedRefs: string[];
  warnings: StepWarning[];
  artifacts: ManifestArtifact[];
  usage?: UsageSummary;
  discardedTasks: number;
  error?: StepError | null;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  sourceFilename: string;
  acceptedTaskCount: number;
  totalTaskCount: number;
  mode: LlmMode;
  model: string;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  hasNotification: boolean;
  error: StepError | null;
}

export type WorkflowEventType =
  | "run.started"
  | "run.finished"
  | "source.claimed"
  | "task.accepted"
  | "task.discarded"
  | "step.started"
  | "step.retry"
  | "step.succeeded"
  | "step.failed"
  | "step.skipped"
  | "iteration.started"
  | "iteration.finished"
  | "notification.written"
  | "progress";

export interface WorkflowEvent {
  sequence: number;
  timestamp: string;
  runId: string;
  type: WorkflowEventType;
  stepId?: string;
  invocationId?: string;
  taskIndex?: number | null;
  taskType?: TaskType;
  data?: Record<string, unknown>;
  error?: StepError;
}

export interface HealthResponse {
  serviceVersion: string;
  protocolVersion: number;
  workspace: {
    status: "ready" | "error";
    errorCode?: string;
  };
  pairing: {
    available: boolean;
    expiresAt?: string;
  };
}

export interface PairRequest {
  code: string;
}

export interface PairResponse {
  sessionToken: string;
  expiresAt: string;
}

export interface ReadinessReport {
  profileValid: boolean;
  modelsValid: boolean;
  calendarValid: boolean;
  appValid: boolean;
  definitionValid: boolean;
  workspaceWriteable: boolean;
  openRouterConfigured: boolean;
  errors: string[];
}

export interface ConfigResponse {
  profile: ProfileConfig;
  models: ModelsConfig;
  app: AppConfig;
  calendar: CalendarEvents;
  openRouterConfigured: boolean;
  readiness: ReadinessReport;
}

export interface UploadResponse {
  runId: string;
  claimed: boolean;
}

export interface RunsPageResponse {
  total: number;
  runs: RunSummary[];
}

export interface ArtifactSummary {
  artifactId: string;
  type: ArtifactType;
  uri: string;
  taskIndex: number | null;
  stepId: string;
  byteSize: number;
}

export interface RunDetailResponse {
  manifest: RunManifest;
  artifacts: ArtifactSummary[];
}

export interface ActionResponse {
  runId: string;
  status: RunStatus;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Array<{ field: string; message: string }>;
  };
}
