import { google } from "googleapis";
import type { GoogleAuth } from "../../../google/oauth.js";
import {
  GOOGLE_ENRICHMENT_MAX_CALENDAR_HISTORY,
  type GoogleEnrichmentArtifact,
  googleEnrichmentKey,
  googleEnrichmentStableRef,
} from "@chief-of-staff-demo/shared";
import type { RunContext } from "../../../engine/module.js";
import type { MeetingBriefEnrichmentSection } from "@chief-of-staff-demo/shared";

export interface CalendarHistoryEvent {
  id: string;
  summary: string;
  startAt: string;
  attendees?: string[];
}

export interface CalendarHistoryProvider {
  listPastMeetings(guestEmail: string, maxResults: number, before: string): Promise<CalendarHistoryEvent[]>;
}

function sanitizeEvidence(text: string): string {
  return text.slice(0, 500).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function readErrorStatus(error: unknown): number | null {
  const maybe = error as { code?: number; status?: number; response?: { status?: number } };
  return maybe?.code ?? maybe?.status ?? maybe?.response?.status ?? null;
}

function readErrorCode(error: unknown): string | null {
  const maybe = error as { code?: string; reason?: string; response?: { data?: { error?: { errors?: Array<{ reason?: string }> } } } };
  if (typeof maybe?.code === "string") return maybe.code;
  if (typeof maybe?.reason === "string") return maybe.reason;
  const nested = maybe?.response?.data?.error?.errors?.[0]?.reason;
  if (typeof nested === "string") return nested;
  return null;
}

function isProviderWideError(error: unknown): boolean {
  const status = readErrorStatus(error);
  const code = readErrorCode(error);
  const msg = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403 || status === 503) return true;
  if (code === "insufficientPermissions" || code === "accessNotConfigured") return true;
  if (/invalid_grant|insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|has not been used in project|is disabled/i.test(msg)) return true;
  return false;
}

export function createCalendarHistoryProvider(auth: GoogleAuth): CalendarHistoryProvider {
  return {
    async listPastMeetings(guestEmail: string, maxResults: number, before: string): Promise<CalendarHistoryEvent[]> {
      const calendar = google.calendar({ version: "v3", auth });
      const timeMax = before;
      // Look back 90 days, bounded
      const timeMin = new Date(Date.parse(timeMax) - 90 * 24 * 60 * 60 * 1000).toISOString();
      const res = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        maxResults: maxResults * 3, // fetch extra to filter by guest
        singleEvents: true,
        orderBy: "startTime",
        q: guestEmail,
      });
      const items = res.data.items ?? [];
      const filtered = items
        .filter((e) => {
          const attendees = (e.attendees ?? []).map((a) => (a.email ?? "").toLowerCase());
          return attendees.includes(guestEmail.toLowerCase());
        })
        .slice(0, maxResults)
        .map((e) => ({
          id: e.id ?? `evt-${Math.random()}`,
          summary: (e.summary ?? ""),
          startAt: (e.start?.dateTime ?? e.start?.date ?? ""),
          attendees: (e.attendees ?? []).map((a) => a.email ?? ""),
        }));
      return filtered;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake
// ---------------------------------------------------------------------------

export type FakeCalendarMode = "normal" | "unavailable";

export interface FakeCalendarHistoryOptions {
  mode?: FakeCalendarMode;
  failFirstFor?: Set<string>;
  unavailableError?: unknown;
  pastMeetings?: Map<string, CalendarHistoryEvent[]>;
}

export class FakeCalendarHistoryProvider implements CalendarHistoryProvider {
  private mode: FakeCalendarMode;
  private failFirstFor: Set<string>;
  private unavailableError: unknown;
  private pastMeetings: Map<string, CalendarHistoryEvent[]>;
  private callCounts = new Map<string, number>();
  private failCounts = new Map<string, number>();

  constructor(opts: FakeCalendarHistoryOptions = {}) {
    this.mode = opts.mode ?? "normal";
    this.failFirstFor = new Set([...(opts.failFirstFor ?? [])].map((s) => s.toLowerCase()));
    this.unavailableError = opts.unavailableError ?? Object.assign(new Error("Calendar unavailable"), { status: 503, code: 503 });
    this.pastMeetings = opts.pastMeetings ?? new Map();
  }

  setPastMeetings(guestEmail: string, events: CalendarHistoryEvent[]): void {
    this.pastMeetings.set(guestEmail.toLowerCase(), events);
  }

  setMode(mode: FakeCalendarMode): void {
    this.mode = mode;
  }

  addFailFirstFor(guestEmail: string): void {
    this.failFirstFor.add(guestEmail.toLowerCase());
  }

  getCallCount(guestEmail: string): number {
    return this.callCounts.get(guestEmail.toLowerCase()) ?? 0;
  }

  async listPastMeetings(guestEmail: string, maxResults: number, _before: string): Promise<CalendarHistoryEvent[]> {
    void maxResults;
    const key = guestEmail.toLowerCase();
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    if (this.mode === "unavailable") throw this.unavailableError;
    const count = this.failCounts.get(key) ?? 0;
    if (this.failFirstFor.has(key) && count === 0) {
      this.failCounts.set(key, count + 1);
      throw Object.assign(new Error("transient calendar failure"), { status: 500 });
    }
    const all = this.pastMeetings.get(key) ?? [];
    // Deduplicate by id
    const seen = new Set<string>();
    const deduped: CalendarHistoryEvent[] = [];
    for (const e of all) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        deduped.push(e);
      }
    }
    return deduped;
  }
}

export async function enrichCalendarHistory(
  provider: CalendarHistoryProvider,
  eventVersion: string,
  guestEmail: string,
  before: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{ artifact: GoogleEnrichmentArtifact; section: MeetingBriefEnrichmentSection }> {
  const normalized = guestEmail.toLowerCase();
  const key = googleEnrichmentKey(eventVersion, normalized, "calendar-history");
  const stableRef = googleEnrichmentStableRef(eventVersion, normalized, "calendar-history");
  const maxResults = GOOGLE_ENRICHMENT_MAX_CALENDAR_HISTORY;
  const filename = `calendar-history-${normalized.replace(/[^a-z0-9]/g, "_")}-${eventVersion}.json`;

  const existingRaw = ctx.readFile(filename);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as GoogleEnrichmentArtifact;
      if (existing.eventVersion === eventVersion && (existing.status === "completed" || existing.status === "empty")) {
        const section: MeetingBriefEnrichmentSection = {
          source: "calendar-history",
          guest: normalized,
          status: existing.status,
          evidence: existing.evidence,
          references: existing.references,
        };
        return { artifact: existing, section };
      }
    } catch {
      // re-enrich
    }
  }

  let attempts = 0;
  let lastError: unknown = null;
  const maxAttempts = 2;
  for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
    try {
      const events = await provider.listPastMeetings(normalized, maxResults, before);
      if (events.length === 0) {
        const artifact: GoogleEnrichmentArtifact = {
          key,
          eventVersion,
          guestEmail: normalized,
          source: "calendar-history",
          status: "empty",
          evidence: [],
          references: [],
          diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, attempts },
          stableRef,
        };
        ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
        ctx.event("calendar_history_empty", { guest: normalized, attempts });
        return { artifact, section: { source: "calendar-history", guest: normalized, status: "empty", evidence: [], references: [] } };
      }
      const limited = events.slice(0, maxResults);
      const truncated = events.length > maxResults;
      const evidence = limited.map((e) => sanitizeEvidence(e.summary || `Meeting ${e.id} at ${e.startAt}`));
      const references = limited.map((e) => `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(e.id)}`);
      const artifact: GoogleEnrichmentArtifact = {
        key,
        eventVersion,
        guestEmail: normalized,
        source: "calendar-history",
        status: "completed",
        evidence,
        references,
        diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, ...(truncated ? { truncated: true } : {}), attempts },
        stableRef,
      };
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("calendar_history_completed", { guest: normalized, count: evidence.length });
      return { artifact, section: { source: "calendar-history", guest: normalized, status: "completed", evidence, references } };
    } catch (error) {
      lastError = error;
      if (isProviderWideError(error)) throw error;
      if (attempts < maxAttempts) {
        ctx.event("calendar_history_retry", { guest: normalized, attempt: attempts });
        continue;
      }
      const httpStatus = readErrorStatus(error);
      const errorCode = readErrorCode(error);
      const reason = error instanceof Error ? error.message : String(error);
      const artifact: GoogleEnrichmentArtifact = {
        key,
        eventVersion,
        guestEmail: normalized,
        source: "calendar-history",
        status: "failed",
        evidence: [],
        references: [],
        diagnostics: { bounded: true, maxResults, stableRef, httpStatus, errorCode, reason: reason.slice(0, 500), untrusted: true, attempts },
        stableRef,
      };
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("calendar_history_failed", { guest: normalized, error: reason.slice(0, 200) });
      return { artifact, section: { source: "calendar-history", guest: normalized, status: "failed", evidence: [], references: [] } };
    }
  }
  throw lastError;
}
