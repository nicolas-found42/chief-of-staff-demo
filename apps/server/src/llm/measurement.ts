import { createHash } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CompletionRequest, LlmConfig } from "./providers.js";

/**
 * The exact-request identity of one model invocation (issue #381).
 *
 * A hash over everything that decides what the configured model is asked —
 * the resolved provider and model, both prompt texts, the result shape and
 * the sampling, binding and routing options — and nothing that does not: the
 * API key, the caller's retry callbacks, admission fields. Two invocations
 * with one fingerprint asked the same question of the same model, which is
 * the most any exact-reuse candidate could ever serve; the measurement report
 * counts those repeats against earlier validated successes to bound the
 * opportunity before anything is built. Opaque by construction: the hash
 * carries no name, transcript text, prompt or quote into a log.
 */
export function requestFingerprint(cfg: LlmConfig, request: CompletionRequest): string {
  const schema = zodToJsonSchema(request.schema, { $refStrategy: "none" });
  return createHash("sha256")
    .update(
      JSON.stringify([
        cfg.provider,
        cfg.model,
        cfg.baseUrl ?? null,
        request.system,
        request.user,
        schema,
        request.preferredBinding ?? null,
        request.temperature ?? null,
        request.reasoningEffort ?? null,
        request.seed ?? null,
        request.compactWireNames ?? false,
        request.preferredMinThroughput ?? null,
      ]),
    )
    .digest("hex");
}
