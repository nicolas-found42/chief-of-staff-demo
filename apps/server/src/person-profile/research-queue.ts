import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PersonResearchSettingsSchema,
  PersonResearchStatusSchema,
  type PersonResearchSettings,
  type PersonResearchStatus,
  type PersonResearchAggregateStatus,
  type PersonResearchJob,
  type PersonResearchOperationOutcome,
  type PersonResearchReadiness,
  type PersonResearchEnqueueDecision,
  type PersonResearchProfileSummary,
  type PersonResearchDiagnosticsPage,
  type PersonResearchRunSummary,
  type PersonResearchHistoryEntry,
} from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "./profiles.js";
import type { PersonResearch } from "./research.js";
import { buildProfileSummary, pagedDiagnostics } from "./research-summary.js";

/** The settings an owner edit actually names; the rest keep their live values. */
export type PersonResearchSettingsPatch = {
  [K in keyof PersonResearchSettings]?: PersonResearchSettings[K] | undefined;
};

const PERSON_RESEARCH_HISTORY_PER_PROFILE = 50;

/**
 * One Workspace runtime owns dispatch of continuous research operations.
 *
 * The queue schedules *which* Profile gets an operation and when it may be
 * refreshed. It no longer splits one Profile's enrichment into budget-limited
 * passes waiting for a later resumption: an operation runs until its own
 * completion conditions hold, or until it is interrupted or hits a safety
 * bound — and those two say so rather than reading as success (#228).
 */
export class PersonResearchQueue {
  private readonly file: string;
  private state: PersonResearchStatus;
  private running = new Set<string>();
  /** Profiles this instance deliberately dropped; never re-adopted on merge. */
  private readonly removed = new Set<string>();
  /** Profiles the file already held when this instance loaded it. */
  private readonly loaded = new Set<string>();
  /** Profiles whose next dispatch was cut by a deliberate request; an
   * in-memory-only signal, so a restart downgrades to continuation. */
  private readonly explicitDispatches = new Set<string>();
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  constructor(
    private readonly deps: {
      workspaceDir: string;
      people: WorkspacePersonProfiles;
      research: PersonResearch;
      now?: () => Date;
      /** Truthful readiness of the pipeline itself (issue #418, T3), apart
       * from this queue's own administrative pause — {@link readiness}
       * folds the two together for every consumer. */
      readiness: () => PersonResearchReadiness;
      upcomingProfileIds?: () => string[];
      evidenceRevision?: (profileId: string) => string;
    },
  ) {
    this.file = join(deps.workspaceDir, "person-research.json");
    this.state = existsSync(this.file)
      ? PersonResearchStatusSchema.parse(JSON.parse(readFileSync(this.file, "utf8")))
      : {
          schemaVersion: 1,
          settings: PersonResearchSettingsSchema.parse({
            paused: false,
            concurrency: 1,
            refreshHours: 168,
          }),
          day: this.now().slice(0, 10),
          usedCalls: 0,
          jobs: [],
          history: [],
        };
    if (!this.state.history) {
      this.state.history = this.seedHistoryFromJobs(this.state.jobs);
    }
    for (const job of this.state.jobs) this.loaded.add(job.profileId);
    /* A process cannot carry its in-flight operation through a restart, and a
       shutdown is an interruption rather than a completion: the job says so,
       keeps its completed evidence, and is re-dispatched automatically. */
    for (const job of this.state.jobs)
      if (job.state === "researching") {
        job.elapsedMilliseconds =
          (job.elapsedMilliseconds ?? 0) +
          (job.startedAt ? Math.max(0, Date.parse(this.now()) - Date.parse(job.startedAt)) : 0);
        delete job.startedAt;
        job.state = "queued";
        job.detail =
          "Application shutdown interrupted the previous research operation; retained evidence and pending leads are preserved.";
      }
  }
  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
  status(): PersonResearchStatus {
    this.rollDay();
    return structuredClone(this.state);
  }
  /**
   * The operation record for one Profile.
   *
   * Four consumers used to reach through `status().jobs` to find this, and
   * `status()` deep-clones every job in the queue — so reading one Profile's
   * coverage cloned all of them. The lookup is named here instead (#231).
   */
  /**
   * Truthful readiness for the automatic/queued research pipeline (issue
   * #418, T3): what the caller reports about the Workspace, provider and
   * owner confirmation, with this queue's own administrative pause folded
   * in. Pausing overrides only an otherwise-`"ready"` readiness, so a real
   * setup problem is never hidden behind "paused". Side-effect-free.
   */
  readiness(): PersonResearchReadiness {
    const base = this.deps.readiness();
    if (base.state === "ready" && this.state.settings.paused)
      return { state: "paused", reason: "administratively-paused" };
    return base;
  }
  private isReady(): boolean {
    return this.readiness().state === "ready";
  }
  operation(profileId: string): PersonResearchOperationOutcome | null {
    this.rollDay();
    const job = this.state.jobs.find((candidate) => candidate.profileId === profileId);
    return job?.operation ? structuredClone(job.operation) : null;
  }
  /**
   * The queue's one record for one Profile.
   *
   * The dossier view used to reach through `status()` to find it, which
   * deep-clones every job in the queue to return one (#231). Named here next
   * to `operation()`, rolling the day first exactly as `status()` does, so a
   * one-Profile read stays a one-job clone.
   */
  job(profileId: string): PersonResearchJob | null {
    this.rollDay();
    const job = this.state.jobs.find((candidate) => candidate.profileId === profileId);
    return job ? structuredClone(job) : null;
  }
  /**
   * The compact per-profile summary a normal poll reads (issue #418, T5,
   * spec §7): readiness, current state, the in-flight operation's identity
   * and revision, bounded counters, the durable decisive summary, and any
   * superseded conclusion as its own labeled history — never the whole
   * queue, a full attempt ledger, or a checkpoint. Built on {@link job},
   * itself already the named one-Profile lookup (#231), so this never clones
   * more than one job. Side-effect-free: never enqueues.
   */
  summary(profileId: string): PersonResearchProfileSummary | null {
    const job = this.job(profileId);
    if (!job) return null;
    return buildProfileSummary({ job, readiness: this.readiness() });
  }
  /**
   * One page of an operation's full attempt ledger (spec §7): bounded to 50
   * entries, cursor-paged, source-free, and named by the operation it came
   * from. Read on explicit demand from the summary's `detailHref`, never
   * embedded in it. Side-effect-free: never enqueues.
   */
  diagnostics(
    profileId: string,
    options?: { cursor?: string },
  ): PersonResearchDiagnosticsPage | null {
    const operation = this.operation(profileId);
    if (!operation) return null;
    return pagedDiagnostics(operation, options?.cursor);
  }
  /**
   * An independently bounded queue-wide projection (issue #418, T5, spec
   * §7), for the rare consumer that genuinely needs queue-wide counts.
   * Computed from counts alone — never a clone of every job — so it stays
   * cheap regardless of queue size, unlike {@link status} which deep-clones
   * everything. This is what `/api/people/research/status` now returns
   * instead of the whole-queue blob the dossier panel used to poll every
   * cycle (#417 F4).
   */
  aggregate(): PersonResearchAggregateStatus {
    this.rollDay();
    const byState: Record<string, number> = {};
    for (const job of this.state.jobs) byState[job.state] = (byState[job.state] ?? 0) + 1;
    return {
      schemaVersion: 1,
      day: this.state.day,
      usedCalls: this.state.usedCalls,
      settings: { ...this.state.settings },
      totalJobs: this.state.jobs.length,
      byState,
      running: this.running.size,
    };
  }
  /**
   * Retained operation identities for unified history (#417 F8), not a claim
   * to a full archive. Read scalar facts directly: neither job() nor status()
   * belongs on a list path because both clone attempt/checkpoint payloads.
   * Keep at most the requested page while scanning the in-memory queue.
   */
  history(
    options: {
      limit?: number;
      before?: { createdAt: string; id: string };
    } = {},
  ): PersonResearchRunSummary[] {
    const rows: PersonResearchRunSummary[] = [];
    const limit = options.limit ?? Infinity;
    const compare = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
    const add = (row: PersonResearchRunSummary) => {
      if (options.before && compare(row, options.before) <= 0) return;
      if (rows.length >= limit && compare(row, rows[rows.length - 1]!) >= 0) return;
      const index = rows.findIndex((existing) => compare(row, existing) < 0);
      rows.splice(index < 0 ? rows.length : index, 0, row);
      if (rows.length > limit) rows.pop();
    };
    for (const job of this.state.jobs) {
      const operation = job.operation;
      const liveId = job.currentOperationId;
      const live = liveId && (job.state === "researching" || liveId !== operation?.operationId);
      const entries = (this.state.history ?? []).filter((e) => e.profileId === job.profileId);
      const currentId = live ? liveId : (operation?.operationId ?? entries[0]?.operationId);
      const seen = new Set<string>();
      const retain = (row: Omit<PersonResearchRunSummary, "kind" | "id" | "profileId">) => {
        if (seen.has(row.operationId)) return;
        seen.add(row.operationId);
        add({
          ...row,
          kind: "person-research",
          id: `person-research:${job.profileId}:${row.operationId}`,
          profileId: job.profileId,
          summary: row.summary.slice(0, 300),
        });
      };
      if (live && liveId)
        retain({
          operationId: liveId,
          ...(job.currentOperationRevision !== undefined
            ? { revision: job.currentOperationRevision }
            : {}),
          phase: "current",
          createdAt: job.currentOperationStartedAt ?? job.startedAt ?? job.queuedAt,
          status: job.state,
          summary: job.detail,
        });
      for (const entry of entries)
        retain({
          operationId: entry.operationId,
          ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
          phase: entry.operationId === currentId ? "current" : "previous",
          createdAt: entry.startedAt,
          finishedAt: entry.finishedAt,
          status: entry.conclusion,
          summary: entry.detail,
        });
      if (operation)
        retain({
          operationId: operation.operationId,
          ...(job.operationRevision !== undefined ? { revision: job.operationRevision } : {}),
          phase: operation.operationId === currentId ? "current" : "previous",
          createdAt: operation.startedAt,
          finishedAt: operation.finishedAt,
          status: operation.conclusion,
          summary: operation.detail,
        });
      const previous = job.previousConclusion;
      if (previous)
        retain({
          operationId: previous.operationId,
          revision: previous.revision,
          phase: "previous",
          createdAt: previous.finishedAt,
          finishedAt: previous.finishedAt,
          status: previous.conclusion,
          summary: previous.detail,
        });
    }
    return rows;
  }
  configure(input: PersonResearchSettingsPatch): PersonResearchStatus {
    /* A patch names only the settings the owner changed: an absent key leaves
       the live value alone, so an unrelated edit cannot re-assert `paused` and
       cancel the research it was not about. */
    const changes = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    this.state.settings = PersonResearchSettingsSchema.parse({
      ...this.state.settings,
      ...changes,
    });
    if (input.paused) this.generation += 1;
    this.save();
    return this.status();
  }
  /**
   * Decide what happens to one Profile's automatic research (issue #418,
   * T3). Used to return `void` and no-op silently in four distinct
   * situations — not ready, missing/inactive Profile, already active, and
   * deferred by backoff — leaving every caller to report success regardless
   * (#417 F1). Every path now returns a typed, exhaustive decision that
   * names the queued or active work an `accepted`/`already-active` result
   * refers to.
   */
  enqueue(
    profileId: string,
    reason: "created" | "meeting" | "explicit" | "viewed" | "backfill" | "refresh" | "evidence",
  ): PersonResearchEnqueueDecision {
    const readiness = this.readiness();
    if (readiness.state !== "ready") return { kind: "rejected-readiness", profileId, readiness };
    const profile = this.deps.people.get(profileId);
    if (!profile || profile.archivedAt !== null || profile.mergedInto)
      return { kind: "inactive-profile", profileId };
    const old = this.state.jobs.find((j) => j.profileId === profileId);
    const now = this.now();
    if (old) {
      if (!old.reasons.includes(reason)) old.reasons.push(reason);
      if (reason === "evidence" || old.checkpoint?.profileRevision !== profile.revision)
        delete old.checkpoint;
      // A queued continuation can carry spent counters after restart. An
      // explicit request renews it before the already-active fast path;
      // repeated clicks on the newly queued request still coalesce.
      const renewQueued =
        reason === "explicit" &&
        (old.state === "queued" || old.state === "paused") &&
        (old.calls > 0 || (old.elapsedMilliseconds ?? 0) > 0);
      if (
        old.state === "researching" ||
        ((old.state === "queued" || old.state === "paused") && !renewQueued)
      ) {
        this.save();
        return { kind: "already-active", profileId, jobState: old.state };
      }
      const ageHours = (Date.parse(now) - Date.parse(old.updatedAt)) / 3600000;
      const urgent =
        reason === "explicit" ||
        reason === "evidence" ||
        (reason === "meeting" && ageHours >= 24) ||
        (reason === "viewed" && ageHours >= 48);
      if (!urgent && old.nextAt > now) {
        this.save();
        return { kind: "deferred", profileId, nextAt: old.nextAt };
      }
      old.state = "queued";
      old.detail = "Waiting for a research slot.";
      if (
        !renewQueued &&
        old.operation?.conclusion !== "bounded" &&
        old.operation?.conclusion !== "interrupted"
      )
        delete old.checkpoint;
      if (!old.checkpoint) {
        old.calls = 0;
        old.elapsedMilliseconds = 0;
        old.sources = 0;
      } else if (reason === "explicit") {
        /* A person asking for research is starting a new operation, not
           retrying the old one, so it is cut a whole allowance (ADR-0087
           withholds a reset from retries and restarts, never from a
           deliberate request). Without this a job that once ended `bounded`
           kept its spent lifetime counters, every later attempt was clamped
           to the 1-call/1000-ms floors, and the Profile became a dead end no
           click could move (audit F2). The checkpoint stays: the new
           allowance resumes the retained traversal rather than rereading it,
           and the day-wide, request and time ceilings are untouched. */
        old.calls = 0;
        old.elapsedMilliseconds = 0;
        this.explicitDispatches.add(profileId);
      }
      delete old.startedAt;
      old.queuedAt = now;
      old.nextAt = now;
    } else
      this.state.jobs.push({
        profileId,
        state: "queued",
        reasons: [reason],
        queuedAt: now,
        updatedAt: now,
        nextAt: now,
        calls: 0,
        sources: 0,
        attempts: 0,
        detail: "Waiting for automatic research.",
      });
    this.save();
    return { kind: "accepted", profileId, jobState: "queued" };
  }
  remove(profileId: string): void {
    this.state.jobs = this.state.jobs.filter((j) => j.profileId !== profileId);
    if (this.state.history) {
      this.state.history = this.state.history.filter((e) => e.profileId !== profileId);
    }
    /* A removal is a decision, and the merge on save must not mistake it for
       a Profile this instance never knew about. Privacy deletion in
       particular has to survive a concurrent runtime's snapshot. */
    this.removed.add(profileId);
    this.save();
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.pending) {
        this.pending = this.tick()
          .catch((error) => {
            console.error(
              "[person-research] Queue dispatch failed",
              error instanceof Error ? error.message : "Unknown error",
            );
          })
          .finally(() => {
            this.pending = undefined;
          });
      }
    }, 2000);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.generation += 1;
  }
  async drain(): Promise<void> {
    this.stop();
    await this.pending;
  }
  reset(): void {
    this.loaded.clear();
    this.running.clear();
    this.explicitDispatches.clear();
    this.removed.clear();
    this.state = existsSync(this.file)
      ? PersonResearchStatusSchema.parse(JSON.parse(readFileSync(this.file, "utf8")))
      : {
          schemaVersion: 1,
          settings: PersonResearchSettingsSchema.parse({
            paused: false,
            concurrency: 1,
            refreshHours: 168,
          }),
          day: this.now().slice(0, 10),
          usedCalls: 0,
          jobs: [],
          history: [],
        };
    if (!this.state.history) {
      this.state.history = this.seedHistoryFromJobs(this.state.jobs);
    }
    for (const job of this.state.jobs) this.loaded.add(job.profileId);
  }
  async runNow(profileId: string): Promise<PersonResearchOperationOutcome | null> {
    const job = this.state.jobs.find((candidate) => candidate.profileId === profileId);
    if (
      job &&
      job.checkpoint &&
      (job.state === "interrupted" || job.operation?.conclusion === "interrupted")
    ) {
      job.state = "queued";
      job.nextAt = this.now();
      delete job.startedAt;
      this.save();
    } else {
      this.enqueue(profileId, "explicit");
    }
    await this.tick(profileId);
    return this.operation(profileId);
  }

  async tick(profileId?: string): Promise<void> {
    if (!this.isReady()) return;
    this.rollDay();
    for (const profile of this.deps.people.search()) {
      if (profileId !== undefined && profile.id !== profileId) continue;
      this.enqueue(profile.id, "backfill");
      const job = this.state.jobs.find((candidate) => candidate.profileId === profile.id);
      const revision = this.deps.evidenceRevision?.(profile.id);
      if (job && revision !== undefined && revision !== job.evidenceRevision) {
        if (job.evidenceRevision !== undefined) this.enqueue(profile.id, "evidence");
        job.evidenceRevision = revision;
        this.save();
      }
    }
    for (const upcomingId of this.deps.upcomingProfileIds?.() ?? [])
      if (profileId === undefined || upcomingId === profileId) this.enqueue(upcomingId, "meeting");
    const now = this.now();
    const priority = (job: PersonResearchJob) => {
      const waitingHours = (Date.parse(now) - Date.parse(job.queuedAt)) / 3600000;
      return (
        waitingHours +
        (job.reasons.includes("meeting")
          ? 3
          : job.reasons.includes("explicit")
            ? 2
            : job.reasons.includes("viewed")
              ? 1
              : 0)
      );
    };
    const eligible = this.state.jobs
      .filter(
        (j) =>
          (profileId === undefined || j.profileId === profileId) &&
          !this.running.has(j.profileId) &&
          (j.state === "queued" || j.state === "paused") &&
          j.nextAt <= now,
      )
      .sort((a, b) => priority(b) - priority(a));
    await Promise.all(
      eligible
        .slice(0, Math.max(0, this.state.settings.concurrency - this.running.size))
        .map((job) => this.run(job)),
    );
  }
  private async run(job: PersonResearchJob): Promise<void> {
    const profile = this.deps.people.get(job.profileId);
    if (!profile || profile.archivedAt !== null || profile.mergedInto) {
      this.remove(job.profileId);
      return;
    }
    /* The per-profile lifetime allowance, read before dispatch rather than
       discovered as a clamped floor mid-run. A slice cut from a spent
       allowance is 1 call and 1000 ms: it does no useful work, and then
       reports whichever floor tripped first — which is how a 4.5-second run
       came to blame a 120-second wall-clock backstop for stopping it (audit
       F6). The allowance that is actually spent is the truthful answer, and
       an explicit request — which cuts a new one in `enqueue` — is what
       clears it. */
    const { profileCalls, profileMilliseconds } = this.state.settings;
    const spentCalls = profileCalls > 0 && job.calls >= profileCalls;
    const spentTime =
      profileMilliseconds > 0 && (job.elapsedMilliseconds ?? 0) >= profileMilliseconds;
    if (spentCalls || spentTime) {
      const seconds = (value: number) => `${Math.round(value / 1000)}s`;
      /* `incomplete`, not `paused`: a paused job is still dispatch-eligible
         and `enqueue` answers `already-active` for one, which would leave an
         explicit request unable to cut the new allowance that clears this. */
      job.state = "incomplete";
      job.detail =
        `This Profile's research allowance is spent — ` +
        [
          spentCalls ? `${job.calls} of ${profileCalls} model calls` : null,
          spentTime
            ? `${seconds(job.elapsedMilliseconds ?? 0)} of its ${seconds(profileMilliseconds)} research time`
            : null,
        ]
          .filter((part) => part !== null)
          .join(" and ") +
        `. Ask for research explicitly to start a new operation; retrieved evidence and pending work are retained.`;
      job.nextAt = new Date(
        Date.parse(this.now()) + this.state.settings.refreshHours * 3600000,
      ).toISOString();
      job.updatedAt = this.now();
      this.save();
      return;
    }
    const generation = this.generation;
    const fingerprint = JSON.stringify(profile);
    const evidenceRevision = this.deps.evidenceRevision?.(profile.id);
    const historical =
      !job.lastHistoricalAt ||
      Date.parse(this.now()) - Date.parse(job.lastHistoricalAt) >=
        (this.state.settings.historicalRefreshHours ?? 720) * 3600000;
    /*
     * The operation identity this dispatch runs under (issue #418, T5, spec
     * §7; #417 F5), minted here rather than left to `research.run()` to
     * generate internally: resuming a checkpoint keeps its operationId, a
     * fresh dispatch mints one before the first await, so live progress can
     * be scoped to it from the moment `researching` is set — never showing a
     * DIFFERENT, already-settled operation's conclusion as this one's own.
     */
    const operationId = job.checkpoint?.operationId ?? randomUUID();
    const active = () =>
      this.isReady() &&
      generation === this.generation &&
      this.state.jobs.includes(job) &&
      job.currentOperationId === operationId &&
      JSON.stringify(this.deps.people.get(job.profileId)) === fingerprint &&
      this.deps.evidenceRevision?.(profile.id) === evidenceRevision;
    const started = Date.now();
    job.startedAt = this.now();
    /* A terminal conclusion under a DIFFERENT operationId is superseded, not
       overwritten: it moves into its own labeled historical area so a caller
       can never mistake this operation's live progress for that one's
       failure (#417 F5). Resuming the SAME operationId (a checkpoint) is not
       a supersession and keeps its existing merge semantics untouched. */
    if (job.operation && job.operation.operationId !== operationId) {
      job.previousConclusion = {
        operationId: job.operation.operationId,
        revision: job.operationRevision ?? 0,
        conclusion: job.operation.conclusion,
        finishedAt: job.operation.finishedAt,
        detail: job.operation.detail,
        ...(job.operation.decisiveExtraction ? { decisive: job.operation.decisiveExtraction } : {}),
      };
    }
    job.state = "researching";
    job.attempts += 1;
    job.currentOperationId = operationId;
    job.currentOperationRevision = job.attempts;
    job.currentOperationStartedAt = this.now();
    job.detail = "Research is in progress.";
    job.updatedAt = this.now();
    this.running.add(job.profileId);
    this.save();
    try {
      const settings = this.state.settings;
      const result = await this.deps.research.run(profile, {
        operationId,
        scope: historical ? "full" : "current",
        /* Consumed here, not in enqueue: only the dispatch that actually
           runs the deliberate operation re-investigates the seeds, and a
           later interrupted re-dispatch is continuation, not re-investigation. */
        ...(this.explicitDispatches.delete(job.profileId) ? { explicit: true } : {}),
        maxModelCalls: Math.max(1, settings.profileCalls - job.calls),
        maxRequests: Math.max(1, settings.profileCalls * 8),
        maxMilliseconds: Math.max(
          1000,
          settings.profileMilliseconds - (job.elapsedMilliseconds ?? 0),
        ),
        readConcurrency: settings.readConcurrency,
        requestTimeoutMilliseconds: settings.requestTimeoutMilliseconds,
        quietRounds: settings.quietRounds,
        ...(job.checkpoint ? { checkpoint: job.checkpoint } : {}),
        saveCheckpoint: (checkpoint) => {
          if (!active()) return;
          job.checkpoint = structuredClone(checkpoint);
          this.save();
        },
        active,
        reserveRequest: () => {
          this.rollDay();
          if (!active()) return false;
          this.state.usedCalls += 1;
          return true;
        },
        reserveModelCall: () => {
          this.rollDay();
          if (!active()) return false;
          job.calls += 1;
          this.save();
          return true;
        },
      });
      /* A newer operation already superseded this one's identity on this job
         (issue #418, T5, spec §7): this is a late or out-of-order response
         from an older generation, and it must never overwrite the newer
         operation's live progress or conclusion. Bookkeeping in `finally`
         still runs; nothing about the job's research state does. */
      if (job.currentOperationId !== operationId) return;
      const ownUpdate =
        result.publishedProfileRevision !== undefined &&
        this.deps.people.get(job.profileId)?.revision === result.publishedProfileRevision &&
        this.isReady() &&
        generation === this.generation &&
        this.state.jobs.includes(job);
      if (!active() && !ownUpdate) {
        if (this.state.jobs.includes(job)) {
          if (
            JSON.stringify(this.deps.people.get(job.profileId)) !== fingerprint ||
            this.deps.evidenceRevision?.(profile.id) !== evidenceRevision
          ) {
            delete job.checkpoint;
            delete job.operation;
            job.state = "queued";
            job.detail = "Profile or evidence changed; stale results were stopped.";
          } else {
            this.retainOperation(job, result.operation);
            job.operationRevision = job.currentOperationRevision;
            job.diagnostics = result.diagnostics;

            job.state = "interrupted";
            job.detail =
              "Research was interrupted by shutdown or a policy change; completed evidence is retained.";
            job.nextAt = this.now();
          }
        }
      } else {
        if (ownUpdate && job.checkpoint && result.publishedProfileRevision !== undefined)
          job.checkpoint.profileRevision = result.publishedProfileRevision;
        job.state = result.state;
        if (historical && ["current", "empty"].includes(result.state))
          job.lastHistoricalAt = this.now();

        job.diagnostics = result.diagnostics;
        this.retainOperation(job, result.operation);
        job.operationRevision = job.currentOperationRevision;
        job.detail = result.detail;
        /* A completed operation clears its traversal: the next run is a
           refresh of changed evidence, not the second half of this one. */
        if (result.operation.conclusion === "completed") delete job.checkpoint;
        job.nextAt = new Date(
          Date.parse(this.now()) +
            (result.state === "unavailable" || result.state === "interrupted"
              ? Math.min(24, 2 ** Math.min(job.attempts, 5))
              : this.state.settings.refreshHours) *
              3600000,
        ).toISOString();
      }
    } catch {
      if (this.state.jobs.includes(job)) {
        job.state = "unavailable";
        job.detail = "Research failed; completed evidence is retained.";
        job.nextAt = new Date(Date.parse(this.now()) + 3600000).toISOString();
      }
    } finally {
      job.elapsedMilliseconds = (job.elapsedMilliseconds ?? 0) + Date.now() - started;
      delete job.startedAt;
      this.running.delete(job.profileId);
      job.updatedAt = this.now();
      this.save();
    }
  }
  private retainOperation(job: PersonResearchJob, operation: PersonResearchOperationOutcome): void {
    const previous = job.operation;
    if (previous?.operationId === operation.operationId) {
      operation.startedAt = previous.startedAt;
      operation.modelCalls += previous.modelCalls;
      operation.requests += previous.requests;
      if (previous.retainedSourceIds && operation.retainedSourceIds) {
        operation.retainedSourceIds = [
          ...new Set([...previous.retainedSourceIds, ...operation.retainedSourceIds]),
        ];
        operation.sourcesRetained = operation.retainedSourceIds.length;
      } else {
        // Legacy counters lack identities: summing could count a resumed source twice.
        // Preserve a conservative lower bound without claiming an exact identity set.
        operation.sourcesRetained = Math.max(previous.sourcesRetained, operation.sourcesRetained);
        delete operation.retainedSourceIds;
      }
      operation.claimsPublished += previous.claimsPublished;
      operation.attempts = [...previous.attempts, ...operation.attempts];
      const leads = new Map(previous.leads.map((lead) => [lead.id, lead]));
      for (const lead of operation.leads)
        if (lead.disposition !== "deduplicated" || !leads.has(lead.id)) leads.set(lead.id, lead);
      operation.leads = [...leads.values()];
    }
    job.operation = operation;
    job.sources = operation.sourcesRetained;
    this.recordHistory(job, operation);
  }
  private recordHistory(job: PersonResearchJob, operation: PersonResearchOperationOutcome): void {
    const entries = (this.state.history ??= []);
    const entry: PersonResearchHistoryEntry = {
      profileId: job.profileId,
      operationId: operation.operationId,
      ...(job.currentOperationRevision !== undefined
        ? { revision: job.currentOperationRevision }
        : job.operationRevision !== undefined
          ? { revision: job.operationRevision }
          : {}),
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
      conclusion: operation.conclusion,
      detail: operation.detail.slice(0, 300),
      ...(operation.decisiveExtraction ? { decisive: operation.decisiveExtraction } : {}),
    };
    const key = `${entry.profileId}:${entry.operationId}`;
    const index = entries.findIndex((e) => `${e.profileId}:${e.operationId}` === key);
    if (index >= 0) {
      entries[index] = entry;
    } else {
      entries.unshift(entry);
    }
    let count = 0;
    for (let i = 0; i < entries.length;) {
      if (entries[i]!.profileId === job.profileId) {
        count += 1;
        if (count > PERSON_RESEARCH_HISTORY_PER_PROFILE) {
          entries.splice(i, 1);
          continue;
        }
      }
      i += 1;
    }
  }
  private seedHistoryFromJobs(jobs: PersonResearchJob[]): PersonResearchHistoryEntry[] {
    const map = new Map<string, PersonResearchHistoryEntry>();
    for (const job of jobs) {
      if (job.previousConclusion) {
        const prev = job.previousConclusion;
        map.set(`${job.profileId}:${prev.operationId}`, {
          profileId: job.profileId,
          operationId: prev.operationId,
          revision: prev.revision,
          startedAt: prev.finishedAt,
          finishedAt: prev.finishedAt,
          conclusion: prev.conclusion,
          detail: prev.detail,
          ...(prev.decisive ? { decisive: prev.decisive } : {}),
        });
      }
      if (job.operation) {
        const op = job.operation;
        map.set(`${job.profileId}:${op.operationId}`, {
          profileId: job.profileId,
          operationId: op.operationId,
          ...(job.operationRevision !== undefined
            ? { revision: job.operationRevision }
            : job.currentOperationRevision !== undefined
              ? { revision: job.currentOperationRevision }
              : {}),
          startedAt: op.startedAt,
          finishedAt: op.finishedAt,
          conclusion: op.conclusion,
          detail: op.detail.slice(0, 300),
          ...(op.decisiveExtraction ? { decisive: op.decisiveExtraction } : {}),
        });
      }
    }
    const entries = [...map.values()];
    entries.sort(
      (a, b) =>
        b.startedAt.localeCompare(a.startedAt) || b.operationId.localeCompare(a.operationId),
    );
    return entries;
  }
  private rollDay(): void {
    const day = this.now().slice(0, 10);
    if (day !== this.state.day) {
      this.state.day = day;
      this.state.usedCalls = 0;
      for (const job of this.state.jobs) if (job.state === "paused") job.nextAt = this.now();
    }
  }
  /**
   * This instance's state merged over what the file already holds.
   *
   * Jobs are keyed by profileId and disjoint across instances of one
   * Workspace by construction — a Profile is researched by one runtime at a
   * time — so this instance's job wins for every profileId it holds and
   * every other on-disk job is preserved with its position.
   *
   * Deletion is the exception in both directions, because a merge must never
   * undo one. A profileId this instance removed is dropped from the disk
   * side, so its own deletion is not read back from a snapshot written
   * before it. And a job this instance still holds is re-added only when the
   * instance created it — a job that was in the file at load time and is
   * gone from it now was deleted by another instance, and a stale snapshot
   * is not grounds to resurrect it.
   *
   * `usedCalls` is a daily diagnostic rather than a gate, so the larger of
   * the two is kept: it cannot under-report what the Workspace spent, and no
   * dispatch decision reads it. A disk snapshot from an earlier day is not
   * carried across the roll, which would resurrect a counter this instance
   * has already reset. Settings and the day come from this instance, which
   * is the one that just acted.
   */
  private mergeWithDisk(): PersonResearchStatus {
    if (!existsSync(this.file)) return this.state;
    let disk: PersonResearchStatus;
    try {
      disk = PersonResearchStatusSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      /* A file this instance cannot read is not a reason to lose the jobs it
         holds; its own state is still the better record of them. */
      return this.state;
    }
    const own = new Map(this.state.jobs.map((job) => [job.profileId, job]));
    const jobs: PersonResearchJob[] = [];
    const merged = new Set<string>();
    for (const job of disk.jobs) {
      if (this.removed.has(job.profileId)) continue;
      jobs.push(own.get(job.profileId) ?? job);
      merged.add(job.profileId);
    }
    for (const job of this.state.jobs)
      if (!merged.has(job.profileId) && !this.loaded.has(job.profileId)) jobs.push(job);
    const historyMap = new Map<string, PersonResearchHistoryEntry>();
    for (const entry of disk.history ?? []) {
      if (this.removed.has(entry.profileId)) continue;
      historyMap.set(`${entry.profileId}:${entry.operationId}`, entry);
    }
    for (const entry of this.state.history ?? []) {
      if (this.removed.has(entry.profileId)) continue;
      historyMap.set(`${entry.profileId}:${entry.operationId}`, entry);
    }
    const mergedProfileIds = new Set(jobs.map((job) => job.profileId));
    const history = [...historyMap.values()].filter((entry) =>
      mergedProfileIds.has(entry.profileId),
    );
    history.sort(
      (a, b) =>
        b.startedAt.localeCompare(a.startedAt) || b.operationId.localeCompare(a.operationId),
    );
    this.state.history = history;
    return {
      ...this.state,
      usedCalls:
        disk.day === this.state.day
          ? Math.max(this.state.usedCalls, disk.usedCalls)
          : this.state.usedCalls,
      jobs,
      history,
    };
  }
  /**
   * One Workspace can carry several queue instances at once: the benchmark
   * researches fixed-document people concurrently, and every composed
   * runtime persists here. Each instance holds the snapshot it loaded, so
   * rewriting that snapshot wholesale would drop the jobs another instance
   * has written since. Merging with the file on the way out keeps both.
   *
   * Read, merge and rename are one synchronous block with no await between
   * them, so no other instance in this process can interleave a write.
   */
  private save(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.mergeWithDisk()));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
