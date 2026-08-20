/**
 * The Modules this Shell hosts, as one list rather than two.
 *
 * The header nav and Home's cards both render from here, so the two cannot
 * disagree about what exists. This is not the server-side registry of ADR-0002:
 * it is the seam that registry can slot behind later without either caller
 * changing, which is why it is shaped as what an endpoint would serve.
 *
 * A hook rather than an exported const for that same reason — the day this
 * becomes a fetch, a const forces both callers to become async, and that is the
 * callers changing.
 */
export interface ModuleDescriptor {
  /** Stable identity. Survives a route rename; never derived from `path`. */
  id: string;
  /** Where the tab and Home's card link. Presentation — expected to change. */
  path: string;
  /** The tab's text, e.g. "Transcript → Tasks". */
  label: string;
  /** One line, for Home's card. */
  description: string;
  /** A planned Module has a tab and no Runs yet (CONTEXT.md). */
  status: "live" | "planned";
}

/* Array order is display order, in the nav and on Home alike. */
const MODULES: ModuleDescriptor[] = [
  {
    id: "transcript",
    path: "/transcript",
    label: "Transcript → Tasks",
    description: "Meeting transcripts become Google Tasks and Gmail drafts.",
    status: "live",
  },
  {
    id: "hot-take",
    path: "/hot-take",
    label: "Hot Take",
    description: "A link or transcript becomes a draft LinkedIn post.",
    status: "planned",
  },
];

/**
 * Every Module the Shell advertises. Not the route table: a line there and a
 * line here are different facts — what to mount, versus what to advertise.
 */
export function useModules(): ModuleDescriptor[] {
  return MODULES;
}
