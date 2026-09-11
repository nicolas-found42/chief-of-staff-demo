import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CampaignManifestSchema,
  type CampaignFreezeFacts,
  type CampaignManifest,
  type CampaignProtocol,
  type CampaignSlot,
} from "@chief-of-staff-demo/shared";

/**
 * The frozen campaign manifest (#363, MWR-017/019).
 *
 * The manifest is written once, before the first dispatch, and every later run
 * reads it instead of rewriting it. Its digest covers the frozen facts and the
 * planned slots, so a request whose configuration changed after the freeze is
 * refused rather than silently recorded as the same campaign.
 */

export class CampaignManifestExistsError extends Error {
  constructor(readonly path: string) {
    super(`A campaign manifest already exists at ${path}; a frozen campaign is never rewritten.`);
    this.name = "CampaignManifestExistsError";
  }
}

export class CampaignManifestMismatchError extends Error {
  constructor(readonly changed: string[]) {
    super(
      `The frozen campaign manifest does not match the requested plan (${changed.join(", ")}); start a new campaign instead of reusing this record.`,
    );
    this.name = "CampaignManifestMismatchError";
  }
}

export class CampaignManifestCorruptError extends Error {
  constructor(readonly path: string) {
    super(`The campaign manifest at ${path} does not match its recorded digest.`);
    this.name = "CampaignManifestCorruptError";
  }
}

/** Deterministic JSON: object keys sorted at every depth, so a digest is stable. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** The plan's identity: freeze facts and slots, without the moment it was frozen. */
function manifestDigest(manifest: Omit<CampaignManifest, "digest">): string {
  const { createdAt: _createdAt, ...plan } = manifest;
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

export interface FreezeCampaignManifestInput {
  campaignId: string;
  protocol: CampaignProtocol;
  createdAt: string;
  freeze: CampaignFreezeFacts;
  slots: CampaignSlot[];
}

export function freezeCampaignManifest(input: FreezeCampaignManifestInput): CampaignManifest {
  const withoutDigest = {
    manifestVersion: 1 as const,
    campaignId: input.campaignId,
    protocol: input.protocol,
    createdAt: input.createdAt,
    freeze: input.freeze,
    slots: input.slots,
  };
  return CampaignManifestSchema.parse({
    ...withoutDigest,
    digest: manifestDigest(withoutDigest),
  });
}

function campaignManifestPath(campaignDir: string): string {
  return join(campaignDir, "manifest.json");
}

/** Writes the manifest exclusively: an existing freeze is never overwritten. */
export function writeCampaignManifest(campaignDir: string, manifest: CampaignManifest): string {
  mkdirSync(campaignDir, { recursive: true });
  const path = campaignManifestPath(campaignDir);
  try {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CampaignManifestExistsError(path);
    }
    throw error;
  }
  return path;
}

export function readCampaignManifest(campaignDir: string): CampaignManifest {
  const path = campaignManifestPath(campaignDir);
  if (!existsSync(path)) throw new CampaignManifestCorruptError(path);
  let parsed: CampaignManifest;
  try {
    parsed = CampaignManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new CampaignManifestCorruptError(path);
  }
  const { digest, ...withoutDigest } = parsed;
  if (manifestDigest(withoutDigest) !== digest) throw new CampaignManifestCorruptError(path);
  return parsed;
}

/**
 * Refuses a request that is not the campaign the manifest froze. The changed
 * fields are named; nothing from either side is quoted into the error.
 */
export function assertManifestMatchesPlan(
  manifest: CampaignManifest,
  requested: Pick<FreezeCampaignManifestInput, "protocol" | "freeze" | "slots">,
): void {
  const changed: string[] = [];
  if (manifest.protocol !== requested.protocol) changed.push("protocol");
  if (canonicalJson(manifest.freeze) !== canonicalJson(requested.freeze)) changed.push("freeze");
  const frozenSlotIds = manifest.slots.map((slot) => slot.slotId);
  const requestedSlotIds = requested.slots.map((slot) => slot.slotId);
  if (canonicalJson(frozenSlotIds) !== canonicalJson(requestedSlotIds)) changed.push("slots");
  if (changed.length > 0) throw new CampaignManifestMismatchError(changed);
}
