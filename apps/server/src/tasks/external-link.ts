import type {
  ExternalTaskBaseline,
  Task,
  TaskDestination,
  TaskLinkFailure,
} from "@chief-of-staff-demo/shared";
import { TaskValidationError, type WorkspaceTasks } from "./tasks.js";

/**
 * External Task Links (issues #184, #185, #189, ADR-0056).
 *
 * Local first, always. A Task is committed to the Workspace before anything is
 * sent outward, and a provider failure leaves the Task exactly as usable as it
 * was — with a link that says `waiting`, `failed` or `missing` rather than no
 * Task at all.
 *
 * One state machine serves every provider. Each outward destination — Google
 * Tasks, Asana — is a `RemoteTaskConnector` the machine dispatches on by the
 * destination's provider, so the local-first ordering, the one-link rule and
 * the failure quadrants are written once and cannot drift between providers.
 *
 * Linked records are read one at a time, and completion only: synchronizing a
 * link asks whether that one Task is done. Nothing is ever listed, and no
 * provider Task ever becomes a Workspace Task.
 */

/** The destination a Task can be linked outward to. */
type ExternalTaskDestination = Extract<TaskDestination, { provider: "google-tasks" | "asana" }>;

export type GoogleTasksDestination = Extract<TaskDestination, { provider: "google-tasks" }>;
export type AsanaDestination = Extract<TaskDestination, { provider: "asana" }>;

/**
 * One provider's outward write, as the shared state machine calls it. The
 * destination comes from the Task or link being worked on, so a connector
 * never guesses which container it was pointed at. `readStatus` answers null
 * when the provider no longer holds the record — the machine marks the link
 * missing rather than failing the local Task.
 */
export interface RemoteTaskConnector<D extends ExternalTaskDestination = ExternalTaskDestination> {
  create(task: Task, destination: D): Promise<{ remoteId: string; url: string | null }>;
  readStatus(destination: D, remoteId: string): Promise<{ completed: boolean } | null>;
  updateStatus(destination: D, remoteId: string, completed: boolean): Promise<void>;
}

/** What the owner chose for Google Tasks, as the Workspace stores it. */
export interface GoogleTasksDestinationSettings {
  enabled: boolean;
  taskListId: string;
  taskListTitle: string;
}

export interface TaskLinkingDeps {
  tasks: WorkspaceTasks;
  /** The stored Google Tasks settings, read live. */
  settings: () => GoogleTasksDestinationSettings;
  save: (settings: GoogleTasksDestinationSettings) => void;
  /** The Google account's Task Lists, or a refusal explaining why not. */
  listRemoteLists: () => Promise<{ id: string; title: string }[]>;
  /** Google Tasks — the connector the original destination was built on. */
  google: RemoteTaskConnector<GoogleTasksDestination>;
  /** Asana, when the Workspace composes it (issue #189). */
  asana?: RemoteTaskConnector<AsanaDestination>;
}

/** The HTTP-ish status a provider failure carries, whatever its shape. */
function providerStatus(error: unknown): number | null {
  if (error !== null && typeof error === "object") {
    for (const key of ["code", "status", "statusCode"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isInteger(value)) return value;
    }
    const response = (error as Record<string, unknown>).response;
    if (response !== null && typeof response === "object") {
      const status = (response as Record<string, unknown>).status;
      if (typeof status === "number" && Number.isInteger(status)) return status;
    }
  }
  return null;
}

/**
 * Strip anything credential-shaped from a provider message and cap its
 * length. A redacted detail is still the provider's own words about this
 * call, never a secret about the account.
 */
function sanitizeDetail(message: string): string {
  const redacted = message
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(ya29\.)[^\s"']+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|refresh[_-]?token|access[_-]?token|client[_-]?secret|id[_-]?token)\s*[:=]\s*)[^\s&"'}]+/gi,
      "$1[redacted]",
    )
    .trim();
  return redacted.length > 280 ? `${redacted.slice(0, 277)}…` : redacted;
}

/**
 * Classify a provider failure at the site that raised it (ADR-0008) and
 * answer the classified fact the link stores. Classified kinds get a fixed
 * sentence — a code is a fact, not prose to quote — while an unclassified
 * failure keeps its redacted detail, which is why a refusal the tests raise
 * by hand still reads the way it was raised.
 */
function classifyTaskLinkError(error: unknown, provider: string): TaskLinkFailure {
  const status = providerStatus(error);
  const raw = error instanceof Error ? error.message : String(error);
  /* Google reports quota exhaustion over 403 with a reason in the body, so
     the reason is read before the status: a rate limit wants a retry, not a
     re-auth. */
  if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(raw)) {
    return { kind: "rate-limit", message: `${provider} is rate-limited. Retry shortly.` };
  }
  if (status === 401 || status === 403 || /invalid_grant/.test(raw)) {
    return {
      kind: "authorization",
      message: `${provider} refused the saved credential. Reconnect ${provider}.`,
    };
  }
  if (status === 400) {
    return { kind: "validation", message: `${provider} refused that change as invalid.` };
  }
  if (status === 404) {
    return { kind: "not-found", message: `${provider} no longer holds that Task.` };
  }
  if (status === 429) {
    return { kind: "rate-limit", message: `${provider} is rate-limited. Retry shortly.` };
  }
  if (
    status === 408 ||
    (status !== null && status >= 500) ||
    /ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(raw)
  ) {
    return { kind: "network", message: `${provider} is unreachable; the Task is intact.` };
  }
  const detail = sanitizeDetail(raw);
  return {
    kind: "unavailable",
    message: detail === "" ? `${provider} failed; the Task is intact.` : detail,
  };
}

export class TaskLinking {
  constructor(private readonly deps: TaskLinkingDeps) {}

  /** The connector a destination's provider dispatches to; null when the Workspace does not compose it. */
  private connectorFor(provider: TaskDestination["provider"]): RemoteTaskConnector | null {
    if (provider === "google-tasks") return this.deps.google;
    if (provider === "asana") return this.deps.asana ?? null;
    return null;
  }

  /** The provider's name as a person reads it, for the sentences failures carry. */
  private providerName(destination: TaskDestination): string {
    return destination.provider === "asana" ? "Asana" : "Google Tasks";
  }

  settings(): GoogleTasksDestinationSettings {
    return this.deps.settings();
  }

  /** The Google Task Lists available as a destination. Containers only. */
  async availableLists(): Promise<{ id: string; title: string }[]> {
    return this.deps.listRemoteLists();
  }

  /**
   * Enable or disable Google Tasks, and choose the list. Enabling with a list
   * validates that Google still holds it — a destination that does not exist
   * would turn every later creation into the same failure, discovered one Task
   * at a time.
   *
   * Disabling keeps the remembered list and touches nothing else: the rest of
   * the Google connection, and every local Task, go on working.
   */
  async select(input: {
    enabled: boolean;
    taskListId?: string;
  }): Promise<GoogleTasksDestinationSettings> {
    const current = this.deps.settings();
    if (!input.enabled) {
      const next = { ...current, enabled: false };
      this.deps.save(next);
      return next;
    }
    const chosen = input.taskListId ?? current.taskListId;
    if (chosen === "") {
      throw new TaskValidationError(
        "invalid-destination",
        "Choose which Google Task List new Tasks are created in.",
      );
    }
    const lists = await this.deps.listRemoteLists();
    const match = lists.find((list) => list.id === chosen);
    if (!match) {
      throw new TaskValidationError(
        "invalid-destination",
        "Google does not have that Task List. Choose one of the lists it offers.",
      );
    }
    const next = { enabled: true, taskListId: match.id, taskListTitle: match.title };
    this.deps.save(next);
    return next;
  }

  /**
   * Create the external record for a Task already committed locally, and store
   * the one External Task Link it may have. A failure is recorded on the Task
   * rather than raised at the owner: the work is captured either way, and the
   * link is what is waiting.
   */
  async link(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    /* A link that names a live record is one link already — whether it is
       synchronized or a failed outward write on top of it. Re-linking over
       one would strand the record Google still holds. Only a link that never
       reached the provider (`remoteId: null`) is an attempt to try again. */
    if (task.externalLink !== null && task.externalLink.remoteId !== null) {
      throw new TaskValidationError(
        "task-already-linked",
        "That Task already has an External Task Link.",
      );
    }
    if (task.destination.provider === "local") {
      throw new TaskValidationError(
        "invalid-destination",
        "That Task is filed locally and has nothing to link to.",
      );
    }
    const connector = this.connectorFor(task.destination.provider);
    if (connector === null) {
      throw new TaskValidationError(
        "invalid-destination",
        `The Workspace does not compose ${this.providerName(task.destination)} as a Task Destination.`,
      );
    }
    const provider = this.providerName(task.destination);
    const destination = task.destination;
    /* Recorded before the provider is called at all, so an outward write that
       never returns leaves a Task that says it is waiting rather than one that
       silently says nothing happened. */
    this.deps.tasks.recordExternalLink(task.id, {
      state: "waiting",
      destination: task.destination,
      remoteId: null,
      url: null,
      baseline: this.baselineFor(task, task.status),
      failure: null,
    });
    /* Only the provider calls sit inside try, for the same reason as
       `recreate`: a Workspace refusal is a domain fact, never provider prose. */
    let created: { remoteId: string; url: string | null };
    try {
      created = await connector.create(task, destination);
    } catch (error) {
      return this.deps.tasks.recordExternalLink(task.id, {
        state: "failed",
        destination: task.destination,
        remoteId: null,
        url: null,
        baseline: this.baselineFor(task, task.status),
        failure: classifyTaskLinkError(error, provider),
      });
    }
    /* Creation cannot carry completion on either provider (the record arrives
       open — Google's insert has no completed field, and Asana's is sent as
       its own call so the sequence stays recoverable), so a completed Task is
       completed in the same operation — and the baseline records the status
       the provider actually holds, never the status the Task wishes it held. */
    const sent = task.status;
    if (task.status === "completed") {
      try {
        await connector.updateStatus(destination, created.remoteId, true);
      } catch (error) {
        return this.deps.tasks.recordExternalLink(task.id, {
          state: "failed",
          destination: task.destination,
          remoteId: created.remoteId,
          url: created.url,
          baseline: this.baselineFor(task, "open"),
          failure: classifyTaskLinkError(error, provider),
        });
      }
    }
    return this.deps.tasks.recordExternalLink(task.id, {
      state: "synchronized",
      destination,
      remoteId: created.remoteId,
      url: created.url,
      baseline: this.baselineFor(task, sent),
      failure: null,
    });
  }

  /**
   * Push the Task's current open or completed state to its linked provider
   * record (issue #185). Runs after the local commit, never instead of it: a
   * provider failure is recorded on the link while the Task itself stays
   * exactly as the owner left it.
   *
   * Side-effect free when there is nothing to send — no link, no remote
   * identity, a link known to be missing, or a baseline that already carries
   * this status — so a repeated completion costs one local write and no
   * provider call. A failed push that left a live record behind is retried
   * here: the outward write is idempotent, and this is how an interrupted
   * completion converges without waiting for issue #187's retry machinery.
   */
  async pushStatus(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    const link = task.externalLink;
    if (
      link === null ||
      link.remoteId === null ||
      link.state === "missing" ||
      link.destination.provider === "local" ||
      link.baseline?.status === task.status
    ) {
      return task;
    }
    const connector = this.connectorFor(link.destination.provider);
    if (connector === null) return task;
    const baseline = this.baselineFor(task, task.status);
    try {
      await connector.updateStatus(link.destination, link.remoteId, task.status === "completed");
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: "synchronized",
        baseline,
        failure: null,
      });
    } catch (error) {
      const classified = classifyTaskLinkError(error, this.providerName(link.destination));
      /* The provider answering not-found means the record is gone, not that
         the write was wrong: the local Task stays intact and the link says
         missing, which is what `recreate` and `removeLink` below resolve. */
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: classified.kind === "not-found" ? "missing" : "failed",
        failure: classified,
      });
    }
  }

  /**
   * Read the linked provider record and apply an unopposed external
   * completion or reopening locally (issue #185). Unopposed means the
   * Workspace has not moved since the baseline: local and baseline agree, so
   * the external side is the only one that changed and applying it loses
   * nothing.
   *
   * A competing local change is left alone for the conflict handling in
   * issue #186 — neither side wins implicitly here. A remote record the
   * provider no longer holds marks the link missing with the local Task
   * intact. Repeated reads that agree with the Task write nothing.
   */
  async synchronize(taskId: string): Promise<Task> {
    const task = this.deps.tasks.get(taskId);
    if (!task) {
      throw new TaskValidationError("task-not-found", `No Task with id ${taskId}`);
    }
    const link = task.externalLink;
    if (
      link === null ||
      link.remoteId === null ||
      link.state === "waiting" ||
      link.destination.provider === "local"
    ) {
      throw new TaskValidationError(
        "task-not-linked",
        "That Task has no linked Task to synchronize.",
      );
    }
    const connector = this.connectorFor(link.destination.provider);
    if (connector === null) {
      throw new TaskValidationError(
        "task-not-linked",
        "That Task has no linked Task to synchronize.",
      );
    }
    /* A missing link is resolved by recreating or removing it, never by
       reading: polling a record known to be gone would only spend quota to
       learn the same answer. */
    if (link.state === "missing") return task;
    let remote: { completed: boolean } | null;
    try {
      remote = await connector.readStatus(link.destination, link.remoteId);
    } catch (error) {
      const classified = classifyTaskLinkError(error, this.providerName(link.destination));
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: classified.kind === "not-found" ? "missing" : "failed",
        failure: classified,
      });
    }
    if (remote === null) {
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: "missing",
        failure: {
          kind: "not-found",
          message: `${this.providerName(link.destination)} no longer holds that Task.`,
        },
      });
    }
    const remoteStatus = remote.completed ? "completed" : "open";
    const baselineStatus = link.baseline?.status;
    if (remoteStatus === task.status) {
      /* In agreement. Converge a stale baseline or clear a past failure
         without touching the provider; a converged link reads free. */
      if (baselineStatus === task.status && link.failure === null) return task;
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: "synchronized",
        baseline: {
          title: link.baseline?.title ?? task.title,
          notes: link.baseline?.notes ?? task.notes,
          dueDate: link.baseline?.dueDate ?? task.dueDate,
          status: task.status,
        },
        failure: null,
      });
    }
    /* The remote differs from the Task, and whose move it was decides what
       this read may do. baseline == Task would mean only the provider moved —
       but that is the apply branch below. Here the baseline differs from the
       Task, so the Workspace moved too: either the provider also moved (a
       Task Link Conflict, which issue #186 resolves) or it still sits at the
       baseline (an interrupted push, which pushStatus retries). Applying the
       provider's stale state would revert accepted work, so this read answers
       unchanged and refuses to pick a winner. */
    if (baselineStatus !== undefined && baselineStatus !== task.status) {
      return task;
    }
    const applied =
      remote.completed === true
        ? this.deps.tasks.complete(task.id)
        : this.deps.tasks.reopen(task.id);
    return this.deps.tasks.refreshExternalLink(applied.id, {
      ...link,
      state: "synchronized",
      baseline: {
        title: link.baseline?.title ?? applied.title,
        notes: link.baseline?.notes ?? applied.notes,
        dueDate: link.baseline?.dueDate ?? applied.dueDate,
        status: applied.status,
      },
      failure: null,
    });
  }

  /**
   * Recreate the remote record for a link the provider no longer holds
   * (issue #185). Stores the replacement identity and a fresh baseline over
   * the current Task, so synchronization resumes from what the owner has
   * rather than from what went missing. Refused unless the link is missing —
   * any other state already names a record or a retry for it.
   */
  async recreate(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    const link = task.externalLink;
    if (link === null || link.state !== "missing" || link.destination.provider === "local") {
      throw new TaskValidationError(
        "link-not-missing",
        "Only a missing External Task Link can be recreated.",
      );
    }
    const connector = this.connectorFor(link.destination.provider);
    if (connector === null) {
      throw new TaskValidationError(
        "invalid-destination",
        `The Workspace does not compose ${this.providerName(link.destination)} as a Task Destination.`,
      );
    }
    const destination = link.destination;
    /* Only the provider calls sit inside try: a Workspace refusal from
       recordExternalLink below is a domain fact and must reach its caller
       as one, never be laundered into provider-failure prose on the link. */
    let created: { remoteId: string; url: string | null };
    try {
      created = await connector.create(task, destination);
    } catch (error) {
      /* Still missing: the replacement never arrived, so the link keeps
         naming the record that went away with the new reason attached. */
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        failure: classifyTaskLinkError(error, this.providerName(destination)),
      });
    }
    /* As in `link`: the replacement record is created open, so a completed
       Task is completed in the same operation, and the baseline always
       records what the provider actually holds. A completion that fails
       leaves the new record live and the link failed against it — the Task
       is intact either way. */
    const sent = task.status;
    if (task.status === "completed") {
      try {
        await connector.updateStatus(destination, created.remoteId, true);
      } catch (error) {
        return this.deps.tasks.recordExternalLink(task.id, {
          state: "failed",
          destination,
          remoteId: created.remoteId,
          url: created.url,
          baseline: this.baselineFor(task, "open"),
          failure: classifyTaskLinkError(error, this.providerName(destination)),
        });
      }
    }
    return this.deps.tasks.recordExternalLink(task.id, {
      state: "synchronized",
      destination,
      remoteId: created.remoteId,
      url: created.url,
      baseline: this.baselineFor(task, sent),
      failure: null,
    });
  }

  /**
   * Remove the External Task Link while preserving the local Task (issue
   * #185). Never deletes the remote record — unlinking ends synchronization,
   * and deletion is a separate decision with its own confirmation.
   */
  async removeLink(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    return this.deps.tasks.clearExternalLink(task.id);
  }

  // ---------------------------------------------------------------------------

  /** The Task a link operation names, or the one refusal every caller shares. */
  private requireTask(taskId: string): Task {
    const task = this.deps.tasks.get(taskId);
    if (!task) {
      throw new TaskValidationError("task-not-found", `No Task with id ${taskId}`);
    }
    return task;
  }

  /**
   * The four outward fields as the provider holds them after this operation:
   * the Task's content, and the status that was actually sent — which is not
   * always the status the Task carries (a completion whose outward write
   * failed has not reached the provider, and the baseline must not claim it
   * did).
   */
  private baselineFor(task: Task, sentStatus: Task["status"]): ExternalTaskBaseline {
    return {
      title: task.title,
      notes: task.notes,
      dueDate: task.dueDate,
      status: sentStatus,
    };
  }
}
