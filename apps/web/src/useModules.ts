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
import type { ComponentType } from "react";
import type { RunDetail } from "@chief-of-staff-demo/shared";
import { TranscriptResultView } from "./modules/transcript/ResultView";
import { ContentScoutResultView } from "./modules/content-scout/ResultView";
import { MeetingBriefResultView } from "./modules/meeting-brief/ResultView";

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
  /**
   * The Module's own view of one of its Runs, rendered under the Shell's half
   * of the Run detail page. Absent is a real answer: a Module's first phase
   * gets the Shell's half and links to its files, which is what it needs. A
   * formatted dump of the result would be a permanent "we will design this
   * later" shipped to somebody who cannot read it.
   */
  resultView?: ComponentType<{ detail: RunDetail }>;
}

/* Array order is display order, in the nav and on Home alike. */
const MODULES: ModuleDescriptor[] = [
  {
    id: "transcript",
    path: "/transcript",
    label: "Transcript → Tasks",
    description: "Meeting transcripts become Google Tasks and Gmail drafts.",
    status: "live",
    resultView: TranscriptResultView,
  },
  {
    id: "youtube-trends",
    path: "/youtube",
    label: "YouTube Trends",
    description: "Every video on a channel, counted once a day, into a trend.",
    status: "live",
    /* No result view in phase 1, which is a real answer rather than a gap: the
       Shell's half of the Run detail page and the links to the Run's own files
       are what a first phase needs, and a formatted dump of the result would be
       a permanent "we will design this later". */
  },
  {
    id: "idea-engine",
    path: "/idea-engine",
    label: "Idea Engine",
    description: "Meeting transcripts become Content Ideas for publishing.",
    status: "live",
  },
  {
    id: "content-scout",
    path: "/content-scout",
    label: "Content Scout",
    description: "Public sources become a ranked shortlist and complete, editable Content Packs.",
    status: "live",
    resultView: ContentScoutResultView,
  },
  {
    id: "meeting-brief-generator",
    path: "/meetings/brief",
    label: "Meeting Brief Generator",
    description:
      "Prepare concise briefings for upcoming internal and external meetings — history, company, intelligence, and Person Profiles.",
    status: "live",
    resultView: MeetingBriefResultView,
  },
  {
    id: "content-research",
    path: "/content-research",
    label: "Content Research",
    description: "Named people, what is resonating for them, and why — ranked by resonance.",
    status: "live",
  },
];

/**
 * Every Module the Shell advertises. Not the route table: a line there and a
 * line here are different facts — what to mount, versus what to advertise.
 */
export function useModules(): ModuleDescriptor[] {
  return MODULES;
}

/**
 * How a Module's identity is spoken aloud. A Run whose Module is no longer
 * hosted keeps its raw identifier rather than vanishing: history does not
 * disappear because a Module was removed.
 */
export function useModuleLabel(): (id: string) => string {
  return (id: string) => MODULES.find((module) => module.id === id)?.label ?? id;
}

/** The Module that made a Run, when this Shell still hosts it. */
export function useModule(id: string | undefined): ModuleDescriptor | null {
  return MODULES.find((module) => module.id === id) ?? null;
}
