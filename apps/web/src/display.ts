/**
 * The display vocabulary for Run facts — statuses, stages, titles and times.
 *
 * Storage keeps the frozen ADR-0004 enum and machine-named stage keys; nothing
 * stops those tokens reaching the screen verbatim except this file, so every
 * surface renders through it (spec D4–D7). An unknown token falls back to
 * itself rather than disappearing: a diagnostic is better than a blank pill.
 */

import type { RunEvent } from "@chief-of-staff-demo/shared";

const STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  running: "Running",
  done: "Completed",
  skipped: "Skipped",
  failed: "Failed",
};

/**
 * Human names for every Module's Stages. A Module names its own Stages and the
 * Shell never holds a list of them (ADR-0003), so this is display vocabulary
 * only: a Stage with no entry renders its own key rather than disappearing.
 */
const STAGE_LABELS: Record<string, string> = {
  convert: "Read transcript",
  extract: "Find follow-ups",
  outputs: "Create tasks & drafts",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/* ---------------------------------------------------------------------------
 * Titles
 *
 * Runs are named at render from the stored filename, so legacy runs benefit
 * and nothing migrates (D4). Drive/Fireflies names carry copy prefixes,
 * extensions and ISO timestamp tails; an operator's log should not.
 * ------------------------------------------------------------------------ */

const EXTENSION = /\.(md|txt|json|jsonc|pdf|docx)$/i;

/* Google Docs copies stack ("Copy of Copy of Stand-up"). */
const COPY_PREFIX = /^(?:copy of\s+)+/i;

/* The tail Fireflies appends: `-2026-06-18T13-00-00.000Z`. Minutes are the
   coarsest part worth matching; seconds and fractional seconds optional. */
const TIMESTAMP_TAIL = /[ _-]*\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}([-:]\d{2})?(?:\.\d+)?Z?$/;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortDate(isoDay: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) {
    return null;
  }
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    return null;
  }
  return `${MONTHS[month - 1]} ${Number(match[3])}`;
}

/**
 * A human title for a stored filename: "Stand-up - 2026-06-18T13-00-00.000Z.json"
 * becomes "Stand-up — Jun 18". Falls back to "Untitled transcript" when there is
 * nothing left to show.
 */
export function runTitle(fileName: string): string {
  const trimmed = fileName.trim();
  let name = trimmed.replace(EXTENSION, "");
  const tail = TIMESTAMP_TAIL.exec(name);
  let date: string | null = null;
  if (tail) {
    date = shortDate(/\d{4}-\d{2}-\d{2}/.exec(tail[0])![0]);
    name = name.slice(0, tail.index);
  }
  name = name.replace(COPY_PREFIX, "").replace(/[\s_\-.,;:]+$/, "").trim();
  /* A name that was only a timestamp still has its date to offer; a truly
     empty cell falls back to the untitled sentence. */
  if (!name) {
    return date ?? "Untitled transcript";
  }
  return date ? `${name} — ${date}` : name;
}

/* ---------------------------------------------------------------------------
 * Times
 * ------------------------------------------------------------------------ */

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

/**
 * How long ago something happened, in words. Coarse on purpose: the absolute
 * time stays available beside it (title attribute), so precision here would
 * only be a second clock to keep in step.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return iso;
  }
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days} d ago`;
  }
  const date = new Date(time);
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? day
    : `${day}, ${date.getFullYear()}`;
}

/**
 * A stage's wall-clock duration, coarse the way relativeTime is: the events
 * carry exact timestamps for anyone who needs them.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return "under a second";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/* ---------------------------------------------------------------------------
 * The human timeline
 *
 * Derived at render from the append-only event log — never forked from it
 * (spec D8). One entry per Stage, in the order the Run met them, with a
 * duration summed across retry attempts.
 * ------------------------------------------------------------------------ */

export interface TimelineEntry {
  stage: string;
  /** Human name (D7); an unrecognized stage key falls back to itself. */
  label: string;
  state: "running" | "done" | "failed";
  /** Milliseconds across every attempt; null while the stage is still open. */
  durationMs: number | null;
}


function stageKeyOf(event: RunEvent): string | null {
  const stage = event.detail?.stage;
  return typeof stage === "string" ? stage : null;
}

/**
 * Replays `events` in order: each `stage_started` opens a stage (closing
 * whatever was open), failures and run boundaries close them. A stage still
 * open at the end of the log is the one a running run is sitting in.
 *
 * What each Stage *meant* is not here: that is the Module's own vocabulary, and
 * it belongs to the Module's half of the Run detail page.
 */
export function buildTimeline(events: RunEvent[]): TimelineEntry[] {
  interface Acc {
    startedAt: number | null;
    durationMs: number;
    failed: boolean;
  }
  const accs = new Map<string, Acc>();
  let open: string | null = null;

  const closeOpen = (at: number | null) => {
    if (open === null) {
      return;
    }
    const acc = accs.get(open)!;
    /* Duration only counts segments with both ends; a malformed log yields no
       invented numbers. */
    if (acc.startedAt !== null && at !== null && at >= acc.startedAt) {
      acc.durationMs += at - acc.startedAt;
    }
    acc.startedAt = null;
    open = null;
  };

  for (const event of events) {
    const stage = stageKeyOf(event);
    const at = new Date(event.at).getTime();
    if (event.type === "stage_started" && stage !== null) {
      closeOpen(Number.isNaN(at) ? null : at);
      if (!accs.has(stage)) {
        accs.set(stage, { startedAt: null, durationMs: 0, failed: false });
      }
      const acc = accs.get(stage)!;
      /* A fresh attempt supersedes the one before it: the stage that failed
         and then finished on retry reads as done, its duration summed. */
      acc.failed = false;
      acc.startedAt = Number.isNaN(at) ? null : at;
      open = stage;
    } else if (event.type === "stage_failed" && stage !== null && accs.has(stage)) {
      accs.get(stage)!.failed = true;
      closeOpen(Number.isNaN(at) ? null : at);
    } else if (event.type === "classify_skipped") {
      closeOpen(Number.isNaN(at) ? null : at);
    } else if (event.type === "run_done" || event.type === "run_failed") {
      closeOpen(Number.isNaN(at) ? null : at);
    }
  }

  return [...accs.keys()].map((stage) => {
    const acc = accs.get(stage)!;
    const stillOpen = open === stage;
    return {
      stage,
      label: stageLabel(stage),
      state: acc.failed ? ("failed" as const) : stillOpen ? ("running" as const) : ("done" as const),
      durationMs: stillOpen || acc.durationMs === 0 ? null : acc.durationMs,
    };
  });
}
