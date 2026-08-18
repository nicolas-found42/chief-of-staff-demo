import type { AppConfig } from "@transcript-tasks/shared";
import type { RunSourceSpec } from "../pipeline/run.js";
import { sentencesToText } from "../text/convert.js";
import { loadState, saveState } from "../state.js";
import { workspaceLayout } from "../paths.js";

const GRAPHQL_URL = "https://api.fireflies.ai/graphql";

const LIST_QUERY =
  "query($from: DateTime!) { transcripts(fromDate: $from, limit: 50) { id title date } }";

const TRANSCRIPT_QUERY =
  "query($id: String!) { transcript(id: $id) { id title date transcript_url meeting_attendees { displayName email } sentences { index speaker_name text start_time } } }";

/** 24h lookback + id dedupe covers late-processed meetings. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

const MAX_INGESTED = 1000;

export class FirefliesError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "FirefliesError";
  }
}

interface FirefliesSentence {
  index?: unknown;
  speaker_name?: unknown;
  text?: unknown;
  start_time?: unknown;
}

interface FirefliesTranscript {
  id: string;
  title: string;
  date?: unknown;
  transcript_url?: string | null;
  meeting_attendees?: { displayName?: string | null; email?: string | null }[];
  sentences?: FirefliesSentence[];
}

interface FirefliesListing {
  id: string;
  title: string;
  date?: unknown;
}

/**
 * Fireflies `date` is epoch-ish; values below 1e12 are seconds.
 * Strings are parsed as ISO/other parseable date text.
 */
export function normalizeFirefliesDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

export interface FirefliesIntakeDeps {
  getConfig: () => AppConfig;
  workspaceDir: string;
  startRun: (spec: RunSourceSpec) => Promise<string>;
  log: (message: string) => void;
}

async function firefliesGql(
  query: string,
  variables: Record<string, unknown>,
  apiKey: string
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new FirefliesError(
      `Fireflies request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const text = await response.text();
  if (response.status === 401) {
    throw new FirefliesError("Fireflies rejected the API key (401)", 401);
  }
  if (!response.ok) {
    throw new FirefliesError(`Fireflies HTTP ${response.status}: ${text.slice(0, 200)}`, response.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FirefliesError("Fireflies returned a non-JSON body");
  }
  if (
    typeof parsed === "object" && parsed !== null && "errors" in parsed &&
    Array.isArray(parsed.errors) && parsed.errors.length > 0
  ) {
    const first = parsed.errors[0];
    const message =
      typeof first === "object" && first !== null && "message" in first && typeof first.message === "string"
        ? first.message
        : JSON.stringify(first);
    throw new FirefliesError(`Fireflies GraphQL error: ${message}`);
  }
  if (typeof parsed === "object" && parsed !== null && "data" in parsed) {
    return (parsed as { data: Record<string, unknown> }).data;
  }
  throw new FirefliesError("Fireflies response has no data field");
}

export class FirefliesIntake {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: FirefliesIntakeDeps) {}

  /** (Re)start or stop polling according to the current config. */
  start(): void {
    this.stop();
    const config = this.deps.getConfig();
    if (!config.fireflies.enabled || !config.fireflies.apiKey) {
      return;
    }
    const intervalMs = config.fireflies.pollIntervalMinutes * 60_000;
    this.timer = setInterval(() => {
      this.pollSafely();
    }, intervalMs);
    this.pollSafely();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private pollSafely(): void {
    this.pollOnce().catch((error) => {
      if (error instanceof FirefliesError && error.status === 401) {
        this.stop();
        this.deps.log(
          "Fireflies key rejected (401). Polling disabled — fix the API key in Settings."
        );
        return;
      }
      this.deps.log(
        `Fireflies poll failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  async pollOnce(): Promise<{ created: number }> {
    const config = this.deps.getConfig();
    if (!config.fireflies.apiKey) {
      throw new FirefliesError("Fireflies API key is not configured");
    }
    const layout = workspaceLayout(this.deps.workspaceDir);
    try {
      const created = await this.ingestNewTranscripts(config.fireflies.apiKey);
      return { created };
    } finally {
      const state = loadState(layout.stateFile);
      state.fireflies.lastPollAt = new Date().toISOString();
      saveState(layout.stateFile, state);
    }
  }

  private async ingestNewTranscripts(apiKey: string): Promise<number> {
    const layout = workspaceLayout(this.deps.workspaceDir);
    const state = loadState(layout.stateFile);
    const ingested = new Set(state.fireflies.ingestedIds);
    const data = await firefliesGql(
      LIST_QUERY,
      { from: new Date(Date.now() - LOOKBACK_MS).toISOString() },
      apiKey
    );
    const listing = Array.isArray(data.transcripts) ? (data.transcripts as unknown[]) : [];
    const fresh = listing
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" &&
          entry !== null &&
          "id" in entry &&
          typeof entry.id === "string" &&
          !ingested.has(entry.id)
      )
      .sort((a, b) => Number(a.date ?? 0) - Number(b.date ?? 0));

    let created = 0;
    for (const entry of fresh) {
      const full = await firefliesGql(TRANSCRIPT_QUERY, { id: entry.id }, apiKey);
      const raw = full.transcript;
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const transcript = raw as FirefliesTranscript;
      if (typeof transcript.id !== "string") {
        continue;
      }
      const text = sentencesToText(transcript.sentences ?? []);
      await this.deps.startRun({
        type: "fireflies",
        fileName: transcript.title || (typeof entry.title === "string" ? entry.title : "") || transcript.id,
        text,
        sourceUrl: transcript.transcript_url ?? null,
        externalId: transcript.id,
        context: {
          meetingDate: normalizeFirefliesDate(transcript.date ?? entry.date),
          attendees: (transcript.meeting_attendees ?? []).map((attendee) => ({
            name: attendee.displayName ?? "",
            email: attendee.email ?? null,
          })),
        },
      });
      created += 1;
      // Mark ingested at run creation: retry is run-level, never re-ingest.
      ingested.add(transcript.id);
      state.fireflies.ingestedIds.push(transcript.id);
      if (state.fireflies.ingestedIds.length > MAX_INGESTED) {
        state.fireflies.ingestedIds.splice(0, state.fireflies.ingestedIds.length - MAX_INGESTED);
      }
      saveState(layout.stateFile, state);
    }
    return created;
  }
}
