import type { ProviderId, RunSummary } from "@chief-of-staff-demo/shared";

/** One thing needing action. Rows link; they do not act — "Open", never "Retry". */
export interface RailRow {
  /** React key, and the identity of the thing the row is about. */
  id: string;
  text: string;
  cta: string;
  to: string;
}

export interface HomeStatus {
  /** One line stating where you stand. Always present, whatever the state. */
  sentence: string;
  /** A row per thing needing action; empty means the rail is omitted entirely. */
  rows: RailRow[];
}

/**
 * ADR-0008 aborts the whole outputs batch on a rejected grant, and the first Run
 * after a weekly expiry always fails, so several simultaneous failures are
 * routine rather than hypothetical. Uncapped, the rail would rebuild the Runs
 * list Home deliberately does not have.
 */
const MAX_FAILED_ROWS = 3;

const TERMINAL = new Set(["done", "skipped", "failed"]);

/**
 * Home's sentence and attention rail, from what the Shell can observe.
 *
 * A condition earns a rail row by being **standing, Shell-observable and
 * actionable**, and by not already being visible where the user is standing —
 * which is why the Google connection is absent from both the rail and the
 * clauses below: the Shell banner says it on every page. The full rule and the
 * candidates it excludes are in ADR-0010.
 *
 * The sentence and the rail are computed together on purpose. The sentence
 * enumerates exactly the conditions the rail itemises, so the summary cannot
 * drift from the detail: the sentence carries the bare fact ("1 run failed"),
 * the row carries the consequence and the way out.
 *
 * `hasNotice` is whether the Shell banner is saying anything — see the
 * `Nothing needs you.` clause below, which is the one part of the sentence that
 * speaks for the whole page rather than for the part Home owns.
 */
export function homeStatus(
  runs: RunSummary[],
  provider: ProviderId,
  hasNotice: boolean
): HomeStatus {
  const failed = runs.filter((run) => run.status === "failed");
  const active = runs.filter((run) => !TERMINAL.has(run.status));
  /* A fresh workspace defaults to `mock`, so this is the likeliest reason a
     beginner's first upload quietly does nothing useful. It speaks only at the
     level the Shell legitimately knows: the provider is Shell configuration,
     but extraction is a Module stage (ADR-0003), so the row must not claim what
     extraction would have produced. */
  const mock = provider === "mock";

  const rows: RailRow[] = failed.slice(0, MAX_FAILED_ROWS).map((run) => ({
    id: run.id,
    text: `${run.fileName || "Untitled transcript"} failed`,
    cta: "Open",
    to: `/runs/${run.id}`,
  }));
  /* The tail of the failed rows, not a condition of its own — so it sits with
     the rows it summarises rather than after the provider. */
  if (failed.length > MAX_FAILED_ROWS) {
    const hidden = failed.length - MAX_FAILED_ROWS;
    rows.push({
      id: "more-failed",
      text: `${hidden} more run${hidden === 1 ? "" : "s"} failed`,
      cta: "See all runs",
      to: "/transcript",
    });
  }
  if (mock) {
    rows.push({
      id: "mock-provider",
      text: "Runs are using the mock provider, so nothing real is extracted",
      cta: "Choose a provider",
      to: "/settings",
    });
  }

  /* One clause per rail condition, in the rail's order. The count is the true
     total, not the capped row count. */
  const clauses: string[] = [];
  if (failed.length > 0) {
    clauses.push(`${failed.length} run${failed.length === 1 ? "" : "s"} failed`);
  }
  if (mock) {
    clauses.push("the extraction provider is a stand-in");
  }

  return { sentence: sentenceFor(clauses, runs.length, active.length, hasNotice), rows };
}

function sentenceFor(
  clauses: string[],
  runCount: number,
  activeCount: number,
  hasNotice: boolean
): string {
  if (clauses.length > 0) {
    /* Capitalised before the prefix, not after: the provider clause starts
       lowercase and can lead the sentence on its own. */
    const enumerated = `${capitalise(join(clauses))}.`;
    return runCount === 0 ? `Nothing has run yet. ${enumerated}` : enumerated;
  }

  /* "Nothing has run yet." claims no all-clear, so it never takes the clause
     below — there is nothing to reassure anyone about yet. */
  if (runCount === 0) {
    return "Nothing has run yet.";
  }

  const standing =
    activeCount > 0
      ? `${activeCount} run${activeCount === 1 ? "" : "s"} in progress.`
      : "All quiet.";

  /* The enumeration above is rail-scoped; this clause is page-scoped, because
     it is a claim about the reader's obligations rather than about the
     workspace. Home cannot make it while the banner above is asking for
     something — including a banner that is only warning about an expiry due
     soon, which exists to get a sign-in *before* a Run fails. */
  return hasNotice ? standing : `${standing} Nothing needs you.`;
}

function join(parts: string[]): string {
  if (parts.length <= 1) {
    return parts.join("");
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
