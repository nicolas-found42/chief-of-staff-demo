import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PersonIdentitySignals, PersonProfile } from "@chief-of-staff-demo/shared";

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedHandle(value: string): string {
  return normalized(value).replace(/^@/, "");
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function intersects(left: string[], right: string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

export class PersonProfileStore {
  private readonly profilesDir: string;

  constructor(workspaceDir: string) {
    this.profilesDir = join(workspaceDir, "person-profiles");
  }

  get(id: string): PersonProfile | null {
    return this.read(join(this.profilesDir, id, "current.json"));
  }

  getRevision(id: string, revision: number): PersonProfile | null {
    const persisted = this.read(join(this.profilesDir, id, "revisions", `${revision}.json`));
    if (persisted) return persisted;
    /* Profiles written before revisioned persistence kept only current.json:
       its revision is still exactly retrievable. */
    const current = this.read(join(this.profilesDir, id, "current.json"));
    return current && current.revision === revision ? current : null;
  }

  list(): PersonProfile[] {
    if (!existsSync(this.profilesDir)) return [];
    return readdirSync(this.profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.get(entry.name))
      .filter((profile): profile is PersonProfile => profile !== null);
  }

  /** Every persisted revision of one Profile, oldest first. Empty when unknown. */
  listRevisions(id: string): PersonProfile[] {
    const revisionsDir = join(this.profilesDir, id, "revisions");
    if (!existsSync(revisionsDir)) {
      const current = this.read(join(this.profilesDir, id, "current.json"));
      return current ? [current] : [];
    }
    return readdirSync(revisionsDir)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number.parseInt(name, 10))
      .sort((left, right) => left - right)
      .map((revision) => this.read(join(revisionsDir, `${revision}.json`)))
      .filter((profile): profile is PersonProfile => profile !== null);
  }

  findBySignals(signals: PersonIdentitySignals): PersonProfile | null {
    const emails = signals.emails.map(normalized).filter(Boolean);
    const urls = signals.profileUrls.map(normalizedUrl).filter((value): value is string => !!value);
    const handles = new Map(
      Object.entries(signals.handles).map(([platform, values]) => [
        normalized(platform),
        values.map(normalizedHandle).filter(Boolean),
      ]),
    );
    return (
      this.list().find((profile) => {
        if (intersects(profile.emails.map(normalized), emails)) return true;
        if (
          intersects(
            profile.profileUrls
              .map(normalizedUrl)
              .filter((value): value is string => value !== null),
            urls,
          )
        )
          return true;
        for (const [platform, values] of handles) {
          const stored = profile.handles[platform]?.map(normalizedHandle) ?? [];
          if (intersects(stored, values)) return true;
        }
        return false;
      }) ?? null
    );
  }

  save(profile: PersonProfile): void {
    const root = join(this.profilesDir, profile.id);
    const revisions = join(root, "revisions");
    mkdirSync(revisions, { recursive: true });
    const content = `${JSON.stringify(profile, null, 2)}\n`;
    this.writeAtomic(join(revisions, `${profile.revision}.json`), content);
    this.writeAtomic(join(root, "current.json"), content);
  }

  private read(path: string): PersonProfile | null {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as PersonProfile;
    } catch {
      return null;
    }
  }

  private writeAtomic(path: string, content: string): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  }
}
