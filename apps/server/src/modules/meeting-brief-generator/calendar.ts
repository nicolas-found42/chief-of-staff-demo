import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Calendar types — primary Calendar push channel + incremental sync (issue://83)
// ---------------------------------------------------------------------------

export interface CalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus: "accepted" | "tentative" | "needsAction" | "declined";
  organizer?: boolean;
  resource?: boolean;
}

export interface CalendarEvent {
  calendarId: string;
  eventId: string;
  /** Occurrence identity — one per recurring occurrence (e.g. eventId + start). */
  occurrenceId: string;
  version: string;
  summary: string;
  description?: string;
  startAt: string; // ISO datetime
  endAt: string; // ISO datetime
  location?: string | null;
  conferenceLink?: string | null;
  organizer?: { email: string; displayName?: string };
  attendees: CalendarAttendee[];
  status: "confirmed" | "cancelled" | "tentative";
  isAllDay?: boolean;
  attachments?: string[];
  // Unused Calendar metadata — ignored for material changes (ADR-0033)
  colorId?: string | null;
  etag?: string | null;
  visibility?: string | null;
  transparency?: string | null;
  created?: string | null;
  updated?: string | null;
}

export interface CalendarListResult {
  events: CalendarEvent[];
  nextSyncToken: string | null;
}

export class InvalidSyncTokenError extends Error {
  override name = "InvalidSyncTokenError";
  constructor(message = "sync token invalid") {
    super(message);
  }
}

export interface CalendarWatchResult {
  resourceId: string | null;
  expiration: string | null; // ISO string
}

export interface CalendarProvider {
  /** Create a watch channel for calendarId; returns resourceId/expiration. */
  watchChannel(args: {
    calendarId: string;
    channelId: string;
    token: string;
    expiration?: string | null;
  }): Promise<CalendarWatchResult>;
  /** Stop a channel. */
  stopChannel(args: { channelId: string; resourceId: string | null }): Promise<void>;
  /** List events — incremental if syncToken, bounded full sync otherwise. */
  listEvents(args: {
    calendarId: string;
    syncToken?: string | null;
    timeMin?: string | null;
    timeMax?: string | null;
  }): Promise<CalendarListResult>;
}

// ---------------------------------------------------------------------------
// Local durable state for channel identity/token/resource identity/expiration/syncToken (issue://83)
// ---------------------------------------------------------------------------

export interface CalendarChannelLocal {
  channelId: string;
  token: string;
  resourceId: string | null;
  expiration: string | null; // ISO
  calendarId: string;
}

export interface MeetingBriefCalendarState {
  channel: CalendarChannelLocal | null;
  syncToken: string | null;
  lastSyncAt: string | null;
}

const EMPTY: MeetingBriefCalendarState = {
  channel: null,
  syncToken: null,
  lastSyncAt: null,
};

function filePath(workspaceDir: string): string {
  return join(workspaceDir, "meeting-brief-calendar.json");
}

function readState(workspaceDir: string): MeetingBriefCalendarState {
  const file = filePath(workspaceDir);
  if (!existsSync(file)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MeetingBriefCalendarState>;
    const channelRaw = parsed.channel as unknown;
    let channel: CalendarChannelLocal | null = null;
    if (
      channelRaw &&
      typeof channelRaw === "object" &&
      typeof (channelRaw as Record<string, unknown>).channelId === "string" &&
      typeof (channelRaw as Record<string, unknown>).token === "string"
    ) {
      const c = channelRaw as Record<string, unknown>;
      channel = {
        channelId: String(c.channelId),
        token: String(c.token),
        resourceId: typeof c.resourceId === "string" ? c.resourceId : null,
        expiration: typeof c.expiration === "string" ? c.expiration : null,
        calendarId: typeof c.calendarId === "string" ? c.calendarId : "primary",
      };
    }
    return {
      channel,
      syncToken: typeof parsed.syncToken === "string" ? parsed.syncToken : null,
      lastSyncAt: typeof parsed.lastSyncAt === "string" ? parsed.lastSyncAt : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

function writeState(workspaceDir: string, state: MeetingBriefCalendarState): void {
  const file = filePath(workspaceDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

export class MeetingBriefCalendarStore {
  constructor(private readonly workspaceDir: string) {}

  load(): MeetingBriefCalendarState {
    return readState(this.workspaceDir);
  }

  save(state: MeetingBriefCalendarState): void {
    writeState(this.workspaceDir, state);
  }

  clear(): void {
    writeState(this.workspaceDir, { ...EMPTY });
  }

  getChannel(): CalendarChannelLocal | null {
    return this.load().channel;
  }

  setChannel(channel: CalendarChannelLocal | null): void {
    const current = this.load();
    this.save({ ...current, channel });
  }

  getSyncToken(): string | null {
    return this.load().syncToken;
  }

  setSyncToken(syncToken: string | null): void {
    const current = this.load();
    this.save({
      ...current,
      syncToken,
      lastSyncAt: syncToken ? new Date().toISOString() : current.lastSyncAt,
    });
  }

  setSyncState(syncToken: string | null, at: string | null): void {
    const current = this.load();
    this.save({ ...current, syncToken, lastSyncAt: at });
  }

  /** Whether the current channel expires soon and needs durable replace. */
  needsRenewal(now: Date, thresholdMs = 60 * 60 * 1000): boolean {
    const channel = this.getChannel();
    if (!channel) return true;
    if (!channel.expiration) return false;
    const exp = Date.parse(channel.expiration);
    if (Number.isNaN(exp)) return false;
    return exp - now.getTime() < thresholdMs;
  }
}

// ---------------------------------------------------------------------------
// Helpers: durable channel creation + renewal (idempotent)
// ---------------------------------------------------------------------------

export function newChannelId(): string {
  return `mbc-${randomUUID()}`;
}

export function newChannelToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Totally injectable fake CalendarProvider for tests (issue://83 host seam).
 * Keeps an in-memory list of events and a monotonic syncToken counter; each
 * listEvents call returns all events and a new syncToken unless syncToken is
 * invalid (simulates 410).
 */
export class FakeCalendarProvider implements CalendarProvider {
  private events: CalendarEvent[] = [];
  private tokenCounter = 0;
  private validTokens = new Set<string | null>();
  private invalidNext = false;
  private watchCalls: Array<{ channelId: string; token: string }> = [];
  private stopCalls: string[] = [];

  constructor(initial: CalendarEvent[] = []) {
    this.events = [...initial];
    // null is always valid for full sync
    this.validTokens.add(null);
    this.validTokens.add(this.nextToken());
  }

  private nextToken(): string {
    this.tokenCounter += 1;
    const tok = `sync-${this.tokenCounter}`;
    this.validTokens.add(tok);
    return tok;
  }

  /** Replace the in-memory event list (simulates calendar edit). */
  setEvents(events: CalendarEvent[]): void {
    this.events = [...events];
  }

  /** Add or update one event. */
  upsertEvent(event: CalendarEvent): void {
    const idx = this.events.findIndex(
      (e) => e.eventId === event.eventId && e.occurrenceId === event.occurrenceId,
    );
    if (idx >= 0) this.events.splice(idx, 1, event);
    else this.events.push(event);
  }

  /** Remove one occurrence */
  removeOccurrence(eventId: string, occurrenceId: string): void {
    this.events = this.events.filter(
      (e) => !(e.eventId === eventId && e.occurrenceId === occurrenceId),
    );
  }

  /** Force the next listEvents with a syncToken to throw InvalidSyncTokenError */
  invalidateNextSync(): void {
    this.invalidNext = true;
  }

  /** Inspect watch/stop calls */
  getWatchCalls(): Array<{ channelId: string; token: string }> {
    return [...this.watchCalls];
  }
  getStopCalls(): string[] {
    return [...this.stopCalls];
  }

  async watchChannel(args: {
    calendarId: string;
    channelId: string;
    token: string;
  }): Promise<CalendarWatchResult> {
    this.watchCalls.push({ channelId: args.channelId, token: args.token });
    // Return a resourceId and expiration 7 days out
    const expiration = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return { resourceId: `res-${args.channelId}`, expiration };
  }

  async stopChannel(args: { channelId: string }): Promise<void> {
    this.stopCalls.push(args.channelId);
  }

  async listEvents(args: {
    calendarId: string;
    syncToken?: string | null;
  }): Promise<CalendarListResult> {
    const token = args.syncToken ?? null;
    if (this.invalidNext) {
      this.invalidNext = false;
      throw new InvalidSyncTokenError("invalid sync token (fake)");
    }
    if (token !== null && !this.validTokens.has(token)) {
      throw new InvalidSyncTokenError(`unknown syncToken ${token}`);
    }
    // For incremental vs full sync: return all current events
    // In real Google, incremental returns only changed; fake returns all and host will reconcile.
    const next = this.nextToken();
    // Clone events to avoid mutation
    const cloned = this.events.map((e) => ({
      ...e,
      attendees: e.attendees.map((a) => ({ ...a })),
    }));
    return { events: cloned, nextSyncToken: next };
  }
}
