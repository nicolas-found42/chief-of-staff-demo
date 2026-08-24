import type {
  IdeaEngineIndex,
  IdeaEngineRunResult,
  IdeaEngineIdea,
} from "@chief-of-staff-demo/shared";
import { IDEA_ENGINE_MODULE_ID } from "@chief-of-staff-demo/shared";
import type { Runs } from "../../runs.js";

export interface IdeaIndexDeps {
  runs: Runs;
  spreadsheet: () => { id: string; url: string } | null;
}

export class IdeaIndex {
  private cached: IdeaEngineIndex | null = null;

  constructor(private readonly deps: IdeaIndexDeps) {}

  read(): IdeaEngineIndex {
    if (this.cached !== null) return this.cached;
    this.cached = this.build();
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }

  private build(): IdeaEngineIndex {
    const summaries = this.deps.runs.list({ module: IDEA_ENGINE_MODULE_ID }).runs;
    // newest first from list? list returns newest first; keep that order
    const runEntries: IdeaEngineIndex["runs"] = [];
    const allIdeas: IdeaEngineIdea[] = [];

    for (const summary of summaries) {
      const handle = this.deps.runs.open(summary.id);
      if (!handle) continue;
      const raw = handle.readArtifact("result.json");
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as IdeaEngineRunResult;
        if (!Array.isArray(parsed.ideas)) continue;
        const ideas = parsed.ideas;
        const entry: IdeaEngineIndex["runs"][number] = {
          runId: summary.id,
          createdAt: summary.createdAt,
          sourceUrl: summary.sourceUrl,
          externalId: handle.read().externalId,
          ideas,
          summary: summary.summary,
        };
        if (summary.fileName !== undefined) entry.fileName = summary.fileName;
        runEntries.push(entry);
        allIdeas.push(...ideas);
      } catch {
        // torn result is one missing run, not broken page
      }
    }

    // runEntries already newest first via list order; ensure sorted newest first by createdAt as fallback
    runEntries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    return { runs: runEntries, ideas: allIdeas, spreadsheet: this.deps.spreadsheet() };
  }
}
