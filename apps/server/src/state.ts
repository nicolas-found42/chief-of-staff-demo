import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FirefliesState {
  ingestedIds: string[];
  lastPollAt: string | null;
}

export interface WorkspaceState {
  fireflies: FirefliesState;
}

const EMPTY: WorkspaceState = { fireflies: { ingestedIds: [], lastPollAt: null } };

export function loadState(stateFile: string): WorkspaceState {
  if (!existsSync(stateFile)) {
    return { fireflies: { ...EMPTY.fireflies } };
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      fireflies?: { ingestedIds?: unknown; lastPollAt?: unknown };
    };
    const fireflies = parsed.fireflies ?? {};
    return {
      fireflies: {
        ingestedIds: Array.isArray(fireflies.ingestedIds)
          ? fireflies.ingestedIds.filter((id): id is string => typeof id === "string")
          : [],
        lastPollAt: typeof fireflies.lastPollAt === "string" ? fireflies.lastPollAt : null,
      },
    };
  } catch {
    return { fireflies: { ...EMPTY.fireflies } };
  }
}

export function saveState(stateFile: string, state: WorkspaceState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}
