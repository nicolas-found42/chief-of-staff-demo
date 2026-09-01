import type {
  PersonProfile,
  RememberedMapping,
  TranscriptCandidateConflict,
  TranscriptCandidatePolicyClass,
  TranscriptCandidateSignal,
  TranscriptMention,
} from "@chief-of-staff-demo/shared";
import {
  normalizeExternalContactIds,
  normalizeHandles,
  normalizeName,
  normalizeProfileUrl,
  unique,
} from "./identity-extraction.js";

const WEIGHT_EXACT_EMAIL = 5;
const WEIGHT_EXACT_PROFILE_URL = 5;
const WEIGHT_VERIFIED_HANDLE = 5;
const WEIGHT_EXTERNAL_CONTACT_ID = 5;
const WEIGHT_SPEAKER_CALENDAR_EMAIL = 5;
const WEIGHT_REMEMBERED_MAPPING = 5;
const WEIGHT_FULL_NAME = 2;
const WEIGHT_SPEAKER_LABEL = 1;
const WEIGHT_EMPLOYER_HINT = 1;
const PROBABLE_MIN_SCORE = WEIGHT_FULL_NAME;
const PROBABLE_MIN_LEAD = 2;

function profileNameForms(profile: PersonProfile): string[] {
  return unique(
    [profile.fullName].filter((value): value is string => value !== null).map(normalizeName),
  );
}

interface StableIdentifier {
  kind: "email" | "profile-url" | "handle" | "external-contact-id";
  key: string;
  display: string;
}

function uniqueStableIdentifiers(items: StableIdentifier[]): StableIdentifier[] {
  return [...new Map(items.map((item) => [item.key, item])).values()];
}

function mentionStableIdentifiers(mention: TranscriptMention): StableIdentifier[] {
  return uniqueStableIdentifiers([
    ...mention.emails.map((email) => ({
      kind: "email" as const,
      key: `email:${email.normalize("NFKC").toLowerCase()}`,
      display: email,
    })),
    ...(mention.speakerCalendarEmail === null
      ? []
      : [
          {
            kind: "email" as const,
            key: `email:${mention.speakerCalendarEmail.normalize("NFKC").toLowerCase()}`,
            display: mention.speakerCalendarEmail,
          },
        ]),
    ...mention.profileUrls.flatMap((value) => {
      const url = normalizeProfileUrl(value);
      return url === null
        ? []
        : [{ kind: "profile-url" as const, key: `profile-url:${url}`, display: url }];
    }),
    ...Object.entries(normalizeHandles(mention.verifiedHandles)).flatMap(([platform, handles]) =>
      handles.map((handle) => ({
        kind: "handle" as const,
        key: `handle:${platform}:${handle}`,
        display: `${platform}:${handle}`,
      })),
    ),
    ...normalizeExternalContactIds(mention.externalContactIds).map((item) => ({
      kind: "external-contact-id" as const,
      key: `external-contact-id:${item.system}:${item.externalId}`,
      display: `${item.system}:${item.externalId}`,
    })),
  ]);
}

function profileStableIdentifiers(profile: PersonProfile): StableIdentifier[] {
  return uniqueStableIdentifiers([
    ...unique([
      ...profile.emails,
      ...(profile.primaryEmail === null ? [] : [profile.primaryEmail]),
    ]).map((email) => ({
      kind: "email" as const,
      key: `email:${email.normalize("NFKC").toLowerCase()}`,
      display: email.normalize("NFC").toLowerCase(),
    })),
    ...profile.profileUrls.flatMap((value) => {
      const url = normalizeProfileUrl(value);
      return url === null
        ? []
        : [{ kind: "profile-url" as const, key: `profile-url:${url}`, display: url }];
    }),
    ...Object.entries(normalizeHandles(profile.handles)).flatMap(([platform, handles]) =>
      handles.map((handle) => ({
        kind: "handle" as const,
        key: `handle:${platform}:${handle}`,
        display: `${platform}:${handle}`,
      })),
    ),
    ...normalizeExternalContactIds(profile.externalContactIds ?? []).map((item) => ({
      kind: "external-contact-id" as const,
      key: `external-contact-id:${item.system}:${item.externalId}`,
      display: `${item.system}:${item.externalId}`,
    })),
  ]);
}

export function activeMappingFor(
  mappings: RememberedMapping[],
  transcriptId: string,
  forms: string[],
): RememberedMapping | null {
  return (
    mappings.find(
      (mapping) =>
        mapping.revokedAt === null &&
        forms.includes(normalizeName(mapping.normalizedForm)) &&
        (mapping.scope === "workspace" || mapping.scopeId === transcriptId),
    ) ?? null
  );
}

export function candidateSignals(
  mention: TranscriptMention,
  profile: PersonProfile,
  mapping: RememberedMapping | null,
): TranscriptCandidateSignal[] {
  const profileForms = profileNameForms(profile);
  const mentionName = mention.normalizedForms[0] ?? "";
  const profileName = profile.fullName === null ? null : normalizeName(profile.fullName);
  const nameMatched =
    profileName !== null &&
    (mention.normalizedForms.includes(profileName) ||
      (mentionName.split(" ").length === 1 &&
        profileForms.some((form) => {
          const tokens = form.split(" ");
          return tokens[0] === mentionName || tokens[tokens.length - 1] === mentionName;
        })));
  const profileEmails = unique(
    [...profile.emails, ...(profile.primaryEmail === null ? [] : [profile.primaryEmail])].map(
      (email) => email.normalize("NFKC").toLowerCase(),
    ),
  );
  const emailMatched = profileEmails.some((email) =>
    mention.emails.map((value) => value.normalize("NFKC").toLowerCase()).includes(email),
  );
  const profileUrls = unique(
    profile.profileUrls.map(normalizeProfileUrl).filter((value): value is string => value !== null),
  );
  const profileUrlMatched = profileUrls.some((url) => mention.profileUrls.includes(url));
  const profileHandles = normalizeHandles(profile.handles);
  const verifiedHandleMatched = Object.entries(normalizeHandles(mention.verifiedHandles)).some(
    ([platform, handles]) =>
      handles.some((handle) => (profileHandles[platform] ?? []).includes(handle)),
  );
  const profileExternalIds = new Set(
    normalizeExternalContactIds(profile.externalContactIds ?? []).map(
      (item) => `${item.system}:${item.externalId}`,
    ),
  );
  const externalContactMatched = normalizeExternalContactIds(mention.externalContactIds).some(
    (item) => profileExternalIds.has(`${item.system}:${item.externalId}`),
  );
  const speakerCalendarEmailMatched =
    mention.speakerCalendarEmail !== null &&
    profileEmails.includes(mention.speakerCalendarEmail.normalize("NFKC").toLowerCase());
  const employers = unique(
    [profile.currentEmployer, ...profile.employerHints].filter(
      (value): value is string => value !== null,
    ),
  );
  const employerMatched =
    mention.organizationContext !== null &&
    employers.some((value) => normalizeName(value).includes(mention.organizationContext!));
  return [
    {
      signal: "exact-email",
      explanation:
        mention.emails.length === 0
          ? "The mention carries no email address."
          : emailMatched
            ? `The mention's email ${mention.emails[0]} exactly matches this Profile's email.`
            : `The mention's email ${mention.emails[0]} does not match this Profile's emails.`,
      matched: emailMatched,
      weight: WEIGHT_EXACT_EMAIL,
    },
    {
      signal: "exact-profile-url",
      explanation:
        mention.profileUrls.length === 0
          ? "The mention carries no canonical Profile URL."
          : profileUrlMatched
            ? `The canonical Profile URL ${mention.profileUrls[0]} exactly matches this Profile.`
            : `The canonical Profile URL ${mention.profileUrls[0]} does not match this Profile.`,
      matched: profileUrlMatched,
      weight: WEIGHT_EXACT_PROFILE_URL,
    },
    {
      signal: "verified-handle",
      explanation:
        Object.keys(mention.verifiedHandles).length === 0
          ? "The mention carries no source-verified handle."
          : verifiedHandleMatched
            ? "A source-verified handle exactly matches this Profile."
            : "The source-verified handles do not match this Profile.",
      matched: verifiedHandleMatched,
      weight: WEIGHT_VERIFIED_HANDLE,
    },
    {
      signal: "external-contact-id",
      explanation:
        mention.externalContactIds.length === 0
          ? "The mention carries no external contact identifier."
          : externalContactMatched
            ? "A provider-owned external contact identifier exactly matches this Profile."
            : "The external contact identifiers do not match this Profile.",
      matched: externalContactMatched,
      weight: WEIGHT_EXTERNAL_CONTACT_ID,
    },
    {
      signal: "speaker-calendar-email",
      explanation:
        mention.speakerCalendarEmail === null
          ? "The source speaker has no verified Calendar email mapping."
          : speakerCalendarEmailMatched
            ? `The source speaker maps to Calendar email ${mention.speakerCalendarEmail}, which exactly matches this Profile.`
            : `The source speaker's Calendar email ${mention.speakerCalendarEmail} does not match this Profile.`,
      matched: speakerCalendarEmailMatched,
      weight: WEIGHT_SPEAKER_CALENDAR_EMAIL,
    },
    {
      signal: "remembered-mapping",
      explanation:
        mapping === null
          ? "No remembered mapping applies to this mention inside its scope."
          : mapping.profileId === profile.id
            ? `Remembered mapping v${mapping.mappingVersion} ties this name to the Profile inside its ${mapping.scope} scope.`
            : "A remembered mapping applies to this name, but it points at a different Profile.",
      matched: mapping !== null && mapping.profileId === profile.id,
      weight: WEIGHT_REMEMBERED_MAPPING,
    },
    {
      signal: "normalized-full-name",
      explanation:
        profileName === null
          ? "The Profile has no full name to compare."
          : nameMatched
            ? `The normalized mention name "${mentionName}" matches the Profile name "${profileName}".`
            : `The normalized mention name "${mentionName}" does not match the Profile name.`,
      matched: nameMatched,
      weight: WEIGHT_FULL_NAME,
    },
    {
      signal: "speaker-label",
      explanation:
        mention.attendeeStatus !== "speaker"
          ? "The mention is not a source speaker label."
          : nameMatched
            ? "The mention is a source speaker label and the Profile carries the same name."
            : "The mention is a source speaker label, but the Profile carries a different name.",
      matched: mention.attendeeStatus === "speaker" && nameMatched,
      weight: WEIGHT_SPEAKER_LABEL,
    },
    {
      signal: "employer-hint",
      explanation:
        mention.organizationContext === null
          ? "The mention names no organization context."
          : employerMatched
            ? `The organization context "${mention.organizationContext}" matches this Profile's employer evidence.`
            : `The organization context "${mention.organizationContext}" does not match this Profile's employer evidence.`,
      matched: employerMatched,
      weight: WEIGHT_EMPLOYER_HINT,
    },
  ];
}

export function conflictsFor(
  mention: TranscriptMention,
  profile: PersonProfile,
  allProfiles: PersonProfile[],
): TranscriptCandidateConflict[] {
  const conflicts: TranscriptCandidateConflict[] = [];
  if (profile.archivedAt !== null) {
    conflicts.push({
      kind: "archived-profile",
      explanation: "The Profile is archived; archived Profiles are never auto-linked.",
      hard: true,
    });
  }
  const profileStableKeys = new Set(profileStableIdentifiers(profile).map((item) => item.key));
  for (const identifier of mentionStableIdentifiers(mention)) {
    const owners = allProfiles.filter((candidate) =>
      profileStableIdentifiers(candidate).some((item) => item.key === identifier.key),
    );
    if (profileStableKeys.has(identifier.key) && owners.length > 1) {
      conflicts.push({
        kind: "duplicate-stable-id",
        explanation: `The exact ${identifier.kind} ${identifier.display} is owned by ${owners.length} Profiles.`,
        hard: true,
      });
    } else if (!profileStableKeys.has(identifier.key) && owners.length > 0) {
      conflicts.push({
        kind:
          identifier.kind === "email" ? "email-belongs-elsewhere" : "stable-id-belongs-elsewhere",
        explanation: `The exact ${identifier.kind} ${identifier.display} belongs to Profile ${owners[0]?.id}, not this one.`,
        hard: true,
      });
    }
  }
  if (mention.emails.length > 0) {
    const profileEmails = new Set(
      [...profile.emails, ...(profile.primaryEmail === null ? [] : [profile.primaryEmail])].map(
        (email) => email.normalize("NFKC").toLowerCase(),
      ),
    );
    const intersects = mention.emails.some((email) =>
      profileEmails.has(email.normalize("NFKC").toLowerCase()),
    );
    const identifierHasOwner = mentionStableIdentifiers(mention).some(
      (identifier) =>
        identifier.kind === "email" &&
        allProfiles.some((candidate) =>
          profileStableIdentifiers(candidate).some((item) => item.key === identifier.key),
        ),
    );
    if (!intersects && !identifierHasOwner && profile.primaryEmail !== null) {
      conflicts.push({
        kind: "name-email-mismatch",
        explanation: `The mention carries email ${mention.emails[0]} but this Profile's primary email is ${profile.primaryEmail}.`,
        hard: false,
      });
    }
  }
  return conflicts;
}

export function policyClassOf(
  mention: TranscriptMention,
  signals: TranscriptCandidateSignal[],
  conflicts: TranscriptCandidateConflict[],
  leadOverNext: number | null,
  isTop: boolean,
): TranscriptCandidatePolicyClass {
  const hasHardConflict = conflicts.some((conflict) => conflict.hard);
  const stableIdentifierMatched = signals.some(
    (signal) =>
      [
        "exact-email",
        "exact-profile-url",
        "verified-handle",
        "external-contact-id",
        "speaker-calendar-email",
      ].includes(signal.signal) && signal.matched,
  );
  if (!hasHardConflict && stableIdentifierMatched) return "confirmed";
  if (mention.kind === "ambiguous-name" || hasHardConflict) return "ambiguous";
  const score = signals
    .filter((signal) => signal.matched)
    .reduce((sum, signal) => sum + signal.weight, 0);
  const decisive = leadOverNext === null || leadOverNext >= PROBABLE_MIN_LEAD;
  if (isTop && score >= PROBABLE_MIN_SCORE && decisive) return "probable";
  return "ambiguous";
}
