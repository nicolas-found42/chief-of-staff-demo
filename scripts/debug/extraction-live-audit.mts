/** Bounded live diagnostic; captures only application outputs and request diagnostics. */
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const { zodToJsonSchema } = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)("zod-to-json-schema") as {
  zodToJsonSchema: (schema: ReturnType<typeof buildDebriefMessages>["schema"]) => unknown;
};
import { buildDebriefMessages } from "../../apps/server/src/modules/meeting-debrief/extraction.js";
import { makeCompleteJson } from "../../apps/server/src/llm/providers.js";
import {
  modelBoundaryDiagnostic,
  modelDiagnosticEventDetail,
} from "../../apps/server/src/llm/failure.js";
import type { TranscriptRecord, ModelAttemptEvent } from "@chief-of-staff-demo/shared";

import { extractDebriefCandidates } from "../../apps/server/src/modules/meeting-debrief/candidate-extraction.js";
import { writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) throw new Error("Provide a new output directory");
const file = process.argv[3] ?? "tests/fixtures/operational-handoff/2026-09-09-found42-stand-up.md";
const samples = Number(process.argv[4] ?? 2);
if (!Number.isInteger(samples) || samples < 1 || samples > 2) throw new Error("1–2 samples only");
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY required");
await mkdir(out, { recursive: false });
const text = await readFile(file, "utf8");
const record = {
  normalizedText: text,
  meetingDate: file.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
  roster: [],
  occurrence: null,
} as unknown as TranscriptRecord;
const messages = buildDebriefMessages(record, { mentions: [], decisions: [], organizations: [] });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const model = "inception/mercury-2.5";
const routes: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init);
  const url = input instanceof Request ? input.url : input.toString();
  if (!url.endsWith("/chat/completions") || !response.body) return response;
  let buffer = "";
  const decoder = new TextDecoder();
  const body = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
          try {
            const event = JSON.parse(line.slice(5)) as { provider?: string };
            if (event.provider && !routes.includes(event.provider)) routes.push(event.provider);
          } catch {
            /* Non-JSON SSE event carries no provider metadata. */
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
const complete = makeCompleteJson({ provider: "openrouter", model, apiKey: key }, "");
await writeFile(
  `${out}/request.json`,
  JSON.stringify(
    {
      model,
      temperature: 0,
      samples,
      file,
      inputHash: hash(text),
      promptHash: hash(messages.system),
      schemaHash: hash(JSON.stringify(zodToJsonSchema(messages.schema))),
      system: messages.system,
      user: messages.user,
      schema: zodToJsonSchema(messages.schema),
    },
    null,
    2,
  ),
);
for (let sample = 0; sample < samples; sample++) {
  routes.length = 0;
  const events: ModelAttemptEvent[] = [];
  const began = performance.now();
  try {
    let modelRaw: unknown;
    const raw = await extractDebriefCandidates({
      record,
      identity: { mentions: [], decisions: [], organizations: [] },
      complete,
      retry: { onAttempt: (e) => events.push(e) },
      capture: (name, value) => {
        writeFileSync(`${out}/${sample}-${name}.json`, JSON.stringify(value, null, 2));
        if (name === "assembled") modelRaw = value;
      },
    });
    const parsed = messages.schema.safeParse(modelRaw);
    const ms = Math.round(performance.now() - began);
    await writeFile(
      `${out}/${sample}.json`,
      JSON.stringify(
        {
          model,
          ms,
          valid: parsed.success,
          routes: [...routes],
          events,
          modelRaw,
          raw,
          issues: parsed.success ? [] : parsed.error.issues,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        sample,
        ms,
        valid: parsed.success,
        events,
        actions: parsed.success ? parsed.data.actionItems.length : null,
      }),
    );
  } catch (error) {
    const result = {
      model,
      ms: Math.round(performance.now() - began),
      valid: false,
      events,
      diagnostic: modelBoundaryDiagnostic(error),
      ...modelDiagnosticEventDetail(error),
    };
    await writeFile(`${out}/${sample}.error.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  }
}
