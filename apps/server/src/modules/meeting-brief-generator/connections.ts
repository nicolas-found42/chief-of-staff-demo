import type { ConfigStore } from "../../config.js";
import { HubSpotConnection } from "./hubspot/connection.js";
import type { HubSpotStatus, HubSpotSetupCheck } from "@chief-of-staff-demo/shared";

/**
 * Meeting Brief Generator connections — Shell-credential/Module-call boundary.
 *
 * Shell owns: HubSpot private-app token (secret), classification of state.
 * Module owns: query semantics (contact/company/deal lookup via HubSpotApi).
 *
 * No shared Found42 credential is ever used; each workspace supplies its own
 * private-app token via Settings. Token is never returned verbatim — status
 * routes expose only a redacted hint.
 */

export function hubSpotStatus(configStore: ConfigStore, now?: () => Date): HubSpotStatus {
  return new HubSpotConnection(configStore, undefined, now).status();
}

export function hubSpotSetupProbe(
  configStore: ConfigStore,
  now?: () => Date,
  probeFactory?: ConstructorParameters<typeof HubSpotConnection>[1],
): Promise<HubSpotSetupCheck> {
  return new HubSpotConnection(configStore, probeFactory, now).verifySetup();
}

export function normalizeInternalDomains(domains: string[]): string[] {
  return domains
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0)
    .filter((d, idx, arr) => arr.indexOf(d) === idx)
    .sort();
}

/**
 * Classification helpers for HubSpot errors — keep at failure site (ADR-0008).
 * Delegates to HubSpotConnection's classifier for single source of truth.
 */
export { classifyHubSpotProbeError } from "./hubspot/connection.js";
