import type { CompleteJson } from "../../llm/providers.js";
import type { Runs } from "../../runs.js";
import { TranscriptCatalogStore } from "../../transcript-catalog/store.js";
import { TranscriptIdentityStore } from "../../transcript-catalog/identity-store.js";
import { MeetingDebriefHost } from "./host.js";

export interface MeetingDebriefProductionRuntimeOptions {
  runs: Runs;
  workspaceDir: string;
  getCompleteJson: () => CompleteJson;
  /** Provider/model recorded on extract_attempt events for diagnosis. */
  getLlmInfo: () => { provider: string; model: string };
  log?: (message: string) => void;
}

export interface MeetingDebriefProductionRuntime {
  host: MeetingDebriefHost;
}

/**
 * Production composition root for the Meeting Debrief (issue #139). Both
 * consumers read the one Workspace directory the Transcript Catalog owns: the
 * immutable Transcript records and the identity-mining review state. There is
 * no Drive access and no conversion here — the Catalog is the sole source.
 */
export function createMeetingDebriefProductionRuntime(
  options: MeetingDebriefProductionRuntimeOptions,
): MeetingDebriefProductionRuntime {
  const catalogStore = new TranscriptCatalogStore(options.workspaceDir);
  const identityStore = new TranscriptIdentityStore(options.workspaceDir);
  const host = new MeetingDebriefHost({
    runs: options.runs,
    catalog: {
      getTranscript: (transcriptId) => catalogStore.readTranscript(transcriptId),
    },
    identity: {
      reviewFor: (transcriptId) => ({
        mentions: identityStore
          .readMentions()
          .filter((mention) => mention.provenance.transcriptId === transcriptId),
        decisions: identityStore
          .readDecisions()
          .filter((decision) => decision.transcriptId === transcriptId),
        organizations: identityStore
          .readOrganizations()
          .filter((organization) => organization.provenance.transcriptId === transcriptId),
      }),
    },
    getCompleteJson: options.getCompleteJson,
    getLlmInfo: options.getLlmInfo,
    ...(options.log ? { log: options.log } : {}),
  });
  return { host };
}
