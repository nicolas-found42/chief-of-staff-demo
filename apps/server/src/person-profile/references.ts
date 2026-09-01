import type { Runs } from "../runs.js";
import type { PersonProfileLifecycleRegistry } from "./profiles.js";

interface ProfileReference {
  profileId?: unknown;
}

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Workspace-owned registry for structured Profile references already held by
 * immutable Runs. Privacy deletion is the explicit exception that removes
 * Profile pins and projection snapshots while leaving every unrelated Run
 * field and artifact intact. It performs only local `Runs` operations.
 */
export class WorkspacePersonProfileReferences implements PersonProfileLifecycleRegistry {
  constructor(private readonly runs: Runs) {}

  inspect(): ReturnType<PersonProfileLifecycleRegistry["inspect"]> {
    /* Existing Meeting Brief references are historical consumer pins, not
       active configuration. Future configurable consumers register their own
       adapter in the aggregate lifecycle registry. */
    return { dependentConfigurations: [], residualSourceArtifacts: [] };
  }

  privacyDelete(profileId: string): ReturnType<PersonProfileLifecycleRegistry["privacyDelete"]> {
    let activeLinks = 0;
    let personSnapshots = 0;
    for (const summary of this.runs.list().runs) {
      const run = this.runs.open(summary.id);
      if (!run) continue;

      const result = parsed(run.readArtifact("result.json"));
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const record = result as Record<string, unknown>;
        if (Array.isArray(record.personProfileLinks)) {
          const kept = record.personProfileLinks.filter((link) => {
            const matches =
              link !== null &&
              typeof link === "object" &&
              (link as ProfileReference).profileId === profileId;
            if (matches) activeLinks += 1;
            return !matches;
          });
          if (kept.length !== record.personProfileLinks.length) {
            run.writeArtifact(
              "result.json",
              `${JSON.stringify({ ...record, personProfileLinks: kept }, null, 2)}\n`,
            );
          }
        }
      }

      const pins = parsed(run.readArtifact("attendee-profiles.json"));
      if (Array.isArray(pins)) {
        const kept = pins.filter((pin) => {
          const matches =
            pin !== null &&
            typeof pin === "object" &&
            (pin as ProfileReference).profileId === profileId;
          if (matches) activeLinks += 1;
          return !matches;
        });
        if (kept.length !== pins.length) {
          if (kept.length === 0) run.deleteArtifact("attendee-profiles.json");
          else run.writeArtifact("attendee-profiles.json", `${JSON.stringify(kept, null, 2)}\n`);
        }
      }

      for (const name of this.runs.detail(summary.id)?.files ?? []) {
        if (!name.startsWith("person-profile-") || !name.endsWith(".json")) continue;
        const snapshot = parsed(run.readArtifact(name));
        if (
          snapshot !== null &&
          typeof snapshot === "object" &&
          !Array.isArray(snapshot) &&
          (snapshot as ProfileReference).profileId === profileId
        ) {
          run.deleteArtifact(name);
          personSnapshots += 1;
        }
      }
    }
    return {
      aliases: 0,
      candidates: 0,
      mappings: 0,
      decisions: 0,
      activeLinks,
      personSnapshots,
    };
  }
}
