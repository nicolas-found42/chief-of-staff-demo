/**
 * Live measurement probe for issue #381 Step 3 (R3): does OpenRouter +
 * `inception/mercury-2.5` already report `cachedInputTokens` on a repeated
 * exact request prefix, with no transport change? Records shape/usage only
 * (tokens, cost, cache split) — never prompt content, per the model-boundary
 * diagnostic convention. Run: `node --import tsx scripts/debug/mercury-prefix-cache-probe.mts`.
 */
import { z } from "../../apps/server/node_modules/zod/v3/index.js";
import {
  makeCompleteJson,
  observeModelUsage,
  type CompletionRequest,
} from "../../apps/server/src/llm/providers.js";

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is required");

// A long, stable prefix representative of a retained-source extraction
// request (E1's shape: a big passage plus a small structured ask). Long
// enough to clear typical provider cache-eligibility floors (~1024 tokens).
const stablePrefix = Array.from(
  { length: 220 },
  (_, i) =>
    `Paragraph ${i}: this is a synthetic retained-source passage used only to size a cache probe. ` +
    `It repeats a stable shape so the request prefix is identical across calls, exactly as a resumed ` +
    `document's Extraction Part request would be. No real content, names, or transcripts appear here.`,
).join("\n");

const schema = z.object({
  found: z.boolean(),
  count: z.number(),
});

const usages: Array<{
  call: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
}> = [];
let callIndex = 0;
observeModelUsage((u) => {
  usages.push({
    call: callIndex,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedInputTokens: u.cachedInputTokens,
    costUsd: u.costUsd,
  });
});

const complete = makeCompleteJson(
  { provider: "openrouter", model: "inception/mercury-2.5", apiKey: key },
  "",
);

async function run(call: number, suffix: string) {
  callIndex = call;
  const request: CompletionRequest = {
    system: "You count sentences containing the word 'stable'. Answer via the schema only.",
    user: `${stablePrefix}\n\nQuestion ${suffix}: how many paragraphs mention 'stable'?`,
    // Cast through `unknown`: this script resolves zod through a different
    // physical module path than the one `CompletionRequest`'s own `schema`
    // field type was declared against, so a direct structural comparison of
    // the two (structurally identical, nominally distinct) ZodObject types
    // sends `tsc` into an excessively deep instantiation. Both are the real
    // zod runtime at the version this monorepo installs; only the type
    // identity, not the value, differs. oxlint's own type checker resolves
    // the two module identities as compatible and calls this cast
    // unnecessary; `tsc -p scripts` genuinely fails without it (verified).
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    schema: schema as unknown as CompletionRequest["schema"],
    temperature: 0,
    preferredBinding: "forced_tool_call",
  };
  await complete(request);
}

// Three calls with an identical long prefix and a one-token-varying suffix:
// cold, then two immediate warm repeats.
await run(1, "A");
await run(2, "B");
await run(3, "C");

console.log(JSON.stringify(usages, null, 2));
