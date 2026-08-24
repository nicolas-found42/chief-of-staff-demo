import type { RunMeta } from "@chief-of-staff-demo/shared";
import { Runner } from "../engine/runner.js";
import {
  transcriptModule,
  type GoogleAccess,
  type RunSourceSpec,
  type TranscriptInput,
} from "../modules/transcript/module.js";
import type { Runs } from "../runs.js";
import { type CompleteJson } from "../llm/providers.js";

export { meetingDateFromFileName } from "../modules/transcript/module.js";
export type { GoogleAccess, RunSourceSpec } from "../modules/transcript/module.js";

export interface PipelineDeps {
  /** Constructed once by the Shell: the run directory has one owner. */
  runs: Runs;
  /** Fresh per attempt so config edits apply without a restart. */
  getCompleteJson: () => CompleteJson;
  /** Provider/model recorded on extract_attempt events for diagnosis. */
  getLlmInfo: () => { provider: string; model: string };
  google: GoogleAccess;
  getTasklistName: () => string;
  log?: (message: string) => void;
}

/**
 * The transcript Module, hosted: its Stages live in
 * `../modules/transcript/module.ts` and the Run engine that records them lives
 * in `../engine/`. What is left here is the wiring plus the two calls its
 * Intake makes — `startRun` for a file the Drive folder produced, `retryRun`
 * for one that failed.
 */
export class Pipeline {
  private readonly runner: Runner<TranscriptInput>;

  constructor(deps: PipelineDeps) {
    this.runner = new Runner({
      runs: deps.runs,
      module: transcriptModule({
        getCompleteJson: deps.getCompleteJson,
        getLlmInfo: deps.getLlmInfo,
        google: deps.google,
        getTasklistName: deps.getTasklistName,
      }),
      log: deps.log,
    });
  }

  /** Resolves when every enqueued job has settled (test seam). */
  idle(): Promise<void> {
    return this.runner.idle();
  }

  /** Create the Run for one transcript and enqueue its work. */
  startRun(spec: RunSourceSpec): Promise<string> {
    return this.runner.startRun(
      {
        intake: spec.intake,
        fileName: spec.fileName,
        sourceUrl: spec.sourceUrl ?? null,
        externalId: spec.externalId ?? null,
      },
      { kind: "fresh", spec },
    );
  }

  /** Re-run a failed Run: extraction from scratch, or outputs from the result. */
  retryRun(id: string): Promise<RunMeta> {
    return this.runner.retryRun(id);
  }
}
