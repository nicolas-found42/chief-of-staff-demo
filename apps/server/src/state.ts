import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DriveState {
  ingestedIds: string[];
  /** Remembered fact about the last completed poll attempt (D14). */
  lastPollAt: string | null;
  lastPollOutcome: "ok" | "failed" | null;
}

export interface WorkspaceState {
  drive: DriveState;
}


export function loadState(stateFile: string): WorkspaceState {
  const empty: WorkspaceState = {
    drive: { ingestedIds: [], lastPollAt: null, lastPollOutcome: null },
  };
  if (!existsSync(stateFile)) {
    return empty;
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      drive?: { ingestedIds?: unknown; lastPollAt?: unknown; lastPollOutcome?: unknown };
    };
    const drive = parsed.drive ?? {};
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
    };
  } catch {
    return empty;
  }
}

export function saveState(stateFile: string, state: WorkspaceState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}
