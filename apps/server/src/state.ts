import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DriveState {
  ingestedIds: string[];
  lastPollAt: string | null;
}

export interface WorkspaceState {
  drive: DriveState;
}


export function loadState(stateFile: string): WorkspaceState {
  if (!existsSync(stateFile)) {
    return { drive: { ingestedIds: [], lastPollAt: null } };
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      drive?: { ingestedIds?: unknown; lastPollAt?: unknown };
    };
    const drive = parsed.drive ?? {};
    return {
      drive: {
        ingestedIds: Array.isArray(drive.ingestedIds)
          ? drive.ingestedIds.filter((id): id is string => typeof id === "string")
          : [],
        lastPollAt: typeof drive.lastPollAt === "string" ? drive.lastPollAt : null,
      },
    };
  } catch {
    return { drive: { ingestedIds: [], lastPollAt: null } };
  }
}

export function saveState(stateFile: string, state: WorkspaceState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}
