import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface DriveState {
  ingestedIds: string[];
  /** Remembered fact about the last completed poll attempt (D14). */
  lastPollAt: string | null;
  lastPollOutcome: "ok" | "failed" | null;
}

interface IdeaEngineState {
  ingestedIds: string[];
}

/**
 * YouTube Trends' own key. Durability comes from a remembered date, never from a
 * timer: an interval timer resets on every restart, so a laptop restarted every
 * few days would never fire one.
 */
interface YoutubeTrendsState {
  /** The last calendar day a Run was started for, local time. */
  lastRunDay: string | null;
}

export interface WorkspaceState {
  drive: DriveState;
  youtubeTrends: YoutubeTrendsState;
  ideaEngine: IdeaEngineState;
}

const MAX_INGESTED = 1000;
const IDEA_ENGINE_MODULE_ID = "idea-engine";



export function loadState(stateFile: string): WorkspaceState {
  const empty: WorkspaceState = {
    drive: { ingestedIds: [], lastPollAt: null, lastPollOutcome: null },
    youtubeTrends: { lastRunDay: null },
    ideaEngine: { ingestedIds: [] },
  };
  if (!existsSync(stateFile)) {
    return empty;
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      drive?: { ingestedIds?: unknown; lastPollAt?: unknown; lastPollOutcome?: unknown };
      youtubeTrends?: { lastRunDay?: unknown };
      ideaEngine?: { ingestedIds?: unknown };
    };
    const drive = parsed.drive ?? {};
    const youtubeTrends = parsed.youtubeTrends ?? {};
    const ideaEngine = parsed.ideaEngine ?? {};
    return {
      drive: {
        ingestedIds: Array.isArray(drive.ingestedIds)
          ? drive.ingestedIds.filter((id): id is string => typeof id === "string")
          : [],
        lastPollAt: typeof drive.lastPollAt === "string" ? drive.lastPollAt : null,
        /* Legacy state files have no outcome; absent reads as "unknown", which
           is exactly what the line should say. */
        lastPollOutcome:
          drive.lastPollOutcome === "ok" || drive.lastPollOutcome === "failed"
            ? drive.lastPollOutcome
            : null,
      },
      youtubeTrends: {
        /* A state file written before this Module existed has no day, which
           reads as "no Run yet" — exactly right. */
        lastRunDay: typeof youtubeTrends.lastRunDay === "string" ? youtubeTrends.lastRunDay : null,
      },
      ideaEngine: {
        ingestedIds: Array.isArray(ideaEngine.ingestedIds)
          ? ideaEngine.ingestedIds.filter((id): id is string => typeof id === "string")
          : [],
      },
    };
  } catch {
    return empty;
  }
}

export function saveState(stateFile: string, state: WorkspaceState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Whether the Workspace has already ingested this Drive file for the given Module.
 * Namespaced per Module over the same durable file, capped FIFO, load-modify-save guarded.
 * Spec sentence `Workspace.hasSeen(externalId)` is the transcript Module's alias.
 */
export function hasSeen(stateFile: string, externalId: string): boolean {
  const state = loadState(stateFile);
  return state.drive.ingestedIds.includes(externalId);
}

export function hasSeenForModule(
  stateFile: string,
  moduleId: string,
  externalId: string,
): boolean {
  const state = loadState(stateFile);
  if (moduleId === IDEA_ENGINE_MODULE_ID) {
    return state.ideaEngine.ingestedIds.includes(externalId);
  }
  return state.drive.ingestedIds.includes(externalId);
}
/**
 * Load-modify-save guarded remember. Single writer at a time via file re-read.
 */
export function rememberSeen(stateFile: string, externalId: string): void {
  const state = loadState(stateFile);
  if (state.drive.ingestedIds.includes(externalId)) return;
  state.drive.ingestedIds.push(externalId);
  if (state.drive.ingestedIds.length > MAX_INGESTED) {
    state.drive.ingestedIds.splice(0, state.drive.ingestedIds.length - MAX_INGESTED);
  }
  saveState(stateFile, state);
}

export function rememberSeenForModule(
  stateFile: string,
  moduleId: string,
  externalId: string,
): void {
  const state = loadState(stateFile);
  if (moduleId === IDEA_ENGINE_MODULE_ID) {
    if (state.ideaEngine.ingestedIds.includes(externalId)) return;
    state.ideaEngine.ingestedIds.push(externalId);
    if (state.ideaEngine.ingestedIds.length > MAX_INGESTED) {
      state.ideaEngine.ingestedIds.splice(0, state.ideaEngine.ingestedIds.length - MAX_INGESTED);
    }
    saveState(stateFile, state);
    return;
  }
  rememberSeen(stateFile, externalId);
}

