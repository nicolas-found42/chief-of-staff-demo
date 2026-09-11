/* oxlint-disable typescript/no-unnecessary-condition -- freshness classifies optional provenance that legacy artifacts and fixtures omit entirely */
import type {
  MeetingBrief,
  MeetingBriefContextFreshness,
  MeetingBriefEnrichmentProvenance,
  MeetingBriefEnrichmentSection,
  MeetingBriefFreshnessClass,
  MeetingBriefFreshnessItem,
  MeetingBriefFreshnessState,
  MeetingBriefFreshnessWindows,
} from "@chief-of-staff-demo/shared";
import {
  MEETING_BRIEF_CONTEXT_FRESHNESS_VERSION,
  PERSON_PROFILE_SOURCE_ID,
  resolveMeetingBriefFreshnessWindows,
} from "@chief-of-staff-demo/shared";

/**
 * Context freshness (issue #362, MWR-050; ADR-0089).
 *
 * Every researched context item carries dated provenance; this module turns
 * that into a state under configurable windows and makes the non-current states
 * visible. Freshness is a check on how old the evidence is, never proof that it
 * is true: a contradiction defeats a current assertion even inside its window.
 *
 * A missing date is `unknown`, never current. Historical relationship evidence
 * keeps its event date and is never presented as current.
 */

/** Claim kinds producers use to build `claimId`; they decide the label a person reads. */
export type MeetingBriefClaimKind =
  "current-role" | "current-employer" | "news" | "relationship-history" | "other";

const CLAIM_LABELS: Record<MeetingBriefClaimKind, string> = {
  "current-role": "current role",
  "current-employer": "current employer",
  news: "news and conversation context",
  "relationship-history": "relationship history",
  other: "context",
};

/** Sources whose facts assert something about a person's current work. */
const CURRENT_ROLE_COMPANY_SOURCES: Record<string, true> = {
  [PERSON_PROFILE_SOURCE_ID]: true,
  "hubspot-contact": true,
  "hubspot-company": true,
  "employer-match": true,
  "employer-verification": true,
};

/** Sources that are news or conversation hooks: useful while they are recent. */
const NEWS_HOOK_SOURCES: Record<string, true> = {
  "company-news": true,
  "industry-news": true,
};

/**
 * Sources that evidence a relationship rather than a current fact. Their event
 * date is the date that matters and the item is never presented as current.
 */
const HISTORICAL_RELATIONSHIP_SOURCES: Record<string, true> = {
  "gmail-exact": true,
  "gmail-company-domain": true,
  "calendar-history": true,
  "drive-docs": true,
  "confirmed-transcripts": true,
  "transcript-catalog": true,
};

/**
 * A declared claim kind decides the class; the source is only the fallback for
 * legacy sections that carry no claim identity.
 */
export function freshnessClassFor(
  source: string,
  claimKind?: MeetingBriefClaimKind,
): MeetingBriefFreshnessClass {
  if (claimKind === "current-role" || claimKind === "current-employer") {
    return "current-role-company";
  }
  if (claimKind === "news") return "news-conversation-hook";
  if (claimKind === "relationship-history") return "historical-relationship";
  if (claimKind === "other") return "other";
  if (CURRENT_ROLE_COMPANY_SOURCES[source] === true) return "current-role-company";
  if (NEWS_HOOK_SOURCES[source] === true) return "news-conversation-hook";
  if (HISTORICAL_RELATIONSHIP_SOURCES[source] === true) return "historical-relationship";
  return "other";
}

/** Stable claim identity, e.g. `current-employer:alice@external.co`. */
export function claimIdFor(
  kind: MeetingBriefClaimKind,
  subject: string | null | undefined,
): string {
  return `${kind}:${(subject ?? "").toLowerCase()}`;
}

/**
 * Parse the kind back out of a `claimId`. `null` means the id does not declare
 * a known kind — a legacy or fixture section — and the source decides instead.
 */
function claimKindOf(claimId: string): MeetingBriefClaimKind | null {
  const kind = claimId.slice(0, claimId.indexOf(":"));
  if (
    kind === "current-role" ||
    kind === "current-employer" ||
    kind === "news" ||
    kind === "relationship-history" ||
    kind === "other"
  ) {
    return kind;
  }
  return null;
}

const HOUR_MS = 60 * 60 * 1000;

function parseDate(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The newest dated evidence entry, when the source states dates per item. */
function latestEvidenceDate(provenance: MeetingBriefEnrichmentProvenance): string | null {
  let newest: number | null = null;
  let newestValue: string | null = null;
  for (const value of provenance.evidenceDates ?? []) {
    const parsed = parseDate(value);
    if (parsed === null) continue;
    if (newest === null || parsed > newest) {
      newest = parsed;
      newestValue = value;
    }
  }
  return newestValue;
}

/**
 * The date a freshness window is measured against. A source that states when
 * its claim held (publication/as-of/event date) is measured on that date;
 * otherwise on when the app checked it. Neither known means unknown.
 */
function asOfFor(
  provenance: MeetingBriefEnrichmentProvenance,
  freshnessClass: MeetingBriefFreshnessClass,
): string | null {
  if (provenance.publishedAt) return provenance.publishedAt;
  if (freshnessClass === "historical-relationship") {
    // Relationship evidence keeps its event date; when the source states none,
    // the item stays undated. Reading it today does not date it.
    return latestEvidenceDate(provenance);
  }
  return provenance.retrievedAt;
}

function windowHoursFor(
  freshnessClass: MeetingBriefFreshnessClass,
  windows: MeetingBriefFreshnessWindows,
): number | null {
  if (freshnessClass === "current-role-company") return windows.currentRoleCompanyHours;
  if (freshnessClass === "news-conversation-hook") return windows.newsConversationHookHours;
  return null;
}

function stateFor(
  freshnessClass: MeetingBriefFreshnessClass,
  asOf: string | null,
  windowHours: number | null,
  nowMs: number,
): MeetingBriefFreshnessState {
  if (asOf === null) return "unknown";
  if (freshnessClass === "current-role-company" || freshnessClass === "news-conversation-hook") {
    const asOfMs = parseDate(asOf);
    if (asOfMs === null) return "unknown";
    return nowMs - asOfMs > (windowHours ?? 0) * HOUR_MS ? "expired" : "current";
  }
  // Historical relationship evidence keeps its event date; nothing else is
  // promoted to current just because it is recent.
  return "historical";
}

function qualificationFor(item: {
  claimKind: MeetingBriefClaimKind;
  state: MeetingBriefFreshnessState;
  asOf: string | null;
  windowHours: number | null;
  subject: string;
  conflictValues?: string[];
}): string | null {
  const claim = CLAIM_LABELS[item.claimKind];
  if (item.state === "current") return null;
  if (item.state === "conflicting") {
    const values = item.conflictValues?.filter(Boolean) ?? [];
    const disagreement = values.length > 1 ? ` (${values.join(" vs ")})` : "";
    return `${item.subject}: sources disagree about the ${claim}${disagreement}; no current value is asserted.`;
  }
  if (item.state === "expired") {
    const age =
      item.windowHours === null ? "" : `, older than the ${item.windowHours}h freshness window`;
    return `${item.subject}: the ${claim} evidence is dated ${item.asOf}${age}; verify it before treating it as current.`;
  }
  if (item.state === "unknown") {
    return `${item.subject}: the ${claim} evidence has no known date, so its freshness is unknown; verify it before treating it as current.`;
  }
  return `${item.subject}: the ${claim} evidence is historical (dated ${item.asOf}); it is not a current fact.`;
}

/**
 * Classify every researched item and expose the states a person must see.
 * Pure: same sections, same clock and same windows produce the same record.
 */
export function classifyContextFreshness(
  sections: MeetingBriefEnrichmentSection[],
  options: { now: Date; windows?: Partial<MeetingBriefFreshnessWindows> | null },
): MeetingBriefContextFreshness {
  const windows = resolveMeetingBriefFreshnessWindows(options.windows);
  const nowMs = options.now.getTime();
  const computedAt = options.now.toISOString();

  // A completed item with evidence is classified even when it carries no dated
  // provenance: that is precisely the unknown-freshness case, and it must be
  // disclosed rather than skipped.
  const classified = sections.filter(
    (section) => section.status === "completed" && section.evidence.length > 0,
  );

  const items: MeetingBriefFreshnessItem[] = [];
  // Contradiction detection groups structured claims by identity.
  const claimValues = new Map<string, Set<string>>();
  for (const section of classified) {
    const provenance = section.provenance;
    const claimId = provenance?.claimId ?? `${section.source}:${section.guest ?? ""}`;
    const value = provenance?.claimValue?.trim();
    if (value) {
      const values = claimValues.get(claimId) ?? new Set<string>();
      values.add(value);
      claimValues.set(claimId, values);
    }
  }

  for (const section of classified) {
    const provenance = section.provenance;
    const claimId = provenance?.claimId ?? `${section.source}:${section.guest ?? ""}`;
    const claimKind = claimKindOf(claimId);
    const freshnessClass = freshnessClassFor(section.source, claimKind ?? undefined);
    const guest = section.guest && section.guest.length > 0 ? section.guest : null;
    const company = section.company && section.company.length > 0 ? section.company : null;
    const asOf = provenance ? asOfFor(provenance, freshnessClass) : null;
    const windowHours = windowHoursFor(freshnessClass, windows);
    const declaredConflict = (provenance?.conflicting?.length ?? 0) > 0;
    const claimValue = provenance?.claimValue?.trim();
    const distinctValues = [...(claimValues.get(claimId) ?? [])];
    const contradicting = claimValue ? distinctValues.length > 1 : false;
    const state: MeetingBriefFreshnessState =
      declaredConflict || contradicting
        ? "conflicting"
        : stateFor(freshnessClass, asOf, windowHours, nowMs);
    const item: MeetingBriefFreshnessItem = {
      claimId,
      source: section.source,
      guest,
      company,
      class: freshnessClass,
      state,
      windowHours,
      asOf,
      retrievedAt: provenance?.retrievedAt ?? null,
      qualification: null,
    };
    item.qualification = qualificationFor({
      claimKind: claimKind ?? "other",
      state,
      asOf,
      windowHours,
      subject: guest ?? company ?? "this meeting",
      conflictValues: distinctValues,
    });
    items.push(item);
  }

  const unknown = items
    .filter((item) => item.state === "unknown")
    .map((item) => item.qualification)
    .filter((value): value is string => value !== null);
  const conflicting = items
    .filter((item) => item.state === "conflicting")
    .map((item) => item.qualification)
    .filter((value): value is string => value !== null);

  return {
    version: MEETING_BRIEF_CONTEXT_FRESHNESS_VERSION,
    computedAt,
    windows,
    items,
    unknown: [...new Set(unknown)],
    conflicting: [...new Set(conflicting)],
  };
}

/** The combined current-role/company state for one guest, worst-first. */
function guestRoleState(
  freshness: MeetingBriefContextFreshness,
  guestEmail: string,
): MeetingBriefFreshnessState | null {
  const relevant = freshness.items.filter(
    (item) =>
      item.class === "current-role-company" &&
      (item.guest ?? "").toLowerCase() === guestEmail.toLowerCase(),
  );
  if (relevant.length === 0) return null;
  if (relevant.some((item) => item.state === "conflicting")) return "conflicting";
  if (relevant.some((item) => item.state === "current")) return "current";
  if (relevant.every((item) => item.state === "unknown")) return "unknown";
  return "expired";
}

function appendBounded(values: string[], additions: string[], cap = 5): string[] {
  const next = [...values];
  for (const addition of additions) {
    if (next.includes(addition)) continue;
    if (next.length >= values.length + cap) break;
    next.push(addition);
  }
  return next;
}

/**
 * Make the non-current states visible on the composed Brief.
 *
 * A stale or contradicted current-role/company claim is defeated: the Brief
 * does not carry it as the guest's current role. An undated claim is kept but
 * disclosed as unknown freshness. Everything expired, unknown or conflicting
 * is named in the uncertainty list a person actually reads.
 */
export function applyFreshnessPolicy(
  brief: MeetingBrief,
  freshness: MeetingBriefContextFreshness,
): MeetingBrief {
  const qualificationsForGuest = (email: string): string[] =>
    freshness.items
      .filter(
        (item) =>
          item.class === "current-role-company" &&
          (item.guest ?? "").toLowerCase() === email.toLowerCase() &&
          item.qualification !== null,
      )
      .map((item) => item.qualification as string);

  const guests = brief.guests.map((guest) => {
    const state = guestRoleState(freshness, guest.email);
    if (state === null) return guest;
    const defeatRole = state === "expired" || state === "conflicting";
    return {
      ...guest,
      role: defeatRole ? null : guest.role,
      uncertainty: appendBounded(guest.uncertainty, qualificationsForGuest(guest.email)),
    };
  });

  const companies = brief.companies.map((company) => {
    const relevant = freshness.items.filter(
      (item) =>
        company.name.length > 0 &&
        (item.company ?? "").toLowerCase() === company.name.toLowerCase() &&
        item.state !== "current" &&
        item.qualification !== null,
    );
    if (relevant.length === 0) return company;
    return {
      ...company,
      uncertainty: appendBounded(
        company.uncertainty,
        relevant.map((item) => item.qualification as string),
      ),
    };
  });

  const claimed = new Set(
    freshness.items.filter((item) => item.state !== "current").map((i) => i.claimId),
  );
  const attached = new Set<string>();
  for (const item of freshness.items) {
    if (item.qualification === null) continue;
    const guestMatch = item.guest
      ? guests.some((guest) => guest.email.toLowerCase() === (item.guest ?? "").toLowerCase())
      : false;
    const companyMatch = item.company
      ? companies.some(
          (company) => company.name.toLowerCase() === (item.company ?? "").toLowerCase(),
        )
      : false;
    if (guestMatch || companyMatch) attached.add(item.claimId);
  }
  const unattached = freshness.items
    .filter(
      (item) =>
        item.qualification !== null && claimed.has(item.claimId) && !attached.has(item.claimId),
    )
    .map((item) => item.qualification as string);

  return {
    ...brief,
    guests,
    companies,
    uncertainty: appendBounded(brief.uncertainty, [...new Set(unattached)]),
    contextFreshness: freshness,
  };
}
