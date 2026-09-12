import type { SourceLifecycleGrant, TranscriptRoutePolicy } from "@chief-of-staff-demo/shared";

/**
 * Known development models with specific retention policies (#341, #351).
 * None of the free campaign models (#363) is on OpenRouter's ZDR list, so each
 * dispatches only under a grant that carries the explicit non-ZDR exception.
 */
const NON_ZDR_MODELS_WITH_EXCEPTION = new Set([
  "nex-agi/nex-n2.5-mini:free",
  "thinkingmachines/inkling-small:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
]);

/**
 * Returns whether a model is considered ZDR-compliant or covered by an explicit exception (#341).
 */
export function isZdrCompliantModel(model: string, policy: TranscriptRoutePolicy): boolean {
  if (NON_ZDR_MODELS_WITH_EXCEPTION.has(model)) {
    return policy.allowNonZdrException === true;
  }
  // Standard development models DeepSeek and Nemotron are routed to ZDR endpoints.
  return true;
}

/**
 * Derives the default route policy for a development or production model (#341, #351).
 */
export function defaultRoutePolicyForModel(model: string): TranscriptRoutePolicy {
  if (NON_ZDR_MODELS_WITH_EXCEPTION.has(model)) {
    return {
      zdrRequired: false,
      dataCollection: "deny",
      allowNonZdrException: true,
    };
  }
  return {
    zdrRequired: true,
    dataCollection: "deny",
  };
}

export interface GrantVerificationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verifies that a source lifecycle grant authorizes dispatching source-derived
 * content to the given model and provider (#341, #356, MWR-051).
 */
export function verifySourceGrant(
  grant: SourceLifecycleGrant | null | undefined,
  model: string,
): GrantVerificationResult {
  if (!grant) {
    return {
      ok: false,
      reason: "No source lifecycle grant provided for transcript dispatch",
    };
  }
  if (grant.revokedAt !== null) {
    return {
      ok: false,
      reason: `Source lifecycle grant ${grant.id} was revoked at ${grant.revokedAt}`,
    };
  }
  if (
    grant.routePolicy.allowedEndpoints !== undefined &&
    grant.routePolicy.allowedEndpoints.length === 0
  ) {
    return {
      ok: false,
      reason: "Empty approved endpoints set; dispatch refused",
    };
  }
  if (grant.routePolicy.zdrRequired && !isZdrCompliantModel(model, grant.routePolicy)) {
    return {
      ok: false,
      reason: `Model ${model} does not satisfy required Zero Data Retention policy`,
    };
  }
  return { ok: true };
}

/**
 * Creates an active source lifecycle grant for an owner-consented transcript (#341, #356).
 */
export function createSourceLifecycleGrant(options: {
  id?: string;
  sourceId: string;
  purpose: SourceLifecycleGrant["purpose"];
  grantedBy?: string;
  model?: string;
  policy?: Partial<TranscriptRoutePolicy>;
}): SourceLifecycleGrant {
  const model = options.model ?? "default";
  const defaultPolicy = defaultRoutePolicyForModel(model);
  return {
    id: options.id ?? `grant_${options.sourceId}_${Date.now()}`,
    sourceId: options.sourceId,
    purpose: options.purpose,
    grantedBy: options.grantedBy ?? "owner",
    grantedAt: new Date().toISOString(),
    revokedAt: null,
    routePolicy: {
      ...defaultPolicy,
      ...options.policy,
    },
  };
}
