/** Sequential candidate-accounting evaluation; same extraction path as the host. */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { extractDebriefCandidates } from "../apps/server/src/modules/meeting-debrief/candidate-extraction.js";
import { makeCompleteJson } from "../apps/server/src/llm/providers.js";
import { modelDiagnosticEventDetail } from "../apps/server/src/llm/failure.js";
import type { TranscriptRecord } from "../packages/shared/src/transcript.js";
import type { ModelAttemptEvent } from "../packages/shared/src/llm.js";

const model = process.argv[2];
const out = process.argv[3] ?? "/tmp/debrief-runs";
const files = process.argv.slice(4);
if (!model || !files.length)
  throw new Error("usage: tsx scripts/run-debrief-eval.mts <model> <outdir> <files...>");
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
await mkdir(out, { recursive: true });
const complete = makeCompleteJson({ provider: "openrouter", model, apiKey }, "");
for (const file of files) {
  const name = file.split("/").pop()!;
  const output = `${out}/${name}.debrief.json`;
  const errorFile = `${out}/${name}.error.json`;
  const record = {
    normalizedText: await readFile(file, "utf8"),
    meetingDate: name.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
    roster: [],
    occurrence: null,
  } as unknown as TranscriptRecord;
  const began = Date.now();
  let modelRaw: unknown;
  const events: ModelAttemptEvent[] = [];
  try {
    const raw = await extractDebriefCandidates({
      record,
      identity: { mentions: [], decisions: [], organizations: [] },
      complete,
      retry: { onAttempt: (event) => events.push(event) },
      capture: (stage, value) => {
        writeFileSync(`${output}.candidate-${stage}.json`, JSON.stringify(value, null, 2));
        if (stage === "assembled") modelRaw = value;
      },
    });
    await writeFile(
      output,
      JSON.stringify(
        {
          model,
          ms: Date.now() - began,
          valid: true,
          raw,
          modelRaw,
          events,
          strategy: "candidate-accounting-v12",
        },
        null,
        2,
      ),
    );
    await rm(errorFile, { force: true });
    console.log(`${name}: OK ${raw.actionItems.length} actions, ${Date.now() - began}ms`);
  } catch (error) {
    await rm(output, { force: true });
    await writeFile(
      errorFile,
      JSON.stringify(
        {
          model,
          ms: Date.now() - began,
          valid: false,
          events,
          error: error instanceof Error ? error.message : "Extraction failed",
          diagnostic: modelDiagnosticEventDetail(error),
        },
        null,
        2,
      ),
    );
    console.log(`${name}: FAILED (see retained diagnostic)`);
    process.exitCode = 1;
  }
}
