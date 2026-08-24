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
 * appear in `required`. The pipeline normalizes nulls away and re-validates
 * with `ExtractionResultSchema` before trusting the payload.
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

/**
 * Convert a provider payload into the canonical shape. Accepts either the
 * wire shape (all fields required, null for absent optionals — what strict
 * structured-output providers emit) or the canonical shape (optional fields
 * omitted, e.g. a hand-edited mock-result.json). Throws when neither
 * validates.
 */
export function normalizeExtractionResult(payload: unknown): ExtractionResult {
  const wire = ExtractionWireSchema.safeParse(payload);
  if (wire.success) {
    return ExtractionResultSchema.parse({
      ...wire.data,
      tasks: wire.data.tasks.map((task) => {
        const out: Record<string, unknown> = { title: task.title };
        for (const key of ["owner", "due", "notes", "sourceQuote"] as const) {
          if (task[key] !== null && task[key] !== undefined) {
            out[key] = task[key];
          }
        }
        return out;
      }),
      drafts: wire.data.drafts.map((draft) => {
        const out: Record<string, unknown> = {
          to: draft.to ?? "",
          subject: draft.subject,
          body: draft.body,
        };
        if (draft.reason !== null && draft.reason !== undefined) {
          out.reason = draft.reason;
        }
        return out;
      }),
    });
  }
  return ExtractionResultSchema.parse(payload);
}
