import { google } from "googleapis";
import type { GoogleAuth } from "../../../google/oauth.js";
import type { RunContext } from "../../../engine/module.js";
import type { MeetingBriefEnrichmentSection } from "@chief-of-staff-demo/shared";
import {
  GOOGLE_ENRICHMENT_MAX_GMAIL_COMPANY,
  GOOGLE_ENRICHMENT_MAX_GMAIL_EXACT,
  type GoogleEnrichmentArtifact,
  googleEnrichmentKey,
  googleEnrichmentStableRef,
} from "@chief-of-staff-demo/shared";

export interface GmailThread {
  id: string;
  snippet: string;
  messages?: Array<{ id: string; snippet: string }>;
}

export interface GmailProvider {
  listExactThreads(guestEmail: string, maxResults: number): Promise<GmailThread[]>;
  listCompanyThreads(companyDomain: string, maxResults: number): Promise<GmailThread[]>;
}

function sanitizeEvidence(text: string): string {
  // Treat provider content as untrusted evidence — truncate, strip control chars, keep as data.
  const truncated = text.slice(0, 500);
  // Remove control characters except newline/tab
  // eslint-disable-next-line no-control-regex
  return truncated.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function readErrorStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    if ("status" in error && typeof (error as Record<string, unknown>).status === "number")
      return (error as { status: number }).status;
    if ("code" in error && typeof (error as Record<string, unknown>).code === "number")
      return (error as { code: number }).code;
    if ("response" in error) {
      const resp = (error as { response?: { status?: number } }).response;
      if (resp && typeof resp.status === "number") return resp.status;
    }
  }
  return null;
}

function readErrorCode(error: unknown): string | null {
  if (error && typeof error === "object") {
    if ("code" in error && typeof (error as Record<string, unknown>).code === "string")
      return (error as { code: string }).code;
    if ("reason" in error && typeof (error as Record<string, unknown>).reason === "string")
      return (error as { reason: string }).reason;
    const nested = (
      error as { response?: { data?: { error?: { errors?: Array<{ reason?: string }> } } } }
    ).response?.data?.error?.errors?.[0]?.reason;
    if (typeof nested === "string") return nested;
  }
  return null;
}

function isProviderWideError(error: unknown): boolean {
  const status = readErrorStatus(error);
  const code = readErrorCode(error);
  const msg = error instanceof Error ? error.message : String(error);
  // 401 rejected, 403 missing authority/insufficientPermissions, 503 unavailable
  if (status === 401 || status === 403 || status === 503) return true;
  if (code === "insufficientPermissions" || code === "accessNotConfigured") return true;
  if (
    /invalid_grant|insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|has not been used in project|is disabled/i.test(
      msg,
    )
  )
    return true;
  return false;
}

export function createGmailProvider(auth: GoogleAuth): GmailProvider {
  return {
    async listExactThreads(guestEmail: string, maxResults: number): Promise<GmailThread[]> {
      const gmail = google.gmail({ version: "v1", auth });
      // Exact-address query: from:email OR to:email (bounded)
      const q = `{from:${guestEmail} to:${guestEmail}}`;
      const res = await gmail.users.threads.list({ userId: "me", q, maxResults });
      const threads = res.data.threads ?? [];
      return threads.slice(0, maxResults).map((t) => ({
        id: t.id ?? `thread-${Math.random()}`,
        snippet: t.snippet ?? "",
      }));
    },
    async listCompanyThreads(companyDomain: string, maxResults: number): Promise<GmailThread[]> {
      const gmail = google.gmail({ version: "v1", auth });
      const q = `{from:*@${companyDomain} to:*@${companyDomain}}`;
      const res = await gmail.users.threads.list({ userId: "me", q, maxResults });
      const threads = res.data.threads ?? [];
      return threads.slice(0, maxResults).map((t) => ({
        id: t.id ?? `thread-${Math.random()}`,
        snippet: t.snippet ?? "",
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Fake Gmail provider for host-seam tests (issue://85)
// ---------------------------------------------------------------------------

export type FakeGmailMode = "normal" | "unavailable";

export interface FakeGmailOptions {
  mode?: FakeGmailMode;
  // For individual failure simulation: map guestEmail lowercased to failure behavior
  failFirstFor?: Set<string>;
  // For unavailable global: throw for all
  unavailableError?: unknown;
  // Custom threads per guestEmail or company domain
  exactThreads?: Map<string, GmailThread[]>;
  companyThreads?: Map<string, GmailThread[]>;
  // Global delay or count
  callCounts?: Map<string, number>;
}

export class FakeGmailProvider implements GmailProvider {
  private mode: FakeGmailMode;
  private failFirstFor: Set<string>;
  private unavailableError: unknown;
  private exactThreads: Map<string, GmailThread[]>;
  private companyThreads: Map<string, GmailThread[]>;
  private callCounts = new Map<string, number>();
  private failCounts = new Map<string, number>();

  constructor(opts: FakeGmailOptions = {}) {
    this.mode = opts.mode ?? "normal";
    this.failFirstFor = new Set([...(opts.failFirstFor ?? [])].map((s) => s.toLowerCase()));
    this.unavailableError =
      opts.unavailableError ??
      Object.assign(new Error("Gmail unavailable"), { status: 503, code: 503 });
    this.exactThreads = opts.exactThreads ?? new Map<string, GmailThread[]>();
    this.companyThreads = opts.companyThreads ?? new Map<string, GmailThread[]>();
  }

  setExactThreads(guestEmail: string, threads: GmailThread[]): void {
    this.exactThreads.set(guestEmail.toLowerCase(), threads);
  }

  setCompanyThreads(domain: string, threads: GmailThread[]): void {
    this.companyThreads.set(domain.toLowerCase(), threads);
  }

  setMode(mode: FakeGmailMode): void {
    this.mode = mode;
  }

  addFailFirstFor(guestEmail: string): void {
    this.failFirstFor.add(guestEmail.toLowerCase());
  }

  getCallCount(key: string): number {
    return this.callCounts.get(key) ?? 0;
  }

  async listExactThreads(guestEmail: string, maxResults: number): Promise<GmailThread[]> {
    void maxResults;
    const key = `exact:${guestEmail.toLowerCase()}`;
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    if (this.mode === "unavailable") throw this.unavailableError;
    const count = this.failCounts.get(key) ?? 0;
    if (this.failFirstFor.has(guestEmail.toLowerCase()) && count === 0) {
      this.failCounts.set(key, count + 1);
      throw Object.assign(new Error("transient gmail exact failure"), { status: 500 });
    }
    const all =
      this.exactThreads.get(guestEmail.toLowerCase()) ?? this.generateDefaultExact(guestEmail);
    // Deduplicate by id preserving order, then bound
    const seen = new Set<string>();
    const deduped: GmailThread[] = [];
    for (const t of all) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        deduped.push(t);
      }
    }
    return deduped;
  }

  async listCompanyThreads(companyDomain: string, maxResults: number): Promise<GmailThread[]> {
    void maxResults;
    const key = `company:${companyDomain.toLowerCase()}`;
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    if (this.mode === "unavailable") throw this.unavailableError;
    const count = this.failCounts.get(key) ?? 0;
    if (this.failFirstFor.has(companyDomain.toLowerCase()) && count === 0) {
      this.failCounts.set(key, count + 1);
      throw Object.assign(new Error("transient gmail company failure"), { status: 500 });
    }
    const all =
      this.companyThreads.get(companyDomain.toLowerCase()) ??
      this.generateDefaultCompany(companyDomain);
    const seen = new Set<string>();
    const deduped: GmailThread[] = [];
    for (const t of all) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        deduped.push(t);
      }
    }
    return deduped;
  }

  private generateDefaultExact(guestEmail: string): GmailThread[] {
    void guestEmail;
    // Default fixture: 2 threads for matching tests, empty for others unless overridden
    // For generic tests, return empty to test empty success unless set.
    return [];
  }

  private generateDefaultCompany(domain: string): GmailThread[] {
    void domain;
    return [];
  }
}

export async function enrichGmailExact(
  provider: GmailProvider,
  eventVersion: string,
  guestEmail: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{ artifact: GoogleEnrichmentArtifact; section: MeetingBriefEnrichmentSection }> {
  const normalized = guestEmail.toLowerCase();
  const key = googleEnrichmentKey(eventVersion, normalized, "gmail-exact");
  const stableRef = googleEnrichmentStableRef(eventVersion, normalized, "gmail-exact");
  const maxResults = GOOGLE_ENRICHMENT_MAX_GMAIL_EXACT;
  let lastError: unknown = null;
  const maxAttempts = 2;

  // Same-version retry preservation: if artifact exists and is completed/empty, reuse without calling provider.
  const existingRaw = ctx.readFile(
    `gmail-exact-${normalized.replace(/[^a-z0-9]/g, "_")}-${eventVersion}.json`,
  );
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as GoogleEnrichmentArtifact;
      if (
        existing.eventVersion === eventVersion &&
        (existing.status === "completed" || existing.status === "empty")
      ) {
        // Preserve completed/empty without crossing revision
        const section: MeetingBriefEnrichmentSection = {
          source: "gmail-exact",
          guest: normalized,
          status: existing.status,
          evidence: existing.evidence,
          references: existing.references,
        };
        return { artifact: existing, section };
      }
    } catch {
      // ignore parse failure, re-enrich
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attempts = attempt;
    try {
      const threads = await provider.listExactThreads(normalized, maxResults);
      if (threads.length === 0) {
        const artifact: GoogleEnrichmentArtifact = {
          key,
          eventVersion,
          guestEmail: normalized,
          source: "gmail-exact",
          status: "empty",
          evidence: [],
          references: [],
          diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, attempts },
          stableRef,
        };
        const filename = `gmail-exact-${normalized.replace(/[^a-z0-9]/g, "_")}-${eventVersion}.json`;
        ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
        ctx.event("gmail_exact_empty", { guest: normalized, eventVersion, attempts });
        const section: MeetingBriefEnrichmentSection = {
          source: "gmail-exact",
          guest: normalized,
          status: "empty",
          evidence: [],
          references: [],
        };
        return { artifact, section };
      }
      // Deduplicate already done by provider, but double-check
      const seen = new Set<string>();
      const deduped: GmailThread[] = [];
      for (const t of threads) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          deduped.push(t);
        }
      }
      const limited = deduped.slice(0, maxResults);
      const truncated = deduped.length > maxResults || threads.length > maxResults;
      const evidence = limited.map((t) =>
        sanitizeEvidence(t.snippet || `Gmail thread ${t.id} with ${normalized}`),
      );
      const references = limited.map((t) => `https://mail.google.com/mail/u/0/#inbox/${t.id}`);
      const artifact: GoogleEnrichmentArtifact = {
        key,
        eventVersion,
        guestEmail: normalized,
        source: "gmail-exact",
        status: "completed",
        evidence,
        references,
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          untrusted: true,
          ...(truncated ? { truncated: true } : {}),
          attempts,
        },
        stableRef,
      };
      const filename = `gmail-exact-${normalized.replace(/[^a-z0-9]/g, "_")}-${eventVersion}.json`;
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("gmail_exact_completed", {
        guest: normalized,
        count: evidence.length,
        truncated: !!truncated,
      });
      const section: MeetingBriefEnrichmentSection = {
        source: "gmail-exact",
        guest: normalized,
        status: "completed",
        evidence,
        references,
      };
      return { artifact, section };
    } catch (error) {
      lastError = error;
      if (isProviderWideError(error)) {
        // Provider-wide unavailable should fail whole enrich stage, not just this guest
        throw error;
      }
      if (attempts < maxAttempts) {
        ctx.event("gmail_exact_retry", {
          guest: normalized,
          attempt: attempts,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const httpStatus = readErrorStatus(error);
      const errorCode = readErrorCode(error);
      const reason = error instanceof Error ? error.message : String(error);
      const artifact: GoogleEnrichmentArtifact = {
        key,
        eventVersion,
        guestEmail: normalized,
        source: "gmail-exact",
        status: "failed",
        evidence: [],
        references: [],
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          httpStatus,
          errorCode,
          reason: reason.slice(0, 500),
          untrusted: true,
          attempts,
        },
        stableRef,
      };
      const filename = `gmail-exact-${normalized.replace(/[^a-z0-9]/g, "_")}-${eventVersion}.json`;
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("gmail_exact_failed", { guest: normalized, error: reason.slice(0, 200), attempts });
      const section: MeetingBriefEnrichmentSection = {
        source: "gmail-exact",
        guest: normalized,
        status: "failed",
        evidence: [],
        references: [],
      };
      return { artifact, section };
    }
  }
  throw lastError;
}

export async function enrichGmailCompanyDomain(
  provider: GmailProvider,
  eventVersion: string,
  guestEmail: string,
  companyDomain: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{ artifact: GoogleEnrichmentArtifact; section: MeetingBriefEnrichmentSection }> {
  const normalizedGuest = guestEmail.toLowerCase();
  const normalizedDomain = companyDomain.toLowerCase();
  const key = googleEnrichmentKey(
    eventVersion,
    normalizedGuest,
    "gmail-company-domain",
    normalizedDomain,
  );
  const stableRef = googleEnrichmentStableRef(
    eventVersion,
    normalizedGuest,
    "gmail-company-domain",
    normalizedDomain,
  );
  const maxResults = GOOGLE_ENRICHMENT_MAX_GMAIL_COMPANY;

  const sanitizedGuest = normalizedGuest.replace(/[^a-z0-9]/g, "_");
  const sanitizedDomain = normalizedDomain.replace(/[^a-z0-9]/g, "_");
  const filename = `gmail-company-${sanitizedGuest}-${sanitizedDomain}-${eventVersion}.json`;
  const existingRaw = ctx.readFile(filename);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as GoogleEnrichmentArtifact;
      if (
        existing.eventVersion === eventVersion &&
        (existing.status === "completed" || existing.status === "empty")
      ) {
        const section: MeetingBriefEnrichmentSection = {
          source: "gmail-company-domain",
          guest: normalizedGuest,
          company: normalizedDomain,
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

  let lastError: unknown = null;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attempts = attempt;
    try {
      const threads = await provider.listCompanyThreads(normalizedDomain, maxResults);
      if (threads.length === 0) {
        const artifact: GoogleEnrichmentArtifact = {
          key,
          eventVersion,
          guestEmail: normalizedGuest,
          companyDomain: normalizedDomain,
          source: "gmail-company-domain",
          status: "empty",
          evidence: [],
          references: [],
          diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, attempts },
          stableRef,
        };
        ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
        ctx.event("gmail_company_empty", {
          guest: normalizedGuest,
          domain: normalizedDomain,
          attempts,
        });
        return {
          artifact,
          section: {
            source: "gmail-company-domain",
            guest: normalizedGuest,
            company: normalizedDomain,
            status: "empty",
            evidence: [],
            references: [],
          },
        };
      }
      const seen = new Set<string>();
      const deduped: GmailThread[] = [];
      for (const t of threads) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          deduped.push(t);
        }
      }
      const limited = deduped.slice(0, maxResults);
      const truncated = deduped.length > maxResults;
      const evidence = limited.map((t) =>
        sanitizeEvidence(t.snippet || `Company Gmail thread ${t.id} @${normalizedDomain}`),
      );
      const references = limited.map((t) => `https://mail.google.com/mail/u/0/#inbox/${t.id}`);
      const artifact: GoogleEnrichmentArtifact = {
        key,
        eventVersion,
        guestEmail: normalizedGuest,
        companyDomain: normalizedDomain,
        source: "gmail-company-domain",
        status: "completed",
        evidence,
        references,
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          untrusted: true,
          ...(truncated ? { truncated: true } : {}),
          attempts,
        },
        stableRef,
      };
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("gmail_company_completed", {
        guest: normalizedGuest,
        domain: normalizedDomain,
        count: evidence.length,
      });
      return {
        artifact,
        section: {
          source: "gmail-company-domain",
          guest: normalizedGuest,
          company: normalizedDomain,
          status: "completed",
          evidence,
          references,
        },
      };
    } catch (error) {
      lastError = error;
      if (isProviderWideError(error)) throw error;
      if (attempts < maxAttempts) {
        ctx.event("gmail_company_retry", {
          guest: normalizedGuest,
          domain: normalizedDomain,
          attempt: attempts,
        });
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
        source: "gmail-company-domain",
        status: "failed",
        evidence: [],
        references: [],
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          httpStatus,
          errorCode,
          reason: reason.slice(0, 500),
          untrusted: true,
          attempts,
        },
        stableRef,
      };
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("gmail_company_failed", {
        guest: normalizedGuest,
        domain: normalizedDomain,
        error: reason.slice(0, 200),
      });
      return {
        artifact,
        section: {
          source: "gmail-company-domain",
          guest: normalizedGuest,
          company: normalizedDomain,
          status: "failed",
          evidence: [],
          references: [],
        },
      };
    }
  }
  throw lastError;
}
