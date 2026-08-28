import { google } from "googleapis";
import type { GoogleAuth } from "../../../google/oauth.js";
import {
  GOOGLE_ENRICHMENT_MAX_DRIVE_DOCS,
  type GoogleEnrichmentArtifact,
  googleEnrichmentKey,
  googleEnrichmentStableRef,
} from "@chief-of-staff-demo/shared";
import type { RunContext } from "../../../engine/module.js";
import type { MeetingBriefEnrichmentSection } from "@chief-of-staff-demo/shared";

export interface DriveDoc {
  id: string;
  name: string;
  webViewLink: string;
}

export interface DriveProvider {
  searchDocs(query: string, maxResults: number): Promise<DriveDoc[]>;
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

export function createDriveProvider(auth: GoogleAuth): DriveProvider {
  return {
    async searchDocs(query: string, maxResults: number): Promise<DriveDoc[]> {
      const drive = google.drive({ version: "v3", auth });
      const res = await drive.files.list({
        q: query,
        pageSize: maxResults,
        fields: "files(id, name, webViewLink)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const files = res.data.files ?? [];
      return files.slice(0, maxResults).map((f) => ({
        id: f.id ?? `doc-${Math.random()}`,
        name: (f.name ?? ""),
        webViewLink: (f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`),
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Fake
// ---------------------------------------------------------------------------

export type FakeDriveMode = "normal" | "unavailable";

export interface FakeDriveOptions {
  mode?: FakeDriveMode;
  failFirstFor?: Set<string>;
  unavailableError?: unknown;
  docs?: Map<string, DriveDoc[]>;
}

export class FakeDriveProvider implements DriveProvider {
  private mode: FakeDriveMode;
  private failFirstFor: Set<string>;
  private unavailableError: unknown;
  private docs: Map<string, DriveDoc[]>;
  private callCounts = new Map<string, number>();
  private failCounts = new Map<string, number>();

  constructor(opts: FakeDriveOptions = {}) {
    this.mode = opts.mode ?? "normal";
    this.failFirstFor = new Set([...(opts.failFirstFor ?? [])].map((s) => s.toLowerCase()));
    this.unavailableError = opts.unavailableError ?? Object.assign(new Error("Drive unavailable"), { status: 503, code: 503 });
    this.docs = opts.docs ?? new Map();
  }

  setDocs(queryKey: string, docs: DriveDoc[]): void {
    this.docs.set(queryKey.toLowerCase(), docs);
  }

  setMode(mode: FakeDriveMode): void {
    this.mode = mode;
  }

  addFailFirstFor(queryKey: string): void {
    this.failFirstFor.add(queryKey.toLowerCase());
  }

  getCallCount(queryKey: string): number {
    return this.callCounts.get(queryKey.toLowerCase()) ?? 0;
  }

  async searchDocs(query: string, maxResults: number): Promise<DriveDoc[]> {
    void maxResults;
    const key = query.toLowerCase();
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    if (this.mode === "unavailable") throw this.unavailableError;
    const count = this.failCounts.get(key) ?? 0;
    if (this.failFirstFor.has(key) && count === 0) {
      this.failCounts.set(key, count + 1);
      throw Object.assign(new Error("transient drive failure"), { status: 500 });
    }
    const all = this.docs.get(key) ?? [];
    const seen = new Set<string>();
    const deduped: DriveDoc[] = [];
    for (const d of all) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        deduped.push(d);
      }
    }
    return deduped;
  }
}

export async function enrichDriveDocs(
  provider: DriveProvider,
  eventVersion: string,
  guestEmail: string,
  companyDomain: string | null,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{ artifact: GoogleEnrichmentArtifact; section: MeetingBriefEnrichmentSection }> {
  const normalizedGuest = guestEmail.toLowerCase();
  const normalizedDomain = companyDomain ? companyDomain.toLowerCase() : null;
  // Drive artifact keyed by guest + company presence; if companyDomain present, include it
  const source = "drive-docs" as const;
  const key = googleEnrichmentKey(eventVersion, normalizedGuest, source, normalizedDomain);
  const stableRef = googleEnrichmentStableRef(eventVersion, normalizedGuest, source, normalizedDomain);
  const maxResults = GOOGLE_ENRICHMENT_MAX_DRIVE_DOCS;
  const sanitizedGuest = normalizedGuest.replace(/[^a-z0-9]/g, "_");
  const sanitizedDomain = normalizedDomain ? normalizedDomain.replace(/[^a-z0-9]/g, "_") : "person";
  const filename = `drive-${sanitizedGuest}-${sanitizedDomain}-${eventVersion}.json`;

  const existingRaw = ctx.readFile(filename);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as GoogleEnrichmentArtifact;
      if (existing.eventVersion === eventVersion && (existing.status === "completed" || existing.status === "empty")) {
        const section = {
          source,
          guest: normalizedGuest,
          ...(normalizedDomain ? { company: normalizedDomain } : {}),
          status: existing.status,
          evidence: existing.evidence,
          references: existing.references,
        } as MeetingBriefEnrichmentSection;
        return { artifact: existing, section };
      }
    } catch {
      // re-enrich
    }
  }

  // Build bounded query: for company domain, search for Drive docs containing company domain or guest email
  // For consumer domains, only guest-specific query
  const queryParts: string[] = [];
  if (normalizedDomain) {
    queryParts.push(`fullText contains '${normalizedDomain}'`);
    queryParts.push(`fullText contains '${normalizedGuest}'`);
  } else {
    queryParts.push(`fullText contains '${normalizedGuest}'`);
  }
  const query = queryParts.join(" or ");

  let attempts = 0;
  let lastError: unknown = null;
  const maxAttempts = 2;
  for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
    try {
      const docs = await provider.searchDocs(query, maxResults);
      if (docs.length === 0) {
        const artifact: GoogleEnrichmentArtifact = {
          key,
          eventVersion,
          guestEmail: normalizedGuest,
          companyDomain: normalizedDomain,
          source,
          status: "empty",
          evidence: [],
          references: [],
          diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, attempts },
          stableRef,
        };
        ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
        ctx.event("drive_empty", { guest: normalizedGuest, domain: normalizedDomain, attempts });
        return {
          artifact,
          section: { source, guest: normalizedGuest, ...(normalizedDomain ? { company: normalizedDomain } : {}), status: "empty", evidence: [], references: [] },
        };
      }
      const limited = docs.slice(0, maxResults);
      const truncated = docs.length > maxResults;
      const evidence = limited.map((d) => sanitizeEvidence(d.name || `Doc ${d.id}`));
      const references = limited.map((d) => d.webViewLink);
      const artifact: GoogleEnrichmentArtifact = {
        key,
        eventVersion,
        guestEmail: normalizedGuest,
        companyDomain: normalizedDomain,
        source,
        status: "completed",
        evidence,
        references,
        diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, ...(truncated ? { truncated: true } : {}), attempts },
        stableRef,
      };
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("drive_completed", { guest: normalizedGuest, domain: normalizedDomain, count: evidence.length });
      return {
        artifact,
        section: { source, guest: normalizedGuest, ...(normalizedDomain ? { company: normalizedDomain } : {}), status: "completed", evidence, references },
      };
    } catch (error) {
      lastError = error;
      if (isProviderWideError(error)) throw error;
      if (attempts < maxAttempts) {
        ctx.event("drive_retry", { guest: normalizedGuest, attempt: attempts });
        continue;
      }
      const httpStatus = readErrorStatus(error);
      const errorCode = readErrorCode(error);
      const reason = error instanceof Error ? error.message : String(error);
      const artifact: GoogleEnrichmentArtifact = {
        key,
        eventVersion,
        guestEmail: normalizedGuest,
        companyDomain: normalizedDomain,
        source,
        status: "failed",
        evidence: [],
        references: [],
        diagnostics: { bounded: true, maxResults, stableRef, httpStatus, errorCode, reason: reason.slice(0, 500), untrusted: true, attempts },
        stableRef,
      };
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("drive_failed", { guest: normalizedGuest, error: reason.slice(0, 200) });
      return {
        artifact,
        section: { source, guest: normalizedGuest, ...(normalizedDomain ? { company: normalizedDomain } : {}), status: "failed", evidence: [], references: [] },
      };
    }
  }
  throw lastError;
}
