import { z } from "zod";

/**
 * Extraction result — mirror of the routine's `routine/outbox-schema.json` v1,
 * with two adaptations for this app:
 *  - `drafts[].body` added: this app composes the draft text itself and creates
 *    the Gmail draft from it.
 *  - `sourceId` / `sourceUrl` generalized: a run id or Fireflies transcript id
 *    and any source URL, instead of Drive file id / url.
 */
export const ExtractionResultSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.string(),
  sourceFileName: z.string(),
  sourceUrl: z.string().nullable(),
  processedAt: z.string(),
  isTranscript: z.boolean(),
  skipReason: z.string().nullable(),
  summary: z.string(),
  tasks: z.array(
    z.strictObject({
      title: z.string().min(1),
      owner: z.string().optional(),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "due must be YYYY-MM-DD")
        .optional(),
      notes: z.string().optional(),
      sourceQuote: z.string().optional(),
    }),
  ),
  drafts: z.array(
    z.strictObject({
      /** Empty string when the recipient is unknown. */
      to: z.string().optional(),
      subject: z.string(),
      body: z.string(),
      reason: z.string().optional(),
    }),
  ),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type TaskItem = ExtractionResult["tasks"][number];
export type DraftItem = ExtractionResult["drafts"][number];

/**
 * Wire schema handed to LLM providers as the structured-output contract.
 * Identical to `ExtractionResultSchema` except every optional field is
 * required-but-nullable: OpenAI strict json_schema demands that all properties
 * appear in `required`. The normalization schema below removes those nulls in
 * the same validation pass before the pipeline trusts the payload.
 */
export const ExtractionWireSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.string(),
  sourceFileName: z.string(),
  sourceUrl: z.string().nullable(),
  processedAt: z.string(),
  isTranscript: z.boolean(),
  skipReason: z.string().nullable(),
  summary: z.string(),
  tasks: z.array(
    z.strictObject({
      title: z.string(),
      owner: z.string().nullable(),
      due: z.string().nullable(),
      notes: z.string().nullable(),
      sourceQuote: z.string().nullable(),
    }),
  ),
  drafts: z.array(
    z.strictObject({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      reason: z.string().nullable(),
    }),
  ),
});

const NormalizedWireExtractionSchema = ExtractionWireSchema.transform((wire): ExtractionResult => ({
  ...wire,
  tasks: wire.tasks.map((task) => {
    const out: ExtractionResult["tasks"][number] = { title: task.title };
    for (const key of ["owner", "due", "notes", "sourceQuote"] as const) {
      if (task[key] !== null) {
        out[key] = task[key];
      }
    }
    return out;
  }),
  drafts: wire.drafts.map((draft) => {
    const out: ExtractionResult["drafts"][number] = {
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
    };
    if (draft.reason !== null) {
      out.reason = draft.reason;
    }
    return out;
  }),
}));

/**
 * The accepted reply variants, normalized as part of the one validation pass:
 * strict-provider wire values lose their null placeholders, while canonical
 * values (including hand-edited fixtures) pass through unchanged.
 */
export const NormalizedExtractionResultSchema = z.union([
  NormalizedWireExtractionSchema,
  ExtractionResultSchema,
]);
