import { createHash } from "node:crypto";
import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";
import { PersonDossierContentSchema } from "@chief-of-staff-demo/shared";

/**
 * What one Extraction Part asks the model for: a dossier slice plus the
 * document-level facts that attribute it. The research operation validates
 * every model reply against this before anything downstream sees it.
 */
export const ExtractionSchema = PersonDossierContentSchema.extend({
  fullName: z.string().max(200).nullable(),
  employer: z.string().max(200).nullable(),
  sourceClass: z.enum(["self-report", "independent-account", "primary-artifact"]),
  author: z.string().max(1000).nullable(),
  publishedAt: z.string().max(40).nullable(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * The reuse-key version (issue #381, R1). Bumping it is the rollback for the
 * key's own semantics: every checkpoint written under an older version is a
 * miss, nothing stored is rewritten, and no research has to be re-run.
 *
 * It is also the reader/selector pipeline version the spec names as its own
 * key dependency: `extractionPartKey`'s `partIndex`/`partCount`/`offset`/
 * `length` already invalidate a hit whenever a reader or selector change
 * actually produces different values for the same text, but a change whose
 * output happens to coincide with the old one (a pure refactor of
 * `extraction-passages.ts` or the reader route it feeds) would not — bump
 * this version alongside any such change so it invalidates unconditionally.
 */
export const EXTRACTION_PART_REUSE_VERSION = 1;

/**
 * A validated Extraction Part result, checkpointed so a resumed document can
 * be served the parts that already succeeded instead of re-extracting them.
 *
 * The result stored is what `parsePartial` returned — bounded, schema-valid
 * and grounded — never the model's raw reply. The key is the complete
 * request identity (below), and the source id and text hash are kept beside
 * it so a replay can prove it is grounding against the very bytes the answer
 * was validated against.
 */
export const ExtractionPartCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  key: z.string().length(64),
  profileId: z.string().max(160),
  operationId: z.string().max(64),
  sourceId: z.string().length(64),
  /** SHA-256 of the retained text the part was cut from. */
  textHash: z.string().length(64),
  /** `k/n` — which part of how many, as the model was told. */
  part: z.string().max(20),
  transcriptId: z.string().max(160).optional(),
  recordedAt: z.string().max(40),
  result: ExtractionSchema,
});
export type ExtractionPartCheckpoint = z.infer<typeof ExtractionPartCheckpointSchema>;

const EXTRACTION_WIRE_SCHEMA = JSON.stringify(
  zodToJsonSchema(ExtractionSchema, { $refStrategy: "none" }),
);

/**
 * The complete request identity of one Extraction Part, after configuration
 * and binding resolution — the only thing a checkpoint may be keyed by.
 *
 * Every dependency of the answer is in it: the operation and profile
 * revision (reuse lives inside one operation, ADR-0075), the retained source
 * version and the exact bytes and range the part was cut from (the selector's
 * output), the resolved model identity, the prompts — which carry the
 * identity and provenance context — the result shape, and the request
 * options. Content alone never keys a hit; a change to any one of these is a
 * miss by construction rather than by a rule someone has to remember.
 */
export function extractionPartKey(input: {
  operationId: string;
  profileId: string;
  profileRevision: number;
  sourceId: string;
  textHash: string;
  partIndex: number;
  partCount: number;
  offset: number;
  length: number;
  modelIdentity: string;
  system: string;
  user: string;
  options: Record<string, string | number | boolean | null>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        EXTRACTION_PART_REUSE_VERSION,
        input.operationId,
        input.profileId,
        input.profileRevision,
        input.sourceId,
        input.textHash,
        input.partIndex,
        input.partCount,
        input.offset,
        input.length,
        input.modelIdentity,
        input.system,
        input.user,
        EXTRACTION_WIRE_SCHEMA,
        input.options,
      ]),
    )
    .digest("hex");
}

/** Whether every citation a stored result carries is still a verbatim substring of `text`. */
export function replayGrounded(result: Extraction, text: string): boolean {
  return result.claims.every((claim) =>
    claim.citations.every((citation) => text.includes(citation.quote)),
  );
}
