import { identifier } from "./resolver.js";
import type { PersonProfileStore } from "./store.js";
import {
  PERSON_PROFILE_CALENDAR_SOURCE,
  PERSON_PROFILE_MEETING_PROJECTION_VERSION,
  PERSON_PROFILE_PUBLIC_SAFE_PROJECTION_VERSION,
  type PersonProfile,
  type PersonProfileCalendarAttendeeInput,
  type PersonProfileCalendarAttendeeResult,
  type PersonProfileCreateInput,
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
      | "missing-identity-input"
      | "invalid-identity-input"
      | "duplicate-profile"
      | "conflicting-identity",
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
    if (!profile) return null;
    const base = {
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

  /** Keeps the canonical id stable while letting a name-only second Profile exist. */
  private uniqueId(base: string): string {
    let id = base;
    for (let n = 2; this.store.get(id); n += 1) id = `${base}-${n}`;
    return id;
  }

  /**
   * Calendar attendee identity (issue #124, spec #117 creation and matching
   * policy): the exact Calendar email is an authoritative anchor, so a
   * non-conflicting exact match reuses the existing Profile and an unknown
   * attendee receives one idempotent minimal email-anchored shell with source
   * provenance. Calendar never supplies inferred employer, title, biography,
   * or public-search claims, so nothing else is recorded. Conflicting stable
   * identifiers fail visibly — they are never merged or overwritten here.
   */
  ensureCalendarAttendeeProfile(
    input: PersonProfileCalendarAttendeeInput,
  ): PersonProfileCalendarAttendeeResult {
    const email = trimmed(input.email)?.toLowerCase() ?? null;
    if (!email)
      throw new PersonProfileValidationError(
        "missing-identity-input",
        "A Calendar attendee shell needs the attendee's email address.",
      );
    if (!EMAIL_PATTERN.test(email))
      throw new PersonProfileValidationError(
        "invalid-identity-input",
        `Not an email address: ${email}`,
      );

    /* An exact email is a stable identifier: every Profile holding it is a
       reuse candidate, and more than one holder is a visible conflict, never
       an automatic merge. */
    const holders = this.store
      .list()
      .filter((profile) => profile.emails.some((value) => value.trim().toLowerCase() === email));
    if (holders.length > 1)
      throw new PersonProfileValidationError(
        "conflicting-identity",
        `Two or more Person Profiles already hold the Calendar attendee email ${email}; resolve the duplicate explicitly instead of merging automatically.`,
      );
    if (holders.length === 1) {
      const holder = holders[0]!;
      if (holder.archivedAt !== null)
        throw new PersonProfileValidationError(
          "conflicting-identity",
          `An archived Person Profile holds the Calendar attendee email ${email}; restore or resolve it explicitly before Calendar reuses it.`,
        );
      return { profile: holder, created: false };
    }

    /* The canonical id derives from the email, which keeps the shell stable
       across event revisions and sibling occurrences. If that id already
       belongs to a Profile without this email, the stable identifiers
       conflict — fail visibly rather than overwrite. */
    const id = identifier({
      emails: [email],
      fullNames: [],
      handles: {},
      profileUrls: [],
      employerHints: [],
    });
    const squatter = this.store.get(id);
    if (squatter)
      throw new PersonProfileValidationError(
        "conflicting-identity",
        `The canonical id derived from the Calendar attendee email ${email} already belongs to Person Profile ${squatter.id}; resolve the conflict explicitly instead of overwriting it.`,
      );

    const observedAt = this.now().toISOString();
    const shell: PersonProfile = {
      id,
      revision: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
      fullName: null,
      primaryEmail: email,
      emails: [email],
      handles: {},
      profileUrls: [],
      employerHints: [],
      role: null,
      background: null,
      currentEmployer: null,
      socialProfiles: [],
      websites: [],
      feeds: [],
      publications: [],
      mentions: [],
      evidence: [],
      sourceDiagnostics: [
        {
          source: PERSON_PROFILE_CALENDAR_SOURCE,
          status: "completed",
          detail: input.provenance
            ? `Calendar attendee shell — ${input.provenance}`
            : "Calendar attendee shell",
        },
      ],
      archivedAt: null,
    };
    this.store.save(shell);
    return { profile: shell, created: true };
  }
}
