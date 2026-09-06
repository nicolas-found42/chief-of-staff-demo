import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PersonResearchSettingsSchema,
  PersonResearchStatusSchema,
  type PersonResearchSettings,
  type PersonResearchStatus,
  type PersonResearchJob,
  type PersonResearchOperationOutcome,
} from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "./profiles.js";
import type { PersonResearch } from "./research.js";

/** The settings an owner edit actually names; the rest keep their live values. */
export type PersonResearchSettingsPatch = {
  [K in keyof PersonResearchSettings]?: PersonResearchSettings[K] | undefined;
};

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
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  constructor(
    private readonly deps: {
      workspaceDir: string;
      people: WorkspacePersonProfiles;
      research: PersonResearch;
      now?: () => Date;
      enabled: () => boolean;
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
        };
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
  operation(profileId: string): PersonResearchOperationOutcome | null {
    this.rollDay();
    const job = this.state.jobs.find((candidate) => candidate.profileId === profileId);
    return job?.operation ? structuredClone(job.operation) : null;
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
  enqueue(
    profileId: string,
    reason: "created" | "meeting" | "explicit" | "viewed" | "backfill" | "refresh" | "evidence",
  ): void {
    if (!this.deps.enabled()) return;
    const profile = this.deps.people.get(profileId);
    if (!profile || profile.archivedAt !== null || profile.mergedInto) return;
    const old = this.state.jobs.find((j) => j.profileId === profileId);
    const now = this.now();
    if (old) {
      if (!old.reasons.includes(reason)) old.reasons.push(reason);
      if (reason === "evidence" || old.checkpoint?.profileRevision !== profile.revision)
        delete old.checkpoint;
      if (old.state === "researching" || old.state === "queued" || old.state === "paused") {
        this.save();
        return;
      }
      const ageHours = (Date.parse(now) - Date.parse(old.updatedAt)) / 3600000;
      const urgent =
        reason === "explicit" ||
        reason === "evidence" ||
        (reason === "meeting" && ageHours >= 24) ||
        (reason === "viewed" && ageHours >= 48);
      if (!urgent && old.nextAt > now) {
        this.save();
        return;
      }
      old.state = "queued";
      if (old.operation?.conclusion !== "bounded" && old.operation?.conclusion !== "interrupted")
        delete old.checkpoint;
      if (!old.checkpoint) {
        old.calls = 0;
        old.elapsedMilliseconds = 0;
        old.sources = 0;
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
  }
  remove(profileId: string): void {
    this.state.jobs = this.state.jobs.filter((j) => j.profileId !== profileId);
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

  async tick(profileId?: string): Promise<void> {
    if (!this.deps.enabled() || this.state.settings.paused) return;
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
    const generation = this.generation;
    const fingerprint = JSON.stringify(profile);
    const evidenceRevision = this.deps.evidenceRevision?.(profile.id);
    const historical =
      !job.lastHistoricalAt ||
      Date.parse(this.now()) - Date.parse(job.lastHistoricalAt) >=
        (this.state.settings.historicalRefreshHours ?? 720) * 3600000;
    const active = () =>
      this.deps.enabled() &&
      !this.state.settings.paused &&
      generation === this.generation &&
      this.state.jobs.includes(job) &&
      JSON.stringify(this.deps.people.get(job.profileId)) === fingerprint &&
      this.deps.evidenceRevision?.(profile.id) === evidenceRevision;
    const started = Date.now();
    job.startedAt = this.now();
    job.state = "researching";
    job.attempts += 1;
    job.updatedAt = this.now();
    this.running.add(job.profileId);
    this.save();
    try {
      const settings = this.state.settings;
      const result = await this.deps.research.run(profile, {
        scope: historical ? "full" : "current",
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
      const ownUpdate =
        result.publishedProfileRevision !== undefined &&
        this.deps.people.get(job.profileId)?.revision === result.publishedProfileRevision &&
        this.deps.enabled() &&
        !this.state.settings.paused &&
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
  }
  private rollDay(): void {
    const day = this.now().slice(0, 10);
    if (day !== this.state.day) {
      this.state.day = day;
      this.state.usedCalls = 0;
      for (const job of this.state.jobs) if (job.state === "paused") job.nextAt = this.now();
    }
  }
  private save(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
