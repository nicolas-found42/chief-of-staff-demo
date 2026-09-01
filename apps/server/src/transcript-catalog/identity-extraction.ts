import { createHash } from "node:crypto";
import type {
  OrganizationMention,
  TranscriptMention,
  TranscriptMentionConfidence,
  TranscriptMentionProvenance,
  TranscriptIdentityExtractionResult,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";

/** Bumped whenever extraction, scoring, or link policy changes meaning. */
export const IDENTITY_MINING_ALGORITHM_VERSION = 3;

const LINE_TIMESTAMP = /^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]?\s*/;
const SPEAKER_COLON = /^([^\s:][^:\n]{0,79}):\s+/;
const PERSON_LIKE_LABEL = /^\p{Lu}[\p{L}\p{M}]*(?:'[\p{L}\p{M}]+)?(?:\s\p{Lu}[\p{L}\p{M}]*){0,2}$/u;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PROFILE_URL = /https?:\/\/[^\s<>()]+/gi;
const CAPITALIZED_RUN = /\p{Lu}[\p{L}\p{M}\p{N}&.'-]*(?:\s+\p{Lu}[\p{L}\p{M}\p{N}&.'-]*)*/gu;
const PRODUCT_CUE =
  /\b(?:our|the|my)\s+(?:new\s+|next\s+|flagship\s+|beta\s+)?([A-Z][A-Za-z0-9]+)\b/g;
/** Words that precede an organization the speaker names in context. */
const ORG_CUE = /\b(?:at|from|with|of)\s+$/i;
const ORG_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "gmbh",
  "corp",
  "corporation",
  "company",
  "co",
  "labs",
  "laboratories",
  "technologies",
  "systems",
  "group",
  "university",
  "institute",
  "partners",
  "holdings",
  "foundation",
  "solutions",
  "ventures",
]);
const HONORIFICS = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "miss",
  "prof",
  "professor",
  "sir",
  "madam",
  "rev",
  "hon",
]);
const CREDENTIALS = /\b(?:ph\.?\s?d\.?|m\.?d\.?|m\.?b\.?a\.?|j\.?d\.?|esq\.?|cfa|cpa)\b/gi;
/** Sentence words, greetings, days, months, and meeting-recording boilerplate
 *  that are proper-noun-shaped in transcripts but never identity evidence. */
const NON_NAME_WORDS = new Set([
  "i",
  "we",
  "the",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "he",
  "she",
  "they",
  "them",
  "his",
  "her",
  "their",
  "you",
  "your",
  "my",
  "our",
  "ok",
  "okay",
  "yes",
  "no",
  "so",
  "and",
  "but",
  "or",
  "if",
  "then",
  "now",
  "well",
  "also",
  "just",
  "not",
  "do",
  "does",
  "did",
  "done",
  "let",
  "lets",
  "please",
  "thanks",
  "thank",
  "hello",
  "hi",
  "hey",
  "good",
  "great",
  "nice",
  "sure",
  "right",
  "yeah",
  "yep",
  "alright",
  "actually",
  "basically",
  "however",
  "anyway",
  "maybe",
  "perhaps",
  "probably",
  "really",
  "first",
  "second",
  "next",
  "last",
  "finally",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "email",
  "note",
  "notes",
  "agenda",
  "summary",
  "recap",
  "topic",
  "topics",
  "items",
  "actions",
  "update",
  "updates",
  "sync",
  "standup",
  "weekly",
  "monthly",
  "review",
  "kickoff",
  "decisions",
  "intro",
  "transcript",
  "call",
  "video",
  "recording",
  "speaker",
  "attendees",
  "participants",
  "owner",
  "date",
  "time",
  "duration",
  "project",
  "sprint",
  "demo",
  "launch",
  "plan",
  "roadmap",
  "team",
  "all",
  "everyone",
  "guys",
  "folks",
  "here",
  "there",
  "when",
  "what",
  "where",
  "why",
  "who",
  "how",
  "which",
  "one",
]);

interface ExtractedLine {
  timestamp: string | null;
  speakerLabel: string | null;
  /** Absolute offset where the utterance text starts. */
  utteranceStart: number;
  utterance: string;
}

/** A classified span before mention records are built. */
interface SpanDraft {
  kind: TranscriptMention["kind"];
  surfaceText: string;
  normalizedForms: string[];
  emails: string[];
  profileUrls: string[];
  verifiedHandles: Record<string, string[]>;
  externalContactIds: TranscriptMention["externalContactIds"];
  speakerCalendarEmail: string | null;
  confidence: TranscriptMentionConfidence;
  spanStart: number;
  spanEnd: number;
}

interface OrgDraft {
  surfaceText: string;
  normalizedName: string;
  confidence: TranscriptMentionConfidence;
  spanStart: number;
  spanEnd: number;
  timestamp: string | null;
  speakerLabel: string | null;
}

export function normalizeName(value: string): string {
  const base = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stripped = base
    .split(" ")
    .filter((token) => !HONORIFICS.has(token.replace(/\.$/, "")))
    .join(" ")
    .replace(CREDENTIALS, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : base;
}

export function normalizeProfileUrl(value: string): string | null {
  try {
    const url = new URL(value.normalize("NFKC").replace(/[.,;!?]+$/, ""));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    /* An arbitrary HTTP URL is not a stable person identifier. v1 accepts
       only a source whose URL shape unambiguously denotes a person Profile. */
    if (host !== "linkedin.com" || parts.length !== 2 || parts[0]?.toLowerCase() !== "in") {
      return null;
    }
    url.protocol = "https:";
    url.hostname = "linkedin.com";
    url.pathname = `/in/${parts[1]}`;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizeHandle(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/^@/, "");
}

export function normalizeHandles(input: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(input)
      .map(
        ([platform, handles]) =>
          [
            platform.normalize("NFKC").trim().toLowerCase(),
            unique(handles.map(normalizeHandle)),
          ] as const,
      )
      .filter(([, handles]) => handles.length > 0),
  );
}

export function normalizeExternalContactIds(
  input: TranscriptMention["externalContactIds"],
): TranscriptMention["externalContactIds"] {
  return input.map((item) => ({
    system: item.system.normalize("NFKC").trim().toLowerCase(),
    externalId: item.externalId.normalize("NFKC").trim(),
  }));
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** `tm_<12 hex>` — stable per transcript, span, and form, so re-mining of an
 *  unchanged revision reproduces the same mention ids and decisions survive. */
function mentionId(transcriptId: string, spanStart: number, form: string, kind: string): string {
  const digest = createHash("sha1")
    .update(`${transcriptId}|${spanStart}|${kind}|${form}`)
    .digest("hex");
  return `tm_${digest.slice(0, 12)}`;
}

function organizationId(transcriptId: string, spanStart: number, form: string): string {
  const digest = createHash("sha1")
    .update(`org|${transcriptId}|${spanStart}|${form}`)
    .digest("hex");
  return `om_${digest.slice(0, 12)}`;
}

function isStopword(token: string): boolean {
  return NON_NAME_WORDS.has(token.toLowerCase().replace(/\.$/, ""));
}

function lastToken(run: string): string {
  return run.trim().split(/\s+/).at(-1)?.replace(/\.$/, "").toLowerCase() ?? "";
}

function parseLines(text: string): ExtractedLine[] {
  const lines: ExtractedLine[] = [];
  let offset = 0;
  for (const rawLine of text.split("\n")) {
    let rest = rawLine;
    let position = offset;
    let timestamp: string | null = null;
    const timeMatch = rest.match(LINE_TIMESTAMP);
    if (timeMatch) {
      timestamp = timeMatch[1] ?? null;
      position += timeMatch[0].length;
      rest = rest.slice(timeMatch[0].length);
    }
    let speakerLabel: string | null = null;
    let utteranceStart = position;
    let utterance = rest;
    const labelMatch = rest.match(SPEAKER_COLON);
    if (labelMatch) {
      const label = labelMatch[1]?.trim() ?? "";
      if (PERSON_LIKE_LABEL.test(label) || /^speaker/i.test(label)) {
        speakerLabel = label;
        utteranceStart = position + labelMatch[0].length;
        utterance = rest.slice(labelMatch[0].length);
      }
    }
    lines.push({ timestamp, speakerLabel, utteranceStart, utterance });
    offset += rawLine.length + 1;
  }
  return lines;
}

/** Runs of capitalized tokens with stopword tokens trimmed off both ends. */
function nameRuns(text: string, base: number): { run: string; start: number }[] {
  const runs: { run: string; start: number }[] = [];
  for (const match of text.matchAll(CAPITALIZED_RUN)) {
    const tokens = match[0]
      .trim()
      .replace(/[.,]+$/, "")
      .split(/\s+/);
    let first = 0;
    let last = tokens.length - 1;
    while (first <= last && isStopword(tokens[first] ?? "")) first += 1;
    while (last >= first && isStopword(tokens[last] ?? "")) last -= 1;
    if (first > last) continue;
    const inner = tokens.slice(first, last + 1);
    const leading = tokens.slice(0, first).join(" ");
    const start = base + match.index + (leading.length > 0 ? leading.length + 1 : 0);
    runs.push({ run: inner.join(" "), start });
  }
  return runs;
}

/**
 * Deterministic extraction (spec #117, "Extraction and normalization").
 * Pure and provider-free: every span is classified from the text itself and
 * retained — organizations, ambiguous single names, non-attendee and
 * organization-context people, products, unknowns — without coercing every
 * proper noun into a person.
 */
export interface TranscriptExtraction {
  mentions: TranscriptMention[];
  organizations: OrganizationMention[];
}

export function extractMentions(
  record: TranscriptRecord,
  supplement: TranscriptIdentityExtractionResult,
): TranscriptExtraction {
  const text = record.normalizedText;
  const lines = parseLines(text);
  const speakerLabels = new Set(
    lines.flatMap((line) => (line.speakerLabel === null ? [] : [normalizeName(line.speakerLabel)])),
  );
  const spans: SpanDraft[] = [];
  const orgDrafts: OrgDraft[] = [];
  const seenLabelForms = new Set<string>();

  const statusFor = (line: ExtractedLine, surface: string): TranscriptMention["attendeeStatus"] => {
    if (line.speakerLabel !== null && normalizeName(line.speakerLabel) === normalizeName(surface)) {
      return "speaker";
    }
    if (speakerLabels.has(normalizeName(surface))) return "speaker";
    return line.speakerLabel !== null ? "third-person" : "unknown";
  };

  for (const line of lines) {
    /* Source speaker labels are the strongest person-shaped evidence: one
       mention per distinct label, at its first written occurrence. */
    if (line.speakerLabel !== null) {
      const labelForm = normalizeName(line.speakerLabel);
      const identityMapping = record.speakerIdentityMappings.find(
        (mapping) => normalizeName(mapping.speakerLabel) === labelForm,
      );
      const start = line.utteranceStart - (line.speakerLabel.length + 2);
      if (
        !seenLabelForms.has(labelForm) &&
        start >= 0 &&
        text.slice(start, start + line.speakerLabel.length) === line.speakerLabel
      ) {
        spans.push({
          kind: "person",
          surfaceText: line.speakerLabel,
          normalizedForms: unique([normalizeName(line.speakerLabel)]),
          emails: [],
          profileUrls: [],
          verifiedHandles: normalizeHandles(identityMapping?.verifiedHandles ?? {}),
          externalContactIds: normalizeExternalContactIds(
            identityMapping?.externalContactIds ?? [],
          ),
          speakerCalendarEmail:
            identityMapping?.calendarEmail?.normalize("NFKC").toLowerCase() ?? null,
          confidence: "high",
          spanStart: start,
          spanEnd: start + line.speakerLabel.length,
        });
      }
      seenLabelForms.add(labelForm);
    }

    /* Product-cued names ("the new Atlas") are retained as products and are
       excluded from person-name scanning below. */
    const productRanges: { start: number; end: number }[] = [];
    for (const match of line.utterance.matchAll(PRODUCT_CUE)) {
      const surface = match[1];
      if (surface === undefined) continue;
      const start = line.utteranceStart + match.index + match[0].indexOf(surface);
      productRanges.push({ start, end: start + surface.length });
      spans.push({
        kind: "product",
        surfaceText: surface,
        normalizedForms: [normalizeName(surface)],
        emails: [],
        profileUrls: [],
        verifiedHandles: {},
        externalContactIds: [],
        speakerCalendarEmail: null,
        confidence: "medium",
        spanStart: start,
        spanEnd: start + surface.length,
      });
    }
    const reservedRanges = [...productRanges];
    for (const match of line.utterance.matchAll(PROFILE_URL)) {
      const surface = match[0].replace(/[.,;!?]+$/, "");
      const normalizedUrl = normalizeProfileUrl(surface);
      if (normalizedUrl === null) continue;
      const start = line.utteranceStart + match.index;
      reservedRanges.push({ start, end: start + surface.length });
      spans.push({
        kind: "person",
        surfaceText: surface,
        normalizedForms: [normalizedUrl],
        emails: [],
        profileUrls: [normalizedUrl],
        verifiedHandles: {},
        externalContactIds: [],
        speakerCalendarEmail: null,
        confidence: "high",
        spanStart: start,
        spanEnd: start + surface.length,
      });
    }
    const inReservedRange = (start: number, end: number): boolean =>
      reservedRanges.some((range) => start >= range.start && end <= range.end);

    const classifiedRuns: {
      kind: SpanDraft["kind"];
      run: string;
      start: number;
      forms: string[];
      emails: string[];
    }[] = [];
    for (const { run, start } of nameRuns(line.utterance, line.utteranceStart).filter(
      (candidate) =>
        !inReservedRange(candidate.start, candidate.start + candidate.run.length) &&
        candidate.run.trim().length > 0,
    )) {
      const end = start + run.length;
      const forms = unique([normalizeName(run)]);
      const normalizedForm = forms[0];
      if (normalizedForm === undefined || normalizedForm.length === 0) continue;
      const tokens = run.split(/\s+/);
      const orgBySuffix = ORG_SUFFIXES.has(lastToken(run));
      const orgByBrandStylization = /\p{Ll}\p{Lu}/u.test(run);

      /* "X at/from/with/of Org" — the capitalized object after the
         preposition is an Organization Mention; the person before it gains
         organization context (linked after all lines are scanned). */
      const before = line.utterance.slice(0, start - line.utteranceStart);
      const organizationByContext = ORG_CUE.test(before);

      if (orgBySuffix || (organizationByContext && orgByBrandStylization)) {
        const confidence: TranscriptMentionConfidence = orgBySuffix ? "high" : "medium";
        orgDrafts.push({
          surfaceText: run,
          normalizedName: normalizedForm,
          confidence,
          spanStart: start,
          spanEnd: end,
          timestamp: line.timestamp,
          speakerLabel: line.speakerLabel,
        });
        continue;
      }

      const singleToken =
        tokens.length === 1 && !HONORIFICS.has((tokens[0] ?? "").replace(/\.$/, ""));
      const unknownEntity = singleToken && /^[A-Z0-9]{2,}$/.test(run);
      classifiedRuns.push({
        kind: unknownEntity ? "unknown" : singleToken ? "ambiguous-name" : "person",
        run,
        start,
        forms,
        emails: [],
      });
    }

    /* Emails are exact stable identifiers. An email directly attached to a
       person run ("Grace Hopper grace@example.com") belongs to that person's
       mention; a standalone email is its own person mention. */
    const emailMatches = [...line.utterance.matchAll(EMAIL)];
    for (const match of emailMatches) {
      const email = match[0].normalize("NFKC").toLowerCase();
      const matchIndex = match.index;
      const start = line.utteranceStart + matchIndex;
      const attached = classifiedRuns.find(
        (candidate) =>
          candidate.kind === "person" &&
          candidate.start + candidate.run.length < start &&
          line.utterance
            .slice(candidate.start + candidate.run.length - line.utteranceStart, matchIndex)
            .trim() === "",
      );
      if (attached) {
        attached.forms = unique([...attached.forms, email]);
        attached.emails.push(email);
        continue;
      }
      spans.push({
        kind: "person",
        surfaceText: match[0],
        normalizedForms: [email],
        emails: [email],
        profileUrls: [],
        verifiedHandles: {},
        externalContactIds: [],
        speakerCalendarEmail: null,
        confidence: "high",
        spanStart: start,
        spanEnd: start + match[0].length,
      });
    }
    for (const candidate of classifiedRuns) {
      spans.push({
        kind: candidate.kind,
        surfaceText: candidate.run,
        normalizedForms: candidate.forms,
        emails: candidate.emails,
        profileUrls: [],
        verifiedHandles: {},
        externalContactIds: [],
        speakerCalendarEmail: null,
        confidence: candidate.kind === "person" ? "medium" : "low",
        spanStart: candidate.start,
        spanEnd: candidate.start + candidate.run.length,
      });
    }
  }

  const mentions: TranscriptMention[] = spans.map((span) => {
    /* Recover the line context for each span from its position in the text. */
    const line = lines.find(
      (candidate) =>
        span.spanStart >= candidate.utteranceStart - 200 &&
        span.spanStart <= candidate.utteranceStart + candidate.utterance.length,
    );
    const provenance: TranscriptMentionProvenance = {
      transcriptId: record.id,
      spanStart: span.spanStart,
      spanEnd: span.spanEnd,
      quote: span.surfaceText,
      timestamp: line?.timestamp ?? null,
      speakerLabel: line?.speakerLabel ?? null,
      meetingDate: record.meetingDate,
    };
    return {
      id: mentionId(record.id, span.spanStart, span.normalizedForms[0] ?? "", span.kind),
      kind: span.kind,
      surfaceText: span.surfaceText,
      normalizedForms: span.normalizedForms,
      emails: span.emails,
      profileUrls: span.profileUrls,
      verifiedHandles: span.verifiedHandles,
      externalContactIds: span.externalContactIds,
      speakerCalendarEmail: span.speakerCalendarEmail,
      titles: [],
      roles: [],
      aliases: [],
      relationshipAssertions: [],
      organizationContext: null,
      attendeeStatus: line === undefined ? "unknown" : statusFor(line, span.surfaceText),
      confidence: span.confidence,
      provenance,
      minedAt: record.ingestedAt,
      algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
    };
  });

  /* Organization-context linkage: a person run directly followed by
     "at/from/with/of <Capitalized>" borrows that organization's name. */
  for (const org of orgDrafts) {
    for (const mention of mentions) {
      if (mention.kind !== "person" || mention.organizationContext !== null) continue;
      const between = text.slice(mention.provenance.spanEnd, org.spanStart);
      if (/^\s+(?:at|from|with|of)\s+$/.test(between)) {
        mention.organizationContext = org.normalizedName;
      }
    }
  }

  /* Email domains attach to the organizations they plausibly name:
     "acme.com" feeds the "Acme …" Organization Mention's domain list. */
  const domains = unique(
    mentions.flatMap((mention) => mention.emails.map((email) => email.split("@")[1] ?? "")),
  );
  const organizations: OrganizationMention[] = orgDrafts.map((org) => {
    const stem = org.normalizedName.split(" ")[0] ?? "";
    return {
      id: organizationId(record.id, org.spanStart, org.normalizedName),
      surfaceText: org.surfaceText,
      normalizedName: org.normalizedName,
      aliases: [],
      domains: domains.filter((domain) => domain.split(".")[0] === stem),
      externalCompanyIds: [],
      relationshipAssertions: [],
      relatedMentionIds: mentions
        .filter((mention) => mention.organizationContext === org.normalizedName)
        .map((mention) => mention.id),
      confidence: org.confidence,
      provenance: {
        transcriptId: record.id,
        spanStart: org.spanStart,
        spanEnd: org.spanEnd,
        quote: org.surfaceText,
        timestamp: org.timestamp,
        speakerLabel: org.speakerLabel,
        meetingDate: record.meetingDate,
      },
      minedAt: record.ingestedAt,
      algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
    };
  });

  applyModelSupplement(record, lines, mentions, organizations, supplement);
  mentions.sort((left, right) => left.provenance.spanStart - right.provenance.spanStart);
  organizations.sort((left, right) => left.provenance.spanStart - right.provenance.spanStart);
  return { mentions, organizations };
}

function evidenceText(value: string): string {
  return value.normalize("NFC").trim();
}

function assertionsOf(
  assertions: TranscriptIdentityExtractionResult["mentions"][number]["relationshipAssertions"],
): TranscriptMention["relationshipAssertions"] {
  return assertions.map((assertion) => ({
    subject: evidenceText(assertion.subject),
    relationship: evidenceText(assertion.relationship),
    object: evidenceText(assertion.object),
  }));
}

function checkedSurface(record: TranscriptRecord, spanStart: number, spanEnd: number): string {
  if (spanEnd <= spanStart || spanEnd > record.normalizedText.length) {
    throw new Error(`Identity extraction returned invalid span ${spanStart}:${spanEnd}`);
  }
  const surface = record.normalizedText.slice(spanStart, spanEnd);
  if (surface.length === 0) throw new Error("Identity extraction returned an empty span");
  return surface;
}

function contextFor(
  lines: ExtractedLine[],
  spanStart: number,
): { timestamp: string | null; speakerLabel: string | null } {
  const line = lines.find(
    (candidate) =>
      spanStart >= candidate.utteranceStart - 200 &&
      spanStart <= candidate.utteranceStart + candidate.utterance.length,
  );
  return { timestamp: line?.timestamp ?? null, speakerLabel: line?.speakerLabel ?? null };
}

/** Merge strict model classifications into deterministic recognition. The
 * deterministic spans remain the floor; a valid model span may supplement or
 * add evidence, but never invent text outside the immutable artifact. */
function applyModelSupplement(
  record: TranscriptRecord,
  lines: ExtractedLine[],
  mentions: TranscriptMention[],
  organizations: OrganizationMention[],
  supplement: TranscriptIdentityExtractionResult,
): void {
  for (const extracted of supplement.mentions) {
    const surfaceText = checkedSurface(record, extracted.spanStart, extracted.spanEnd);
    const existing = mentions.find(
      (mention) =>
        mention.provenance.spanStart === extracted.spanStart &&
        mention.provenance.spanEnd === extracted.spanEnd,
    );
    const normalizedForms = unique([normalizeName(surfaceText)]);
    const context = contextFor(lines, extracted.spanStart);
    const evidence = {
      titles: unique(extracted.titles.map(evidenceText)),
      roles: unique(extracted.roles.map(evidenceText)),
      aliases: unique(extracted.aliases.map(evidenceText)),
      relationshipAssertions: assertionsOf(extracted.relationshipAssertions),
    };
    if (existing) {
      existing.id = mentionId(
        record.id,
        extracted.spanStart,
        existing.normalizedForms[0] ?? normalizedForms[0] ?? "",
        extracted.kind,
      );
      existing.kind = extracted.kind;
      existing.confidence = extracted.confidence;
      Object.assign(existing, evidence);
      continue;
    }
    mentions.push({
      id: mentionId(record.id, extracted.spanStart, normalizedForms[0] ?? "", extracted.kind),
      kind: extracted.kind,
      surfaceText,
      normalizedForms,
      emails: [],
      profileUrls: [],
      verifiedHandles: {},
      externalContactIds: [],
      speakerCalendarEmail: null,
      ...evidence,
      organizationContext: null,
      attendeeStatus: context.speakerLabel === null ? "unknown" : "third-person",
      confidence: extracted.confidence,
      provenance: {
        transcriptId: record.id,
        spanStart: extracted.spanStart,
        spanEnd: extracted.spanEnd,
        quote: surfaceText,
        timestamp: context.timestamp,
        speakerLabel: context.speakerLabel,
        meetingDate: record.meetingDate,
      },
      minedAt: record.ingestedAt,
      algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
    });
  }

  for (const extracted of supplement.organizations) {
    const surfaceText = checkedSurface(record, extracted.spanStart, extracted.spanEnd);
    const normalizedName = normalizeName(surfaceText);
    const context = contextFor(lines, extracted.spanStart);
    const evidence = {
      aliases: unique(extracted.aliases.map(evidenceText)),
      domains: unique(
        extracted.domains.map((domain) => domain.normalize("NFKC").trim().toLowerCase()),
      ),
      externalCompanyIds: normalizeExternalContactIds(extracted.externalCompanyIds),
      relationshipAssertions: assertionsOf(extracted.relationshipAssertions),
    };
    const existing = organizations.find(
      (organization) =>
        organization.provenance.spanStart === extracted.spanStart &&
        organization.provenance.spanEnd === extracted.spanEnd,
    );
    if (existing) {
      existing.confidence = extracted.confidence;
      existing.aliases = unique([...existing.aliases, ...evidence.aliases]);
      existing.domains = unique([...existing.domains, ...evidence.domains]);
      existing.externalCompanyIds = evidence.externalCompanyIds;
      existing.relationshipAssertions = evidence.relationshipAssertions;
      continue;
    }
    organizations.push({
      id: organizationId(record.id, extracted.spanStart, normalizedName),
      surfaceText,
      normalizedName,
      ...evidence,
      relatedMentionIds: [],
      confidence: extracted.confidence,
      provenance: {
        transcriptId: record.id,
        spanStart: extracted.spanStart,
        spanEnd: extracted.spanEnd,
        quote: surfaceText,
        timestamp: context.timestamp,
        speakerLabel: context.speakerLabel,
        meetingDate: record.meetingDate,
      },
      minedAt: record.ingestedAt,
      algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
    });
  }
}
