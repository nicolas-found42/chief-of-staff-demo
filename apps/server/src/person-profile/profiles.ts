import { identifier } from "./resolver.js";
import type { PersonProfileStore } from "./store.js";
import {
  PERSON_PROFILE_MEETING_PROJECTION_VERSION,
  PERSON_PROFILE_PUBLIC_SAFE_PROJECTION_VERSION,
  type PersonProfile,
  type PersonProfileCorrectionInput,
  type PersonProfileCreateInput,
  type PersonProfileDetachInput,
  type PersonProfileInvalidation,
  type PersonProfileMergeInput,
  type PersonProfileProjection,
  type PersonProjectedEvidence,
} from "@chief-of-staff-demo/shared";

/**
 * The Person Profiles deep interface (spec #117, Deep interfaces item 1): the
 * Workspace-owned operations over the canonical store — search, explicit
 * creation, current/exact-revision retrieval, and purpose-specific
 * projections. Matching indexes, revision writes, and deletion invalidation
 * stay behind it; merge/split/correction/archive and the Review queue are
 * later slices that extend this class.
 */
export interface PersonProfileSearchOptions {
  /** Case-insensitive text over name, contact, employer, and site identity. */
  query?: string;
  /** Archived Profiles are lifecycle state, not gone; searching them is explicit. */
  includeArchived?: boolean;
}

export class PersonProfileValidationError extends Error {
  constructor(
    public readonly code:
      | "self-merge"
      | "missing-identity-input"
      | "invalid-identity-input"
      | "duplicate-profile"
      | "profile-not-found"
      | "nothing-to-correct"
      | "profile-merged"
      | "merge-conflict"
      | "evidence-not-found",
    message: string,
  ) {
    super(message);
    this.name = "PersonProfileValidationError";
  }
}

export interface PersonProfileProjectionOptions {
  /** Pin the projection to an exact historical revision; omit for the current one. */
  revision?: number;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function projected(item: PersonProfile["evidence"][number]): PersonProjectedEvidence {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    url: item.url,
    ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
    matchConfidence: item.matchConfidence,
    observedAt: item.observedAt,
  };
}

function searchHaystack(profile: PersonProfile): string {
  return [
    profile.fullName ?? "",
    ...profile.emails,
    ...Object.values(profile.handles).flat(),
    ...profile.profileUrls,
    profile.role ?? "",
    profile.currentEmployer ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

export class WorkspacePersonProfiles {
  private readonly store: PersonProfileStore;
  private readonly now: () => Date;

  constructor(deps: { store: PersonProfileStore; now?: () => Date }) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  search(options: PersonProfileSearchOptions = {}): PersonProfile[] {
    const needle = options.query?.trim().toLowerCase() ?? "";
    return this.store
      .list()
      .filter((profile) => options.includeArchived || profile.archivedAt === null)
      .filter((profile) => !needle || searchHaystack(profile).includes(needle))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  create(input: PersonProfileCreateInput): PersonProfile {
    const fullName = trimmed(input.fullName);
    const primaryEmail = trimmed(input.primaryEmail)?.toLowerCase() ?? null;
    if (!fullName && !primaryEmail)
      throw new PersonProfileValidationError(
        "missing-identity-input",
        "A Person Profile needs at least a full name or an email address.",
      );
    if (primaryEmail && !EMAIL_PATTERN.test(primaryEmail))
      throw new PersonProfileValidationError(
        "invalid-identity-input",
        `Not an email address: ${primaryEmail}`,
      );
    /* An exact email is a stable identifier, so it refuses creation as a
       duplicate; a name alone is review material (spec #117), so a same-named
       Profile is not a collision and gets its own disambiguated id below. */
    if (primaryEmail) {
      const byEmail = this.store.findBySignals({
        emails: [primaryEmail],
        fullNames: [],
        handles: {},
        profileUrls: [],
        employerHints: [],
      });
      if (byEmail && byEmail.emails.includes(primaryEmail))
        throw new PersonProfileValidationError(
          "duplicate-profile",
          "A Person Profile with this identity already exists.",
        );
    }

    const observedAt = this.now().toISOString();
    const candidate: PersonProfile = {
      id: this.uniqueId(
        identifier({
          emails: primaryEmail ? [primaryEmail] : [],
          fullNames: fullName ? [fullName] : [],
          handles: {},
          profileUrls: [],
          employerHints: [],
        }),
      ),
      revision: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
      fullName,
      primaryEmail,
      emails: primaryEmail ? [primaryEmail] : [],
      handles: {},
      profileUrls: [],
      employerHints: [],
      role: trimmed(input.role),
      background: trimmed(input.background),
      currentEmployer: trimmed(input.currentEmployer),
      socialProfiles: [],
      websites: [],
      feeds: [],
      publications: [],
      mentions: [],
      evidence: [],
      sourceDiagnostics: [],
      archivedAt: null,
    };
    this.store.save(candidate);
    return candidate;
  }

  /**
   * Identity repair (ticket #121): an ordinary factual correction appends a
   * new revision. The superseded snapshot stays exactly readable, and the
   * correction files an invalidation so consumers of the old revision refresh.
   */
  correct(profileId: string, input: PersonProfileCorrectionInput): PersonProfile {
    const current = this.repairable(profileId);
    const next: PersonProfile = { ...current };

    let stated = 0;
    for (const [field, value] of [
      ["fullName", trimmed(input.fullName)],
      ["role", trimmed(input.role)],
      ["currentEmployer", trimmed(input.currentEmployer)],
      ["background", trimmed(input.background)],
    ] as const) {
      if (value === null) continue;
      stated += 1;
      next[field] = value;
    }

    const primaryEmail = trimmed(input.primaryEmail)?.toLowerCase() ?? null;
    if (primaryEmail !== null) {
      stated += 1;
      if (!EMAIL_PATTERN.test(primaryEmail))
        throw new PersonProfileValidationError(
          "invalid-identity-input",
          `Not an email address: ${primaryEmail}`,
        );
      if (primaryEmail !== current.primaryEmail)
        this.ensureEmailAvailable(primaryEmail, [current.id]);
      next.primaryEmail = primaryEmail;
      /* The previous address stays an identity signal of this person; only the
         primary designation moves. Signal history is never silently erased. */
      if (!next.emails.includes(primaryEmail)) next.emails = [...next.emails, primaryEmail];
    }

    if (stated === 0)
      throw new PersonProfileValidationError(
        "nothing-to-correct",
        "A correction states at least one fact to change.",
      );

    return this.appendRevision(next, {
      kind: "correction",
      affectedRevision: current.revision,
      detail:
        input.note?.trim() ||
        `Revision ${current.revision} facts were corrected; treat that revision as superseded.`,
    });
  }

  /** The current record of a Profile that still owns its identity. */
  private repairable(profileId: string): PersonProfile {
    const profile = this.store.get(profileId);
    if (!profile)
      throw new PersonProfileValidationError(
        "profile-not-found",
        "No Person Profile with that id.",
      );
    if (profile.mergedInto)
      throw new PersonProfileValidationError(
        "profile-merged",
        `This Profile was merged into ${profile.mergedInto}; follow that id instead.`,
      );
    return profile;
  }

  /** Persists the next revision of `next` and files one invalidation record. */
  private appendRevision(
    next: PersonProfile,
    record: Omit<PersonProfileInvalidation, "id" | "occurredAt">,
  ): PersonProfile {
    const occurredAt = this.now().toISOString();
    const invalidations = next.invalidations ?? [];
    const repaired: PersonProfile = {
      ...next,
      revision: next.revision + 1,
      updatedAt: occurredAt,
      invalidations: [
        ...invalidations,
        { id: `inv_${invalidations.length + 1}`, ...record, occurredAt },
      ],
    };
    this.store.save(repaired);
    return repaired;
  }

  /** Refuses a primary email another Profile already holds; `selfIds` are exempt. */
  private ensureEmailAvailable(primaryEmail: string, selfIds: string[]): void {
    const holder = this.store.findBySignals({
      emails: [primaryEmail],
      fullNames: [],
      handles: {},
      profileUrls: [],
      employerHints: [],
    });
    if (holder && !selfIds.includes(holder.id) && holder.emails.includes(primaryEmail))
      throw new PersonProfileValidationError(
        "duplicate-profile",
        "Another Person Profile already holds this email address.",
      );
  }

  /**
   * Identity repair (ticket #121): merge a duplicate Profile away into the
   * surviving one through an audited decision. Evidence keeps its original
   * provenance, identity signals union, conflicting facts must be resolved
   * explicitly, and the merged-away Profile stays readable as an audit record
   * that redirects consumers to the survivor.
   */
  merge(survivorId: string, input: PersonProfileMergeInput): PersonProfile {
    const survivor = this.repairable(survivorId);
    if (input.duplicateId === survivorId)
      throw new PersonProfileValidationError(
        "self-merge",
        "A Profile cannot be merged into itself.",
      );
    const duplicate = this.store.get(input.duplicateId);
    if (!duplicate)
      throw new PersonProfileValidationError(
        "profile-not-found",
        "No Person Profile with that id.",
      );
    if (duplicate.mergedInto)
      throw new PersonProfileValidationError(
        "profile-merged",
        `That Profile was already merged into ${duplicate.mergedInto}.`,
      );

    const resolutions = input.resolutions ?? {};
    const FACTS = ["fullName", "role", "currentEmployer", "background"] as const;
    const conflicts = [
      ...FACTS.filter(
        (field) =>
          survivor[field] !== null &&
          duplicate[field] !== null &&
          survivor[field] !== duplicate[field],
      ),
      ...(survivor.primaryEmail &&
      duplicate.primaryEmail &&
      survivor.primaryEmail !== duplicate.primaryEmail
        ? (["primaryEmail"] as const)
        : []),
    ];
    const unresolved = conflicts.filter((field) => resolutions[field] === undefined);
    if (unresolved.length > 0)
      throw new PersonProfileValidationError(
        "merge-conflict",
        `Both Profiles state different ${unresolved.join(", ")}; resolve them explicitly.`,
      );
    const resolved = (field: (typeof FACTS)[number]): string | null => {
      const choice = trimmed(resolutions[field]);
      if (choice !== null) return choice;
      return survivor[field] ?? duplicate[field];
    };
    const primaryEmail = (trimmed(resolutions.primaryEmail)?.toLowerCase() ??
      survivor.primaryEmail ??
      duplicate.primaryEmail);
    if (primaryEmail !== null && !EMAIL_PATTERN.test(primaryEmail))
      throw new PersonProfileValidationError(
        "invalid-identity-input",
        `Not an email address: ${primaryEmail}`,
      );
    if (primaryEmail !== null) this.ensureEmailAvailable(primaryEmail, [survivor.id, duplicate.id]);

    const union = (left: string[], right: string[]): string[] => [...new Set([...left, ...right])];
    const unionBy = <T>(left: T[], right: T[], key: (item: T) => string): T[] => {
      const seen = new Set<string>();
      const result: T[] = [];
      for (const item of [...left, ...right]) {
        const identity = key(item);
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push(item);
      }
      return result;
    };

    const next: PersonProfile = {
      ...survivor,
      fullName: resolved("fullName"),
      role: resolved("role"),
      currentEmployer: resolved("currentEmployer"),
      background: resolved("background"),
      primaryEmail,
      emails: union(union(survivor.emails, duplicate.emails), primaryEmail ? [primaryEmail] : []),
      handles: Object.fromEntries(
        [...new Set([...Object.keys(survivor.handles), ...Object.keys(duplicate.handles)])].map(
          (platform) => [
            platform,
            union(survivor.handles[platform] ?? [], duplicate.handles[platform] ?? []),
          ],
        ),
      ),
      profileUrls: union(survivor.profileUrls, duplicate.profileUrls),
      employerHints: union(survivor.employerHints, duplicate.employerHints),
      socialProfiles: unionBy(survivor.socialProfiles, duplicate.socialProfiles, (s) => s.url),
      websites: union(survivor.websites, duplicate.websites),
      feeds: unionBy(survivor.feeds, duplicate.feeds, (feed) => feed.url),
      publications: unionBy(survivor.publications, duplicate.publications, (item) => item.id),
      mentions: unionBy(survivor.mentions, duplicate.mentions, (item) => item.id),
      evidence: unionBy(survivor.evidence, duplicate.evidence, (item) => item.id),
    };

    const merged = this.appendRevision(next, {
      kind: "merge",
      affectedRevision: survivor.revision,
      mergedFrom: duplicate.id,
      detail:
        input.note?.trim() ||
        `Merged ${duplicate.id} into this Profile; its evidence and signals carry their original provenance.`,
    });
    this.appendRevision(
      { ...duplicate, mergedInto: survivor.id },
      {
        kind: "merge",
        affectedRevision: duplicate.revision,
        mergedInto: survivor.id,
        detail:
          input.note?.trim() ||
          `Merged into ${survivor.id}; this Profile remains readable as an audit record.`,
      },
    );
    return merged;
  }

  /**
   * Identity repair (ticket #121): detach one evidence record from the
   * Profile it was attributed to, optionally splitting it onto the correct
   * Profile. The old attribution stays readable in past revisions but is
   * filed as invalid, so it is never presented as current fact.
   */
  detachEvidence(
    profileId: string,
    input: PersonProfileDetachInput,
  ): { from: PersonProfile; to: PersonProfile | null } {
    const source = this.repairable(profileId);
    /* A bad target must refuse the whole decision durably, so the target is
       resolved before anything is written. */
    const target = input.toProfileId === undefined ? null : this.repairable(input.toProfileId);
    if (target && target.id === source.id)
      throw new PersonProfileValidationError(
        "invalid-identity-input",
        "Evidence cannot be detached to the Profile it is already attributed to.",
      );

    const LOCATIONS = ["publications", "mentions", "evidence"] as const;
    const location = LOCATIONS.find((key) =>
      source[key].some((item) => item.id === input.evidenceId),
    );
    if (!location)
      throw new PersonProfileValidationError(
        "evidence-not-found",
        "No such evidence record on that Profile.",
      );
    const evidence = source[location].find((item) => item.id === input.evidenceId)!;

    const from = this.appendRevision(
      { ...source, [location]: source[location].filter((item) => item.id !== input.evidenceId) },
      {
        kind: "evidence-detached",
        affectedRevision: source.revision,
        evidenceId: input.evidenceId,
        ...(input.toProfileId === undefined ? {} : { movedTo: input.toProfileId }),
        detail:
          input.note?.trim() ||
          `Evidence ${input.evidenceId} is no longer attributed to this Profile.`,
      },
    );

    let to: PersonProfile | null = null;
    if (target !== null) {
      to = this.appendRevision(
        { ...target, [location]: [...target[location], evidence] },
        {
          kind: "evidence-detached",
          affectedRevision: target.revision,
          evidenceId: input.evidenceId,
          movedFrom: source.id,
          detail:
            input.note?.trim() ||
            `Evidence ${input.evidenceId} was re-attributed from ${source.id}.`,
        },
      );
    }
    return { from, to };
  }

  get(profileId: string): PersonProfile | null {
    return this.store.get(profileId);
  }

  getRevision(profileId: string, revision: number): PersonProfile | null {
    return this.store.getRevision(profileId, revision);
  }

  revisions(profileId: string): PersonProfile[] {
    return this.store.listRevisions(profileId);
  }

  project(
    purpose: "public-safe" | "meeting",
    profileId: string,
    options?: PersonProfileProjectionOptions,
  ): PersonProfileProjection | null {
    const profile =
      options?.revision === undefined
        ? this.store.get(profileId)
        : this.store.getRevision(profileId, options.revision);
    const currentRecord = this.store.get(profileId);
    /* A merged-away Profile has no current identity of its own; consumers
       follow mergedInto. Its exact revisions stay projected as history. */
    if (currentRecord?.mergedInto !== undefined && options?.revision === undefined) return null;
    if (!profile) return null;
    /* Immutable history discloses its own invalidation: a projection of an
       older revision carries every repair record filed against it. */
    const affecting = (currentRecord?.invalidations ?? []).filter(
      (record) => record.affectedRevision === profile.revision,
    );
    const base = {
      ...(affecting.length === 0 ? {} : { invalidations: affecting }),
      profileId: profile.id,
      profileRevision: profile.revision,
      fullName: profile.fullName,
      role: profile.role,
      background: profile.background,
      currentEmployer: profile.currentEmployer,
      socialProfiles: profile.socialProfiles,
      websites: profile.websites,
      feeds: profile.feeds,
    };
    if (purpose === "public-safe")
      return {
        purpose,
        projectionVersion: PERSON_PROFILE_PUBLIC_SAFE_PROJECTION_VERSION,
        ...base,
        // Publications only: mention and CRM/contact evidence are outside the
        // public-safe authority, along with every email and diagnostic.
        publications: profile.publications.map(projected),
      };
    return {
      purpose,
      projectionVersion: PERSON_PROFILE_MEETING_PROJECTION_VERSION,
      ...base,
      primaryEmail: profile.primaryEmail,
      emails: profile.emails,
      publications: profile.publications.map(projected),
      mentions: profile.mentions.map(projected),
      evidence: profile.evidence.map(projected),
    };
  }

  /** The append-only invalidation log of a Profile; consumers poll it to refresh. */
  invalidations(profileId: string): PersonProfileInvalidation[] {
    return this.store.get(profileId)?.invalidations ?? [];
  }
  /** Keeps the canonical id stable while letting a name-only second Profile exist. */
  private uniqueId(base: string): string {
    let id = base;
    for (let n = 2; this.store.get(id); n += 1) id = `${base}-${n}`;
    return id;
  }
}
