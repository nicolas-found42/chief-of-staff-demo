/* eslint-disable no-control-regex, @typescript-eslint/no-unnecessary-condition -- helpers handle nullable provider errors and sanitization */
/**
 * Shared enrichment helpers — deduplicated from enrich.ts and publicIntelligence.ts
 * (sanitizeEvidence, readErrorStatus, readErrorCode, isProviderWideError, deduplicateEvidence)
 */

export function sanitizeEvidence(text: string): string {
  return text
    .slice(0, 500)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .trim();
}

export function readErrorStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const v = (error as Record<string, unknown>).status;
    if (typeof v === "number") return v;
  }
  if (error && typeof error === "object" && "httpStatus" in error) {
    const v = (error as Record<string, unknown>).httpStatus;
    if (typeof v === "number") return v;
  }
  if (error && typeof error === "object" && "diagnostics" in error) {
    const diag = (error as Record<string, unknown>).diagnostics;
    if (diag && typeof diag === "object" && "statusCode" in (diag as Record<string, unknown>)) {
      const v = (diag as Record<string, unknown>).statusCode;
      if (typeof v === "number") return v;
    }
  }
  if (error && typeof error === "object" && "response" in error) {
    const resp = (error as { response?: { status?: number } }).response;
    if (resp && typeof resp.status === "number") return resp.status;
  }
  return null;
}

export function readErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "category" in error) {
    const v = (error as Record<string, unknown>).category;
    if (typeof v === "string") return v;
  }
  if (error && typeof error === "object" && "code" in error) {
    const v = (error as Record<string, unknown>).code;
    if (typeof v === "string") return v;
  }
  if (error && typeof error === "object" && "errorCode" in error) {
    const v = (error as Record<string, unknown>).errorCode;
    if (typeof v === "string") return v;
  }
  return null;
}

export function isProviderWideError(error: unknown): boolean {
  const maybe = error as { status?: number; code?: number; response?: { status?: number } };
  const status = maybe?.status ?? maybe?.code ?? maybe?.response?.status ?? readErrorStatus(error);
  const msg = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403 || status === 503) return true;
  if (
    /invalid_grant|insufficient authentication|ACCESS_TOKEN|accessNotConfigured|has not been used|is disabled|not configured|missing_configuration|rejected|unavailable|missing_authority/i.test(
      msg,
    )
  )
    return true;
  const code = readErrorCode(error);
  if (code && /rejected|missing_authority|unavailable|missing_configuration/i.test(code))
    return true;
  return false;
}

export function deduplicateEvidence(evidence: string[]): string[] {
  const seen = new Map<string, string>();
  for (const e of evidence) {
    const key = e.toLowerCase().trim().replace(/\s+/g, " ");
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}
