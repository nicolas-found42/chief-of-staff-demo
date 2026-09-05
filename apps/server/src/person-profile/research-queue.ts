import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PersonResearchSettingsSchema,
  PersonResearchStatusSchema,
  type PersonResearchSettings,
  type PersonResearchStatus,
  type PersonResearchJob,
} from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "./profiles.js";
import type { PersonResearch } from "./research.js";

/** One Workspace runtime owns dispatch; every allowance is persisted before use. */
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
    },
  ) {
    this.file = join(deps.workspaceDir, "person-research.json");
    this.state = existsSync(this.file)
      ? PersonResearchStatusSchema.parse(JSON.parse(readFileSync(this.file, "utf8")))
      : {
          schemaVersion: 1,
          settings: {
            paused: false,
            concurrency: 1,
            profileCalls: 12,
            profileMilliseconds: 120000,
            dailyCalls: 96,
            refreshHours: 168,
          },
          day: this.now().slice(0, 10),
          usedCalls: 0,
          jobs: [],
        };
    // A process cannot carry its old in-flight lease through restart.
    for (const job of this.state.jobs)
      if (job.state === "researching") {
        job.state = "queued";
        job.detail = "Resuming interrupted research.";
      }
  }
  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
  status(): PersonResearchStatus {
    this.rollDay();
    return structuredClone(this.state);
  }
  configure(input: Partial<PersonResearchSettings>): PersonResearchStatus {
    this.state.settings = PersonResearchSettingsSchema.parse({ ...this.state.settings, ...input });
    if (input.paused) this.generation += 1;
    this.save();
    return this.status();
  }
  enqueue(
    profileId: string,
    reason: "created" | "meeting" | "explicit" | "viewed" | "backfill" | "refresh",
  ): void {
    if (!this.deps.enabled()) return;
    const profile = this.deps.people.get(profileId);
    if (!profile || profile.archivedAt !== null || profile.mergedInto) return;
    const old = this.state.jobs.find((j) => j.profileId === profileId);
    const now = this.now();
    if (old) {
      if (!old.reasons.includes(reason)) old.reasons.push(reason);
      if (old.state === "researching" || old.state === "queued") {
        this.save();
        return;
      }
      if (reason !== "explicit" && old.nextAt > now) {
        this.save();
        return;
      }
      old.state = "queued";
      old.calls = 0;
      old.sources = 0;
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

  async tick(): Promise<void> {
    if (!this.deps.enabled() || this.state.settings.paused) return;
    this.rollDay();
    for (const profile of this.deps.people.search()) this.enqueue(profile.id, "backfill");
    for (const profileId of this.deps.upcomingProfileIds?.() ?? [])
      this.enqueue(profileId, "meeting");
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
    if (this.state.usedCalls >= this.state.settings.dailyCalls) {
      job.state = "paused";
      job.detail = "Daily research allowance reached.";
      this.save();
      return;
    }
    const generation = this.generation;
    const fingerprint = JSON.stringify(profile);
    const active = () =>
      this.deps.enabled() &&
      !this.state.settings.paused &&
      generation === this.generation &&
      this.state.jobs.includes(job) &&
      JSON.stringify(this.deps.people.get(job.profileId)) === fingerprint;
    job.state = "researching";
    job.attempts += 1;
    job.updatedAt = this.now();
    this.running.add(job.profileId);
    this.save();
    try {
      const result = await this.deps.research.run(profile, {
        maxCalls: Math.max(0, this.state.settings.profileCalls - job.calls),
        maxMilliseconds: this.state.settings.profileMilliseconds,
        active,
        reserve: () => {
          this.rollDay();
          if (!active() || this.state.usedCalls >= this.state.settings.dailyCalls) return false;
          this.state.usedCalls += 1;
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
          job.state = "queued";
          job.detail = "Profile or research policy changed; stale results were stopped.";
        }
      } else {
        job.state =
          this.state.usedCalls >= this.state.settings.dailyCalls && result.state === "incomplete"
            ? "paused"
            : result.state;
        job.sources += result.sources;
        job.diagnostics = result.diagnostics;
        job.detail = result.detail;
        job.nextAt = new Date(
          Date.parse(this.now()) +
            (result.state === "unavailable"
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
      this.running.delete(job.profileId);
      job.updatedAt = this.now();
      this.save();
    }
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
