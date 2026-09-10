import { createHash } from "node:crypto";
import type {
  ActionItem,
  ActionItemMaterializationMapping,
  ActionItemOccurrence,
  MeetingHandoff,
  TaskResponsiblePerson,
} from "@chief-of-staff-demo/shared";

/**
 * Exact materialization (#355, MWR-010): a checked extraction entry becomes a
 * Workspace record under a versioned key, and the key is derived from the
 * artifact scope and the entry's own checked content — never from mutable
 * display fields, and never from an array position alone.
 *
 * The rules the callers rely on:
 *
 * - Replaying a key returns the mapping it already has, so a retry, a restart
 *   or a repeated recovery allocates nothing.
 * - The same key with a different payload checksum is an integrity error, not
 *   a silent overwrite: the entry under that key is not the entry that was
 *   checked.
 * - Identical content at two places in one checked output is two entries, not
 *   one: the ordinal among identical payloads is part of the entry id.
 */

/** The key format this build allocates and reads. */
const MATERIALIZATION_KEY_VERSION = 1;

/** The checked content of one output entry, in the shape it was verified in. */
export interface CheckedEntryPayload {
  title: string;
  owner: string | null;
  ownerMentionId: string | null;
  ownerProfileId: string | null;
  dueDate: string | null;
  /** Handoff notes derived from the checked handoff; empty when there is none. */
  notes: string;
  responsiblePerson: TaskResponsiblePerson | null;
  occurrence: ActionItemOccurrence;
  /**
   * The checked handoff this entry was extracted with, or null when the
   * extraction produced none. It is part of the checked content on purpose:
   * the commitment and responsibility basis it records are what review and
   * automatic promotion read, so two entries that agree on every displayed
   * field and disagree here are two entries, not one.
   */
  handoff: MeetingHandoff | null;
}

/** One checked output entry with the local accounting the pipeline kept for it. */
export interface CheckedOutputEntry {
  /** The extraction pipeline's own candidate id; local accounting, never an identity. */
  candidateAlias: string | null;
  payload: CheckedEntryPayload;
}

/** An entry's stored mapping disagrees with the entry itself. */
export class MaterializationIntegrityError extends Error {
  constructor(
    public readonly key: string,
    detail: string,
  ) {
    super(`Action Item materialization is not consistent: ${detail}`);
    this.name = "MaterializationIntegrityError";
  }
}

/**
 * JSON with sorted keys at every level, so the checksum of a payload does not
 * depend on the order an object happened to be built in.
 */
function canonicalJson(value: unknown): string {
  // `JSON.stringify(undefined)` is undefined rather than a document; an absent
  // value and an explicit null check the same here.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** The checksum of one entry payload, as recorded in its mapping. */
export function payloadChecksum(payload: CheckedEntryPayload): string {
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

/**
 * The identity of one checked output entry. Content-derived on purpose — this
 * is extraction accounting, not a Workspace identity — with the ordinal among
 * identical payloads appended so two identical obligations stay two entries.
 * Reordering the output cannot change it.
 */
export function outputEntryId(entries: readonly CheckedOutputEntry[], index: number): string {
  const entry = entries[index]!;
  const checksum = payloadChecksum(entry.payload);
  let ordinal = 0;
  for (let candidate = 0; candidate <= index; candidate += 1) {
    if (payloadChecksum(entries[candidate]!.payload) === checksum) ordinal += 1;
  }
  return `ce_${createHash("sha256").update(`${checksum}#${ordinal}`).digest("hex").slice(0, 16)}`;
}

/**
 * The versioned key one entry materializes under. Scoped to the Run whose
 * checked artifact produced it: the same entry across two Runs is a new
 * observation, and the relationship between them is a reconciliation decision
 * rather than an inherited identity.
 */
export function materializationKey(debriefRunId: string, entryId: string): string {
  return `materialization:v${MATERIALIZATION_KEY_VERSION}:${debriefRunId}:${entryId}`;
}

/**
 * The materialization index, read from the records themselves. Every proposal
 * revision an extraction produced names the key it was materialized under and
 * the checksum of the entry that was checked, so the index is a projection of
 * durable state rather than a second record that can go missing.
 */
export function materializationIndex(
  items: readonly ActionItem[],
): Map<string, ActionItemMaterializationMapping> {
  const index = new Map<string, ActionItemMaterializationMapping>();
  for (const item of items)
    for (const revision of item.proposalRevisions) {
      const { origin } = revision;
      if (origin.kind !== "extraction") continue;
      index.set(origin.materializationKey, {
        key: origin.materializationKey,
        debriefRunId: origin.debriefRunId,
        outputEntryId: origin.outputEntryId,
        candidateAlias: origin.candidateAlias,
        payloadChecksum: origin.payloadChecksum,
        actionItemId: item.id,
        proposalRevision: revision.revision,
        allocatedAt: revision.createdAt,
      });
    }
  return index;
}
